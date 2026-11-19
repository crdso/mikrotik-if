// @ts-nocheck
// Cria (ou reaproveita) o Pix de R$ 5 de um aparelho. O valor é decidido aqui
// no servidor; nada do que o navegador enviar altera preço, descrição ou prazo.
import {
  GRANT_SECONDS, HttpError, MpError, PIX_TTL_MINUTES, SERVICE_NAME, PRICE_BRL, PRICE_CENTS, browserAllowed, cors, env, json,
  mpCancelPayment, mpCreatePix, mpDate, normalizeMac, preflight, readJson, rpc, validEmail,
} from '../_shared/common.ts';

function secondsLeft(expiresAt) {
  if (!expiresAt) return null;
  return Math.max(0, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000));
}

export async function handler(req) {
  const pf = preflight(req); if (pf) return pf;
  const headers = cors(req);
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405, headers);
  if (!browserAllowed(req)) return json({ error: 'Forbidden origin' }, 403, headers);

  let orderId = null;
  try {
    const input = await readJson(req);
    const mac = normalizeMac(input?.mac);
    const email = String(input?.email ?? '').trim();
    if (!mac) return json({ error: 'Dispositivo não identificado. Abra esta página pela tela de login da rede ' + SERVICE_NAME + '.' }, 400, headers);
    if (!validEmail(email)) return json({ error: 'Informe um e-mail válido.' }, 400, headers);

    const r = await rpc('hotspot_reserve_order', { p_mac: mac, p_amount_cents: PRICE_CENTS, p_grant_seconds: GRANT_SECONDS });
    switch (r?.action) {
      case 'rate_limited':
        return json({ error: 'Muitas tentativas. Aguarde alguns minutos.' }, 429, { ...headers, 'Retry-After': '60' });
      case 'in_progress':
        return json({ error: 'Seu Pix está sendo gerado. Aguarde alguns segundos.', retry: true }, 409, headers);
      case 'paid_waiting':
        return json({ order_id: r.order_id, read_token: r.read_token, status: 'paid' }, 200, headers);
      case 'existing':
        return json({
          order_id: r.order_id, read_token: r.read_token, status: 'pending', reused: true,
          qr_code: r.qr_code, qr_code_base64: r.qr_code_base64 || null, ticket_url: r.ticket_url || null,
          seconds_left: secondsLeft(r.expires_at),
        }, 200, headers);
      case 'created':
        break;
      default:
        return json({ error: 'Dispositivo inválido.' }, 400, headers);
    }

    orderId = r.order_id;
    const expiresAt = new Date(Date.now() + PIX_TTL_MINUTES * 60 * 1000);
    let payment;
    try {
      payment = await mpCreatePix({
        transaction_amount: PRICE_BRL,
        description: `${SERVICE_NAME} - 5 horas`,
        payment_method_id: 'pix',
        payer: { email },
        external_reference: orderId,
        notification_url: `${env('SUPABASE_URL')}/functions/v1/mp-webhook`,
        date_of_expiration: mpDate(expiresAt),
      }, orderId); // X-Idempotency-Key = id do pedido
    } catch (e) {
      await rpc('hotspot_fail_order', { p_order_id: orderId }).catch(() => {});
      console.error('create-payment: MP create failed', e instanceof MpError ? e.status : String(e));
      return json({ error: 'Não foi possível gerar o Pix. Tente novamente.' }, 502, headers);
    }

    const trans = payment?.point_of_interaction?.transaction_data || {};
    const amountOk = Number(payment?.transaction_amount) === PRICE_BRL;
    if (!payment?.id || !trans.qr_code || !amountOk) {
      if (payment?.id) await mpCancelPayment(payment.id).catch(() => {});
      await rpc('hotspot_fail_order', { p_order_id: orderId }).catch(() => {});
      console.error('create-payment: resposta inesperada do MP', payment?.id, payment?.status);
      return json({ error: 'O provedor não retornou o Pix. Tente novamente.' }, 502, headers);
    }

    await rpc('hotspot_attach_payment', {
      p_order_id: orderId,
      p_payment_id: String(payment.id),
      p_qr_code: trans.qr_code,
      p_qr_code_base64: trans.qr_code_base64 || null,
      p_ticket_url: trans.ticket_url || null,
      p_expires_at: expiresAt.toISOString(),
    });
    return json({
      order_id: orderId, read_token: r.read_token, status: 'pending',
      qr_code: trans.qr_code, qr_code_base64: trans.qr_code_base64 || null,
      ticket_url: trans.ticket_url || null,
      seconds_left: secondsLeft(expiresAt.toISOString()),
    }, 200, headers);
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.message }, error.status, headers);
    console.error('create-payment:', String(error), orderId || '');
    return json({ error: 'Erro interno ao criar pagamento.' }, 500, headers);
  }
}

Deno.serve(handler);
