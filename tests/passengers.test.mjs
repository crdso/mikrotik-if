// Passageiros: cadastro obrigatório (nome + e-mail), presença de aparelhos, painel e privacidade.
// Banco REAL (PGlite), funções reais, Mercado Pago simulado. Nenhum teste usa serviços externos nem gera pagamento real.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, req, read, FN_BASE, ENV, MAC_A, MAC_B } from './helpers/harness.mjs';
import { RouterSim } from './helpers/router-sim.mjs';

const MAC_C = 'AA:BB:CC:DD:EE:03';
const MAC_D = 'AA:BB:CC:DD:EE:04';
const MAC_E = 'AA:BB:CC:DD:EE:05';
const MAC_F = 'AA:BB:CC:DD:EE:06';
const dash = (m) => m.replaceAll(':', '-');

let h; let router; let adm; let op;
before(async () => { h = await createHarness(); adm = await h.makeUser('admin@example.org', 'admin'); op = await h.makeUser('operador@example.org', 'operator'); });
after(async () => { await h.close(); });
beforeEach(async () => {
  for (const t of ['hotspot_router_commands', 'hotspot_access', 'hotspot_blocks', 'hotspot_orders', 'hotspot_known_hosts', 'hotspot_passengers', 'hotspot_passenger_history', 'hotspot_device_state', 'hotspot_device_credit']) await h.q(`delete from public.${t}`);
  await h.q("delete from public.hotspot_settings where key in ('hosts_feed_at', 'maintenance_at')");
  await h.q('delete from public.admin_audit_log');
  h.mp.reset(); h.state.failRpc = null;
  router = new RouterSim(h);
});

const preq = (body, o = {}) => req(`${FN_BASE}/passenger`, { method: 'POST', body, ...o });
const reg = async (mac, name = 'Maria Souza Lima', email = 'maria@example.com') => read(await h.passenger(preq({ mac, name, email })));
const hint = async (mac) => read(await h.passenger(req(`${FN_BASE}/passenger?mac=${mac}`)));
const feed = (...entries) => h.routerPull(undefined, 'text', entries.map((e) => (Array.isArray(e) ? `${dash(e[0])}|${e[1]}|${e[2] || 'n'}` : dash(e)) + ';').join(''));
const people = async (filter = 'all', q = '') => (await h.admin('passengers', { filter, q }, adm.token)).data;
const payWith = async (mac, name, email) => {
  const created = await h.createPix(mac, email, { name }); const paymentId = [...h.mp.payments.keys()].at(-1);
  h.mp.approve(paymentId); await h.webhook(paymentId); return { created: created.data, paymentId };
};
const rowOf = async (mac) => (await people()).rows.find((r) => r.mac === mac);

// ============================== cadastro ==============================
test('cadastro válido: grava nome + e-mail (e-mail em minúsculas), um registro por MAC, e NÃO concede crédito', async () => {
  await feed(MAC_A);
  const r = await reg(MAC_A, '  Maria   Souza  Lima ', 'Maria@example.COM ');
  assert.equal(r.status, 200); assert.equal(r.data.action, 'created');
  const p = (await h.q('select * from public.hotspot_passengers'))[0];
  assert.equal(p.full_name, 'Maria Souza Lima'); assert.equal(p.email, 'maria@example.com'); assert.equal(p.device_mac, MAC_A);
  assert.equal((await reg(MAC_A, 'Maria Souza Lima', 'maria@example.com')).data.action, 'unchanged');
  assert.equal((await h.q('select count(*)::int n from public.hotspot_passengers'))[0].n, 1, 'sem duplicidade por MAC');
  assert.equal(await h.rpc('hotspot_device_credit_state', { p_mac: MAC_A }), 'none', 'cadastro não libera internet');
  assert.equal((await h.routerPull(undefined, 'json')).data.orders.length, 0, 'nenhum crédito entregue ao roteador');
  assert.equal(h.mp.calls.length, 0, 'nada vai ao Mercado Pago');
});

