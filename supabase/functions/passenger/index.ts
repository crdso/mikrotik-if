// @ts-nocheck
// Cadastro do passageiro (nome completo + e-mail, AUTODECLARADOS; o MAC não é identidade verificada).
//   GET  ?mac=AA:BB:..   -> estado do PRÓPRIO aparelho para a tela "Aguardando liberação" (sem dados pessoais além de
//                           dicas MASCARADAS; só para aparelhos presentes na rede):
//                           { registered, name_hint?, email_hint?, access: none|provisioning|active|revoked|blocked,
//                             internet, stuck, pix_pending, router_online }
//                           Vem do servidor (nunca do localStorage): reabrir o portal, fechar a janela do iPhone para pagar
//                           no app do banco ou trocar de navegador não perde o pagamento nem a liberação.
//   POST {mac, name, email} -> { ok: true, action }                   (validado aqui e de novo no banco)
// O cadastro NÃO libera internet: a liberação depende do Pix aprovado OU da liberação manual do administrador. Gravar exige que o aparelho esteja presente
// no Hotspot (mesma lista do MikroTik usada no checkout) e há limites contra spam (por aparelho e global).
import {
  SERVICE_NAME, browserAllowed, cleanName, cors, json, normalizeMac, preflight, readJson, registrationError, rpc,
  validEmail, validName, HttpError,
} from '../_shared/common.ts';

export async function handler(req) {
  const pf = preflight(req); if (pf) return pf;
  const headers = { ...cors(req), 'Cache-Control': 'no-store' };
  if (!browserAllowed(req)) return json({ error: 'Forbidden origin' }, 403, headers);
  try {
    if (req.method === 'GET') {
      const mac = normalizeMac(new URL(req.url).searchParams.get('mac'));
      if (!mac) return json({ registered: false, known: false }, 200, headers);
      const st = await rpc('hotspot_portal_state', { p_mac: mac });
      const access = ['none', 'provisioning', 'active', 'revoked', 'blocked'].includes(st?.access) ? st.access : 'none';
      return json({
        known: st?.known === true,
        registered: st?.registered === true,
        ...(st?.registered ? { name_hint: String(st.name_hint ?? ''), email_hint: String(st.email_hint ?? '') } : {}),
        access,
        internet: st?.internet === true,
        stuck: st?.stuck === true,
        pix_pending: st?.pix_pending === true,
        router_online: st?.router_online === true,
        expires_at: typeof st?.expires_at === 'string' ? st.expires_at : null,
      }, 200, headers);
    }
    if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405, headers);

    const input = await readJson(req, 2048);
    const mac = normalizeMac(input?.mac);
    const name = cleanName(input?.name);
    const email = String(input?.email ?? '').trim().toLowerCase();
    if (!mac) return json({ error: 'Dispositivo não identificado. Abra esta página pela tela de login da rede ' + SERVICE_NAME + '.' }, 400, headers);
    if (!validName(name)) return json({ error: 'Informe seu nome completo (nome e sobrenome).' }, 400, headers);
    if (!validEmail(email)) return json({ error: 'Informe um e-mail válido.' }, 400, headers);

    const r = await rpc('hotspot_register_passenger', { p_mac: mac, p_name: name, p_email: email });
    const bad = registrationError(r?.action, SERVICE_NAME);
    if (bad) return json({ error: bad[1], ...(bad[2] ? { retry: true } : {}) }, bad[0], bad[0] === 429 ? { ...headers, 'Retry-After': '60' } : headers);
    if (!['created', 'updated', 'unchanged'].includes(r?.action)) return json({ error: 'Não foi possível salvar agora. Tente novamente.' }, 500, headers);
    return json({ ok: true, action: r.action }, 200, headers);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status, headers);
    console.error('passenger:', String(e).replace(/[^\s@]+@[^\s@]+/g, '[e-mail]').slice(0, 200)); // sem e-mail em log
    return json({ error: 'Erro interno ao salvar o cadastro.' }, 500, headers);
  }
}

Deno.serve(handler);
