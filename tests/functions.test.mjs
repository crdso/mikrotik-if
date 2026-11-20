// Testes das 4 Edge Functions (código de produção) com banco Postgres real (PGlite)
// e Mercado Pago SIMULADO. Camada: HTTP/handlers.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, signedWebhook, req, read, ENV, FN_BASE, MAC_A, MAC_B } from './helpers/harness.mjs';

let h;
before(async () => { h = await createHarness(); });
after(async () => { await h.close(); });
beforeEach(async () => {
  await h.q('delete from public.hotspot_orders');
  await h.q('update public.hotspot_router_state set last_seen_at = null, last_ack_at = null');
  h.mp.reset(); h.state.failRpc = null; h.state.rpcCalls.length = 0;
  process.env.SITE_ORIGIN = ENV.SITE_ORIGIN;
});

const lastPaymentId = () => [...h.mp.payments.keys()].at(-1);
const createReq = (body, o = {}) => req(`${FN_BASE}/create-payment`, { method: 'POST', body, ...o });
const sendWebhook = async (request) => read(await h.webhookHandler(request));
async function pendingOrder(mac = MAC_A) {
  const order = (await h.createPix(mac)).data;
  return { order, paymentId: lastPaymentId() };
}

// ============================== create-payment ==============================
test('create-payment: devolve Pix e envia ao MP exatamente R$ 5 com chave de idempotência', async () => {
  const r = await h.createPix(MAC_A);
  assert.equal(r.status, 200);
  assert.equal(r.data.status, 'pending');
  assert.match(r.data.qr_code, /^0002/);
  assert.ok(r.data.qr_code_base64);
  assert.ok(r.data.seconds_left > 1700 && r.data.seconds_left <= 1800);
  assert.equal(h.mp.creates().length, 1);
  const c = h.mp.creates()[0];
  assert.equal(c.body.transaction_amount, 5);
  assert.equal(c.body.payment_method_id, 'pix');
  assert.equal(c.body.external_reference, r.data.order_id);
  assert.equal(c.headers['x-idempotency-key'], r.data.order_id);
  assert.equal(c.body.notification_url, `${ENV.SUPABASE_URL}/functions/v1/mp-webhook`);
  assert.match(c.body.date_of_expiration, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}-03:00$/);
  const row = await h.order(r.data.order_id);
  assert.equal(row.payment_status, 'pending'); assert.equal(row.device_mac, MAC_A); assert.equal(row.payment_id, lastPaymentId());
  assert.equal(r.headers.get('access-control-allow-origin'), ENV.SITE_ORIGIN);
});

test('create-payment: o navegador NÃO consegue alterar preço, descrição ou meio de pagamento', async () => {
  const r = await h.createPix(MAC_A, 'a@b.co', { amount: 0.01, transaction_amount: 0.01, price: 1, description: 'x', payment_method_id: 'credit_card', external_reference: 'hack' });
  assert.equal(r.status, 200);
  const c = h.mp.creates()[0];
  assert.equal(c.body.transaction_amount, 5);
  assert.equal(c.body.payment_method_id, 'pix');
  assert.equal(c.body.description, 'Wifi a Bordo - 5 horas');
  assert.equal(c.body.external_reference, r.data.order_id);
});

test('create-payment: origem proibida, ausente ou método errado não chega ao banco nem ao MP', async () => {
  const bad = await read(await h.createPayment(createReq({ mac: MAC_A, email: 'a@b.co' }, { origin: 'https://evil.example' })));
  assert.equal(bad.status, 403);
  const none = await read(await h.createPayment(createReq({ mac: MAC_A, email: 'a@b.co' }, { origin: null })));
  assert.equal(none.status, 403);
  const get = await read(await h.createPayment(req(`${FN_BASE}/create-payment`)));
  assert.equal(get.status, 405);
  assert.equal(h.mp.calls.length, 0);
  assert.equal((await h.orders()).length, 0);
  assert.equal(bad.headers.get('access-control-allow-origin'), null);
});