test('validação no backend: vazio, curto, número, símbolos, tags, longo demais e e-mail inválido são recusados', async () => {
  await feed(MAC_A);
  for (const [name, email, status] of [
    ['', 'a@b.co', 400], ['Maria', 'a@b.co', 400], ['M S', 'a@b.co', 400], ['Maria 123', 'a@b.co', 400], ['Maria <b>S</b>', 'a@b.co', 400],
    ['=cmd|x Silva', 'a@b.co', 400], ['A'.repeat(81) + ' Silva', 'a@b.co', 400], ['Maria Souza', '', 400], ['Maria Souza', 'sem-arroba', 400],
    ['Maria Souza', `${'a'.repeat(250)}@b.co`, 400], ['Maria Souza', 'a b@b.co', 400],
  ]) {
    const r = await reg(MAC_A, name, email);
    assert.equal(r.status, status, `${name.slice(0, 20)} / ${email.slice(0, 20)}`);
  }
  assert.equal((await h.q('select count(*)::int n from public.hotspot_passengers'))[0].n, 0);
  assert.equal((await reg('zz')).status, 400);
  assert.equal((await read(await h.passenger(preq({ mac: MAC_A, name: 'Maria Souza', email: 'a@b.co', lixo: 'x'.repeat(3000) })))).status, 413);
  assert.ok((await reg(MAC_A, "D'Ávila Ünal-Nóbrega Jr.", 'a@b.co')).data.ok, 'acentos, apóstrofo, hífen e ponto são aceitos');
});

test('MAC desconhecido pelo roteador não consegue cadastro (não aceita associação arbitrária)', async () => {
  await feed(MAC_A);
  const r = await reg(MAC_B);
  assert.equal(r.status, 403); assert.match(r.data.error, /Não reconhecemos este aparelho/);
  assert.equal((await h.q('select count(*)::int n from public.hotspot_passengers'))[0].n, 0);
  assert.equal((await reg(MAC_A)).status, 200);
});

test('limite contra spam: muitas alterações no mesmo aparelho -> 429; dados idênticos não contam', async () => {
  await feed(MAC_A);
  let limited = 0;
  for (let i = 0; i < 30; i++) { const r = await reg(MAC_A, `Maria Souza ${'abcdefghijklmnopqrstuvwxyzabcd'[i]}ilva`, 'maria@example.com'); if (r.status === 429) limited++; }
  assert.ok(limited > 0, 'houve bloqueio');
  assert.ok((await h.q('select count(*)::int n from public.hotspot_passenger_history'))[0].n <= 5, 'histórico limitado');
  for (let i = 0; i < 40; i++) assert.ok([200, 429].includes((await reg(MAC_A, 'Maria Souza Lima', 'maria@example.com')).status));
});

test('limite global de cadastros novos em 10 minutos', async () => {
  const macs = Array.from({ length: 12 }, (_, i) => `02:00:00:00:00:${i.toString(16).padStart(2, '0').toUpperCase()}`);
  await feed(...macs);
  await h.q(`insert into public.hotspot_passenger_history (device_mac, full_name, email)
             select 'AA:AA:AA:' || upper(lpad(to_hex(i / 256), 2, '0')) || ':' || upper(lpad(to_hex(i % 256), 2, '0')) || ':01', 'X Y Z', 'x@b.co' from generate_series(1, 300) i`);
  assert.equal((await reg(macs[0])).status, 429);
});

test('dica no portal: só dados MASCARADOS e só para aparelho presente na rede', async () => {
  await feed(MAC_A);
  assert.equal((await hint(MAC_A)).data.registered, false);
  await reg(MAC_A, 'João Carlos Silva', 'joao.silva@example.com');
  const ok = await hint(MAC_A);
  assert.equal(ok.data.registered, true); assert.equal(ok.data.name_hint, 'João S.'); assert.equal(ok.data.email_hint, 'j***@example.com');
  assert.doesNotMatch(ok.text, /joao\.silva|Carlos/);
  assert.equal((await hint(MAC_B)).data.registered, false, 'aparelho que o roteador não vê');
  assert.equal((await read(await h.passenger(req(`${FN_BASE}/passenger?mac=lixo`)))).data.registered, false);
});

test('passenger: origem proibida, método errado e CORS', async () => {
  const bad = await read(await h.passenger(preq({ mac: MAC_A, name: 'Maria Souza', email: 'a@b.co' }, { origin: 'https://evil.example' })));
  assert.equal(bad.status, 403);
  assert.equal((await read(await h.passenger(req(`${FN_BASE}/passenger`, { method: 'DELETE' })))).status, 405);
  const pre = await h.passenger(req(`${FN_BASE}/passenger`, { method: 'OPTIONS' }));
  assert.equal(pre.headers.get('access-control-allow-origin'), ENV.SITE_ORIGIN);
});

