// Testes do SQL REAL (migration aplicada em Postgres/PGlite). Camada: banco.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createHarness, MAC_A, MAC_B, ROOT } from './helpers/harness.mjs';

let h;
before(async () => { h = await createHarness(); });
after(async () => { await h.close(); });

const AMOUNT = 500;
async function reserve(mac = MAC_A) { return h.rpc('hotspot_reserve_order', { p_mac: mac, p_amount_cents: AMOUNT }); }
async function attach(orderId, paymentId, minutes = 30) {
  return h.rpc('hotspot_attach_payment', {
    p_order_id: orderId, p_payment_id: paymentId, p_qr_code: 'QR' + paymentId, p_qr_code_base64: 'b64',
    p_ticket_url: 'https://t', p_expires_at: new Date(Date.now() + minutes * 60000).toISOString(),
  });
}
const apply = (orderId, paymentId, o = {}) => h.rpc('hotspot_apply_payment', {
  p_order_id: orderId, p_payment_id: paymentId, p_mp_status: 'approved', p_mp_status_detail: 'accredited',
  p_amount_cents: AMOUNT, p_currency: 'BRL', p_method: 'pix', ...o,
});
async function newOrder(mac, paymentId) {
  const r = await reserve(mac); assert.equal(r.action, 'created');
  await attach(r.order_id, paymentId); return r;
}
async function clean() {
  await h.q('delete from public.hotspot_orders');
  await h.q('update public.hotspot_router_state set last_seen_at = null, last_ack_at = null');
}

test('permissões: anon/authenticated não leem a tabela nem executam funções', async () => {
  for (const role of ['anon', 'authenticated']) {
    await assert.rejects(h.pg.transaction(async (tx) => { await tx.exec(`set local role ${role}`); await tx.query('select * from public.hotspot_orders'); }), /permission denied/i, `${role} select`);
    await assert.rejects(h.pg.transaction(async (tx) => { await tx.exec(`set local role ${role}`); await tx.query("select public.hotspot_router_pull(5)"); }), /permission denied/i, `${role} rpc pull`);
    await assert.rejects(h.pg.transaction(async (tx) => { await tx.exec(`set local role ${role}`); await tx.query("select public.hotspot_apply_payment('00000000-0000-0000-0000-000000000000','1','approved',null,500,'BRL','pix')"); }), /permission denied/i, `${role} rpc apply`);
  }
  const rls = await h.q("select relname, relrowsecurity from pg_class where relname in ('hotspot_orders','hotspot_router_state') order by 1");
  assert.deepEqual(rls.map((r) => r.relrowsecurity), [true, true]);
  const pol = await h.q("select count(*)::int n from pg_policies where schemaname='public'");
  assert.equal(pol[0].n, 0, 'nenhuma policy pública');
});

test('reserve: cria, valida MAC e normaliza para maiúsculas', async () => {
  await clean();
  assert.equal((await h.rpc('hotspot_reserve_order', { p_mac: 'xx', p_amount_cents: AMOUNT })).action, 'invalid_mac');
  assert.equal((await h.rpc('hotspot_reserve_order', { p_mac: MAC_A, p_amount_cents: 0 })).action, 'invalid_amount');
  const r = await h.rpc('hotspot_reserve_order', { p_mac: MAC_A.toLowerCase(), p_amount_cents: AMOUNT });
  assert.equal(r.action, 'created');
  const row = await h.order(r.order_id);
  assert.equal(row.device_mac, MAC_A); assert.equal(row.payment_status, 'pending'); assert.equal(row.amount_cents, 500);
});

test('reserve: reaproveita o Pix pendente (sem cobrança duplicada) e devolve in_progress sem QR', async () => {
  await clean();
  const r1 = await reserve();
  assert.equal((await reserve()).action, 'in_progress', 'pedido ainda sem Pix');
  await attach(r1.order_id, 'P1');
  const again = await reserve();
  assert.equal(again.action, 'existing'); assert.equal(again.order_id, r1.order_id);
  assert.equal(again.qr_code, 'QRP1');
  assert.equal((await h.q('select count(*)::int n from public.hotspot_orders'))[0].n, 1);
});

