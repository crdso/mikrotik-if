// Protocolo de sincronização com o MikroTik (texto simples, compatível com RouterOS 6)
// e o modelo do algoritmo do script. Banco real (PGlite); roteador SIMULADO.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, ENV, MAC_A, MAC_B } from './helpers/harness.mjs';
import { RouterSim, parseRosTime } from './helpers/router-sim.mjs';

let h; let router;
const H5 = 5 * 3600;
before(async () => { h = await createHarness(); await h.useLegacyPlan(); }); // modelo antigo de horas (pedidos históricos)
after(async () => { await h.close(); });
beforeEach(async () => {
  await h.q('delete from public.hotspot_orders');
  await h.q('update public.hotspot_router_state set last_seen_at = null, last_ack_at = null');
  h.mp.reset(); h.state.failRpc = null; h.state.rpcCalls.length = 0;
  delete process.env.ROUTER_SHARED_KEY_NEXT;
  router = new RouterSim(h);
});

test('texto: formato exato "OK" + linhas G de largura fixa; vazio = só "OK"', async () => {
  assert.equal((await h.routerPull(undefined, 'text')).text, 'OK\n');
  const p = await h.payOrder(MAC_A);
  const r = await h.routerPull(undefined, 'text');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^text\/plain/);
  assert.equal(r.text, `OK\nG ${MAC_A} ${p.created.order_id} 5h0m0s\n`);
  const line = r.text.split('\n')[1];
  assert.equal(line.length, 63);                          // posições usadas pelo :pick do script
  assert.equal(line.slice(2, 19), MAC_A); assert.equal(line.slice(20, 56), p.created.order_id); assert.equal(line.slice(57), '5h0m0s');
});

test('texto: no máximo 10 pedidos por consulta e resposta pequena (< 1 KB)', async () => {
  for (let i = 0; i < 14; i++) { await h.payOrder(`AA:BB:CC:02:00:${String(i).padStart(2, '0')}`); }
  const r = await h.routerPull(undefined, 'text');
  const lines = r.text.trim().split('\n');
  assert.equal(lines[0], 'OK'); assert.equal(lines.length, 11);
  assert.ok(r.text.length < 1024, `resposta com ${r.text.length} bytes`);
});

test('ping público: sem chave, sem tocar no banco; as demais rotas continuam protegidas', async () => {
  h.state.rpcCalls.length = 0;
  const ping = await h.routerRaw('?ping=1');
  assert.equal(ping.status, 200); assert.equal(ping.text, 'pong\n');
  assert.deepEqual(h.state.rpcCalls, []);
  assert.equal((await h.routerPull(null, 'text')).status, 401);
  assert.equal((await h.routerPull('errada', 'text')).status, 401);
});

