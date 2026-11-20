// @ts-nocheck
// Cria (ou reaproveita) o Pix de um aparelho para o PLANO escolhido (hoje: "Internet para toda a viagem", R$ 25,00).
// Nunca cobra de novo quem já tem acesso ativo (pré-pago liberado pelo admin ou Pix anterior), está bloqueado ou
// teve o acesso revogado. Pix pendente do mesmo aparelho é REAPROVEITADO (fechar a janela não gera outra cobrança). Preço e duração são decididos aqui,
// no servidor, a partir do banco (hotspot_plans) e congelados no pedido; o navegador só envia o identificador
// do plano. O e-mail do passageiro continua obrigatório (exigência do Mercado Pago).
import {
  HttpError, MpError, PIX_TTL_MINUTES, SERVICE_NAME, browserAllowed, cleanName, cors, env, isUuid, json,
  mpCancelPayment, mpCreatePix, mpDate, mpGetPayment, normalizeMac, paymentApplyArgs, preflight, readJson,
  recordFees, registrationError, rpc, validEmail, validName,
} from '../_shared/common.ts';

function secondsLeft(expiresAt) {
  if (!expiresAt) return null;
  return Math.max(0, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000));
}

// Pix pendente de OUTRO plano: antes de cancelar, o estado é relido no Mercado Pago. Um pagamento aprovado
// nunca é cancelado nem perdido: ele é aplicado ao pedido antigo (que passa a "paid") e nenhum Pix novo é criado.
async function settleOldPix(orderId, paymentId) {
  let payment = await mpGetPayment(paymentId);
  if (String(payment?.id) !== String(paymentId) || String(payment?.external_reference) !== String(orderId)) {
    throw new HttpError(409, 'Não foi possível conferir o Pix anterior. Tente novamente.');
  }
  if (payment.status === 'pending') {
    await mpCancelPayment(paymentId).catch((e) => {
      console.error('create-payment: cancelamento do Pix anterior falhou', e instanceof MpError ? e.status : String(e));
    });
    payment = await mpGetPayment(paymentId); // confirma o estado FINAL (pode ter sido pago ao mesmo tempo)
  }
  await rpc('hotspot_apply_payment', paymentApplyArgs(orderId, payment));
  await recordFees(orderId, payment);
  if (['pending', 'in_process', 'authorized', 'in_mediation'].includes(payment.status)) {
    // O MP ainda não confirmou o cancelamento: o pedido antigo é encerrado AQUI para o passageiro poder trocar de plano.
    // Se ele for pago mesmo assim, o webhook/reconciliação aplica o pagamento (failed -> paid) e o acesso é liberado.
    await rpc('hotspot_apply_payment', { ...paymentApplyArgs(orderId, payment), p_mp_status: 'cancelled', p_mp_status_detail: 'troca_de_plano' });
  }
}

