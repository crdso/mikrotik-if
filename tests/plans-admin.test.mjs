// Planos e preços, painel administrativo, financeiro e telemetria. Banco REAL (PGlite) + funções reais.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, req, read, ENV, FN_BASE, MAC_A, MAC_B } from './helpers/harness.mjs';
import { RouterSim } from './helpers/router-sim.mjs';

let h; let admin; let operator; let nobody; let router;
const MAC_C = 'AA:BB:CC:DD:EE:03';
const H = 3600;

before(async () => { h = await createHarness(); });
after(async () => { await h.close(); });
beforeEach(async () => {
  await h.q('delete from public.hotspot_orders');
  await h.q('delete from public.hotspot_device_credit');
  await h.q('delete from public.hotspot_device_state');
  await h.q('delete from public.admin_audit_log');
  await h.q('delete from public.admin_users');
  await h.q('delete from auth.users');
  await h.q('update public.hotspot_router_state set last_seen_at = null, last_ack_at = null, last_telemetry_at = null, sessions_online = null');
  await h.q("delete from public.hotspot_plans where name <> '5 horas'");
  await h.q("update public.hotspot_plans set price_cents = 500, grant_seconds = 18000, active = true, is_default = true, highlight = false, sort_order = 0 where name = '5 horas'");
  await h.q('delete from public.hotspot_settings where key not in (\'timezone\', \'router_name\', \'site_name\')');
  await h.q("insert into public.hotspot_settings (key, value) values ('router_offline_seconds','180'),('telemetry_stale_seconds','180'),('paid_wait_alert_seconds','300') on conflict (key) do update set value = excluded.value");
  h.mp.reset(); h.state.failRpc = null;
  router = new RouterSim(h);
  admin = await h.makeUser('admin@example.com', 'admin');
  operator = await h.makeUser('operador@example.com', 'operator');
  nobody = await h.makeUser('qualquer@example.com', null);
});