test('reserve: requisições concorrentes do mesmo MAC não criam dois pedidos', async () => {
  await clean();
  const results = await Promise.all([reserve(), reserve(), reserve()]);
  assert.equal(results.filter((r) => r.action === 'created').length, 1);
  assert.equal((await h.q('select count(*)::int n from public.hotspot_orders'))[0].n, 1);
});

test('reserve: pago e ainda não liberado -> paid_waiting (não gera outro Pix)', async () => {
  await clean();
  const r = await newOrder(MAC_A, 'P2');
  await apply(r.order_id, 'P2');
  const again = await reserve();
  assert.equal(again.action, 'paid_waiting'); assert.equal(again.order_id, r.order_id);
});

test('reserve: limite por MAC (5/10min) e global (200/10min)', async () => {
  await clean();
  for (let i = 0; i < 5; i++) { const r = await reserve(); assert.equal(r.action, 'created'); await h.rpc('hotspot_fail_order', { p_order_id: r.order_id }); }
  assert.equal((await reserve()).action, 'rate_limited');
  await clean();
  await h.q(`insert into public.hotspot_orders (device_mac, amount_cents, payment_status)
             select 'AA:00:00:00:' || upper(lpad(to_hex(i / 256), 2, '0')) || ':' || upper(lpad(to_hex(i % 256), 2, '0')), 500, 'failed'
               from generate_series(1, 200) i`);
  assert.equal((await reserve('AA:BB:CC:00:00:99')).action, 'rate_limited');
});

test('apply: aprovado com valor/moeda/meio corretos -> paid (uma vez só, idempotente)', async () => {
  await clean();
  const r = await newOrder(MAC_A, 'P3');
  assert.equal((await apply(r.order_id, 'P3')).result, 'paid');
  const paidAt = (await h.order(r.order_id)).paid_at;
  assert.ok(paidAt);
  assert.equal((await apply(r.order_id, 'P3')).result, 'already_paid');
  assert.equal(String((await h.order(r.order_id)).paid_at), String(paidAt), 'paid_at não muda no replay');
});

test('apply: valor, moeda ou meio errados NUNCA viram paid', async () => {
  await clean();
  let n = 0;
  for (const [bad, label] of [[{ p_amount_cents: 100 }, 'valor menor'], [{ p_amount_cents: 50000 }, 'valor maior'],
    [{ p_amount_cents: null }, 'valor nulo'], [{ p_currency: 'USD' }, 'moeda'], [{ p_method: 'credit_card' }, 'meio']]) {
    const mac = `AA:BB:CC:DD:00:0${++n}`;
    const r = await newOrder(mac, `PX${n}`);
    assert.equal((await apply(r.order_id, `PX${n}`, bad)).result, 'invalid_payment', label);
    assert.equal((await h.order(r.order_id)).payment_status, 'pending', label);
  }
});

test('apply: pagamento não pode migrar entre pedidos nem servir a dois pedidos', async () => {
  await clean();
  const a = await newOrder(MAC_A, 'PA'); const b = await newOrder(MAC_B, 'PB');
  assert.equal((await apply(a.order_id, 'PB')).result, 'payment_mismatch', 'pedido A com pagamento do B');
  assert.equal((await apply(b.order_id, 'PA')).result, 'payment_mismatch', 'pedido B com pagamento do A');
  assert.equal((await apply('00000000-0000-0000-0000-000000000000', 'PZ')).result, 'order_not_found');
  assert.deepEqual((await h.orders()).map((o) => o.payment_status), ['pending', 'pending']);
});

test('apply: status não aprovados (pending/in_process/rejected/cancelled) nunca liberam', async () => {
  await clean();
  const r = await newOrder(MAC_A, 'P4');
  for (const st of ['pending', 'in_process', 'authorized', 'in_mediation']) {
    assert.equal((await apply(r.order_id, 'P4', { p_mp_status: st })).result, 'noop');
    assert.equal((await h.order(r.order_id)).payment_status, 'pending', st);
  }
  assert.equal((await apply(r.order_id, 'P4', { p_mp_status: 'rejected', p_mp_status_detail: 'cc_rejected_other' })).result, 'rejected');
  assert.equal((await h.order(r.order_id)).payment_status, 'failed');
  const e = await newOrder(MAC_B, 'P5');
  assert.equal((await apply(e.order_id, 'P5', { p_mp_status: 'cancelled', p_mp_status_detail: 'expired' })).result, 'cancelled');
  assert.equal((await h.order(e.order_id)).payment_status, 'expired');
});