// ============================== pagamento ==============================
test('Pix exige cadastro: sem nome/e-mail -> 428, nada vai ao Mercado Pago; com cadastro guardado no servidor, gera Pix', async () => {
  await feed(MAC_A);
  const noReg = await read(await h.createPayment(req(`${FN_BASE}/create-payment`, { method: 'POST', body: { mac: MAC_A } })));
  assert.equal(noReg.status, 428); assert.equal(noReg.data.registration_required, true);
  assert.equal(h.mp.calls.length, 0); assert.equal((await h.q('select count(*)::int n from public.hotspot_orders'))[0].n, 0);
  await reg(MAC_A, 'Maria Souza Lima', 'Maria@example.COM');
  const ok = await read(await h.createPayment(req(`${FN_BASE}/create-payment`, { method: 'POST', body: { mac: MAC_A } })));
  assert.equal(ok.status, 200); assert.equal(h.mp.creates().length, 1);
  assert.equal(h.mp.creates()[0].body.payer.email, 'maria@example.com', 'e-mail do cadastro vai ao MP como payer.email');
  assert.equal(h.mp.creates()[0].body.transaction_amount, 25, 'preço do produto da viagem definido no servidor');
});

test('cadastro inline no create-payment (nome + e-mail no mesmo pedido) grava e gera o Pix', async () => {
  await feed(MAC_A);
  const r = await h.createPix(MAC_A, 'passageiro@example.org', { name: 'Pedro Alves Neto' });
  assert.equal(r.status, 200);
  const p = (await h.q('select * from public.hotspot_passengers'))[0];
  assert.equal(p.full_name, 'Pedro Alves Neto'); assert.equal(p.email, 'passageiro@example.org');
  const bad = await read(await h.createPayment(req(`${FN_BASE}/create-payment`, { method: 'POST', body: { mac: MAC_B, name: 'Pedro Alves', email: 'ok@b.co' } })));
  assert.equal(bad.status, 403, 'aparelho desconhecido não gera Pix nem cadastro');
});

test('o pedido guarda nome/e-mail DA COMPRA; corrigir o cadastro depois não reescreve o histórico', async () => {
  await feed(MAC_A);
  await reg(MAC_A, 'Maria Souza Lima', 'maria@example.com');
  const pay = await payWith(MAC_A, 'Maria Souza Lima', 'maria@example.com');
  await reg(MAC_A, 'Outra Pessoa Silva', 'outra@example.com'); // aparelho reutilizado por outra pessoa
  const o = await h.order(pay.created.order_id);
  assert.equal(o.payer_name, 'Maria Souza Lima'); assert.equal(o.payer_email, 'maria@example.com');
  assert.equal(o.amount_cents, 2500);
  const d = (await h.admin('passenger', { mac: MAC_A }, adm.token)).data;
  assert.equal(d.person.full_name, 'Outra Pessoa Silva');
  assert.equal(d.orders[0].payer_name, 'Maria Souza Lima');
  assert.deepEqual(d.history.map((x) => x.full_name), ['Outra Pessoa Silva', 'Maria Souza Lima']);
});

// ============================== presença e telemetria ==============================
test('presença: IP completo, só último octeto, autenticado; formato antigo continua valendo; lixo é ignorado', async () => {
  await feed([MAC_A, '252'], [MAC_B, '192.168.88.77', 'a'], MAC_C, [MAC_D, '999.1.1.1'], [MAC_E, 'abc']);
  const byMac = Object.fromEntries((await h.q('select device_mac, ip, authorized from public.hotspot_known_hosts')).map((r) => [r.device_mac, r]));
  assert.equal(byMac[MAC_A].ip, '192.168.88.252'); assert.equal(byMac[MAC_A].authorized, false);
  assert.equal(byMac[MAC_B].ip, '192.168.88.77'); assert.equal(byMac[MAC_B].authorized, true);
  assert.equal(byMac[MAC_C].ip, null); assert.equal(byMac[MAC_D].ip, null); assert.equal(byMac[MAC_E].ip, null);
});