test('create-payment: CORS preflight só para a origem do site; várias origens separadas por vírgula', async () => {
  const ok = await h.createPayment(req(`${FN_BASE}/create-payment`, { method: 'OPTIONS' }));
  assert.equal(ok.status, 204); assert.equal(ok.headers.get('access-control-allow-origin'), ENV.SITE_ORIGIN);
  const evil = await h.createPayment(req(`${FN_BASE}/create-payment`, { method: 'OPTIONS', origin: 'https://evil.example' }));
  assert.equal(evil.headers.get('access-control-allow-origin'), null);
  process.env.SITE_ORIGIN = 'https://a.example/, https://b.example';
  const second = await h.createPayment(req(`${FN_BASE}/create-payment`, { method: 'OPTIONS', origin: 'https://b.example' }));
  assert.equal(second.headers.get('access-control-allow-origin'), 'https://b.example');
  process.env.SITE_ORIGIN = '';
  const closed = await read(await h.createPayment(createReq({ mac: MAC_A, email: 'a@b.co' })));
  assert.equal(closed.status, 403, 'sem SITE_ORIGIN configurado ninguém é aceito');
});

test('create-payment: entradas inválidas -> 400/413 sem criar pedido', async () => {
  for (const [body, status] of [
    [{ mac: 'zz', email: 'a@b.co' }, 400], [{ email: 'a@b.co' }, 400], [{ mac: MAC_A, email: 'sem-arroba' }, 400],
    [{ mac: MAC_A, email: `${'a'.repeat(250)}@b.co` }, 400], [{ mac: MAC_A }, 400], ['{nao-json', 400],
    [JSON.stringify({ mac: MAC_A, email: 'a@b.co', lixo: 'x'.repeat(5000) }), 413],
  ]) {
    const r = await read(await h.createPayment(createReq(body)));
    assert.equal(r.status, status, JSON.stringify(body).slice(0, 60));
  }
  assert.equal((await h.orders()).length, 0); assert.equal(h.mp.calls.length, 0);
});

test('create-payment: duplo clique / reenvio devolve o MESMO Pix (uma cobrança só)', async () => {
  const a = await h.createPix(MAC_A);
  const b = await h.createPix(MAC_A);
  assert.equal(b.status, 200); assert.equal(b.data.order_id, a.data.order_id); assert.equal(b.data.reused, true);
  assert.equal(b.data.qr_code, a.data.qr_code);
  assert.equal(h.mp.creates().length, 1);
  assert.equal((await h.orders()).length, 1);
  const other = await h.createPix(MAC_B);
  assert.notEqual(other.data.order_id, a.data.order_id);
});

test('create-payment: falha no MP -> 502, pedido failed, nenhuma cobrança; nova tentativa funciona', async () => {
  h.mp.failCreate = true;
  const r = await h.createPix(MAC_A);
  assert.equal(r.status, 502);
  assert.doesNotMatch(JSON.stringify(r.data), /TEST-|token|internal error/i);
  assert.equal((await h.orders())[0].payment_status, 'failed');
  h.mp.failCreate = false;
  const again = await h.createPix(MAC_A);
  assert.equal(again.status, 200);
});

test('create-payment: se o MP devolver valor diferente de R$ 5, cancela o Pix e falha o pedido', async () => {
  h.mp.createTamper = (p) => { p.transaction_amount = 1; };
  const r = await h.createPix(MAC_A);
  assert.equal(r.status, 502);
  assert.equal(h.mp.get(lastPaymentId()).status, 'cancelled');
  assert.equal((await h.orders())[0].payment_status, 'failed');
});

test('create-payment: resposta do MP sem QR Code -> 502 e Pix cancelado', async () => {
  h.mp.createTamper = (p) => { delete p.point_of_interaction; };
  const r = await h.createPix(MAC_A);
  assert.equal(r.status, 502);
  assert.equal(h.mp.get(lastPaymentId()).status, 'cancelled');
});

test('create-payment: limite de tentativas por aparelho -> 429', async () => {
  h.mp.failCreate = true;
  for (let i = 0; i < 5; i++) assert.equal((await h.createPix(MAC_A)).status, 502);
  const r = await h.createPix(MAC_A);
  assert.equal(r.status, 429); assert.equal(r.headers.get('retry-after'), '60');
});