test('apply: pagamento aprovado depois de failed/expired AINDA libera (MP é a verdade)', async () => {
  await clean();
  const r = await newOrder(MAC_A, 'P6');
  await h.q("update public.hotspot_orders set payment_status='expired' where id=$1", [r.order_id]);
  assert.equal((await apply(r.order_id, 'P6')).result, 'paid');
  const f = await newOrder(MAC_B, 'P7');
  await h.q("update public.hotspot_orders set payment_status='failed' where id=$1", [f.order_id]);
  assert.equal((await apply(f.order_id, 'P7')).result, 'paid');
});

test('apply: estorno de pedido pago -> refunded; estorno não é revertido por replay de aprovado', async () => {
  await clean();
  const r = await newOrder(MAC_A, 'P8');
  await apply(r.order_id, 'P8');
  const ref = await apply(r.order_id, 'P8', { p_mp_status: 'refunded' });
  assert.equal(ref.result, 'refunded'); assert.equal(ref.was_provisioned, false);
  assert.equal((await h.order(r.order_id)).payment_status, 'refunded');
  assert.equal((await apply(r.order_id, 'P8')).result, 'ignored', 'replay de aprovado não revive pedido estornado');
  assert.equal((await h.rpc('hotspot_router_pull', {})).orders.length, 0, 'estornado não vai ao roteador');
});

test('router pull/ack: só pagos e não confirmados; ACK idempotente; MAC e pedido conferidos', async () => {
  await clean();
  const paid = await newOrder(MAC_A, 'P9'); await apply(paid.order_id, 'P9');
  await newOrder(MAC_B, 'P10'); // pendente
  const pull = await h.rpc('hotspot_router_pull', { p_limit: 30 });
  assert.deepEqual(pull.orders, [{ id: paid.order_id, mac: MAC_A, grant_seconds: 18000 }]);

  assert.equal((await h.rpc('hotspot_router_ack', { p_order_id: paid.order_id, p_mac: MAC_B })).ok, false, 'MAC errado');
  const pendingId = (await h.q("select id from public.hotspot_orders where payment_status='pending'"))[0].id;
  assert.equal((await h.rpc('hotspot_router_ack', { p_order_id: pendingId, p_mac: MAC_B })).ok, false, 'pedido pendente não pode ser confirmado');
  const ack = await h.rpc('hotspot_router_ack', { p_order_id: paid.order_id, p_mac: MAC_A });
  assert.deepEqual(ack, { ok: true, already: false });
  assert.deepEqual(await h.rpc('hotspot_router_ack', { p_order_id: paid.order_id, p_mac: MAC_A }), { ok: true, already: true });
  assert.equal((await h.rpc('hotspot_router_pull', {})).orders.length, 0);
  const t = (await h.order(paid.order_id)).provisioned_at;
  await h.rpc('hotspot_router_ack', { p_order_id: paid.order_id, p_mac: MAC_A });
  assert.equal(String((await h.order(paid.order_id)).provisioned_at), String(t), 'provisioned_at não muda');
});

test('constraints: não existe provisionamento sem pagamento (nem por UPDATE direto)', async () => {
  await clean();
  const r = await newOrder(MAC_A, 'P11');
  await assert.rejects(h.q("update public.hotspot_orders set provisioned_at = now() where id = $1", [r.order_id]), /provisioned_requires_paid/);
  await assert.rejects(h.q("update public.hotspot_orders set payment_status = 'paid' where id = $1", [r.order_id]), /paid_has_timestamp/);
  await assert.rejects(h.q("update public.hotspot_orders set payment_status = 'bogus' where id = $1", [r.order_id]), /payment_status_check/);
  await assert.rejects(h.q("insert into public.hotspot_orders (device_mac) values ('not-a-mac')"), /device_mac_check|violates check/);
  await assert.rejects(h.q("update public.hotspot_orders set amount_cents = 0 where id = $1", [r.order_id]), /amount_positive/);
});