test('Pix antigo de R$ 5 ainda pendente: ao pagar agora, é conferido no MP e cancelado; o novo Pix é o de R$ 25 da viagem', async () => {
  await feed(MAC_A); await reg(MAC_A);
  await h.useLegacyPlan();
  const old = (await read(await h.createPayment(req(`${FN_BASE}/create-payment`, { method: 'POST', body: { mac: MAC_A } })))).data;
  await h.useTripPlan();
  const r = await read(await h.createPayment(req(`${FN_BASE}/create-payment`, { method: 'POST', body: { mac: MAC_A } })));
  assert.equal(r.status, 200); assert.notEqual(r.data.order_id, old.order_id);
  assert.equal(h.mp.creates().at(-1).body.transaction_amount, 25);
  assert.equal((await h.order(old.order_id)).payment_status, 'failed', 'Pix antigo cancelado só depois de conferido como pendente');
});

test('painel: estados novos e separados, sem inventar nome/e-mail, cada MAC uma vez', async () => {
  await feed([MAC_A, '10'], [MAC_B, '11'], [MAC_C, '12'], [MAC_D, '13'], [MAC_E, '14'], [MAC_F, '15']);
  await reg(MAC_B, 'Bruno Barros Dias', 'bruno@example.com');                                           // aguardando
  await reg(MAC_C, 'Carla Campos Melo', 'carla@example.com'); await h.createPix(MAC_C, 'carla@example.com', { name: 'Carla Campos Melo' }); // Pix pendente
  await reg(MAC_D, 'Diego Dantas Lopes', 'diego@example.com'); await h.payOrder(MAC_D);                  // Pix aprovado -> liberando
  await reg(MAC_E, 'Elisa Esteves Reis', 'elisa@example.com');
  assert.equal((await h.admin('device_action', { mac: MAC_E, op: 'grant' }, adm.token)).status, 200);     // pré-pago liberado
  await reg(MAC_F, 'Fábio Freitas Gomes', 'fabio@example.com');
  await h.q("update public.hotspot_known_hosts set seen_at = now() - interval '10 minutes' where device_mac = $1", [MAC_F]); // saiu da rede

  let st = Object.fromEntries((await people()).rows.map((r) => [r.mac, r]));
  assert.equal(Object.keys(st).length, 6);
  assert.equal(st[MAC_A].status, 'not_identified'); assert.equal(st[MAC_A].full_name, null); assert.equal(st[MAC_A].email, null);
  assert.equal(st[MAC_B].status, 'waiting'); assert.equal(st[MAC_B].full_name, 'Bruno Barros Dias');
  assert.equal(st[MAC_C].status, 'pix_pending');
  assert.equal(st[MAC_D].status, 'provisioning'); assert.equal(st[MAC_D].access_source, 'pix'); assert.equal(st[MAC_D].total_paid_cents, 2500);
  assert.equal(st[MAC_E].status, 'provisioning'); assert.equal(st[MAC_E].access_source, 'manual_prepaid_20'); assert.equal(st[MAC_E].total_paid_cents, 0, 'pré-pago não vira receita do MP');
  assert.equal(st[MAC_F].online, false); assert.equal(st[MAC_F].identified, true);

  // O MikroTik aplica: D e E estão conectados -> autenticam no mesmo ciclo
  for (const [m, x] of [[MAC_A, 10], [MAC_B, 11], [MAC_C, 12], [MAC_D, 13], [MAC_E, 14]]) router.connect(m, `192.168.88.${x}`);
  await router.poll(); await router.poll();
  st = Object.fromEntries((await people()).rows.map((r) => [r.mac, r]));
  assert.equal(st[MAC_D].status, 'internet_active'); assert.equal(st[MAC_E].status, 'internet_active'); assert.equal(st[MAC_E].ip, '192.168.88.14');
  assert.equal(st[MAC_A].status, 'not_identified', 'presença não libera ninguém'); assert.equal(st[MAC_B].status, 'waiting');

  const ids = (f) => people(f).then((r) => r.rows.map((x) => x.mac).sort());
  assert.deepEqual(await ids('online'), [MAC_A, MAC_B, MAC_C, MAC_D, MAC_E]);
  assert.deepEqual(await ids('offline'), [MAC_F]);
  assert.deepEqual(await ids('waiting'), [MAC_B, MAC_C, MAC_F]);
  assert.deepEqual(await ids('unidentified'), [MAC_A]);
  assert.deepEqual(await ids('active'), [MAC_D, MAC_E]);
  assert.deepEqual(await ids('manual'), [MAC_E]);
  assert.deepEqual(await ids('pix'), [MAC_D]);
  assert.deepEqual(await ids('pix_pending'), [MAC_C]);
  assert.equal((await people('all', 'carla')).total, 1); assert.equal((await people('all', '192.168.88.10')).total, 1);
  assert.equal((await h.admin('passengers', { filter: 'xx' }, adm.token)).status, 400);
});

