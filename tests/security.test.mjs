// Auditoria de segurança: vínculo Hotspot -> pedido (impede MACs inventados pela internet de esgotar a cota global).
// Banco REAL (PGlite), funções reais, Mercado Pago simulado. Nenhum teste usa serviços externos.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, req, read, FN_BASE, MAC_A, MAC_B } from './helpers/harness.mjs';
import { RouterSim } from './helpers/router-sim.mjs';

let h; let router;
before(async () => { h = await createHarness(); });
after(async () => { await h.close(); });
beforeEach(async () => {
  await h.q('delete from public.hotspot_orders');
  await h.q('delete from public.hotspot_known_hosts');
  await h.q("delete from public.hotspot_settings where key = 'hosts_feed_at'");
  h.mp.reset(); h.state.failRpc = null;
  router = new RouterSim(h);
});
const randomMac = (i) => `02:00:00:${((i >> 16) & 255).toString(16).padStart(2, '0')}:${((i >> 8) & 255).toString(16).padStart(2, '0')}:${(i & 255).toString(16).padStart(2, '0')}`.toUpperCase();
const orders = async () => (await h.q('select count(*)::int n from public.hotspot_orders'))[0].n;

test('sem lista do roteador (roteador antigo): comportamento anterior preservado (fail-open documentado)', async () => {
  const r = await h.createPix(MAC_B);
  assert.equal(r.status, 200);
  assert.equal(await h.rpc('hotspot_device_gate', { p_mac: MAC_B }), 'no_feed');
});

test('com a lista do roteador: só aparelhos presentes no Hotspot geram Pix; MAC inventado não chega ao Mercado Pago', async () => {
  router.hosts = new Set([MAC_A]); await router.poll();
  const intruder = await h.createPix(MAC_B);
  assert.equal(intruder.status, 403); assert.match(intruder.data.error, /Não reconhecemos este aparelho/);
  assert.equal(h.mp.creates().length, 0, 'nenhuma chamada ao Mercado Pago'); assert.equal(await orders(), 0, 'nenhuma linha criada');
  const legit = await h.createPix(MAC_A);
  assert.equal(legit.status, 200); assert.equal(h.mp.creates().length, 1);
});

test('ataque de cota global: 300 MACs inventados não consomem a cota e o passageiro real continua comprando', async () => {
  router.hosts = new Set([MAC_A]); await router.poll();
  for (let i = 0; i < 300; i++) {
    const r = await h.createPix(randomMac(i));
    assert.equal(r.status, 403, `tentativa ${i}`);
  }
  assert.equal(await orders(), 0); assert.equal(h.mp.creates().length, 0);
  const legit = await h.createPix(MAC_A);
  assert.equal(legit.status, 200, 'a venda legítima não foi bloqueada pelo ataque');
});

test('lista recente: aparelho visto há 20 min já não vale (janela de 15 min)', async () => {
  router.hosts = new Set([MAC_A]); await router.poll();
  await h.q("update public.hotspot_known_hosts set seen_at = now() - interval '20 minutes'");
  assert.equal(await h.rpc('hotspot_device_gate', { p_mac: MAC_A }), 'unknown');
});

test('SEM fail-open: roteador parou de informar -> MAC inventado continua barrado; quem já usou o Wi-Fi (24 h) ainda compra', async () => {
  router.hosts = new Set([MAC_A]); await router.poll();
  await h.q("update public.hotspot_settings set value = (now() - interval '5 minutes')::text where key = 'hosts_feed_at'");
  await h.q("update public.hotspot_known_hosts set seen_at = now() - interval '3 hours'");
  assert.equal(await h.rpc('hotspot_device_gate', { p_mac: MAC_B }), 'unknown', 'invenção barrada mesmo com a lista parada');
  assert.equal(await h.rpc('hotspot_device_gate', { p_mac: MAC_A }), 'ok', 'visto há 3 h: ainda vale com a lista parada');
  const bad = await h.createPix(MAC_B);
  assert.equal(bad.status, 403); assert.equal(h.mp.creates().length, 0);
  assert.equal((await h.createPix(MAC_A)).status, 200, 'comprador legítimo continua atendido');
  await h.q("update public.hotspot_known_hosts set seen_at = now() - interval '30 hours'");
  assert.equal(await h.rpc('hotspot_device_gate', { p_mac: MAC_A }), 'unknown', 'depois de 24 h sem ser visto, deixa de valer');
});