test('create-payment: já pagou e aguarda o roteador -> status paid, sem novo Pix', async () => {
  const paid = await h.payOrder(MAC_A);
  const again = await h.createPix(MAC_A);
  assert.equal(again.status, 200); assert.equal(again.data.status, 'paid');
  assert.equal(again.data.order_id, paid.created.order_id);
  assert.equal(h.mp.creates().length, 1);
});

test('create-payment: erro do banco -> 500 genérico, sem vazar detalhes', async () => {
  h.state.failRpc = () => true;
  const r = await h.createPix(MAC_A);
  assert.equal(r.status, 500);
  assert.doesNotMatch(JSON.stringify(r.data), /db down|rpc|proj\.supabase/i);
});

// ================================ mp-webhook ================================
test('webhook: assinatura ausente, malformada, errada, segredo errado ou data.id adulterado -> 401', async () => {
  const { paymentId } = await pendingOrder();
  h.mp.approve(paymentId);
  const cases = {
    ausente: signedWebhook({ dataId: paymentId, omitSignature: true }),
    malformada: signedWebhook({ dataId: paymentId, sigOverride: 'lixo' }),
    'sem v1': signedWebhook({ dataId: paymentId, sigOverride: 'ts=123' }),
    'v1 errado': signedWebhook({ dataId: paymentId, sigOverride: `ts=123,v1=${'0'.repeat(64)}` }),
    'segredo errado': signedWebhook({ dataId: paymentId, secret: 'outro-segredo' }),
    'data.id adulterado': signedWebhook({ dataId: paymentId, queryId: '123456' }),
  };
  for (const [name, request] of Object.entries(cases)) {
    assert.equal((await sendWebhook(request)).status, 401, name);
  }
  assert.equal((await h.orders())[0].payment_status, 'pending', 'nada foi aplicado');
  assert.equal(h.mp.gets().length, 0, 'sem assinatura válida o MP nem é consultado');
});

test('webhook: método diferente de POST -> 405', async () => {
  const r = await read(await h.webhookHandler(req(`${FN_BASE}/mp-webhook?data.id=1`, { origin: null })));
  assert.equal(r.status, 405);
});

test('webhook: assinatura válida + pagamento ainda pendente no MP -> pedido continua pendente', async () => {
  const { order, paymentId } = await pendingOrder();
  const r = await h.webhook(paymentId);
  assert.equal(r.status, 200); assert.equal(r.data.result, 'noop');
  assert.equal((await h.order(order.order_id)).payment_status, 'pending');
});

test('webhook: o corpo NÃO é confiável (corpo diz approved, MP diz pending)', async () => {
  const { order, paymentId } = await pendingOrder();
  const base = signedWebhook({ dataId: paymentId });
  const forged = new Request(base.url, { method: 'POST', headers: base.headers,
    body: JSON.stringify({ type: 'payment', status: 'approved', data: { id: paymentId, status: 'approved', transaction_amount: 5 } }) });
  const r = await sendWebhook(forged);
  assert.equal(r.status, 200);
  assert.equal((await h.order(order.order_id)).payment_status, 'pending');
  assert.equal(h.mp.gets().length, 1, 'o pagamento foi relido na API do MP');
});

test('webhook: aprovado -> paid; repetição (5x) é idempotente e não altera a data de pagamento', async () => {
  const { order, paymentId } = await pendingOrder();
  h.mp.approve(paymentId);
  const first = await h.webhook(paymentId);
  assert.equal(first.status, 200); assert.equal(first.data.result, 'paid');
  const paidAt = String((await h.order(order.order_id)).paid_at);
  for (let i = 0; i < 5; i++) assert.equal((await h.webhook(paymentId)).data.result, 'already_paid');
  assert.equal(String((await h.order(order.order_id)).paid_at), paidAt);
  assert.equal((await h.orders()).filter((o) => o.payment_status === 'paid').length, 1);
});

test('webhook: notificação antiga mas com assinatura válida é aceita (reenvio legítimo do MP)', async () => {
  const { order, paymentId } = await pendingOrder();
  h.mp.approve(paymentId);
  const r = await h.webhook(paymentId, { ts: Math.floor(Date.now() / 1000) - 3 * 3600 });
  assert.equal(r.data.result, 'paid');
  assert.equal((await h.order(order.order_id)).payment_status, 'paid');
});