test('ACK por formulário (RouterOS 6) é idempotente; entradas inválidas são recusadas', async () => {
  const p = await h.payOrder(MAC_A);
  const bad = [
    [{ order: p.created.order_id, mac: MAC_B }, 409], [{ order: 'x', mac: MAC_A }, 400], [{ order: p.created.order_id }, 400],
  ];
  for (const [body, status] of bad) {
    const r = await h.routerRaw('', { method: 'POST', headers: { 'x-router-key': ENV.ROUTER_SHARED_KEY, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });
    assert.equal(r.status, status, JSON.stringify(body));
  }
  assert.deepEqual((await h.routerAckForm(p.created.order_id, MAC_A)).data, { ok: true, already: false });
  assert.deepEqual((await h.routerAckForm(p.created.order_id, MAC_A)).data, { ok: true, already: true });
  assert.equal((await h.routerPull(undefined, 'text')).text, 'OK\n');
});

test('a duração do crédito vem do servidor (por pedido) e o roteador obedece', async () => {
  const a = await h.payOrder(MAC_A);
  await h.q('update public.hotspot_orders set grant_seconds = 7200 where id = $1', [a.created.order_id]);
  assert.match((await h.routerPull(undefined, 'text')).text, / 2h0m0s\n$/);
  await router.poll();
  assert.equal(router.remaining(MAC_A), 7200);
  await assert.rejects(h.q('update public.hotspot_orders set grant_seconds = 10 where id = $1', [a.created.order_id]), /grant_range/);
});

test('linhas malformadas ou maliciosas são ignoradas (nenhum usuário criado)', () => {
  const id = '123e4567-e89b-12d3-a456-426614174000';
  const ok = `G ${MAC_A} ${id} 5h0m0s`;
  assert.deepEqual(RouterSim.parseLine(ok), { mac: MAC_A, oid: id, dur: H5 });
  const bad = [
    '', 'OK', 'X ' + ok.slice(2), ok.slice(0, 40),                                   // tipo errado / curta
    `G ${MAC_A.replace(/:/g, '-')} ${id} 5h0m0s`,                                    // MAC sem dois-pontos
    `G ${MAC_A} ${id.replace(/-/g, '_')} 5h0m0s`,                                    // id sem hífens
    `G ${MAC_A}  ${id} 5h0m0s`, `G ${MAC_A} ${id}5h0m0s`,                           // separadores errados
    `G ${MAC_A} ${id} 0s`.padEnd(62, ' '), `G ${MAC_A} ${id} 0h0m0s`,               // zero
    `G ${MAC_A} ${id} 49h0m0s`, `G ${MAC_A} ${id} 99999h`,                          // acima do teto (2 dias)
    `G ${MAC_A} ${id} 5h0m0s; /system reset-configuration`,                         // tentativa de injeção
    `G ${MAC_A} ${id} abc123`, `G ${MAC_A} ${id} -5h0m0s`,                          // lixo / negativo
    ok + ' '.repeat(40),                                                             // longa demais
  ];
  for (const line of bad) assert.equal(RouterSim.parseLine(line), null, JSON.stringify(line));
  assert.equal(parseRosTime('1w2d3h4m5s'), ((7 + 2) * 24 + 3) * 3600 + 4 * 60 + 5);
});

test('reinicialização: ACK perdido + reboot do roteador não duplica o crédito', async () => {
  const p = await h.payOrder(MAC_A);
  router.dropAcks = 1;
  await router.poll();                         // credita 5h, ACK se perde
  assert.equal(router.remaining(MAC_A), H5);
  router.reboot();                             // variáveis globais somem; usuários persistem
  await router.poll();                         // pedido volta; marcador impede soma; ACK reenviado
  await router.poll();
  assert.equal(router.remaining(MAC_A), H5, 'continua 5h');
  assert.equal((await h.status(p.created)).data.internet_ready, true);
});

test('reinicialização no meio do uso: o tempo consumido e o crédito novo se somam (MODELO: assume que o uptime persiste)', async () => {
  await h.payOrder(MAC_A); await router.poll();
  router.use(MAC_A, 2 * 3600); router.reboot();
  assert.equal(router.remaining(MAC_A), 3 * 3600);
  await h.payOrder(MAC_A); await router.poll();
  assert.equal(router.remaining(MAC_A), 8 * 3600);
});

test('trava contra execuções simultâneas: duas consultas ao mesmo tempo creditam uma vez só', async () => {
  await h.payOrder(MAC_A);
  const [a, b] = await Promise.all([router.poll(), router.poll()]);
  assert.ok(a.skipped || b.skipped);
  assert.equal(router.remaining(MAC_A), H5);
  await router.poll();
  assert.equal(router.remaining(MAC_A), H5);
});

test('falha de sincronização: erro do servidor não libera nada; recupera sozinho depois', async () => {
  const p = await h.payOrder(MAC_A);
  h.state.failRpc = () => true;
  for (let i = 0; i < 3; i++) assert.equal((await router.poll()).ok, false);
  assert.equal(router.failedPolls, 3); assert.equal(router.users.size, 0);
  h.state.failRpc = null;
  assert.equal((await router.poll()).ok, true);
  assert.equal(router.failedPolls, 0); assert.equal(router.canBrowse(MAC_A), true);
  assert.equal((await h.status(p.created)).data.internet_ready, true);
});

test('webhooks duplicados simultâneos: um só pedido pago e um só crédito', async () => {
  const created = (await h.createPix(MAC_A)).data;
  const pid = [...h.mp.payments.keys()].at(-1); h.mp.approve(pid);
  const results = await Promise.all(Array.from({ length: 10 }, () => h.webhook(pid)));
  assert.equal(results.filter((r) => r.data.result === 'paid').length, 1);
  assert.equal(results.filter((r) => r.data.result === 'already_paid').length, 9);
  await router.poll(); await router.poll();
  assert.equal(router.remaining(MAC_A), H5);
  assert.equal((await h.status(created)).data.internet_ready, true);
});

test('usuário já existente (criado à mão, sem marcador) recebe o crédito somado', async () => {
  router.users.set(MAC_A, { limit: 3600, uptime: 0, comment: '' });
  await h.payOrder(MAC_A); await router.poll();
  assert.equal(router.remaining(MAC_A), 3600 + H5);
});

test('rotação de chave: a chave nova (NEXT) e a antiga funcionam juntas; qualquer outra é recusada', async () => {
  process.env.ROUTER_SHARED_KEY_NEXT = 'chave-nova_456';
  assert.equal((await h.routerPull('chave-nova_456', 'text')).status, 200);
  assert.equal((await h.routerPull(ENV.ROUTER_SHARED_KEY, 'text')).status, 200);
  assert.equal((await h.routerPull('chave-outra', 'text')).status, 401);
  delete process.env.ROUTER_SHARED_KEY_NEXT;
  assert.equal((await h.routerPull('chave-nova_456', 'text')).status, 401);
});

test('resumo de créditos para suporte: pagos, aguardando o roteador e estornos', async () => {
  const a = await h.payOrder(MAC_A); await router.poll();
  await h.payOrder(MAC_A);
  const s = await h.rpc('hotspot_credit_summary', { p_mac: MAC_A.toLowerCase() });
  assert.deepEqual(s, { mac: MAC_A, orders_paid: 2, granted_seconds: H5, awaiting_router_seconds: H5, refunded_orders: 0 });
  h.mp.set(a.paymentId, 'refunded', 'refunded'); await h.webhook(a.paymentId);
  assert.equal((await h.rpc('hotspot_credit_summary', { p_mac: MAC_A })).refunded_orders, 1);
});
