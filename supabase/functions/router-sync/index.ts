// @ts-nocheck
// Interface do MikroTik (HTTPS, chamada de dentro para fora; funciona atrás de CGNAT).
//   GET  ?ping          -> "pong" (sem dados; só prova DNS+TLS+rota; usado no diagnóstico)
//   GET                 -> pedidos pagos ainda não confirmados, em TEXTO simples (RouterOS 6 não lê JSON)
//   GET  ?fmt=json      -> o mesmo em JSON (RouterOS 7, testes)
//   POST                -> ACK idempotente (corpo JSON ou order=<uuid>&mac=<MAC>)
//   POST expired=MAC,MAC -> aviso de crédito esgotado (até 20 MACs; idempotente)
// Autenticação: cabeçalho X-Router-Key == ROUTER_SHARED_KEY (ou ROUTER_SHARED_KEY_NEXT).
//
// Formato de texto (largura fixa, no máximo MAX_PER_POLL linhas, resposta < 1 KB):
//   OK
//   G AA:BB:CC:DD:EE:FF 123e4567-e89b-12d3-a456-426614174000 5h0m0s
//   ^  ^MAC(17)          ^id do pedido(36)                      ^tempo a creditar
import {
  HttpError, isUuid, json, normalizeMac, parseRosDuration, readBody, rosTime, routerAuthorized, rpc,
} from '../_shared/common.ts';

const MAX_PER_POLL = 10; // respostas pequenas para o hardware antigo (64 MB de RAM)
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
      if (hosts && hosts.length <= 2000) {
        await rpc('hotspot_router_report_hosts', { p_macs: hosts }).catch((e) => console.error('router-sync hosts', String(e)));
      }
      // Limpeza diária de pedidos inúteis (a função decide se já rodou hoje; falha nunca atrapalha a entrega).
      await rpc('hotspot_maintenance', {}).catch((e) => console.error('router-sync maintenance', String(e)));
      const r = await rpc('hotspot_router_pull', { p_limit: MAX_PER_POLL });
      const orders = r?.orders ?? [];
      if (url.searchParams.get('fmt') === 'json') return json({ orders });
      const lines = ['OK', ...orders.map((o) => `G ${o.mac} ${o.id} ${rosTime(o.grant_seconds)}`)];
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
