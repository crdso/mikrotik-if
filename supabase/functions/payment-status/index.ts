// @ts-nocheck
// Estado do pedido para o portal. Exige id + read_token (aleatórios).
// Se o pedido segue pendente, reconcilia com o Mercado Pago (no máximo uma
// consulta a cada RECONCILE_SECONDS por pedido), cobrindo falha do webhook.
import {
  RECONCILE_SECONDS, browserAllowed, cors, isUuid, json, mpGetPayment, paymentApplyArgs, preflight, rpc,
} from '../_shared/common.ts';

function publicView(s) {
  return {
    status: s.status,
    internet_ready: Boolean(s.internet_ready),
    seconds_left: s.seconds_left ?? null,
    router_online: Boolean(s.router_online),
  };
}

export async function handler(req) {
  const pf = preflight(req); if (pf) return pf;
  const headers = cors(req);
  if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405, headers);
  if (!browserAllowed(req)) return json({ error: 'Forbidden origin' }, 403, headers);
  try {
    const u = new URL(req.url);
    const id = u.searchParams.get('id') || '';
    const token = u.searchParams.get('token') || '';
    if (!isUuid(id) || !isUuid(token)) return json({ error: 'Pedido inválido' }, 400, headers);

    let s = await rpc('hotspot_order_status', { p_order_id: id, p_token: token, p_reconcile_after_seconds: RECONCILE_SECONDS });
    if (!s?.found) return json({ error: 'Pedido não encontrado' }, 404, headers);

    if (s.reconcile_payment_id) {
      try {
        const payment = await mpGetPayment(s.reconcile_payment_id);
        if (String(payment?.id) === s.reconcile_payment_id && String(payment?.external_reference) === id) {
          await rpc('hotspot_apply_payment', paymentApplyArgs(id, payment));
          s = await rpc('hotspot_order_status', { p_order_id: id, p_token: token, p_reconcile_after_seconds: 3600 });
        }
      } catch (e) {
        console.error('payment-status reconcile:', String(e)); // não derruba a consulta
      }
    }
    return json(publicView(s), 200, headers);
  } catch (e) {
    console.error('payment-status', String(e));
    return json({ error: 'Não foi possível consultar o pedido' }, 500, headers);
  }
}

Deno.serve(handler);