// Cortesia: 2 minutos de internet para abrir o app do banco e pagar (no máximo 1 a cada 60 min por aparelho).
// Falha aqui nunca impede o Pix.
async function trial(mac) {
  await rpc('hotspot_trial_grant', { p_mac: mac }).catch((e) => console.error('create-payment trial', String(e)));
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
    const planRaw = input?.plan_id == null ? '' : String(input.plan_id).trim();
    if (!mac) return json({ error: 'Dispositivo não identificado. Abra esta página pela tela de login da rede ' + SERVICE_NAME + '.' }, 400, headers);
    if (planRaw !== '' && !isUuid(planRaw)) return json({ error: 'Plano inválido.' }, 400, headers);
    const planId = planRaw === '' ? null : planRaw;

    // Nome e e-mail são obrigatórios. Se o pedido traz os dois, o cadastro é gravado/atualizado agora (validado no
    // servidor); se não traz, vale o cadastro já guardado no servidor para este aparelho (nunca o localStorage).
    if (input?.name !== undefined || input?.email !== undefined) {
      const name = cleanName(input?.name);
      const emailIn = String(input?.email ?? '').trim().toLowerCase();
      if (!validName(name)) return json({ error: 'Informe seu nome completo (nome e sobrenome).' }, 400, headers);
      if (!validEmail(emailIn)) return json({ error: 'Informe um e-mail válido.' }, 400, headers);
      const reg = await rpc('hotspot_register_passenger', { p_mac: mac, p_name: name, p_email: emailIn });
      const bad = registrationError(reg?.action, SERVICE_NAME);
      if (bad) return json({ error: bad[1], ...(bad[2] ? { retry: true } : {}) }, bad[0], bad[0] === 429 ? { ...headers, 'Retry-After': '60' } : headers);
    }

    let r = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      r = await rpc('hotspot_reserve_plan_order', { p_mac: mac, p_plan_id: planId });
      if (r?.action !== 'switch_needed') break;
      await settleOldPix(r.order_id, r.payment_id); // cancela (se comprovadamente pendente) ou aplica o pagamento aprovado
    }
    switch (r?.action) {
      case 'unknown_device':
        return json({ error: 'Não reconhecemos este aparelho na rede ' + SERVICE_NAME + '. Conecte-se à rede, aguarde alguns segundos e abra o portal pela tela de login.', retry: true }, 403, headers);
      case 'already_active':
        return json({ error: 'Este aparelho já tem acesso liberado para a viagem. Não é preciso pagar de novo.', already_active: true }, 409, headers);
      case 'blocked':
        return json({ error: 'Este aparelho está bloqueado. Procure o responsável pela internet.', blocked: true }, 403, headers);
      case 'revoked':
        return json({ error: 'O acesso deste aparelho foi encerrado. Procure o responsável pela internet.', revoked: true }, 403, headers);
      case 'registration_required':
        return json({ error: 'Identifique-se (nome completo e e-mail) para continuar.', registration_required: true }, 428, headers);
      case 'invalid_mac':
        return json({ error: 'Dispositivo inválido.' }, 400, headers);
      case 'plan_unavailable':
        return json({ error: 'Este plano não está disponível. Atualize a página e escolha outro.' }, 409, headers);
      case 'rate_limited':
        return json({ error: 'Muitas tentativas. Aguarde alguns minutos.' }, 429, { ...headers, 'Retry-After': '60' });
      case 'in_progress':
      case 'switch_needed':
        return json({ error: 'Seu Pix está sendo gerado. Aguarde alguns segundos.', retry: true }, 409, headers);
      case 'paid_waiting':
        return json({ order_id: r.order_id, read_token: r.read_token, status: 'paid' }, 200, headers);
      case 'existing':
        await trial(mac);
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
    // E-mail do cadastro do aparelho (obrigatório; enviado ao Mercado Pago como payer.email).
    const email = String((await rpc('hotspot_passenger_email', { p_mac: mac })) ?? '').trim();
    if (!validEmail(email)) {
      await rpc('hotspot_fail_order', { p_order_id: orderId }).catch(() => {});
      return json({ error: 'Identifique-se (nome completo e e-mail) para continuar.', registration_required: true }, 428, headers);
    }
    const amountCents = Number(r.amount_cents);
    const expiresAt = new Date(Date.now() + PIX_TTL_MINUTES * 60 * 1000);
    let payment;
    try {
      payment = await mpCreatePix({
        transaction_amount: amountCents / 100,
        description: `${SERVICE_NAME} - ${r.plan_name}`,
        payment_method_id: 'pix',
        payer: { email },
        external_reference: orderId,
        notification_url: `${env('SUPABASE_URL')}/functions/v1/mp-webhook`,
        // O Mercado Pago cancela na hora ("expired") Pix com prazo curto (5 min foi rejeitado em produção): ele recebe
        // 30 min; a validade de 5 min vale aqui (expires_at). Pago depois disso, o pagamento ainda é aplicado.
        date_of_expiration: mpDate(new Date(Date.now() + Math.max(PIX_TTL_MINUTES, 30) * 60 * 1000)),
      }, orderId); // X-Idempotency-Key = id do pedido
    } catch (e) {
      await rpc('hotspot_fail_order', { p_order_id: orderId }).catch(() => {});
      console.error('create-payment: MP create failed', e instanceof MpError ? e.status : String(e));
      return json({ error: 'Não foi possível gerar o Pix. Tente novamente.' }, 502, headers);
    }

    const trans = payment?.point_of_interaction?.transaction_data || {};
    const amountOk = Math.round(Number(payment?.transaction_amount) * 100) === amountCents;
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
    await trial(mac);
    return json({
      order_id: orderId, read_token: r.read_token, status: 'pending', trial_seconds: 120,
      qr_code: trans.qr_code, qr_code_base64: trans.qr_code_base64 || null,
      ticket_url: trans.ticket_url || null,
      seconds_left: secondsLeft(expiresAt.toISOString()),
      plan_name: r.plan_name, amount_cents: amountCents,
    }, 200, headers);
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.message }, error.status, headers);
    console.error('create-payment:', String(error), orderId || '');
    return json({ error: 'Erro interno ao criar pagamento.' }, 500, headers);
  }
}

Deno.serve(handler);
