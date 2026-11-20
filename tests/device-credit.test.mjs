// Aviso "Seu tempo de internet acabou": estado do crédito do aparelho, informado pelo MikroTik
// (modelo do script) e consultado pelo portal só com id + read_token. Banco real (PGlite).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, req, read, ENV, FN_BASE, MAC_A, MAC_B } from './helpers/harness.mjs';
import { RouterSim } from './helpers/router-sim.mjs';

let h; let router;
const H5 = 5 * 3600;
before(async () => { h = await createHarness(); });
after(async () => { await h.close(); });
beforeEach(async () => {
  await h.q('delete from public.hotspot_orders');
  await h.q('delete from public.hotspot_device_credit');
  await h.q('update public.hotspot_router_state set last_seen_at = null, last_ack_at = null');
  h.mp.reset(); h.state.failRpc = null; h.state.rpcCalls.length = 0;
  router = new RouterSim(h);
});
const credit = async (order) => (await h.status(order)).data.device_credit;
const deviceRows = () => h.q('select device_mac, exhausted_at is not null as exhausted from public.hotspot_device_credit order by device_mac');

test('usuário SEM compras: nada a mostrar (estado none; pedido pendente ou só pago não tem estado de crédito)', async () => {
  assert.equal((await h.rpc('hotspot_device_credit_state', { p_mac: MAC_A })), 'none');
  const pending = (await h.createPix(MAC_A)).data;
  assert.equal(await credit(pending), null, 'Pix gerado e não pago');
  const pid = [...h.mp.payments.keys()].at(-1); h.mp.approve(pid); await h.webhook(pid);
  assert.equal(await credit(pending), null, 'pago, mas o roteador ainda não liberou');
  assert.equal(await h.rpc('hotspot_device_credit_state', { p_mac: MAC_A }), 'none');
});

test('crédito ATIVO: liberado e usando — nunca aparece como esgotado', async () => {
  const p = await h.payOrder(MAC_A); await router.poll();
  assert.equal(await credit(p.created), 'active');
  router.use(MAC_A, 2 * 3600);
  for (let i = 0; i < 3; i++) await router.poll();
  assert.equal(await credit(p.created), 'active');
  assert.deepEqual(router.expReports, [], 'nenhum aviso enquanto há crédito');
  assert.deepEqual(await deviceRows(), []);
});

test('crédito RECÉM-ESGOTADO: o roteador avisa UMA vez e o portal passa a ver "exhausted"', async () => {
  const p = await h.payOrder(MAC_A); await router.poll();
  router.use(MAC_A, 99 * 3600);
  assert.equal(router.canBrowse(MAC_A), false, 'o MikroTik continua sendo quem bloqueia');
  for (let i = 0; i < 4; i++) await router.poll();
  assert.equal(await credit(p.created), 'exhausted');
  assert.equal(router.expReports.length, 1, 'avisa uma vez, não a cada consulta');
  assert.deepEqual(router.expReports[0].macs, [MAC_A]);
  assert.deepEqual(await deviceRows(), [{ device_mac: MAC_A, exhausted: true }]);
});

test('COMPROU MAIS 5 horas depois de esgotar: volta a active, soma só o novo crédito, sem duplicar', async () => {
  const first = await h.payOrder(MAC_A); await router.poll();
  router.use(MAC_A, 99 * 3600); await router.poll();
  assert.equal(await credit(first.created), 'exhausted');
  const second = await h.payOrder(MAC_A); await router.poll(); await router.poll();
  assert.equal(await credit(second.created), 'active');
  assert.equal(await credit(first.created), 'active', 'o token do pedido antigo também vê o aparelho com crédito novo');
  assert.equal(router.remaining(MAC_A), H5, '5 h consumidas + 5 h novas = restam 5 h (nada some, nada duplica)');
  assert.equal(router.canBrowse(MAC_A), true);
  await router.poll(); assert.equal(router.expReports.length, 1, 'sem novo aviso enquanto há crédito');
  // esgota de novo: novo aviso (segundo esgotamento)
  router.use(MAC_A, 99 * 3600); await router.poll();
  assert.equal(router.expReports.length, 2); assert.equal(await credit(second.created), 'exhausted');
});

test('compra ANTES de esgotar: acumula e nunca é mostrada como esgotada', async () => {
  const first = await h.payOrder(MAC_A); await router.poll();
  router.use(MAC_A, 4 * 3600);                       // sobra 1 h
  const second = await h.payOrder(MAC_A); await router.poll();
  assert.equal(router.remaining(MAC_A), 6 * 3600);
  assert.equal(await credit(first.created), 'active'); assert.equal(await credit(second.created), 'active');
  assert.deepEqual(router.expReports, []);
});

test('DOIS dispositivos: estados independentes; o token de um não revela o outro', async () => {
  const a = await h.payOrder(MAC_A); const b = await h.payOrder(MAC_B); await router.poll();
  router.use(MAC_A, 99 * 3600); router.use(MAC_B, 3600); await router.poll();
  assert.equal(await credit(a.created), 'exhausted'); assert.equal(await credit(b.created), 'active');
  const view = (await h.status(b.created)).data;
  assert.doesNotMatch(JSON.stringify(view), /AA:BB|payment|token|order/i, 'resposta pública sem MAC, pagamento ou token');
  assert.deepEqual(await deviceRows(), [{ device_mac: MAC_A, exhausted: true }]);
});

