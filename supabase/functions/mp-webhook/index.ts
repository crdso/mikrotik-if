// @ts-nocheck
// Webhook do Mercado Pago. Só aceita notificações com assinatura válida e NUNCA
// confia no corpo: relê o pagamento na API do Mercado Pago e deixa o banco
// conferir valor, moeda, meio e vínculo com o pedido.
import {
  MpError, env, isUuid, json, mpGetPayment, paymentApplyArgs, rpc, verifyMpSignature,
} from '../_shared/common.ts';

export async function handler(req) {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  try {
    // Sem assinatura nem se olha para os segredos: recusa já (evita 500 em chamadas forjadas).
    if (!req.headers.get('x-signature')) return json({ error: 'Invalid signature' }, 401);
    const url = new URL(req.url);
    const dataId = url.searchParams.get('data.id') || '';
    const ok = await verifyMpSignature({
      signatureHeader: req.headers.get('x-signature') || '',
      requestId: req.headers.get('x-request-id') || '',
      dataId,
      secret: env('MP_WEBHOOK_SECRET'),
    });
    if (!ok) return json({ error: 'Invalid signature' }, 401);

    const body = await req.json().catch(() => null);
    const type = body?.type ?? url.searchParams.get('type') ?? url.searchParams.get('topic');
    if (type !== 'payment') return json({ ok: true, ignored: 'not_payment' });
    if (!/^\d{1,20}$/.test(dataId)) return json({ ok: true, ignored: 'bad_payment_id' });

    let payment;
    try {
      payment = await mpGetPayment(dataId);
    } catch (e) {
      // 404: notificação de teste/pagamento de outra aplicação. Sem retry útil.
      if (e instanceof MpError && e.status === 404) return json({ ok: true, ignored: 'payment_not_found' });
      throw e; // erro temporário -> 500 -> o Mercado Pago tenta de novo
    }
    if (String(payment?.id) !== dataId) return json({ ok: true, ignored: 'id_mismatch' });

    const orderId = String(payment.external_reference || '');
    if (!isUuid(orderId)) return json({ ok: true, ignored: 'no_order_reference' });

    const result = await rpc('hotspot_apply_payment', paymentApplyArgs(orderId, payment));
    if (['invalid_payment', 'payment_mismatch'].includes(result?.result)) {
      console.error('mp-webhook: pagamento recusado pelo banco', dataId, orderId, result.result);
    }
    return json({ ok: true, result: result?.result ?? null });
  } catch (err) {
    console.error('mp-webhook', String(err));
    return json({ error: 'Webhook error' }, 500); // provedor tentará novamente
  }
}

Deno.serve(handler);