test('resumo ao vivo: contagens reais (presentes, cadastrados, aguardando, manual x Pix, navegando, receita só do MP) e frescor do feed', async () => {
  for (const [m, x] of [[MAC_A, 10], [MAC_B, 11], [MAC_C, 12]]) router.connect(m, `192.168.88.${x}`);
  await router.poll();
  await reg(MAC_B, 'Bruno Barros Dias', 'bruno@example.com'); await reg(MAC_C, 'Carla Campos Melo', 'carla@example.com');
  await h.payOrder(MAC_C); await router.poll(); await router.poll();
  const live = (await h.admin('live', { filter: 'all' }, adm.token)).data;
  const d = live.summary;
  assert.equal(d.present, 3); assert.equal(d.registered, 2); assert.equal(d.present_unidentified, 1);
  assert.equal(d.waiting, 1); assert.equal(d.pix, 1); assert.equal(d.manual, 0); assert.equal(d.internet, 1);
  assert.equal(d.revenue_total_cents, 2500); assert.equal(d.feed_fresh, true); assert.equal(d.router_online, true);
  assert.equal(live.list.total, 3);
  await h.q("update public.hotspot_settings set value = (now() - interval '10 minutes')::text where key = 'hosts_feed_at'");
  assert.equal((await h.admin('live', {}, adm.token)).data.summary.feed_fresh, false);
});

test('presença expira: aparelho visto há mais de 90 s deixa de ser "online" e o painel não confunde visto antes com conectado agora', async () => {
  await feed([MAC_A, '10']);
  assert.equal((await rowOf(MAC_A)).online, true);
  await h.q("update public.hotspot_known_hosts set seen_at = now() - interval '2 minutes'");
  assert.equal((await rowOf(MAC_A)).online, false);
  assert.equal((await h.admin('dashboard', { preset: 'today' }, adm.token)).data.people.present, 0);
});

test('CSV do painel: "Não identificado" para quem não preencheu e sem injeção de fórmula', async () => {
  await feed(MAC_A, MAC_B);
  await reg(MAC_B, 'Bruno Barros Dias', 'bruno@example.com');
  const c = (await h.admin('passengers_csv', { filter: 'all' }, adm.token)).data;
  assert.equal(c.rows, 2); assert.match(c.csv, /Não identificado/); assert.match(c.csv, /bruno@example\.com/);
});

// ============================== autorização e privacidade ==============================
test('painel: sem sessão -> 401; usuário fora da lista -> 403; operador lê mas não exclui; admin exclui', async () => {
  await feed(MAC_A); await reg(MAC_A);
  assert.equal((await h.admin('passengers', {}, null)).status, 401);
  const stranger = await h.makeUser('estranho@example.net', null);
  assert.equal((await h.admin('passengers', {}, stranger.token)).status, 403);
  assert.equal((await h.admin('passenger', { mac: MAC_A }, stranger.token)).status, 403);
  assert.equal((await h.admin('passengers', {}, op.token)).status, 200);
  assert.equal((await h.admin('passenger_delete', { mac: MAC_A }, op.token)).status, 403);
  assert.equal((await h.admin('personal_purge', { days: 0 }, op.token)).status, 403);
  assert.equal((await h.q('select count(*)::int n from public.hotspot_passengers'))[0].n, 1);
  assert.equal((await h.admin('passenger', { mac: 'zz' }, adm.token)).status, 400);
});