test('webhook: aprovado com VALOR diferente de R$ 5 (ou moeda/meio errados) nunca libera', async () => {
  for (const [patch, label] of [[{ transaction_amount: 1 }, 'R$ 1'], [{ transaction_amount: 4.99 }, 'R$ 4,99'],
    [{ transaction_amount: 50 }, 'R$ 50'], [{ currency_id: 'USD' }, 'moeda'], [{ payment_method_id: 'visa' }, 'meio']]) {
    await h.q('delete from public.hotspot_orders');
    const { order, paymentId } = await pendingOrder(MAC_A);
    h.mp.approve(paymentId); Object.assign(h.mp.get(paymentId), patch);
    const r = await h.webhook(paymentId);
    assert.equal(r.data.result, 'invalid_payment', label);
    assert.equal((await h.order(order.order_id)).payment_status, 'pending', label);
    assert.deepEqual((await h.routerPull()).data.orders, [], label);
  }
});

test('webhook: pagamento apontando para o pedido de OUTRO aparelho é rejeitado (payment_mismatch)', async () => {
  const a = await pendingOrder(MAC_A); const b = await pendingOrder(MAC_B);
  h.mp.approve(a.paymentId);
  h.mp.get(a.paymentId).external_reference = b.order.order_id;
  const r = await h.webhook(a.paymentId);
  assert.equal(r.data.result, 'payment_mismatch');
  assert.deepEqual((await h.orders()).map((o) => o.payment_status), ['pending', 'pending']);
});

test('webhook: external_reference inválida, tipo não-payment e pagamento inexistente são ignorados com 200', async () => {
  const a = await pendingOrder();
  h.mp.approve(a.paymentId); h.mp.get(a.paymentId).external_reference = 'nao-e-uuid';
  assert.equal((await h.webhook(a.paymentId)).data.ignored, 'no_order_reference');
  const before = h.mp.gets().length;
  const other = await sendWebhook(signedWebhook({ dataId: '777', type: 'merchant_order' }));
  assert.equal(other.status, 200); assert.equal(other.data.ignored, 'not_payment');
  assert.equal(h.mp.gets().length, before, 'tipo não-payment não consulta o MP');
  const missing = await h.webhook('123456'); // notificação de teste do painel do MP
  assert.equal(missing.status, 200); assert.equal(missing.data.ignored, 'payment_not_found');
  assert.equal((await h.orders())[0].payment_status, 'pending');
});

test('webhook: indisponibilidade do MP ou do banco -> 500 (o MP tentará de novo)', async () => {
  const { paymentId } = await pendingOrder();
  h.mp.approve(paymentId);
  h.mp.failGet = true;
  assert.equal((await h.webhook(paymentId)).status, 500);
  h.mp.failGet = false;
  h.state.failRpc = (n) => n === 'hotspot_apply_payment';
  assert.equal((await h.webhook(paymentId)).status, 500);
  h.state.failRpc = null;
  assert.equal((await h.webhook(paymentId)).data.result, 'paid', 'a repetição seguinte conclui');
});

test('webhook: rejeitado/cancelado/expirado/estornado são tratados sem liberar acesso', async () => {
  const rej = await pendingOrder(MAC_A); h.mp.set(rej.paymentId, 'rejected', 'cc_rejected_other');
  assert.equal((await h.webhook(rej.paymentId)).data.result, 'rejected');
  assert.equal((await h.order(rej.order.order_id)).payment_status, 'failed');

  const exp = await pendingOrder(MAC_B); h.mp.set(exp.paymentId, 'cancelled', 'expired');
  await h.webhook(exp.paymentId);
  assert.equal((await h.order(exp.order.order_id)).payment_status, 'expired');

  const ref = await pendingOrder('AA:BB:CC:DD:EE:03'); h.mp.approve(ref.paymentId);
  await h.webhook(ref.paymentId);
  h.mp.set(ref.paymentId, 'refunded', 'refunded');
  assert.equal((await h.webhook(ref.paymentId)).data.result, 'refunded');
  assert.equal((await h.order(ref.order.order_id)).payment_status, 'refunded');
  assert.deepEqual((await h.routerPull()).data.orders, [], 'estornado não segue para o roteador');
});

