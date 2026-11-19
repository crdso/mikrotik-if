// Fluxos ponta a ponta SIMULADOS: portal -> create-payment -> Mercado Pago (simulado)
// -> webhook -> router-sync <- modelo do roteador. Banco real (PGlite).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, signedWebhook, ENV, MAC_A, MAC_B } from './helpers/harness.mjs';
import { RouterSim } from './helpers/router-sim.mjs';

let h; let router;
const H5 = 5 * 3600;
before(async () => { h = await createHarness(); });
after(async () => { await h.close(); });
beforeEach(async () => {
  await h.q('delete from public.hotspot_orders');
  await h.q('update public.hotspot_router_state set last_seen_at = null, last_ack_at = null');
  h.mp.reset(); h.state.failRpc = null;
  router = new RouterSim(h);
});

test('E2E: caminho feliz — pagar libera 5h, ao esgotar corta', async () => {
  const created = (await h.createPix(MAC_A)).data;
  assert.equal((await h.status(created)).data.status, 'pending');
  await router.poll();
  assert.equal(router.canBrowse(MAC_A), false, 'antes de pagar não há acesso');

  const pid = [...h.mp.payments.keys()].at(-1);
  h.mp.approve(pid);
  assert.equal((await h.webhook(pid)).data.result, 'paid');
  let s = (await h.status(created)).data;
  assert.equal(s.status, 'paid'); assert.equal(s.internet_ready, false, 'pago mas roteador ainda não liberou');

  await router.poll();
  assert.equal(router.canBrowse(MAC_A), true);
  assert.equal(router.remaining(MAC_A), H5);
  s = (await h.status(created)).data;
  assert.equal(s.internet_ready, true);

  assert.equal(router.use(MAC_A, 3 * 3600), 3 * 3600);
  assert.equal(router.canBrowse(MAC_A), true);
  assert.equal(router.use(MAC_A, 3 * 3600), 2 * 3600, 'só restavam 2h');
  assert.equal(router.canBrowse(MAC_A), false, 'bloqueio automático ao esgotar as 5h');
});

test('E2E: quem não pagou nunca é liberado (nem com webhook falso, adulterado ou valor errado)', async () => {
  const b = (await h.createPix(MAC_B)).data;
  const pid = [...h.mp.payments.keys()].at(-1);
  // webhooks fraudulentos
  await h.webhookHandler(signedWebhook({ dataId: pid, secret: 'chute' }));
  await h.webhookHandler(signedWebhook({ dataId: pid, omitSignature: true }));
  await h.webhook(pid); // assinado, mas MP diz "pending"
  h.mp.approve(pid); h.mp.get(pid).transaction_amount = 0.5;
  await h.webhook(pid);
  await router.poll();
  assert.equal(router.users.size, 0);
  assert.equal(router.canBrowse(MAC_B), false);
  assert.equal((await h.status(b)).data.status, 'pending');
});

test('E2E: ACK perdido (queda de internet) não duplica as 5h e é reenviado', async () => {
  const p = await h.payOrder(MAC_A);
  router.dropAcks = 1;
  await router.poll();                      // cria usuário, ACK se perde
  assert.equal(router.remaining(MAC_A), H5);
  assert.equal((await h.status(p.created)).data.internet_ready, false);
  await router.poll();                      // pedido volta; marcador evita somar; reenvia ACK
  await router.poll();
  assert.equal(router.remaining(MAC_A), H5, 'continua 5h, não 10h');
  assert.equal((await h.status(p.created)).data.internet_ready, true);
  assert.deepEqual(router.acks, [200]);
});

test('E2E: segunda compra ACUMULA o tempo restante; replays não somam', async () => {
  const first = await h.payOrder(MAC_A);
  await router.poll();
  router.use(MAC_A, 4 * 3600);              // sobra 1h
  const second = await h.payOrder(MAC_A);   // compra nova antes de acabar
  assert.notEqual(second.created.order_id, first.created.order_id);
  for (let i = 0; i < 3; i++) await router.poll();
  assert.equal(router.remaining(MAC_A), 6 * 3600, '1h restante + 5h novas');
  for (let i = 0; i < 3; i++) await h.webhook(second.paymentId); // replays do webhook
  await router.poll();
  assert.equal(router.remaining(MAC_A), 6 * 3600);
});

test('E2E: tempo esgotado e nova compra reabre o acesso', async () => {
  await h.payOrder(MAC_A); await router.poll();
  router.use(MAC_A, 99 * 3600);
  assert.equal(router.canBrowse(MAC_A), false);
  await h.payOrder(MAC_A); await router.poll();
  assert.equal(router.canBrowse(MAC_A), true);
  assert.equal(router.remaining(MAC_A), H5);
});

test('E2E: roteador offline — pagamento fica pendente de liberação e segue quando volta', async () => {
  const p = await h.payOrder(MAC_A);
  router.online = false;
  for (let i = 0; i < 4; i++) await router.poll();
  assert.equal(router.failedPolls, 4);
  let s = (await h.status(p.created)).data;
  assert.equal(s.status, 'paid'); assert.equal(s.internet_ready, false); assert.equal(s.router_online, false);
  router.online = true;
  await router.poll();
  s = (await h.status(p.created)).data;
  assert.equal(s.internet_ready, true); assert.equal(s.router_online, true);
});

