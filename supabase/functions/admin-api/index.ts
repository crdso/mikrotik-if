// @ts-nocheck
// API do painel administrativo. TODA autorização é feita aqui, no servidor:
//   1. o JWT do Supabase Auth é validado no próprio Auth (assinatura, expiração, usuário existente);
//   2. o usuário precisa estar na tabela admin_users (estar logado NÃO basta; o cadastro público do Auth não dá acesso);
//   3. ações de escrita/auditoria exigem o perfil "admin" (operador é somente leitura) e o banco confere de novo.
// As funções SQL hotspot_admin_* só executam para service_role; o navegador nunca recebe privilégio em tabelas.
import {
  HttpError, browserAllowed, cors, env, isUuid, json, preflight, readJson, rpc,
} from '../_shared/common.ts';

const ADMIN_ONLY = new Set(['plan_save', 'setting_set', 'audit', 'passenger_delete', 'personal_purge', 'device_action', 'transfer', 'end_trip', 'device_reset']);
const PEOPLE_FILTERS = new Set(['all', 'online', 'offline', 'waiting', 'unidentified', 'active', 'problem', 'blocked', 'revoked', 'pix_pending', 'manual', 'pix']);
const DEVICE_ACTIONS = new Set(['grant', 'kick', 'revoke', 'block', 'unblock', 'reauth']);
const MAC_RE = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/;
const PRESETS = new Set(['today', 'yesterday', 'last7', 'last30', 'month', 'custom']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const STATES = new Set(['pending', 'approved_waiting', 'provisioned', 'expired', 'failed', 'cancelled', 'refunded']);

async function authenticate(req) {
  const m = /^Bearer\s+([A-Za-z0-9._-]{20,4000})$/.exec(req.headers.get('authorization') || '');
  if (!m) throw new HttpError(401, 'Sessão necessária.');
  const apikey = Deno.env.get('SUPABASE_ANON_KEY') || Deno.env.get('SUPABASE_PUBLISHABLE_KEY') || env('SUPABASE_SERVICE_ROLE_KEY');
  let res;
  try {
    res = await fetch(`${env('SUPABASE_URL')}/auth/v1/user`, {
      headers: { apikey, Authorization: `Bearer ${m[1]}` }, signal: AbortSignal.timeout(8000),
    });
  } catch { throw new HttpError(503, 'Não foi possível validar a sessão.'); }
  if (res.status === 401 || res.status === 403) throw new HttpError(401, 'Sessão inválida ou expirada.');
  if (!res.ok) throw new HttpError(503, 'Não foi possível validar a sessão.');
  const user = await res.json().catch(() => null);
  if (!user || !isUuid(user.id)) throw new HttpError(401, 'Sessão inválida.');
  const role = await rpc('hotspot_admin_get_role', { p_user: user.id });
  if (role !== 'admin' && role !== 'operator') throw new HttpError(403, 'Este usuário não tem acesso ao painel.');
  return { id: user.id, email: String(user.email || ''), role };
}

async function period(input) {
  const preset = String(input?.preset ?? 'today');
  if (!PRESETS.has(preset)) throw new HttpError(400, 'Período inválido.');
  const start = input?.start == null ? null : String(input.start);
  const end = input?.end == null ? null : String(input.end);
  if (preset === 'custom' && !(DATE_RE.test(start || '') && DATE_RE.test(end || ''))) throw new HttpError(400, 'Informe as datas do período.');
  return rpc('hotspot_admin_period', { p_preset: preset, p_start: preset === 'custom' ? start : null, p_end: preset === 'custom' ? end : null });
}

const pageNum = (v, def, max) => {
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : def;
};
const textArg = (v, max = 80) => String(v ?? '').slice(0, max);

// CSV seguro: aspas duplicadas e prefixo ' contra injeção de fórmulas (=, +, -, @).
function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; // separador é ";" (vírgula decimal pt-BR não exige aspas)
}
const csv = (header, rows) => [header.join(';'), ...rows.map((r) => r.map(csvCell).join(';'))].join('\r\n') + '\r\n';
const brl = (cents) => (cents == null ? '' : (Number(cents) / 100).toFixed(2).replace('.', ','));