async function savePlan(plan, who = admin) {
  return h.admin('plan_save', { plan: { name: 'Plano', price_cents: 200, grant_seconds: 3600, active: false, ...plan } }, who.token);
}
const planByName = async (name) => (await h.q('select * from public.hotspot_plans where name = $1', [name]))[0];
async function seed(o = {}) {
  const row = {
    mac: MAC_A, status: 'paid', cents: 500, secs: 18000, paidAt: new Date().toISOString(), test: false, plan: '5 horas',
    provisioned: false, mpStatus: null, expires: null, created: null, paymentId: null, refundedAt: null, ...o,
  };
  const created = row.created ?? row.paidAt ?? new Date().toISOString();
  const hasPaid = row.status === 'paid' || row.status === 'refunded';
  await h.q(
    `insert into public.hotspot_orders (device_mac, amount_cents, grant_seconds, payment_status, paid_at, provisioned_at, is_test, plan_name, mp_status, expires_at, created_at, payment_id, refunded_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [row.mac, row.cents, row.secs, row.status, hasPaid ? row.paidAt : null,
      row.provisioned ? row.paidAt : null, row.test, row.plan, row.mpStatus, row.expires, created, row.paymentId, row.refundedAt]);
}
const dash = async (extra = {}) => (await h.admin('dashboard', { preset: 'last30', ...extra }, admin.token));

// ---------------------------------------------------------------------------
// Planos
// ---------------------------------------------------------------------------
test('plano inicial: só "5 horas" R$ 5,00 ativo e padrão; o portal lista um plano e o Pix sai por R$ 5,00 / 5 h', async () => {
  const plans = await h.q('select name, price_cents, grant_seconds, active, is_default from public.hotspot_plans');
  assert.deepEqual(plans, [{ name: '5 horas', price_cents: 500, grant_seconds: 18000, active: true, is_default: true }]);
  const list = await h.plansList();
  assert.equal(list.status, 200); assert.equal(list.data.plans.length, 1);
  assert.doesNotMatch(JSON.stringify(list.data), /admin|email|token/i);
  const c = await h.createPix(MAC_A);
  assert.equal(c.status, 200);
  assert.equal(h.mp.creates().at(-1).body.transaction_amount, 5);
  assert.equal(h.mp.creates().at(-1).body.description, 'Wifi a Bordo - 5 horas');
  const o = (await h.orders())[0]; assert.equal(o.amount_cents, 500); assert.equal(o.grant_seconds, 18000); assert.equal(o.plan_name, '5 horas');
});

test('criar plano (inativo não aparece no portal), ativar, destacar, ordenar e auditar', async () => {
  const r = await savePlan({ name: '1 hora', price_cents: 200, grant_seconds: 3600 });
  assert.equal(r.status, 200, r.text); assert.equal(r.data.plan.active, false);
  assert.equal((await h.plansList()).data.plans.length, 1, 'plano inativo não é publicado');
  const on = await savePlan({ id: r.data.plan.id, name: '1 hora', price_cents: 200, grant_seconds: 3600, active: true, highlight: true, sort_order: -1 });
  assert.equal(on.status, 200);
  const list = (await h.plansList()).data.plans;
  assert.deepEqual(list.map((p) => p.name), ['1 hora', '5 horas'], 'ordenado por sort_order');
  assert.equal(list[0].highlight, true);
  const audit = await h.admin('audit', {}, admin.token);
  assert.equal(audit.status, 200);
  assert.deepEqual(audit.data.entries.map((e) => e.action).sort(), ['plan_create', 'plan_update']);
  const upd = audit.data.entries.find((e) => e.action === 'plan_update');
  assert.equal(upd.actor_email, 'admin@example.com'); assert.equal(upd.before_data.active, false); assert.equal(upd.after_data.active, true);
});

test('editar preço (R$ 5 -> R$ 6) vale só para compras futuras: pagamentos e Pix pendentes anteriores ficam intactos', async () => {
  const paid = await h.payOrder(MAC_A); await router.poll();          // compra de R$ 5 já liberada
  const pending = await h.createPix(MAC_B);                            // Pix de R$ 5 pendente
  const five = await planByName('5 horas');
  const r = await savePlan({ id: five.id, name: '5 horas', price_cents: 600, grant_seconds: 18000, active: true, is_default: true });
  assert.equal(r.status, 200, r.text);
  const before = await h.orders();
  assert.deepEqual(before.map((o) => o.amount_cents), [500, 500], 'snapshots antigos preservados');
  // o Pix pendente antigo continua pagável pelo valor ORIGINAL e libera 5 h
  const pid = [...h.mp.payments.keys()].at(-1);
  h.mp.approve(pid); assert.equal((await h.webhook(pid)).data.result, 'paid');
  // nova compra: R$ 6,00
  const next = await h.createPix(MAC_C);
  assert.equal(next.status, 200); assert.equal(h.mp.creates().at(-1).body.transaction_amount, 6);
  assert.equal(next.data.amount_cents, 600);
  // relatório preserva o que foi efetivamente pago
  const d = await dash();
  assert.equal(d.data.overview.revenue_cents, 1000, 'R$ 5 + R$ 5 (o de R$ 6 ainda está pendente)');
  assert.ok(paid.created.order_id && pending.data.order_id);
});

test('editar duração: pedidos antigos mantêm a duração; novo pedido usa a nova; o roteador recebe exatamente a do pedido', async () => {
  const first = await h.payOrder(MAC_A); await router.poll();            // liberado pelo roteador antes da próxima compra
  const five = await planByName('5 horas');
  await savePlan({ id: five.id, name: '5 horas', price_cents: 500, grant_seconds: 7200, active: true, is_default: true });
  const second = await h.payOrder(MAC_A);
  const secs = (await h.orders()).map((o) => o.grant_seconds);
  assert.deepEqual(secs, [18000, 7200]);
  await router.poll(); await router.poll();
  assert.equal(router.remaining(MAC_A), 18000 + 7200, 'soma os dois créditos, sem duplicar');
  assert.ok(first.created.order_id && second.created.order_id);
});

test('limites: preço fora de R$ 1,00–R$ 500,00, duração fora de 1 min–48 h, nomes e valores inválidos são recusados', async () => {
  for (const bad of [
    { price_cents: 99 }, { price_cents: 50001 }, { price_cents: 0 }, { price_cents: -100 }, { price_cents: 'abc' }, { price_cents: '5.5' },
    { grant_seconds: 59 }, { grant_seconds: 172801 }, { grant_seconds: 0 }, { grant_seconds: -60 }, { grant_seconds: 'x' },
    { name: '' }, { name: '   ' }, { name: 'x'.repeat(61) }, { description: 'x'.repeat(201) }, { sort_order: 5000 },
  ]) {
    const r = await savePlan({ name: 'Teste', price_cents: 200, grant_seconds: 3600, ...bad });
    assert.equal(r.status, 400, JSON.stringify(bad) + ' ' + r.text);
  }
  for (const ok of [{ price_cents: 100, grant_seconds: 60 }, { price_cents: 50000, grant_seconds: 172800 }]) {
    assert.equal((await savePlan({ name: 'Limite ' + ok.price_cents, ...ok })).status, 200, JSON.stringify(ok));
  }
  assert.equal((await h.q('select count(*)::int n from public.hotspot_plans'))[0].n, 3);
});

test('desativar plano: compra nova é recusada; Pix pendente já criado continua válido; nunca fica sem plano ativo', async () => {
  const hour = (await savePlan({ name: '1 hora', price_cents: 200, grant_seconds: 3600, active: true })).data.plan;
  const pend = await h.createPix(MAC_B, 'p@example.com', { plan_id: hour.id });
  assert.equal(pend.status, 200); assert.equal(pend.data.amount_cents, 200);
  assert.equal((await savePlan({ id: hour.id, name: '1 hora', price_cents: 200, grant_seconds: 3600, active: false })).status, 200);
  const blocked = await h.createPix(MAC_C, 'p@example.com', { plan_id: hour.id });
  assert.equal(blocked.status, 409); assert.equal(h.mp.creates().length, 1, 'nenhuma cobrança nova');
  const pid = [...h.mp.payments.keys()].at(-1); h.mp.approve(pid);
  assert.equal((await h.webhook(pid)).data.result, 'paid', 'o Pix pendente ainda é honrado');
  const five = await planByName('5 horas');
  const last = await savePlan({ id: five.id, name: '5 horas', price_cents: 500, grant_seconds: 18000, active: false });
  assert.equal(last.status, 400); assert.match(last.data.error, /ao menos um plano ativo/);
  const def = await savePlan({ name: 'Sem ativo', active: false, is_default: true });
  assert.equal(def.status, 400, 'o padrão precisa estar ativo');
});

test('plano padrão: sempre existe um padrão ativo; trocar o padrão move a marca; sem plan_id usa o padrão', async () => {
  const hour = (await savePlan({ name: '1 hora', price_cents: 200, grant_seconds: 3600, active: true, is_default: true })).data.plan;
  assert.deepEqual((await h.q('select name from public.hotspot_plans where is_default')).map((r) => r.name), ['1 hora']);
  await h.createPix(MAC_A);
  assert.equal((await h.orders())[0].plan_name, '1 hora', 'sem plan_id: plano padrão');
  assert.equal((await savePlan({ id: hour.id, name: '1 hora', price_cents: 200, grant_seconds: 3600, active: false })).status, 200);
  assert.deepEqual((await h.q('select name from public.hotspot_plans where is_default')).map((r) => r.name), ['5 horas'], 'o padrão passa a um plano ativo');
});

test('o navegador não decide preço, duração nem plano inexistente', async () => {
  const hour = (await savePlan({ name: '1 hora', price_cents: 200, grant_seconds: 3600, active: true })).data.plan;
  const sneaky = await h.createPix(MAC_A, 'p@example.com', { plan_id: hour.id, amount: 0.01, price_cents: 1, grant_seconds: 999999, transaction_amount: 0.01 });
  assert.equal(sneaky.status, 200);
  assert.equal(h.mp.creates().at(-1).body.transaction_amount, 2); assert.equal(sneaky.data.amount_cents, 200);
  const o = (await h.orders())[0]; assert.equal(o.amount_cents, 200); assert.equal(o.grant_seconds, 3600);
  assert.equal((await h.createPix(MAC_B, 'p@example.com', { plan_id: 'não-é-uuid' })).status, 400);
  assert.equal((await h.createPix(MAC_B, 'p@example.com', { plan_id: '11111111-1111-4111-8111-111111111111' })).status, 409);
  assert.equal((await h.createPix(MAC_B, 'sem-arroba')).status, 400, 'e-mail continua obrigatório e validado');
  assert.equal((await h.createPix(MAC_B, '')).status, 400);
  assert.equal(h.mp.creates().length, 1);
});

test('webhook confere o valor contra o SNAPSHOT do pedido (valor alterado no provedor é recusado)', async () => {
  const hour = (await savePlan({ name: '1 hora', price_cents: 200, grant_seconds: 3600, active: true })).data.plan;
  const c = await h.createPix(MAC_A, 'p@example.com', { plan_id: hour.id });
  const pid = [...h.mp.payments.keys()].at(-1);
  h.mp.get(pid).transaction_amount = 5; h.mp.approve(pid);
  assert.equal((await h.webhook(pid)).data.result, 'invalid_payment');
  assert.equal((await h.order(c.data.order_id)).payment_status, 'pending');
  h.mp.get(pid).transaction_amount = 2;
  assert.equal((await h.webhook(pid)).data.result, 'paid');
  assert.equal((await h.webhook(pid)).data.result, 'already_paid', 'sem crédito duplicado');
});

test('somar créditos de planos diferentes: 40 min restantes + 3 h = 3 h 40 min; sem duplicar', async () => {
  const one = (await savePlan({ name: '1 hora', price_cents: 200, grant_seconds: H, active: true })).data.plan;
  const three = (await savePlan({ name: '3 horas', price_cents: 400, grant_seconds: 3 * H, active: true })).data.plan;
  await h.createPix(MAC_A, 'p@example.com', { plan_id: one.id });
  let pid = [...h.mp.payments.keys()].at(-1); h.mp.approve(pid); await h.webhook(pid);
  await router.poll(); router.use(MAC_A, 20 * 60);                      // sobram 40 min
  assert.equal(router.remaining(MAC_A), 40 * 60);
  await h.createPix(MAC_A, 'p@example.com', { plan_id: three.id });
  pid = [...h.mp.payments.keys()].at(-1); h.mp.approve(pid); await h.webhook(pid);
  await router.poll(); await router.poll(); await router.poll();
  assert.equal(router.remaining(MAC_A), 3 * H + 40 * 60);
  assert.equal((await h.rpc('hotspot_credit_summary', { p_mac: MAC_A })).granted_seconds, 4 * H);
});

test('trocar de plano com Pix pendente: confere no Mercado Pago, cancela o antigo e cria o novo (idempotente)', async () => {
  const hour = (await savePlan({ name: '1 hora', price_cents: 200, grant_seconds: H, active: true })).data.plan;
  const first = await h.createPix(MAC_A);                                   // plano padrão (5 h)
  const oldPid = [...h.mp.payments.keys()].at(-1);
  const sw = await h.createPix(MAC_A, 'p@example.com', { plan_id: hour.id });
  assert.equal(sw.status, 200, sw.text); assert.notEqual(sw.data.order_id, first.data.order_id);
  assert.equal(sw.data.amount_cents, 200);
  assert.equal(h.mp.get(oldPid).status, 'cancelled', 'o Pix antigo foi cancelado');
  assert.equal((await h.order(first.data.order_id)).payment_status, 'failed');
  assert.ok(h.mp.gets().some((c) => c.path.endsWith(`/${oldPid}`)), 'estado relido antes de cancelar');
  const again = await h.createPix(MAC_A, 'p@example.com', { plan_id: hour.id });
  assert.equal(again.data.order_id, sw.data.order_id); assert.equal(again.data.reused, true);
  assert.equal(h.mp.creates().length, 2, 'só 2 cobranças criadas no total');
});

test('trocar de plano quando o Pix antigo JÁ foi pago: nada é cancelado, o pagamento é aplicado e nenhum Pix novo é criado', async () => {
  const hour = (await savePlan({ name: '1 hora', price_cents: 200, grant_seconds: H, active: true })).data.plan;
  const first = await h.createPix(MAC_A);
  const oldPid = [...h.mp.payments.keys()].at(-1);
  h.mp.approve(oldPid);                                                    // pago no MP, webhook ainda não chegou
  const sw = await h.createPix(MAC_A, 'p@example.com', { plan_id: hour.id });
  assert.equal(sw.status, 200); assert.equal(sw.data.status, 'paid'); assert.equal(sw.data.order_id, first.data.order_id);
  assert.equal(h.mp.get(oldPid).status, 'approved', 'pagamento aprovado jamais é cancelado');
  assert.equal(h.mp.creates().length, 1, 'nenhuma cobrança nova');
  assert.equal((await h.order(first.data.order_id)).payment_status, 'paid');
  await router.poll(); assert.equal(router.remaining(MAC_A), 5 * H, 'a compra de 5 h não se perde');
});

test('trocar de plano: se o MP não confirmar o cancelamento, a troca acontece mesmo assim e o Pix antigo, se pago depois, ainda vale', async () => {
  const hour = (await savePlan({ name: '1 hora', price_cents: 200, grant_seconds: H, active: true })).data.plan;
  const old = await h.createPix(MAC_A); const oldPid = [...h.mp.payments.keys()].at(-1);
  const realHandle = h.mp.handle.bind(h.mp);
  h.mp.handle = async (url, init = {}) => ((init.method || 'GET').toUpperCase() === 'PUT' ? h.mp.json(500, { message: 'falha' }) : realHandle(url, init));
  const sw = await h.createPix(MAC_A, 'p@example.com', { plan_id: hour.id });
  h.mp.handle = realHandle;
  assert.equal(sw.status, 200, 'o passageiro consegue trocar de plano (sem loop)'); assert.equal(h.mp.creates().length, 2);
  assert.equal((await h.order(old.data.order_id)).payment_status, 'failed');
  h.mp.approve(oldPid); await h.webhook(oldPid); // pagou o Pix antigo mesmo assim
  assert.equal((await h.order(old.data.order_id)).payment_status, 'paid', 'dinheiro nunca se perde');
});

test('a mesma pessoa mantém o Pix pendente se pedir o mesmo plano, mesmo com preço editado depois', async () => {
  const first = await h.createPix(MAC_A);
  const five = await planByName('5 horas');
  await savePlan({ id: five.id, name: '5 horas', price_cents: 900, grant_seconds: 18000, active: true, is_default: true });
  const again = await h.createPix(MAC_A);
  assert.equal(again.data.reused, true); assert.equal(again.data.order_id, first.data.order_id);
  assert.equal(h.mp.creates().length, 1);
});

// ---------------------------------------------------------------------------
// Segurança do painel
// ---------------------------------------------------------------------------
test('autorização no BACKEND: sem token, token falso, usuário comum e origem estranha não acessam nada', async () => {
  for (const action of ['whoami', 'dashboard', 'orders', 'devices', 'plans', 'plan_save', 'settings', 'setting_set', 'audit', 'orders_csv', 'report']) {
    assert.equal((await h.admin(action, {}, null)).status, 401, `${action} sem token`);
    assert.equal((await h.admin(action, {}, 'tok-falso-qualquer-coisa-1234567890')).status, 401, `${action} token falso`);
    assert.equal((await h.admin(action, {}, nobody.token)).status, 403, `${action} usuário sem papel`);
  }
  assert.equal((await h.admin('whoami', {}, admin.token, 'https://evil.example')).status, 403);
  assert.equal((await h.admin('whoami', {}, admin.token, null)).status, 403);
  const get = await read(await h.adminApi(req(`${FN_BASE}/admin-api`, { method: 'GET', headers: { authorization: `Bearer ${admin.token}` } })));
  assert.equal(get.status, 405);
  assert.equal((await h.admin('apagar_tudo', {}, admin.token)).status, 400);
  const body = await h.admin('whoami', {}, nobody.token);
  assert.doesNotMatch(body.text, /plan|revenue|mac/i, 'nada de dados na resposta de negado');
});

test('cadastro público do Auth não dá acesso: ter conta autenticada sem estar em admin_users é negado', async () => {
  const stranger = await h.makeUser('novo-cadastro@example.com', null);
  const r = await h.admin('dashboard', {}, stranger.token);
  assert.equal(r.status, 403);
  await h.q('insert into public.admin_users (user_id, role) values ($1, $2)', [stranger.id, 'operator']);
  assert.equal((await h.admin('dashboard', {}, stranger.token)).status, 200, 'só passa depois de autorizado por quem administra o banco');
});

test('operador é somente leitura: lê tudo do painel, mas não edita planos, não altera configurações nem lê auditoria', async () => {
  for (const action of ['whoami', 'dashboard', 'orders', 'devices', 'plans', 'settings', 'report']) {
    assert.equal((await h.admin(action, {}, operator.token)).status, 200, action);
  }
  const who = await h.admin('whoami', {}, operator.token); assert.equal(who.data.role, 'operator');
  assert.equal((await h.admin('plan_save', { plan: { name: 'X', price_cents: 200, grant_seconds: 3600 } }, operator.token)).status, 403);
  assert.equal((await h.admin('setting_set', { key: 'router_offline_seconds', value: '300' }, operator.token)).status, 403);
  assert.equal((await h.admin('audit', {}, operator.token)).status, 403);
  assert.equal((await h.q('select count(*)::int n from public.hotspot_plans'))[0].n, 1);
  // o banco também recusa (defesa em profundidade): chamada direta com ator operador
  await assert.rejects(h.rpc('hotspot_admin_plan_save', { p_actor: operator.id, p_actor_email: 'x', p_plan: { name: 'X', price_cents: '200', grant_seconds: '3600' } }), /forbidden/);
  await assert.rejects(h.rpc('hotspot_admin_plan_save', { p_actor: '00000000-0000-4000-8000-000000000000', p_actor_email: 'x', p_plan: { name: 'X', price_cents: '200', grant_seconds: '3600' } }), /forbidden/);
});

test('papéis anon/authenticated não leem tabelas nem executam funções administrativas (nenhum bypass do frontend)', async () => {
  const tables = ['hotspot_plans', 'hotspot_settings', 'admin_users', 'admin_audit_log', 'hotspot_device_state', 'hotspot_orders'];
  const fns = ["hotspot_admin_overview(now() - interval '1 day', now())", 'hotspot_admin_live()', 'hotspot_admin_plans()', 'hotspot_public_plans()',
    "hotspot_admin_plan_save('00000000-0000-4000-8000-000000000000', 'x', '{}'::jsonb)", 'hotspot_admin_audit(10)', "hotspot_router_report_state(1, '[]'::jsonb)",
    "hotspot_reserve_plan_order('AA:BB:CC:DD:EE:01', null)", "hotspot_record_fees('00000000-0000-4000-8000-000000000000', 1, 1)"];
  for (const role of ['anon', 'authenticated']) {
    for (const t of tables) {
      await assert.rejects(h.pg.transaction(async (tx) => { await tx.exec(`set local role ${role}`); await tx.query(`select * from public.${t}`); }), /permission denied/i, `${role} lê ${t}`);
    }
    await assert.rejects(h.pg.transaction(async (tx) => { await tx.exec(`set local role ${role}`); await tx.query("insert into public.admin_users (user_id, role) values (gen_random_uuid(), 'admin')"); }), /permission denied/i, `${role} não vira admin`);
    for (const f of fns) {
      await assert.rejects(h.pg.transaction(async (tx) => { await tx.exec(`set local role ${role}`); await tx.query(`select public.${f}`); }), /permission denied/i, `${role} executa ${f}`);
    }
  }
});

test('plans (público): só GET, só origem do site, nada além do necessário', async () => {
  assert.equal((await read(await h.plans(req(`${FN_BASE}/plans`, { origin: 'https://evil.example' })))).status, 403);
  assert.equal((await read(await h.plans(req(`${FN_BASE}/plans`, { method: 'POST', body: {} })))).status, 405);
  const ok = await h.plansList();
  assert.deepEqual(Object.keys(ok.data.plans[0]).sort(), ['description', 'grant_seconds', 'highlight', 'id', 'is_default', 'name', 'price_cents', 'unlimited']);
});

// ---------------------------------------------------------------------------
// Financeiro
// ---------------------------------------------------------------------------
test('receita: só pagamentos aprovados e não-teste; pendente, expirado, recusado, estornado e teste ficam de fora', async () => {
  const now = new Date().toISOString();
  await seed({ mac: MAC_A, paymentId: '1' });                                                   // aprovado R$ 5
  await seed({ mac: MAC_B, cents: 200, secs: 3600, plan: '1 hora', paymentId: '2' });           // aprovado R$ 2
  await seed({ mac: MAC_C, status: 'pending', expires: new Date(Date.now() + 600000).toISOString(), paymentId: '3', created: now });
  await seed({ mac: MAC_C, status: 'expired', paymentId: '4', created: now });
  await seed({ mac: MAC_C, status: 'failed', paymentId: '5', created: now });
  await seed({ mac: MAC_C, status: 'refunded', paymentId: '6', refundedAt: now });
  await seed({ mac: MAC_C, test: true, secs: 180, plan: null, paymentId: 'TESTE-1' });
  const d = (await dash()).data.overview;
  assert.equal(d.sales_count, 2); assert.equal(d.revenue_cents, 700); assert.equal(d.avg_ticket_cents, 350);
  assert.equal(d.refunds_count, 1); assert.equal(d.refunds_cents, 500);
  assert.equal(d.pending_count, 1); assert.equal(d.pending_cents, 500);
  assert.equal(d.test_orders_excluded, 1); assert.equal(d.devices_served, 2);
  assert.equal(d.seconds_sold, 18000 + 3600);
  assert.deepEqual(d.by_plan.map((p) => [p.name, p.sales, p.revenue_cents]), [['5 horas', 1, 500], ['1 hora', 1, 200]]);
  assert.equal(d.by_plan[0].share_pct, 71.4);
});

test('ticket médio sem vendas é nulo (sem divisão por zero) e estados vazios são consistentes', async () => {
  const d = await dash({ preset: 'today' });
  assert.equal(d.status, 200);
  assert.equal(d.data.overview.sales_count, 0); assert.equal(d.data.overview.revenue_cents, 0);
  assert.equal(d.data.overview.avg_ticket_cents, null); assert.equal(d.data.overview.revenue_change_pct, null);
  assert.equal(d.data.recent.length, 0); assert.deepEqual(d.data.overview.by_plan, []);
});

test('variação: compara com o período anterior equivalente (mesmo tamanho, imediatamente antes)', async () => {
  const day = (offset) => new Date(Date.now() - offset * 86400000).toISOString();
  await seed({ mac: MAC_A, paidAt: day(0.1), paymentId: 'a' }); await seed({ mac: MAC_B, paidAt: day(0.2), paymentId: 'b' }); await seed({ mac: MAC_C, paidAt: day(0.3), paymentId: 'c' });
  await seed({ mac: MAC_A, paidAt: day(8), paymentId: 'd' }); await seed({ mac: MAC_B, paidAt: day(9), paymentId: 'e' });
  await seed({ mac: MAC_C, paidAt: day(20), paymentId: 'f' });     // fora das duas janelas de 7 dias
  const o = (await dash({ preset: 'last7' })).data.overview;
  assert.equal(o.sales_count, 3); assert.equal(o.prev_sales_count, 2);
  assert.equal(o.revenue_change_pct, 50); assert.equal(o.sales_change_pct, 50);
});

test('série do gráfico: hora para 1 dia e dia para vários; fuso America/Fortaleza; intervalos sem venda com zero', async () => {
  // 10/03/2026 em Fortaleza (UTC-3) = 03:00Z do dia 10 até 03:00Z do dia 11
  await seed({ mac: MAC_A, paidAt: '2026-03-10T05:30:00Z', paymentId: 's1' });               // 02:30 local
  await seed({ mac: MAC_B, cents: 200, paidAt: '2026-03-10T05:50:00Z', paymentId: 's2' });   // 02:50 local (mesma hora)
  await seed({ mac: MAC_C, paidAt: '2026-03-11T02:30:00Z', paymentId: 's3' });               // 23:30 local do dia 10
  await seed({ mac: MAC_C, paidAt: '2026-03-11T03:30:00Z', paymentId: 's4' });               // 00:30 local do dia 11 (fora)
  await seed({ mac: MAC_C, paidAt: '2026-03-10T02:30:00Z', paymentId: 's5' });               // 23:30 local do dia 9 (fora)
  const one = (await dash({ preset: 'custom', start: '2026-03-10', end: '2026-03-10' })).data;
  assert.equal(one.series.bucket, 'hour'); assert.equal(one.series.points.length, 24);
  assert.equal(one.series.points[0].label, '2026-03-10T00:00');
  const at = (label) => one.series.points.find((p) => p.label === label);
  assert.deepEqual([at('2026-03-10T02:00').sales, at('2026-03-10T02:00').revenue_cents], [2, 700]);
  assert.deepEqual([at('2026-03-10T23:00').sales, at('2026-03-10T23:00').revenue_cents], [1, 500]);
  assert.equal(at('2026-03-10T10:00').sales, 0, 'hora sem venda = zero');
  assert.equal(one.overview.sales_count, 3);
  const many = (await dash({ preset: 'custom', start: '2026-03-09', end: '2026-03-11' })).data;
  assert.equal(many.series.bucket, 'day'); assert.equal(many.series.points.length, 3);
  assert.deepEqual(many.series.points.map((p) => p.sales), [1, 3, 1]);
  assert.equal((await dash({ preset: 'custom', start: '2026-03-12', end: '2026-03-10' })).status, 400);
  assert.equal((await dash({ preset: 'custom', start: '2024-01-01', end: '2026-03-10' })).status, 400, 'período grande demais');
  assert.equal((await dash({ preset: 'xyz' })).status, 400);
});

test('presets de período: hoje, ontem, 7/30 dias e mês atual coerentes no fuso configurado', async () => {
  const get = async (preset) => h.rpc('hotspot_admin_period', { p_preset: preset });
  const today = await get('today'), yest = await get('yesterday'), l7 = await get('last7'), l30 = await get('last30'), mon = await get('month');
  assert.equal(yest.to, today.from); assert.equal(today.bucket, 'hour'); assert.equal(l7.bucket, 'day');
  assert.equal(Date.parse(today.to) - Date.parse(today.from), 86400000);
  assert.equal(Date.parse(l7.to) - Date.parse(l7.from), 7 * 86400000); assert.equal(Date.parse(l30.to) - Date.parse(l30.from), 30 * 86400000);
  assert.ok(mon.start_date.endsWith('-01')); assert.equal(today.timezone, 'America/Fortaleza');
});

test('estornos e taxas são separados da receita; receita líquida só quando TODAS as taxas são conhecidas', async () => {
  await seed({ mac: MAC_A, paymentId: 'f1' }); await seed({ mac: MAC_B, paymentId: 'f2' });
  await h.q("update public.hotspot_orders set mp_fee_cents = 4, mp_net_cents = 496 where payment_id = 'f1'");
  let o = (await dash()).data.overview;
  assert.equal(o.net_estimated_cents, null, 'taxa de uma venda desconhecida: sem líquido estimado'); assert.equal(o.fees_known_for, 1);
  await h.q("update public.hotspot_orders set mp_fee_cents = 4, mp_net_cents = 496 where payment_id = 'f2'");
  o = (await dash()).data.overview; assert.equal(o.net_estimated_cents, 992); assert.equal(o.revenue_cents, 1000);
});

test('taxas do Mercado Pago chegam pelo webhook (melhor esforço) e nunca derrubam o pagamento', async () => {
  const c = await h.createPix(MAC_A); const pid = [...h.mp.payments.keys()].at(-1);
  h.mp.approve(pid); Object.assign(h.mp.get(pid), { fee_details: [{ type: 'mercadopago_fee', amount: 0.04 }], transaction_details: { net_received_amount: 4.96 } });
  assert.equal((await h.webhook(pid)).data.result, 'paid');
  const o = await h.order(c.data.order_id); assert.equal(o.mp_fee_cents, 4); assert.equal(o.mp_net_cents, 496);
  assert.deepEqual(h.common.paymentFees({ fee_details: 'x' }), null);
  await h.createPix(MAC_B); const pid2 = [...h.mp.payments.keys()].at(-1); h.mp.approve(pid2);
  assert.equal((await h.webhook(pid2)).data.result, 'paid', 'sem campos de taxa: ok');
});

test('relatórios por dia/semana/mês e CSV (sem injeção de fórmulas; testes fora)', async () => {
  await seed({ mac: MAC_A, paidAt: '2026-03-09T15:00:00Z', paymentId: 'r1', provisioned: true }); await seed({ mac: MAC_B, cents: 200, secs: 3600, paidAt: '2026-03-09T16:00:00Z', paymentId: 'r2', plan: '=HYPERLINK("x")', provisioned: true });
  await seed({ mac: MAC_C, paidAt: '2026-03-17T15:00:00Z', paymentId: 'r3', provisioned: true }); await seed({ mac: MAC_C, test: true, paidAt: '2026-03-09T15:00:00Z', paymentId: 'TESTE-2', plan: null, secs: 180 });
  const base = { preset: 'custom', start: '2026-03-01', end: '2026-03-31' };
  const day = (await h.admin('report', { ...base, group: 'day' }, admin.token)).data;
  assert.deepEqual(day.rows.map((r) => [r.period, r.sales, r.revenue_cents]), [['2026-03-09', 2, 700], ['2026-03-17', 1, 500]]);
  assert.equal(day.totals.sales, 3); assert.equal(day.totals.revenue_cents, 1200); assert.equal(day.totals.avg_ticket_cents, 400);
  const week = (await h.admin('report', { ...base, group: 'week' }, admin.token)).data; assert.equal(week.rows.length, 2);
  const month = (await h.admin('report', { ...base, group: 'month' }, admin.token)).data; assert.equal(month.rows.length, 1); assert.equal(month.rows[0].sales, 3);
  assert.equal(month.rows[0].seconds_sold, 18000 + 3600 + 18000);
  assert.equal((await h.admin('report', { ...base, group: 'ano' }, admin.token)).status, 400);
  const csv = (await h.admin('report_csv', { ...base, group: 'day' }, admin.token)).data;
  assert.match(csv.csv, /^periodo_inicio;vendas;receita_brl/); assert.match(csv.csv, /2026-03-09;2;7,00;3,50/);
  const pay = (await h.admin('orders_csv', { status: 'provisioned' }, admin.token)).data;
  assert.doesNotMatch(pay.csv, /;=HYPERLINK/, 'fórmulas neutralizadas'); assert.match(pay.csv, /'=HYPERLINK/);
});

test('pagamentos: lista paginada, filtros por situação, busca e a diferença entre "aprovado" e "crédito provisionado"', async () => {
  await seed({ mac: MAC_A, paymentId: '9001', provisioned: true });                      // provisionado
  await seed({ mac: MAC_B, paymentId: '9002' });                                         // aprovado aguardando provisionamento
  await seed({ mac: MAC_C, status: 'pending', paymentId: '9003', expires: new Date(Date.now() + 600000).toISOString() });
  await seed({ mac: MAC_C, status: 'pending', paymentId: '9004', expires: new Date(Date.now() - 600000).toISOString() }); // vencido
  await seed({ mac: MAC_C, status: 'failed', paymentId: '9005', mpStatus: 'rejected' });
  await seed({ mac: MAC_C, status: 'failed', paymentId: '9006', mpStatus: 'cancelled' });
  await seed({ mac: MAC_C, status: 'refunded', paymentId: '9007', refundedAt: new Date().toISOString() });
  const all = (await h.admin('orders', {}, admin.token)).data; assert.equal(all.total, 7);
  const states = Object.fromEntries(all.rows.map((r) => [r.payment_id, r.state]));
  assert.deepEqual(states, { 9001: 'provisioned', 9002: 'approved_waiting', 9003: 'pending', 9004: 'expired', 9005: 'failed', 9006: 'cancelled', 9007: 'refunded' });
  for (const [st, id] of [['provisioned', '9001'], ['approved_waiting', '9002'], ['pending', '9003'], ['expired', '9004'], ['failed', '9005'], ['cancelled', '9006'], ['refunded', '9007']]) {
    const r = (await h.admin('orders', { status: st }, admin.token)).data; assert.deepEqual(r.rows.map((x) => x.payment_id), [id], st);
  }
  assert.equal((await h.admin('orders', { q: '9003' }, admin.token)).data.total, 1);
  assert.equal((await h.admin('orders', { q: MAC_A.toLowerCase() }, admin.token)).data.total, 1);
  assert.equal((await h.admin('orders', { q: '%' }, admin.token)).data.total, 0, 'curingas não são interpretados');
  const p1 = (await h.admin('orders', { limit: 3, offset: 0 }, admin.token)).data; const p3 = (await h.admin('orders', { limit: 3, offset: 6 }, admin.token)).data;
  assert.equal(p1.rows.length, 3); assert.equal(p3.rows.length, 1); assert.equal(p1.total, 7);
  assert.equal((await h.admin('orders', { status: 'inventado' }, admin.token)).status, 400);
});

// ---------------------------------------------------------------------------
// Roteador, sessões e alertas
// ---------------------------------------------------------------------------
async function tel(entries, online, key = ENV.ROUTER_SHARED_KEY) {
  return read(await h.routerSync(req(`${FN_BASE}/router-sync`, { method: 'POST', origin: null, body: `tel=${entries}&online=${online}`,
    headers: { 'x-router-key': key, 'content-type': 'application/x-www-form-urlencoded' } })));
}

test('parser de tempo do RouterOS: formas "1h2m3s" e "1d02:03:04"; lixo é recusado', () => {
  const p = h.common.parseRosDuration;
  assert.equal(p('5h'), 18000); assert.equal(p('3m5s'), 185); assert.equal(p('1w2d3h4m5s'), (((9 * 24) + 3) * 60 + 4) * 60 + 5);
  assert.equal(p('00:03:00'), 180); assert.equal(p('1d02:03:04'), 86400 + 2 * 3600 + 184); assert.equal(p('1w1d00:00:00'), 8 * 86400);
  assert.equal(p('0s'), 0);
  for (const bad of ['', 'abc', '1h2x', '00:61:00', '1:2:3', '5 horas', null, undefined, '--1s', '1h1h']) assert.equal(p(bad), null, String(bad));
});

test('telemetria exige a chave do roteador, aceita só aparelhos conhecidos e entradas válidas (sem uma requisição por aparelho)', async () => {
  await h.payOrder(MAC_A); await router.poll();
  assert.equal((await tel(`${MAC_A}_192.168.88.10_3m5s_5h_1`, 1, 'chave-errada')).status, 401);
  assert.equal((await read(await h.routerSync(req(`${FN_BASE}/router-sync`, { method: 'POST', origin: null, body: `tel=${MAC_A}_x_1s_1s_1`, headers: { 'content-type': 'application/x-www-form-urlencoded' } })))).status, 401);
  const entries = [`${MAC_A}_192.168.88.10_00:03:05_5h0m0s_1`, `${MAC_B}_192.168.88.11_1s_1h_1` /* sem pedido: ignorado */, 'lixo', `${MAC_A}_1.2.3_x_1h_1`, 'ZZ:ZZ_1.1.1.1_1s_1h_1'].join(',');
  const r = await tel(entries, 7); assert.equal(r.status, 200); assert.equal(r.data.accepted, 1);
  const dev = (await h.q('select * from public.hotspot_device_state'));
  assert.equal(dev.length, 1); assert.equal(dev[0].device_mac, MAC_A); assert.equal(dev[0].ip, '192.168.88.10');
  assert.equal(dev[0].uptime_seconds, 185); assert.equal(dev[0].limit_seconds, 18000); assert.equal(dev[0].session_active, true);
  assert.equal((await tel('x'.repeat(2001), 1)).status, 400);
  assert.equal((await h.q('select sessions_online from public.hotspot_router_state'))[0].sessions_online, 7);
});

test('dispositivos online = sessões autenticadas do roteador; tempo restante vem do limit-uptime e uptime reais', async () => {
  await h.payOrder(MAC_A); await h.payOrder(MAC_B); await router.poll();
  await tel(`${MAC_A}_192.168.88.10_1h20m_5h_1,${MAC_B}_192.168.88.11_10m_5h_0`, 12);
  const live = (await h.admin('dashboard', {}, admin.token)).data.live;
  assert.equal(live.sessions_online, 12, 'contagem de sessões autenticadas informada pelo MikroTik (inclui qualquer sessão ativa)');
  const devs = (await h.admin('devices', {}, admin.token)).data.rows; const a = devs.find((d) => d.mac === MAC_A), b = devs.find((d) => d.mac === MAC_B);
  assert.equal(a.online, true); assert.equal(a.remaining_seconds, 3 * 3600 + 40 * 60); assert.equal(a.used_seconds, 4800); assert.equal(a.limit_seconds, 18000);
  assert.equal(b.online, false, 'sessão encerrada não é online'); assert.equal(b.remaining_seconds, 5 * 3600 - 600);
  assert.equal(a.purchases, 1); assert.equal(a.total_paid_cents, 500); assert.equal(a.credit_state, 'active'); assert.equal(a.telemetry_fresh, true);
  const det = (await h.admin('device', { mac: MAC_A }, admin.token)).data; assert.equal(det.orders.length, 1); assert.equal(det.telemetry.ip, '192.168.88.10');
  assert.equal((await h.admin('device', { mac: 'xx' }, admin.token)).status, 400);
});

test('telemetria antiga NÃO aparece como atual: sessões viram "não disponível" e o painel sinaliza dados desatualizados', async () => {
  await h.payOrder(MAC_A); await router.poll();
  await tel(`${MAC_A}_192.168.88.10_10m_5h_1`, 5);
  await h.q("update public.hotspot_router_state set last_telemetry_at = now() - interval '10 minutes'");
  await h.q("update public.hotspot_device_state set reported_at = now() - interval '10 minutes'");
  const live = (await h.admin('dashboard', {}, admin.token)).data.live;
  assert.equal(live.sessions_online, null, 'sem contagem regressiva nem sessão "online" inventada');
  assert.equal(live.sessions_last_known, 5); assert.equal(live.router.telemetry_fresh, false); assert.equal(live.router.integration, 'telemetry_stale');
  assert.ok(live.alerts.some((x) => x.code === 'telemetry_stale'));
  const a = (await h.admin('devices', {}, admin.token)).data.rows[0];
  assert.equal(a.online, false); assert.equal(a.telemetry_fresh, false); assert.equal(a.session_active_last_known, true); assert.equal(a.remaining_seconds, 5 * 3600 - 600, 'última informação conhecida (com carimbo de data)');
  assert.ok(a.reported_at);
});

test('roteador offline/online: limite configurável, último contato e reconexão', async () => {
  let live = (await h.admin('dashboard', {}, admin.token)).data.live;
  assert.equal(live.router.online, false); assert.equal(live.routers_total, 1); assert.equal(live.routers_online, 0); assert.equal(live.router.integration, 'never');
  assert.ok(live.alerts.some((x) => x.code === 'router_offline'));
  await h.routerPull();                                                   // o wifi-poll consulta: último contato
  live = (await h.admin('dashboard', {}, admin.token)).data.live;
  assert.equal(live.router.online, true); assert.equal(live.routers_online, 1); assert.ok(live.router.seconds_since_contact <= 2);
  assert.ok(!live.alerts.some((x) => x.code === 'router_offline'));
  assert.equal(live.router.integration, 'no_telemetry');
  await h.q("update public.hotspot_router_state set last_seen_at = now() - interval '5 minutes'");
  live = (await h.admin('dashboard', {}, admin.token)).data.live; assert.equal(live.router.online, false); assert.equal(live.sessions_online, null);
  assert.equal((await h.admin('setting_set', { key: 'router_offline_seconds', value: '900' }, admin.token)).status, 200);
  live = (await h.admin('dashboard', {}, admin.token)).data.live; assert.equal(live.router.online, true, 'limite configurável pelo painel');
  await h.routerPull(); live = (await h.admin('dashboard', {}, admin.token)).data.live; assert.ok(live.router.seconds_since_contact <= 2, 'reconexão atualiza o último contato');
});

test('configurações: só administrador altera, valores validados e tudo auditado', async () => {
  for (const bad of [{ key: 'router_offline_seconds', value: '10' }, { key: 'router_offline_seconds', value: '999999' }, { key: 'router_offline_seconds', value: 'abc' }, { key: 'timezone', value: 'UTC' }, { key: 'x', value: '1' }, { key: 'router_name', value: '' }]) {
    assert.equal((await h.admin('setting_set', bad, admin.token)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await h.admin('setting_set', { key: 'router_name', value: 'MikroTik ônibus 1' }, admin.token)).status, 200);
  assert.equal((await h.admin('dashboard', {}, admin.token)).data.live.router.name, 'MikroTik ônibus 1');
  assert.ok((await h.admin('audit', {}, admin.token)).data.entries.some((e) => e.action === 'setting_update' && e.entity_id === 'router_name'));
});

test('alertas reais: pagamento aprovado aguardando liberação e falhas recorrentes de cobrança (e nada quando está tudo bem)', async () => {
  await h.routerPull();
  let live = (await h.admin('dashboard', {}, admin.token)).data.live; assert.deepEqual(live.alerts, []);
  await seed({ mac: MAC_A, paidAt: new Date(Date.now() - 20 * 60000).toISOString(), paymentId: 'w1' });
  live = (await h.admin('dashboard', {}, admin.token)).data.live;
  const w = live.alerts.find((a) => a.code === 'paid_waiting'); assert.ok(w); assert.equal(w.count, 1); assert.ok(w.since);
  await seed({ mac: MAC_B, paidAt: new Date(Date.now() - 20 * 60000).toISOString(), paymentId: 'w2', test: true });
  live = (await h.admin('dashboard', {}, admin.token)).data.live; assert.equal(live.alerts.find((a) => a.code === 'paid_waiting').count, 1, 'crédito de teste não alerta');
  for (const i of [1, 2, 3]) await seed({ mac: MAC_C, status: 'failed', paymentId: `x${i}`, created: new Date().toISOString() });
  live = (await h.admin('dashboard', {}, admin.token)).data.live; assert.ok(live.alerts.some((a) => a.code === 'payment_failures'));
});

test('passes ativos = aparelhos com crédito ainda disponível (não confunde com sessões conectadas)', async () => {
  await h.payOrder(MAC_A); await h.payOrder(MAC_B); await router.poll();
  assert.equal((await h.admin('dashboard', {}, admin.token)).data.live.active_passes, 2);
  router.use(MAC_A, 99 * H); await router.poll();
  assert.equal((await h.admin('dashboard', {}, admin.token)).data.live.active_passes, 1, 'crédito esgotado sai dos passes ativos');
  await h.payOrder(MAC_A); await router.poll();
  assert.equal((await h.admin('dashboard', {}, admin.token)).data.live.active_passes, 2, 'nova compra reativa');
});

test('privacidade: limpar pedidos antigos remove também o estado de telemetria do aparelho', async () => {
  await h.payOrder(MAC_A); await router.poll(); await tel(`${MAC_A}_192.168.88.10_1m_5h_1`, 1);
  assert.equal((await h.q('select count(*)::int n from public.hotspot_device_state'))[0].n, 1);
  await h.q("update public.hotspot_orders set created_at = now() - interval '3 days'");
  await h.rpc('hotspot_purge', { p_days: 1 });
  assert.equal((await h.q('select count(*)::int n from public.hotspot_device_state'))[0].n, 0);
});

// ---------------------------------------------------------------------------
// Telemetria ponta a ponta com o modelo do script (blocos, formato de tempo, reboot, sessão encerrada)
// ---------------------------------------------------------------------------
test('telemetria do wifi-poll (modelo): sessões, uso e limite chegam ao painel; blocos de até 10; sem uma requisição por aparelho', async () => {
  const macs = Array.from({ length: 23 }, (_, i) => `AA:BB:CC:00:10:${String(i + 10).padStart(2, '0')}`);
  for (const m of macs) await h.payOrder(m);
  await router.poll(); await router.poll(); await router.poll();            // o roteador recebe até 10 créditos por consulta
  macs.slice(0, 7).forEach((m) => router.sessions.add(m));
  router.use(macs[0], 4800); router.use(macs[1], 600);
  await router.telemetry();
  assert.equal(router.telPosts.length, 3, '23 aparelhos = 3 requisições (não 23)');
  assert.deepEqual(router.telPosts.map((p) => p.entries), [10, 10, 3]); assert.ok(router.telPosts.every((p) => p.status === 200));
  const live = (await h.admin('dashboard', {}, admin.token)).data.live; assert.equal(live.sessions_online, 7);
  const devs = (await h.admin('devices', { limit: 100 }, admin.token)).data.rows;
  const d0 = devs.find((d) => d.mac === macs[0]), d9 = devs.find((d) => d.mac === macs[9]);
  assert.equal(d0.online, true); assert.equal(d0.used_seconds, 4800); assert.equal(d0.remaining_seconds, 18000 - 4800); assert.equal(d0.ip, '192.168.88.10');
  assert.equal(d9.online, false); assert.equal(d9.remaining_seconds, 18000);
});

test('telemetria: sessão encerrada vira offline, reboot zera sessões, nova compra soma ao limite e esgotado mostra restante 0', async () => {
  await h.payOrder(MAC_A); await router.poll(); router.sessions.add(MAC_A); router.use(MAC_A, 3600);
  await router.telemetry();
  let d = (await h.admin('devices', {}, admin.token)).data.rows[0]; assert.equal(d.online, true); assert.equal(d.remaining_seconds, 18000 - 3600);
  router.sessions.delete(MAC_A); await router.telemetry();
  d = (await h.admin('devices', {}, admin.token)).data.rows[0]; assert.equal(d.online, false); assert.equal(d.remaining_seconds, 18000 - 3600, 'desconectar não faz perder o tempo restante');
  assert.ok(d.last_seen, 'última atividade preservada');
  router.sessions.add(MAC_A); router.reboot(); await router.telemetry();
  assert.equal((await h.admin('dashboard', {}, admin.token)).data.live.sessions_online, 0, 'reboot: sem sessões');
  await h.payOrder(MAC_A); await router.poll(); await router.telemetry();
  d = (await h.admin('devices', {}, admin.token)).data.rows[0]; assert.equal(d.limit_seconds, 36000); assert.equal(d.remaining_seconds, 36000 - 3600);
  router.use(MAC_A, 99 * H); await router.poll(); await router.telemetry();
  d = (await h.admin('devices', {}, admin.token)).data.rows[0]; assert.equal(d.remaining_seconds, 0); assert.equal(d.credit_state, 'exhausted');
});

test('script do roteador: telemetria só lê o Hotspot, usa a mesma chave e validação TLS, em blocos e a cada 60 s', async () => {
  const { readFileSync } = await import('node:fs');
  const rsc = readFileSync(new URL('../router/hotspot-poll.rsc', import.meta.url), 'utf8').split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n');
  assert.ok(rsc.includes(':local telEvery 60s')); assert.ok(rsc.includes('(($now - $wifiTelLast) >= $telEvery)'));
  assert.ok(rsc.includes('if ($nb >= 10)'), 'blocos de 10');
  const tel = rsc.slice(rsc.indexOf('Telemetria')); const part = rsc.slice(rsc.indexOf(':set wifiTelLast $now'));
  assert.ok(part.includes('/ip hotspot active find') && part.includes('limit-uptime'));
  assert.doesNotMatch(part, /\/ip hotspot (user|active) (add|set|remove|disable)|\/file (set|remove|print)|\/system|\/ip firewall/, 'telemetria não altera nada no roteador');
  assert.ok(tel.length > 0);
});