test('limpeza diária: apaga pedidos falhos/expirados/pendentes antigos, preserva pagos e recentes, roda 1x por dia', async () => {
  const paid = await h.payOrder(MAC_A);
  await h.q("insert into public.hotspot_orders (device_mac, amount_cents, grant_seconds, payment_status, created_at, paid_at) values ('AA:BB:CC:DD:EE:11', 500, 18000, 'failed', now() - interval '40 days', null), ('AA:BB:CC:DD:EE:12', 500, 18000, 'expired', now() - interval '40 days', null), ('AA:BB:CC:DD:EE:13', 500, 18000, 'pending', now() - interval '9 days', null), ('AA:BB:CC:DD:EE:14', 500, 18000, 'failed', now() - interval '2 days', null), ('AA:BB:CC:DD:EE:15', 500, 18000, 'paid', now() - interval '90 days', now() - interval '90 days')");
  await h.q("delete from public.hotspot_settings where key = 'maintenance_at'");
  const r = await h.rpc('hotspot_maintenance', {});
  assert.equal(r.ran, true); assert.equal(r.failed_expired_deleted, 2); assert.equal(r.pending_deleted, 1);
  const left = (await h.q("select device_mac from public.hotspot_orders order by 1")).map((x) => x.device_mac);
  assert.ok(left.includes('AA:BB:CC:DD:EE:14') && left.includes('AA:BB:CC:DD:EE:15'), 'recente e pago preservados');
  assert.ok(left.includes(MAC_A), 'pedido pago real preservado'); assert.ok(paid);
  assert.equal((await h.rpc('hotspot_maintenance', {})).ran, false, 'segunda chamada no mesmo dia não faz nada');
});

test('lista vazia ou inválida não liga o bloqueio; entradas inválidas são ignoradas; tamanho limitado', async () => {
  router.hosts = new Set(); await router.poll();
  assert.equal(await h.rpc('hotspot_device_gate', { p_mac: MAC_B }), 'no_feed', 'lista vazia não bloqueia ninguém');
  const r = await h.rpc('hotspot_router_report_hosts', { p_macs: `lixo;${MAC_A.toLowerCase()};ZZ:ZZ:ZZ:ZZ:ZZ:ZZ;;${MAC_A};` });
  assert.equal(r.accepted, 1);
  assert.equal((await h.rpc('hotspot_router_report_hosts', { p_macs: 'aa-bb-cc-dd-ee-02;' })).accepted, 1, 'formato com hífens (enviado pelo RouterOS)');
  assert.equal(await h.rpc('hotspot_device_gate', { p_mac: MAC_B }), 'ok');
  assert.equal((await h.rpc('hotspot_router_report_hosts', { p_macs: 'x'.repeat(2001) })).accepted, 0);
  const many = Array.from({ length: 150 }, (_, i) => randomMac(i)).join(';');
  assert.ok((await h.rpc('hotspot_router_report_hosts', { p_macs: many.slice(0, 2000) })).accepted <= 100);
});

test('a lista só é aceita com a chave do roteador', async () => {
  const bad = await h.routerPull('chave-errada', 'text', `${MAC_B};`);
  assert.equal(bad.status, 401);
  assert.equal((await h.q('select count(*)::int n from public.hotspot_known_hosts'))[0].n, 0);
  const noKey = await read(await h.routerSync(req(`${FN_BASE}/router-sync`, { headers: { 'x-hosts': `${MAC_B};` }, origin: null })));
  assert.equal(noKey.status, 401);
});

test('falha ao gravar a lista não impede a entrega de créditos já pagos', async () => {
  await h.payOrder(MAC_A);
  h.state.failRpc = (n) => n === 'hotspot_router_report_hosts';
  router.hosts = new Set([MAC_A]); await router.poll();
  h.state.failRpc = null;
  assert.equal(router.remaining(MAC_A), 5 * 3600);
});

test('papéis públicos não leem a lista nem executam as funções novas', async () => {
  for (const role of ['anon', 'authenticated']) {
    await assert.rejects(h.pg.transaction(async (tx) => { await tx.exec(`set local role ${role}`); await tx.query('select * from public.hotspot_known_hosts'); }), /permission denied/i);
    await assert.rejects(h.pg.transaction(async (tx) => { await tx.exec(`set local role ${role}`); await tx.query("select public.hotspot_router_report_hosts('AA:BB:CC:DD:EE:01;')"); }), /permission denied/i);
    await assert.rejects(h.pg.transaction(async (tx) => { await tx.exec(`set local role ${role}`); await tx.query("select public.hotspot_device_gate('AA:BB:CC:DD:EE:01')"); }), /permission denied/i);
  }
});