test('status: token errado não revela pedido; reconciliação é limitada por intervalo', async () => {
  await clean();
  const r = await newOrder(MAC_A, 'P12');
  assert.equal((await h.rpc('hotspot_order_status', { p_order_id: r.order_id, p_token: '00000000-0000-0000-0000-000000000000' })).found, false);
  const s1 = await h.rpc('hotspot_order_status', { p_order_id: r.order_id, p_token: r.read_token, p_reconcile_after_seconds: 10 });
  assert.equal(s1.found, true); assert.equal(s1.status, 'pending'); assert.equal(s1.reconcile_payment_id, 'P12');
  const s2 = await h.rpc('hotspot_order_status', { p_order_id: r.order_id, p_token: r.read_token, p_reconcile_after_seconds: 10 });
  assert.equal(s2.reconcile_payment_id, null, 'segunda consulta dentro de 10s não reconcilia');
  assert.ok(s1.seconds_left > 1700 && s1.seconds_left <= 1800);
});

test('expiração: Pix vencido (+2min) -> expired; pedido sem Pix após 45s -> failed', async () => {
  await clean();
  const a = await newOrder(MAC_A, 'P13');
  await h.q("update public.hotspot_orders set expires_at = now() - interval '121 seconds' where id=$1", [a.order_id]);
  const b = await reserve(MAC_B);
  await h.q("update public.hotspot_orders set created_at = now() - interval '46 seconds' where id=$1", [b.order_id]);
  const s = await h.rpc('hotspot_order_status', { p_order_id: a.order_id, p_token: a.read_token });
  assert.equal(s.status, 'expired');
  assert.equal((await h.order(b.order_id)).payment_status, 'failed');
  const c = await newOrder('AA:BB:CC:DD:EE:03', 'P14');
  await h.q("update public.hotspot_orders set expires_at = now() - interval '60 seconds' where id=$1", [c.order_id]);
  const s2 = await h.rpc('hotspot_order_status', { p_order_id: c.order_id, p_token: c.read_token });
  assert.equal(s2.status, 'pending', 'dentro da tolerância de 2 min ainda aceita pagamento');
});

test('router_online reflete a última consulta do roteador (<60s)', async () => {
  await clean();
  const r = await newOrder(MAC_A, 'P15');
  const q = () => h.rpc('hotspot_order_status', { p_order_id: r.order_id, p_token: r.read_token, p_reconcile_after_seconds: 3600 });
  assert.equal((await q()).router_online, false);
  await h.rpc('hotspot_router_pull', {});
  assert.equal((await q()).router_online, true);
  await h.q("update public.hotspot_router_state set last_seen_at = now() - interval '5 minutes'");
  assert.equal((await q()).router_online, false);
});

test('purge: remove pedidos encerrados, preserva pendentes; rejeita dias inválidos', async () => {
  await clean();
  const a = await newOrder(MAC_A, 'P16'); await apply(a.order_id, 'P16');
  await newOrder(MAC_B, 'P17');
  assert.equal((await h.rpc('hotspot_purge', { p_days: -1 })).error, 'invalid_days');
  await h.q("update public.hotspot_orders set created_at = now() - interval '2 days'");
  assert.equal((await h.rpc('hotspot_purge', { p_days: 1 })).deleted, 1);
  assert.equal((await h.orders()).length, 1);
});

test('migration é idempotente (pode ser reexecutada sem perder pedidos)', async () => {
  await clean();
  const r = await newOrder(MAC_A, 'P18'); await apply(r.order_id, 'P18');
  for (const f of readdirSync(`${ROOT}/supabase/migrations`).filter((n) => n.endsWith('.sql')).sort()) {
    await h.pg.exec(readFileSync(`${ROOT}/supabase/migrations/${f}`, 'utf8')); // reaplicar tudo, em ordem
  }
  assert.equal((await h.order(r.order_id)).payment_status, 'paid');
});