async function handleAction(action, input, who) {
  switch (action) {
    case 'whoami':
      return { email: who.email, role: who.role };

    case 'dashboard': {
      const p = await period(input);
      const [overview, series, live, recent, people] = await Promise.all([
        rpc('hotspot_admin_overview', { p_from: p.from, p_to: p.to }),
        rpc('hotspot_admin_series', { p_from: p.from, p_to: p.to, p_bucket: p.bucket }),
        rpc('hotspot_admin_live'),
        rpc('hotspot_admin_orders', { p_limit: 10, p_offset: 0, p_status: null, p_from: null, p_to: null, p_q: '' }),
        rpc('hotspot_admin_people_summary'),
      ]);
      return { period: p, overview, series, live, recent: recent.rows, people };
    }

    // Passageiros / dispositivos (dados pessoais: só quem passou em authenticate() chega aqui).
    case 'passengers': {
      const filter = textArg(input?.filter, 20) || 'all';
      if (!PEOPLE_FILTERS.has(filter)) throw new HttpError(400, 'Filtro inválido.');
      return rpc('hotspot_admin_passengers', {
        p_filter: filter, p_q: textArg(input?.q, 80), p_limit: pageNum(input?.limit, 50, 100), p_offset: pageNum(input?.offset, 0, 100000),
      });
    }

    // Painel "Ao vivo": resumo + lista em UMA chamada (o painel repete a cada poucos segundos).
    case 'live': {
      const filter = textArg(input?.filter, 20) || 'all';
      if (!PEOPLE_FILTERS.has(filter)) throw new HttpError(400, 'Filtro inválido.');
      const [summary, list] = await Promise.all([
        rpc('hotspot_admin_people_summary'),
        rpc('hotspot_admin_passengers', { p_filter: filter, p_q: textArg(input?.q, 80), p_limit: pageNum(input?.limit, 200, 200), p_offset: 0 }),
      ]);
      return { summary, list, role: who.role };
    }

    // Liberar | Desconectar | Revogar | Bloquear | Desbloquear | Reautenticar (o banco confere o perfil admin de novo).
    case 'device_action': {
      const mac = String(input?.mac ?? '').toUpperCase();
      const act = textArg(input?.op, 10);
      if (!MAC_RE.test(mac)) throw new HttpError(400, 'Aparelho inválido.');
      if (!DEVICE_ACTIONS.has(act)) throw new HttpError(400, 'Ação inválida.');
      return rpc('hotspot_admin_device_action', { p_actor: who.id, p_actor_email: who.email, p_mac: mac, p_action: act, p_note: textArg(input?.note, 200) });
    }

    case 'transfer': {
      const from = String(input?.from ?? '').toUpperCase();
      const to = String(input?.to ?? '').toUpperCase();
      if (!MAC_RE.test(from) || !MAC_RE.test(to) || from === to) throw new HttpError(400, 'Aparelhos inválidos.');
      return rpc('hotspot_admin_transfer', { p_actor: who.id, p_actor_email: who.email, p_from: from, p_to: to });
    }

    case 'device_reset': {
      const mac = String(input?.mac ?? '').toUpperCase();
      if (!MAC_RE.test(mac)) throw new HttpError(400, 'Aparelho inválido.');
      return rpc('hotspot_admin_device_reset', { p_actor: who.id, p_actor_email: who.email, p_mac: mac });
    }

    case 'router_monitor':
      return rpc('hotspot_admin_router_monitor', { p_minutes: pageNum(input?.minutes, 60, 2880) });

    case 'end_trip':
      return rpc('hotspot_admin_end_trip', { p_actor: who.id, p_actor_email: who.email, p_confirm: textArg(input?.confirm, 20) });

    case 'passenger': {
      const mac = String(input?.mac ?? '').toUpperCase();
      if (!MAC_RE.test(mac)) throw new HttpError(400, 'Aparelho inválido.');
      return rpc('hotspot_admin_passenger', { p_mac: mac });
    }

    case 'passenger_delete': {
      const mac = String(input?.mac ?? '').toUpperCase();
      if (!MAC_RE.test(mac)) throw new HttpError(400, 'Aparelho inválido.');
      return rpc('hotspot_admin_passenger_delete', { p_actor: who.id, p_actor_email: who.email, p_mac: mac });
    }

    case 'personal_purge': {
      const days = Number.parseInt(String(input?.days ?? ''), 10);
      if (!Number.isInteger(days) || days < 0 || days > 3650) throw new HttpError(400, 'Informe os dias de retenção.');
      return rpc('hotspot_admin_personal_purge', { p_actor: who.id, p_actor_email: who.email, p_days: days });
    }

    case 'passengers_csv': {
      const filter = textArg(input?.filter, 20) || 'all';
      if (!PEOPLE_FILTERS.has(filter)) throw new HttpError(400, 'Filtro inválido.');
      const rows = [];
      for (let offset = 0; offset < 2000; offset += 100) {
        const page = await rpc('hotspot_admin_passengers', { p_filter: filter, p_q: textArg(input?.q, 80), p_limit: 100, p_offset: offset });
        rows.push(...page.rows);
        if (page.rows.length < 100) break;
      }
      const body = csv(
        ['nome', 'email', 'mac', 'ip', 'presenca', 'situacao', 'acesso', 'origem', 'liberado_em', 'valor_pago_mp_brl', 'bloqueado', 'ultimo_contato'],
        rows.map((x) => [x.full_name || 'Não identificado', x.email || '', x.mac, x.ip, x.online ? 'visto recentemente' : 'sem sinal',
          x.status, x.access_state || '', x.access_source || '', x.access_granted_at || '', brl(x.total_paid_cents),
          x.blocked ? 'sim' : 'nao', x.last_contact]));
      return { filename: 'passageiros.csv', csv: body, rows: rows.length };
    }

    case 'orders': {
      const status = textArg(input?.status, 30);
      if (status && !STATES.has(status)) throw new HttpError(400, 'Situação inválida.');
      const p = input?.preset && input.preset !== 'all' ? await period(input) : null;
      return rpc('hotspot_admin_orders', {
        p_limit: pageNum(input?.limit, 20, 100), p_offset: pageNum(input?.offset, 0, 100000),
        p_status: status || null, p_from: p?.from ?? null, p_to: p?.to ?? null, p_q: textArg(input?.q),
      });
    }

    case 'orders_csv': {
      const status = textArg(input?.status, 30);
      if (status && !STATES.has(status)) throw new HttpError(400, 'Situação inválida.');
      const p = input?.preset && input.preset !== 'all' ? await period(input) : null;
      const rows = [];
      for (let offset = 0; offset < 5000; offset += 100) {
        const page = await rpc('hotspot_admin_orders', {
          p_limit: 100, p_offset: offset, p_status: status || null, p_from: p?.from ?? null, p_to: p?.to ?? null, p_q: textArg(input?.q),
        });
        rows.push(...page.rows);
        if (page.rows.length < 100) break;
      }
      const body = csv(
        ['data_criacao', 'data_pagamento', 'plano', 'valor_brl', 'duracao_min', 'situacao', 'mac', 'id_pagamento', 'taxa_mp_brl', 'teste'],
        rows.map((o) => [o.created_at, o.paid_at, o.plan_name, brl(o.amount_cents), Math.round(o.grant_seconds / 60), o.state, o.device_mac, o.payment_id, brl(o.mp_fee_cents), o.is_test ? 'sim' : 'nao']));
      return { filename: 'pagamentos.csv', csv: body, rows: rows.length };
    }

    case 'devices':
      return rpc('hotspot_admin_devices', { p_limit: pageNum(input?.limit, 25, 100), p_offset: pageNum(input?.offset, 0, 100000), p_q: textArg(input?.q) });

    case 'device':
      return rpc('hotspot_admin_device', { p_mac: textArg(input?.mac, 17) });

    case 'plans':
      return { plans: await rpc('hotspot_admin_plans') };

    case 'plan_save': {
      const plan = input?.plan;
      if (!plan || typeof plan !== 'object') throw new HttpError(400, 'Dados do plano ausentes.');
      const clean = {
        id: plan.id == null || plan.id === '' ? null : String(plan.id),
        name: String(plan.name ?? ''),
        description: plan.description == null ? null : String(plan.description),
        price_cents: String(plan.price_cents ?? ''),
        grant_seconds: String(plan.grant_seconds ?? ''),
        active: plan.active === true, highlight: plan.highlight === true, is_default: plan.is_default === true,
        unlimited: plan.unlimited === true, wall_clock: plan.wall_clock === true,
        sort_order: Number.isInteger(plan.sort_order) ? plan.sort_order : 0,
      };
      if (clean.id !== null && !isUuid(clean.id)) throw new HttpError(400, 'Plano inválido.');
      const saved = await rpc('hotspot_admin_plan_save', { p_actor: who.id, p_actor_email: who.email, p_plan: clean });
      return { plan: saved };
    }

    case 'report': {
      const p = await period(input);
      const group = textArg(input?.group, 10) || 'day';
      return { period: p, ...(await rpc('hotspot_admin_report', { p_from: p.from, p_to: p.to, p_group: group })) };
    }

    case 'report_csv': {
      const p = await period(input);
      const group = textArg(input?.group, 10) || 'day';
      const r = await rpc('hotspot_admin_report', { p_from: p.from, p_to: p.to, p_group: group });
      const body = csv(
        ['periodo_inicio', 'vendas', 'receita_brl', 'ticket_medio_brl', 'horas_vendidas', 'aparelhos', 'taxas_mp_brl'],
        r.rows.map((x) => [x.period, x.sales, brl(x.revenue_cents), brl(x.avg_ticket_cents), (x.seconds_sold / 3600).toFixed(2).replace('.', ','), x.devices,
          x.fees_known_for === x.sales ? brl(x.fees_cents) : '']));
      return { filename: `relatorio-${group}.csv`, csv: body, rows: r.rows.length };
    }

    case 'settings':
      return { settings: await rpc('hotspot_admin_settings') };

    case 'setting_set':
      return rpc('hotspot_admin_setting_set', {
        p_actor: who.id, p_actor_email: who.email, p_key: textArg(input?.key, 40), p_value: textArg(input?.value, 100),
      });

    case 'audit':
      return { entries: await rpc('hotspot_admin_audit', { p_limit: pageNum(input?.limit, 50, 200) }) };

    default:
      throw new HttpError(400, 'Ação desconhecida.');
  }
}

export async function handler(req) {
  const pf = preflight(req, true); if (pf) return pf;
  const headers = cors(req, true);
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405, headers);
  if (!browserAllowed(req)) return json({ error: 'Forbidden origin' }, 403, headers);
  try {
    const who = await authenticate(req);
    const input = await readJson(req, 8192);
    const action = String(input?.action ?? '');
    if (ADMIN_ONLY.has(action) && who.role !== 'admin') throw new HttpError(403, 'Apenas administradores podem fazer isso.');
    return json(await handleAction(action, input, who), 200, headers);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status, headers);
    const text = String(e);
    // Erros de validação do banco (RAISE EXCEPTION => HTTP 400) são mensagens nossas e seguras de mostrar.
    const m = /rpc \w+ HTTP 400: .*?"message":"([^"]{1,200})"/.exec(text);
    if (m) return json({ error: m[1] === 'forbidden' ? 'Sem permissão.' : m[1] }, m[1] === 'forbidden' ? 403 : 400, headers);
    console.error('admin-api', text.slice(0, 300));
    return json({ error: 'Erro interno.' }, 500, headers);
  }
}

Deno.serve(handler);