test('E2E: backend/banco fora do ar não libera ninguém e não quebra o roteador', async () => {
  const p = await h.payOrder(MAC_A);
  h.state.failRpc = () => true;
  const r = await router.poll();
  assert.equal(r.ok, false); assert.equal(router.users.size, 0);
  h.state.failRpc = null;
  await router.poll();
  assert.equal(router.canBrowse(MAC_A), true);
  assert.equal((await h.status(p.created)).data.internet_ready, true);
});

test('E2E: 40 passageiros pagando ao mesmo tempo — cada um recebe o seu acesso, ninguém mais', async () => {
  const macs = Array.from({ length: 40 }, (_, i) => `AA:BB:CC:00:00:${String(i + 1).padStart(2, '0').toUpperCase()}`);
  // Pedidos criados em paralelo; pagamentos aprovados só para os 30 primeiros.
  const created = await Promise.all(macs.map((m) => h.createPix(m)));
  assert.ok(created.every((c) => c.status === 200), 'todos recebem Pix');
  assert.equal(new Set(created.map((c) => c.data.order_id)).size, 40);
  const ids = [...h.mp.payments.keys()];
  for (const id of ids.slice(0, 30)) h.mp.approve(id);
  await Promise.all(ids.slice(0, 30).map((id) => h.webhook(id)));
  for (let i = 0; i < 4; i++) await router.poll(); // o roteador recebe no máximo 10 pedidos por consulta
  assert.equal(router.users.size, 30);
  assert.equal(macs.filter((m) => router.canBrowse(m)).length, 30);
  const paidMacs = new Set(created.slice(0, 30).map((c, i) => macs[i]));
  for (const m of router.users.keys()) assert.ok(paidMacs.has(m));
  // Pull é limitado a 30 por vez; um segundo pagamento posterior também é atendido.
  const late = await h.payOrder('AA:BB:CC:00:01:01');
  await router.poll();
  assert.equal(router.canBrowse('AA:BB:CC:00:01:01'), true);
  assert.equal(late.webhook.data.result, 'paid');
});

test('E2E: muitos pedidos pagos pendentes são atendidos em lotes sucessivos de 10', async () => {
  for (let i = 0; i < 35; i++) {
    const mac = `AA:BB:CC:01:00:${String(i).padStart(2, '0')}`;
    await h.createPix(mac);
  }
  for (const id of h.mp.payments.keys()) h.mp.approve(id);
  for (const id of h.mp.payments.keys()) await h.webhook(id);
  await router.poll();
  assert.equal(router.users.size, 10);
  for (let i = 0; i < 3; i++) await router.poll();
  assert.equal(router.users.size, 35);
});

test('E2E: Pix expirou e o passageiro pagou no limite — ainda recebe o acesso', async () => {
  const created = (await h.createPix(MAC_A)).data;
  const pid = [...h.mp.payments.keys()].at(-1);
  await h.q("update public.hotspot_orders set expires_at = now() - interval '10 minutes'");
  assert.equal((await h.status(created)).data.status, 'expired');
  h.mp.approve(pid); await h.webhook(pid); await router.poll();
  assert.equal(router.canBrowse(MAC_A), true);
});

test('E2E: estorno antes da liberação impede o acesso; depois da liberação fica registrado', async () => {
  const early = await h.payOrder(MAC_A);
  h.mp.set(early.paymentId, 'refunded', 'refunded');
  assert.equal((await h.webhook(early.paymentId)).data.result, 'refunded');
  await router.poll();
  assert.equal(router.canBrowse(MAC_A), false);

  const late = await h.payOrder(MAC_B); await router.poll();
  h.mp.set(late.paymentId, 'refunded', 'refunded');
  const r = await h.webhook(late.paymentId);
  assert.equal(r.data.result, 'refunded');
  assert.equal((await h.order(late.created.order_id)).payment_status, 'refunded');
  assert.equal(router.canBrowse(MAC_B), true, 'LIMITAÇÃO CONHECIDA: o acesso já concedido não é revogado automaticamente');
});

test('E2E: chave do roteador nunca é aceita nos endpoints do navegador e vice-versa', async () => {
  const created = (await h.createPix(MAC_A)).data;
  const { req, read, FN_BASE } = await import('./helpers/harness.mjs');
  const viaRouter = await read(await h.paymentStatus(req(`${FN_BASE}/payment-status?id=${created.order_id}&token=${created.read_token}`, { headers: h.routerHeaders, origin: null })));
  assert.equal(viaRouter.status, 403, 'sem Origin do site o endpoint do navegador recusa');
  const viaBrowser = await read(await h.routerSync(req(`${FN_BASE}/router-sync`, { origin: ENV.SITE_ORIGIN })));
  assert.equal(viaBrowser.status, 401, 'o navegador não tem a chave do roteador');
});
