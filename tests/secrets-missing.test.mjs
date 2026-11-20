// Comportamento SEGURO quando segredos ou configurações ainda não foram cadastrados:
// nada pode liberar internet, nada vaza, e cada falha é fechada (recusa), nunca aberta.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, signedWebhook, req, read, ENV, FN_BASE, MAC_A } from './helpers/harness.mjs';

let h;
before(async () => { h = await createHarness(); await h.useLegacyPlan(); }); // modelo antigo de horas (pedidos históricos)
after(async () => { await h.close(); });
beforeEach(async () => {
  await h.q('delete from public.hotspot_orders');
  h.mp.reset(); h.state.failRpc = null; h.state.rpcCalls.length = 0;
  Object.assign(process.env, ENV);
});

async function without(names, fn) {
  const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  for (const n of names) delete process.env[n];
  try { return await fn(); } finally { Object.assign(process.env, saved); }
}
const noPaidOrders = async () => assert.equal((await h.orders()).filter((o) => o.payment_status === 'paid').length, 0);

test('sem ROUTER_SHARED_KEY: roteador nunca é autenticado (401 sem chave, 500 com chave) e nada é lido', async () => {
  await h.payOrder(MAC_A); h.state.rpcCalls.length = 0;
  await without(['ROUTER_SHARED_KEY'], async () => {
    assert.equal((await h.routerPull(null, 'text')).status, 401);
    const withKey = await h.routerPull('qualquer-chave', 'text');
    assert.equal(withKey.status, 500); assert.doesNotMatch(withKey.text ?? '', /G AA:/);
    assert.equal((await h.routerAckForm('00000000-0000-4000-8000-000000000000', MAC_A, 'qualquer-chave')).status, 500);
    assert.equal((await h.routerRaw('?ping=1')).text, 'pong\n', 'o ping público continua disponível');
  });
  assert.deepEqual(h.state.rpcCalls, [], 'nenhuma consulta ao banco sem autenticação válida');
});

test('sem MP_WEBHOOK_SECRET: webhook nunca marca pagamento (401 sem assinatura, 500 com assinatura)', async () => {
  const created = (await h.createPix(MAC_A)).data;
  const pid = [...h.mp.payments.keys()].at(-1); h.mp.approve(pid);
  await without(['MP_WEBHOOK_SECRET'], async () => {
    assert.equal((await read(await h.webhookHandler(signedWebhook({ dataId: pid, omitSignature: true })))).status, 401);
    assert.equal((await h.webhook(pid)).status, 500);
  });
  await noPaidOrders();
  assert.equal((await h.order(created.order_id)).payment_status, 'pending');
});

test('sem MP_ACCESS_TOKEN: não gera Pix (502), pedido fica failed, ninguém é liberado', async () => {
  await without(['MP_ACCESS_TOKEN'], async () => {
    const r = await h.createPix(MAC_A);
    assert.equal(r.status, 502);
    assert.doesNotMatch(JSON.stringify(r.data), /token|Missing secret/i);
  });
  assert.equal((await h.orders())[0].payment_status, 'failed');
  await noPaidOrders();
  assert.equal(h.mp.creates().length, 0);
});

test('sem MP_ACCESS_TOKEN: a consulta de status continua respondendo e nunca promove a "paid"', async () => {
  const created = (await h.createPix(MAC_A)).data;
  const pid = [...h.mp.payments.keys()].at(-1); h.mp.approve(pid);   // pago no MP, mas o servidor não consegue confirmar
  await without(['MP_ACCESS_TOKEN'], async () => {
    const r = await h.status(created);
    assert.equal(r.status, 200); assert.equal(r.data.status, 'pending');
  });
  await noPaidOrders();
});

test('sem SITE_ORIGIN: endpoints do navegador recusam tudo (403), sem CORS e sem tocar no banco/MP', async () => {
  await without(['SITE_ORIGIN'], async () => {
    const pre = await h.createPayment(req(`${FN_BASE}/create-payment`, { method: 'OPTIONS' }));
    assert.equal(pre.headers.get('access-control-allow-origin'), null);
    assert.equal((await h.createPix(MAC_A)).status, 403);
    assert.equal((await read(await h.paymentStatus(req(`${FN_BASE}/payment-status?id=${ENV.SITE_ORIGIN}&token=x`)))).status, 403);
  });
  assert.deepEqual(h.state.rpcCalls, []); assert.equal(h.mp.calls.length, 0);
});

test('sem credenciais do Supabase: falha com 500 genérico, sem criar nada', async () => {
  await without(['SUPABASE_SERVICE_ROLE_KEY'], async () => {
    const r = await h.createPix(MAC_A);
    assert.equal(r.status, 500); assert.doesNotMatch(JSON.stringify(r.data), /credentials|service_role/i);
  });
  await without(['SUPABASE_URL'], async () => assert.equal((await h.createPix(MAC_A)).status, 500));
  assert.equal(h.mp.creates().length, 0);
});

test('nenhum segredo ausente produz resposta 2xx que autorize internet', async () => {
  await h.payOrder(MAC_A);
  await without(['ROUTER_SHARED_KEY', 'MP_WEBHOOK_SECRET', 'MP_ACCESS_TOKEN', 'SITE_ORIGIN'], async () => {
    const attempts = [
      await h.routerPull(null, 'text'), await h.routerPull('x', 'text'), await h.routerAckForm('00000000-0000-4000-8000-000000000000', MAC_A, 'x'),
      await h.createPix(MAC_A), await h.webhook('1'),
    ];
    for (const a of attempts) assert.ok(a.status >= 400, `status ${a.status} inesperado`);
  });
});