test('webhook: pagamento aprovado DEPOIS de o pedido expirar ainda libera (cliente pagou no limite)', async () => {
  const { order, paymentId } = await pendingOrder();
  await h.q("update public.hotspot_orders set expires_at = now() - interval '10 minutes' where id=$1", [order.order_id]);
  assert.equal((await h.status(order)).data.status, 'expired');
  h.mp.approve(paymentId);
  assert.equal((await h.webhook(paymentId)).data.result, 'paid');
  assert.equal((await h.status(order)).data.status, 'paid');
});

test('verifyMpSignature: manifesto sem request-id, hex maiúsculo e v1 curto', async () => {
  const { createHmac } = await import('node:crypto');
  const v1 = createHmac('sha256', 's3cret').update('id:abc;ts:99;').digest('hex');
  const verify = h.common.verifyMpSignature;
  assert.equal(await verify({ signatureHeader: `ts=99,v1=${v1}`, requestId: '', dataId: 'ABC', secret: 's3cret' }), true, 'id em minúsculo, sem request-id');
  assert.equal(await verify({ signatureHeader: `ts=99,v1=${v1.toUpperCase()}`, requestId: '', dataId: 'abc', secret: 's3cret' }), true);
  assert.equal(await verify({ signatureHeader: `ts=99,v1=${v1.slice(0, 40)}`, requestId: '', dataId: 'abc', secret: 's3cret' }), false);
  assert.equal(await verify({ signatureHeader: `ts=99,v1=${v1}`, requestId: 'x', dataId: 'abc', secret: 's3cret' }), false, 'request-id muda o manifesto');
  assert.equal(await verify({ signatureHeader: `ts=99,v1=${v1}`, requestId: '', dataId: '', secret: 's3cret' }), false);
  assert.equal(await verify({ signatureHeader: `ts=99,v1=${v1}`, requestId: '', dataId: 'abc', secret: '' }), false);
});

// ============================== payment-status ==============================
test('payment-status: validações de origem, id e token', async () => {
  const { order } = await pendingOrder();
  const url = (id, token) => `${FN_BASE}/payment-status?id=${id}&token=${token}`;
  assert.equal((await read(await h.paymentStatus(req(url(order.order_id, order.read_token), { origin: 'https://evil.example' })))).status, 403);
  assert.equal((await read(await h.paymentStatus(req(`${FN_BASE}/payment-status`)))).status, 400);
  assert.equal((await read(await h.paymentStatus(req(url('x', 'y'))))).status, 400);
  assert.equal((await read(await h.paymentStatus(req(url(order.order_id, order.order_id))))).status, 404, 'token errado');
  assert.equal((await read(await h.paymentStatus(req(url('00000000-0000-0000-0000-000000000000', order.read_token))))).status, 404);
  assert.equal((await read(await h.paymentStatus(req(url(order.order_id, order.read_token), { method: 'POST' })))).status, 405);
});

test('payment-status: resposta pública mínima (sem MAC, payment_id ou token)', async () => {
  const { order } = await pendingOrder();
  const r = await h.status(order);
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.data).sort(), ['device_credit', 'internet_ready', 'router_online', 'seconds_left', 'status']);
  assert.equal(r.data.device_credit, null, 'pedido ainda não liberado não tem estado de crédito');
  assert.equal(r.data.status, 'pending'); assert.equal(r.data.internet_ready, false);
  assert.doesNotMatch(JSON.stringify(r.data), /AA:BB|payment_id|read_token/);
});

test('payment-status: reconcilia com o MP quando o webhook não chegou (sem webhook!)', async () => {
  const { order, paymentId } = await pendingOrder();
  h.mp.approve(paymentId); // pago, mas nenhum webhook foi entregue
  const r = await h.status(order);
  assert.equal(r.data.status, 'paid');
  assert.equal(h.mp.gets().length, 1);
  assert.equal((await h.routerPull()).data.orders.length, 1, 'o roteador já enxerga o pedido');
});

