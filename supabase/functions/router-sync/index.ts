// @ts-nocheck
// Interface do MikroTik (HTTPS, chamada de dentro para fora; funciona atrás de CGNAT).
//   GET  ?ping          -> "pong" (sem dados; só prova DNS+TLS+rota; usado no diagnóstico)
//   GET                 -> pedidos pagos ainda não confirmados, em TEXTO simples (RouterOS 6 não lê JSON)
//   GET  ?fmt=json      -> o mesmo em JSON (RouterOS 7, testes)
//   POST                -> ACK idempotente (corpo JSON ou order=<uuid>&mac=<MAC>)
//   POST expired=MAC,MAC -> aviso de crédito esgotado (até 20 MACs; idempotente)
//   POST cmd=<uuid>&mac=<MAC>&r=<ok|auth|login|nohost|err> -> resultado de um comando (idempotente)
// Autenticação: cabeçalho X-Router-Key == ROUTER_SHARED_KEY (ou ROUTER_SHARED_KEY_NEXT).
//
// Formato de texto (largura fixa, no máximo MAX_PER_POLL linhas, resposta < 1 KB):
//   OK
//   G AA:BB:CC:DD:EE:FF 123e4567-e89b-12d3-a456-426614174000 5h0m0s
//   ^  ^MAC(17)          ^id do pedido(36)                      ^tempo a creditar
//   C 123e4567-e89b-12d3-a456-426614174000 G AA:BB:CC:DD:EE:FF      (58 caracteres, largura fixa)
//     ^id do comando(36)                   ^tipo: G=liberar sem limite, R=revogar/bloquear, K=derrubar sessão,
//                                            A=reautenticar (recuperação)
// Os tipos são uma lista fechada; o roteador valida cada campo e nunca executa texto vindo da rede.
import {
  HttpError, isUuid, json, normalizeMac, parseRosDuration, readBody, rosTime, routerAuthorized, rpc,
} from '../_shared/common.ts';

const MAX_PER_POLL = 10;
const MAX_CMDS = 10;
const KIND = { grant: 'G', revoke: 'R', kick: 'K', reauth: 'A', trial: 'T' }; // T = cortesia de 2 min para pagar o Pix
const RESULTS = new Set(['ok', 'auth', 'login', 'nohost', 'err']); // respostas pequenas para o hardware antigo (64 MB de RAM)
const text = (body, status = 200) => new Response(body, {
  status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
});