test('ANTI-ENUMERAÇÃO e falsificação: só id+token do próprio pedido; avisos exigem a chave do roteador', async () => {
  const a = await h.payOrder(MAC_A); await router.poll();
  // o navegador não tem rota por MAC e não consegue avisar esgotamento
  const bad = await read(await h.paymentStatus(req(`${FN_BASE}/payment-status?id=${a.created.order_id}&token=${a.created.order_id}`)));
  assert.equal(bad.status, 404, 'token errado');
  const byMac = await read(await h.paymentStatus(req(`${FN_BASE}/payment-status?mac=${MAC_A}`)));
  assert.equal(byMac.status, 400, 'consulta por MAC não existe');
  const forged = await read(await h.routerSync(req(`${FN_BASE}/router-sync`, { method: 'POST', origin: ENV.SITE_ORIGIN, body: `expired=${MAC_A},`, headers: { 'content-type': 'application/x-www-form-urlencoded' } })));
  assert.equal(forged.status, 401, 'sem a chave do roteador não se declara esgotamento');
  assert.equal((await h.routerReportExpired(`${MAC_A},`, 'chave-errada')).status, 401);
  assert.equal(await credit(a.created), 'active');
  // com a chave, MACs sem crédito concedido ou inválidos são ignorados
  const r = await h.routerReportExpired(`${MAC_B},zz:zz,../../etc,`);
  assert.equal(r.status, 200); assert.equal(r.data.updated, 0);
  assert.deepEqual(await deviceRows(), []);
  assert.equal((await h.routerReportExpired('A'.repeat(401))).status, 400, 'lista grande demais');
});

test('FALHA de conexão com o Supabase: o aviso não se perde — é repetido no ciclo seguinte', async () => {
  const p = await h.payOrder(MAC_A); await router.poll();
  router.use(MAC_A, 99 * 3600);
  h.state.failRpc = (n) => n === 'hotspot_router_report_exhausted';
  await router.poll(); await router.poll();
  assert.equal(await credit(p.created), 'active', 'sem aviso aceito o portal ainda não vê esgotado');
  assert.ok(router.expReports.every((r) => r.status === 500));
  h.state.failRpc = null;
  await router.poll();
  assert.equal(await credit(p.created), 'exhausted');
  assert.equal(router.expReports.at(-1).status, 200);
});

test('REINICIALIZAÇÃO do roteador: reenvia o aviso, mas o servidor é idempotente (estado e datas intactos)', async () => {
  const p = await h.payOrder(MAC_A); await router.poll();
  router.use(MAC_A, 99 * 3600); await router.poll();
  const before = (await h.q('select exhausted_at from public.hotspot_device_credit'))[0].exhausted_at;
  router.reboot(); await router.poll();
  assert.equal(router.expReports.length, 2, 'a lista de avisados é global e some no reboot');
  assert.equal(router.expReports[1].status, 200);
  assert.equal(String((await h.q('select exhausted_at from public.hotspot_device_credit'))[0].exhausted_at), String(before));
  assert.equal(await credit(p.created), 'exhausted');
});

test('ACK perdido + esgotamento + nova compra: créditos nunca somem nem duplicam', async () => {
  const first = await h.payOrder(MAC_A);
  router.dropAcks = 1; await router.poll();          // credita 5 h, ACK se perde
  router.reboot(); await router.poll(); await router.poll();
  assert.equal(router.remaining(MAC_A), H5, 'ACK repetido não soma de novo');
  router.use(MAC_A, 99 * 3600); await router.poll();
  const second = await h.payOrder(MAC_A); await router.poll(); await router.poll();
  assert.equal(router.remaining(MAC_A), H5);
  assert.equal((await h.rpc('hotspot_credit_summary', { p_mac: MAC_A })).granted_seconds, 2 * H5, 'o banco registra exatamente 5 h + 5 h');
  assert.equal(await credit(first.created), 'active'); assert.equal(await credit(second.created), 'active');
});

test('margem de arredondamento: contador parado a poucos segundos do limite ainda é detectado; longe do limite não é', async () => {
  const p = await h.payOrder(MAC_A); await router.poll();
  router.users.get(MAC_A).uptime = H5 - 40; await router.poll();
  assert.equal(await credit(p.created), 'active', 'faltando 40 s ainda não avisa');
  router.users.get(MAC_A).uptime = H5 - 3; await router.poll();   // contador parou 3 s antes do limite (arredondamento)
  assert.equal(await credit(p.created), 'exhausted');
});

test('privacidade: a limpeza remove também o estado dos aparelhos sem pedidos', async () => {
  const p = await h.payOrder(MAC_A); await router.poll(); router.use(MAC_A, 99 * 3600); await router.poll();
  assert.equal((await deviceRows()).length, 1);
  await h.q("update public.hotspot_orders set created_at = now() - interval '2 days'");
  await h.rpc('hotspot_purge', { p_days: 1 });
  assert.deepEqual(await deviceRows(), []);
  assert.equal((await h.status(p.created)).status, 404);
});

test('permissões: o estado de crédito não é acessível a anon/authenticated', async () => {
  for (const role of ['anon', 'authenticated']) {
    await assert.rejects(h.pg.transaction(async (tx) => { await tx.exec(`set local role ${role}`); await tx.query('select * from public.hotspot_device_credit'); }), /permission denied/i);
    await assert.rejects(h.pg.transaction(async (tx) => { await tx.exec(`set local role ${role}`); await tx.query("select public.hotspot_device_credit_state('AA:BB:CC:DD:EE:01')"); }), /permission denied/i);
    await assert.rejects(h.pg.transaction(async (tx) => { await tx.exec(`set local role ${role}`); await tx.query("select public.hotspot_router_report_exhausted('AA:BB:CC:DD:EE:01')"); }), /permission denied/i);
  }
});