test('payment-status: consulta ao MP é limitada (várias leituras rápidas -> 1 chamada)', async () => {
  const { order } = await pendingOrder();
  for (let i = 0; i < 6; i++) assert.equal((await h.status(order)).data.status, 'pending');
  assert.equal(h.mp.gets().length, 1);
});

test('payment-status: MP fora do ar não derruba a consulta; pagamento com referência trocada é ignorado', async () => {
  const a = await pendingOrder(MAC_A);
  h.mp.failGet = true;
  assert.equal((await h.status(a.order)).status, 200);
  h.mp.failGet = false;
  const b = await pendingOrder(MAC_B);
  h.mp.approve(b.paymentId); h.mp.get(b.paymentId).external_reference = a.order.order_id;
  await h.q('update public.hotspot_orders set last_mp_check_at = null');
  assert.equal((await h.status(b.order)).data.status, 'pending', 'external_reference não confere com o pedido consultado');
});

test('payment-status: expirado e internet_ready após o ACK do roteador', async () => {
  const exp = await pendingOrder(MAC_A);
  await h.q("update public.hotspot_orders set expires_at = now() - interval '5 minutes' where id=$1", [exp.order.order_id]);
  assert.equal((await h.status(exp.order)).data.status, 'expired');

  const paid = await h.payOrder(MAC_B);
  let s = (await h.status(paid.created)).data;
  assert.equal(s.status, 'paid'); assert.equal(s.internet_ready, false);
  await h.routerPull();
  assert.equal((await h.status(paid.created)).data.router_online, true);
  assert.equal((await h.routerAck(paid.created.order_id, MAC_B)).status, 200);
  s = (await h.status(paid.created)).data;
  assert.equal(s.internet_ready, true);
});

// ================================ router-sync ================================
test('router-sync: sem chave, chave errada ou de outro tamanho -> 401 sem tocar no banco', async () => {
  await h.payOrder(MAC_A); h.state.rpcCalls.length = 0;
  for (const key of [null, '', 'errada', ENV.ROUTER_SHARED_KEY + 'x', ENV.ROUTER_SHARED_KEY.slice(0, -1)]) {
    assert.equal((await h.routerPull(key)).status, 401, String(key));
    assert.equal((await h.routerAck('00000000-0000-0000-0000-000000000000', MAC_A, key ?? '')).status, 401);
  }
  assert.deepEqual(h.state.rpcCalls, []);
});

test('router-sync GET: lista somente pedidos pagos ainda não confirmados e informa a duração', async () => {
  await pendingOrder(MAC_B); // pendente: não pode aparecer
  const paid = await h.payOrder(MAC_A);
  const r = await h.routerPull();
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.orders, [{ id: paid.created.order_id, mac: MAC_A, grant_seconds: 18000 }]);
});

test('router-sync POST: ACK idempotente; pedido não pago, MAC errado e entrada inválida são recusados', async () => {
  const pending = await pendingOrder(MAC_B);
  const paid = await h.payOrder(MAC_A);
  assert.equal((await h.routerAck(pending.order.order_id, MAC_B)).status, 409, 'pedido ainda pendente');
  assert.equal((await h.routerAck(paid.created.order_id, MAC_B)).status, 409, 'MAC errado');
  assert.equal((await h.routerAck('nao-uuid', MAC_A)).status, 400);
  assert.equal((await h.routerAck(paid.created.order_id, 'zz')).status, 400);
  const ok = await h.routerAck(paid.created.order_id, MAC_A);
  assert.deepEqual(ok.data, { ok: true, already: false });
  assert.deepEqual((await h.routerAck(paid.created.order_id, MAC_A)).data, { ok: true, already: true });
  assert.deepEqual((await h.routerPull()).data.orders, []);
  const bad = await read(await h.routerSync(req(`${FN_BASE}/router-sync`, { method: 'POST', headers: h.routerHeaders, body: '{ruim', origin: null })));
  assert.equal(bad.status, 400);
  const put = await read(await h.routerSync(req(`${FN_BASE}/router-sync`, { method: 'PUT', headers: h.routerHeaders, origin: null })));
  assert.equal(put.status, 405);
});