export async function handler(req) {
  try {
    const url = new URL(req.url);
    if (req.method === 'GET' && url.searchParams.has('ping')) return text('pong\n');
    if (!(await routerAuthorized(req))) return json({ error: 'Unauthorized' }, 401);

    if (req.method === 'GET') {
      // Aparelhos presentes no Hotspot (/ip hotspot host), "MAC;MAC;..." no cabeçalho X-Hosts. Só quem o roteador
      // vê pode gerar Pix (impede MACs inventados pela internet). Falha aqui nunca atrapalha a entrega de créditos.
      const hosts = (req.headers.get('x-hosts') || '').trim();
      if (hosts && hosts.length <= 4000) { // "MAC|IP|a;..." até 150 aparelhos
        await rpc('hotspot_router_report_hosts', { p_macs: hosts }).catch((e) => console.error('router-sync hosts', String(e)));
      }
      // Limpeza diária de pedidos inúteis (a função decide se já rodou hoje; falha nunca atrapalha a entrega).
      await rpc('hotspot_maintenance', {}).catch((e) => console.error('router-sync maintenance', String(e)));
      const r = await rpc('hotspot_router_pull', { p_limit: MAX_PER_POLL });
      const orders = r?.orders ?? [];
      const c = await rpc('hotspot_router_commands_pull', { p_limit: MAX_CMDS });
      const commands = (c?.commands ?? []).filter((x) => KIND[x.kind] && normalizeMac(x.mac) && isUuid(x.id));
      if (url.searchParams.get('fmt') === 'json') return json({ orders, commands });
      const lines = ['OK', ...orders.map((o) => `G ${o.mac} ${o.id} ${rosTime(o.grant_seconds)}`),
        // Tempo corrido: liberação com teto de uso ("L <MAC> <segundos restantes>"); ilimitado: "G <MAC>".
        ...commands.map((x) => (x.kind === 'grant' && Number.isInteger(x.secs) && x.secs > 0
          ? `C ${x.id} L ${normalizeMac(x.mac)} ${Math.min(x.secs, 2592000)}`
          : `C ${x.id} ${KIND[x.kind]} ${normalizeMac(x.mac)}`))];
      return text(lines.join('\n') + '\n');
    }
    if (req.method === 'POST') {
      const data = await readBody(req);
      // Aviso do roteador: aparelhos cujo limit-uptime esgotou (o tempo é controlado SÓ pelo MikroTik).
      if (data?.expired !== undefined) {
        const list = Array.isArray(data.expired) ? data.expired.join(',') : String(data.expired);
        if (list.length > 400) return json({ error: 'Invalid list' }, 400);
        const r = await rpc('hotspot_router_report_exhausted', { p_macs: list });
        return json({ ok: true, updated: r?.updated ?? 0 });
      }
      // Telemetria agregada (a cada ~60 s): "tel=MAC_IP_uso_limite_A,..." (até 20 por chamada) e "online=<n>".
      // Uso/limite chegam no formato de tempo do RouterOS (1h2m3s ou 01:02:03); limite vazio ou 0 = sem limite.
      // Métricas do equipamento (somente leitura, ~60 s): "m=cpu:12,mf:..,mt:..,up:1d02:03:04,ver:..,brd:..,wi:ether1,
      // li:ether2,wr:..,wt:..,lr:..,lt:..,h:30,a:25,cn:900,p:ether1/1/100Mbps|ether2/1/1Gbps". Campos validados um a um;
      // campo inválido vira nulo. Falha aqui nunca afeta comandos, Pix ou cortesia (rota separada, erro isolado).
      if (data?.m !== undefined) {
        const raw = String(data.m);
        if (raw.length > 1500) return json({ error: 'Invalid metrics' }, 400);
        const kv = {};
        for (const part of raw.split(',')) { const i = part.indexOf(':'); if (i > 0) kv[part.slice(0, i).trim()] = part.slice(i + 1).trim(); }
        const int = (v, max) => (/^\d{1,15}$/.test(String(v ?? '')) && Number(v) <= max ? Number(v) : null);
        const txt = (v, max) => { const t = String(v ?? '').replace(/[^A-Za-z0-9 ._()\-]/g, '').slice(0, max); return t || null; };
        const ports = String(kv.p ?? '').split('|').slice(0, 8).map((x) => x.split('/')).filter((f) => /^[A-Za-z0-9_.-]{1,20}$/.test(f[0] || ''))
          .map((f) => ({ name: f[0], running: f[1] === '1' || f[1] === 'true', rate: txt(f[2], 12) }));
        const m = {
          cpu: int(kv.cpu, 100), mem_free: int(kv.mf, 1e12), mem_total: int(kv.mt, 1e12), uptime_s: parseRosDuration(kv.up),
          version: txt(kv.ver, 40), board: txt(kv.brd, 40), wan_if: txt(kv.wi, 20), lan_if: txt(kv.li, 20),
          wan_rx: int(kv.wr, 1e18), wan_tx: int(kv.wt, 1e18), lan_rx: int(kv.lr, 1e18), lan_tx: int(kv.lt, 1e18),
          hosts: int(kv.h, 5000), active: int(kv.a, 5000), conns: int(kv.cn, 1000000), ports,
        };
        if (m.cpu === null && m.mem_free === null) return json({ error: 'Invalid metrics' }, 400);
        const r = await rpc('hotspot_router_report_metrics', { p: m });
        return json({ ok: true, rate: Boolean(r?.rate) });
      }
      if (data?.tel !== undefined) {
        const raw = String(data.tel);
        if (raw.length > 2000) return json({ error: 'Invalid telemetry' }, 400);
        const rows = [];
        for (const entry of raw.split(',')) {
          if (!entry) continue;
          const f = entry.split('_');
          if (f.length !== 5) continue;
          const mac = normalizeMac(f[0]);
          const uptime = parseRosDuration(f[2]);
          const limit = f[3] === '' ? null : parseRosDuration(f[3]);
          if (!mac || uptime === null || (f[3] !== '' && limit === null)) continue;
          rows.push({ mac, ip: f[1], uptime, lim: limit, active: f[4] === '1' });
          if (rows.length >= 20) break;
        }
        const online = /^\d{1,4}$/.test(String(data.online ?? '')) ? Number(data.online) : null;
        const r = await rpc('hotspot_router_report_state', { p_online: online, p_rows: rows });
        return json({ ok: true, accepted: r?.accepted ?? 0 });
      }
      // Resultado de um comando (G/R/K/A).
      if (data?.cmd !== undefined) {
        const cid = String(data.cmd);
        const cmac = normalizeMac(data?.mac);
        const res = String(data?.r ?? '');
        if (!isUuid(cid) || !cmac || !RESULTS.has(res)) return json({ error: 'Invalid command ack' }, 400);
        const r = await rpc('hotspot_router_command_ack', { p_id: cid, p_mac: cmac, p_result: res });
        if (!r?.ok) return json({ error: 'Command not found' }, 409);
        return json({ ok: true, already: Boolean(r.already) });
      }
      const id = String(data?.order_id ?? data?.order ?? '');
      const mac = normalizeMac(data?.mac);
      if (!mac || !isUuid(id)) return json({ error: 'Invalid order' }, 400);
      const r = await rpc('hotspot_router_ack', { p_order_id: id, p_mac: mac });
      if (!r?.ok) return json({ error: 'Order not eligible' }, 409);
      return json({ ok: true, already: Boolean(r.already) });
    }
    return json({ error: 'Method not allowed' }, 405);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error('router-sync', String(e));
    return json({ error: 'Server error' }, 500);
  }
}

Deno.serve(handler);