test('excluir passageiro: apaga nome/e-mail e histórico, anonimiza pedidos e PRESERVA valores pagos; auditoria sem dados pessoais', async () => {
  await feed(MAC_A); await reg(MAC_A, 'Maria Souza Lima', 'maria@example.com'); await reg(MAC_A, 'Maria S Lima', 'maria@example.com');
  const pay = await h.payOrder(MAC_A);
  const r = await h.admin('passenger_delete', { mac: MAC_A }, adm.token);
  assert.equal(r.status, 200); assert.equal(r.data.registrations_deleted, 1); assert.equal(r.data.orders_anonymized, 1);
  assert.equal((await h.q('select count(*)::int n from public.hotspot_passengers'))[0].n, 0);
  assert.equal((await h.q('select count(*)::int n from public.hotspot_passenger_history'))[0].n, 0);
  const o = await h.order(pay.created.order_id);
  assert.equal(o.payer_name, null); assert.equal(o.payer_email, null); assert.equal(o.amount_cents, 2500); assert.equal(o.payment_status, 'paid');
  const audit = JSON.stringify(await h.q('select * from public.admin_audit_log'));
  assert.match(audit, /passenger_delete/); assert.doesNotMatch(audit, /maria@example|Maria/);
});

test('retenção: limpeza apaga cadastros antigos e anonimiza pedidos antigos sem apagar valores; roda pela manutenção diária', async () => {
  await feed(MAC_A, MAC_B); await reg(MAC_A, 'Maria Souza Lima', 'maria@example.com'); await reg(MAC_B, 'Bruno Barros Dias', 'bruno@example.com');
  const pay = await payWith(MAC_A, 'Maria Souza Lima', 'maria@example.com');
  await h.q("update public.hotspot_passengers set last_activity_at = now() - interval '40 days' where device_mac = $1", [MAC_A]);
  await h.q("update public.hotspot_orders set created_at = now() - interval '40 days' where id = $1", [pay.created.order_id]);
  await h.q("update public.hotspot_passenger_history set changed_at = now() - interval '40 days' where device_mac = $1", [MAC_A]);
  await h.q("update public.hotspot_orders set provisioned_at = now() - interval '40 days' where id = $1", [pay.created.order_id]);
  await h.q("delete from public.hotspot_settings where key = 'maintenance_at'");
  const r = await h.rpc('hotspot_maintenance', {});
  assert.equal(r.ran, true); assert.equal(r.personal.passengers_deleted, 1);
  assert.equal((await h.q('select count(*)::int n from public.hotspot_passengers'))[0].n, 1, 'cadastro recente preservado');
  const o = await h.order(pay.created.order_id);
  assert.equal(o.payer_email, null); assert.equal(o.amount_cents, 2500);
});

test('papéis públicos não leem as tabelas de passageiros nem executam as funções novas', async () => {
  for (const role of ['anon', 'authenticated']) {
    for (const t of ['hotspot_passengers', 'hotspot_passenger_history']) {
      await assert.rejects(h.pg.transaction(async (tx) => { await tx.exec(`set local role ${role}`); await tx.query(`select * from public.${t}`); }), /permission denied/i);
    }
    for (const call of [
      "public.hotspot_register_passenger('AA:BB:CC:DD:EE:01','Maria Souza','a@b.co')", "public.hotspot_passenger_hint('AA:BB:CC:DD:EE:01')",
      "public.hotspot_passenger_email('AA:BB:CC:DD:EE:01')", 'public.hotspot_people()', "public.hotspot_admin_passengers('all','',10,0)",
      'public.hotspot_admin_people_summary()', "public.hotspot_admin_passenger('AA:BB:CC:DD:EE:01')", 'public.hotspot_purge_personal(0)',
      "public.hotspot_admin_passenger_delete(gen_random_uuid(),'x','AA:BB:CC:DD:EE:01')", "public.hotspot_admin_personal_purge(gen_random_uuid(),'x',0)", 'public.hotspot_maintenance()',
    ]) {
      await assert.rejects(h.pg.transaction(async (tx) => { await tx.exec(`set local role ${role}`); await tx.query(`select ${call}`); }), /permission denied/i, `${role}: ${call}`);
    }
  }
});

test('logs: o endpoint de cadastro nunca escreve e-mails no log, mesmo quando o banco falha', async () => {
  await feed(MAC_A);
  const logs = []; const orig = console.error; console.error = (...a) => logs.push(a.join(' '));
  try {
    h.state.failRpc = (n) => n === 'hotspot_register_passenger';
    const r = await reg(MAC_A, 'Maria Souza Lima', 'segredo.pessoal@example.com');
    assert.equal(r.status, 500);
  } finally { console.error = orig; h.state.failRpc = null; }
  assert.ok(logs.length > 0); assert.doesNotMatch(logs.join('\n'), /segredo\.pessoal|Maria Souza/);
});
