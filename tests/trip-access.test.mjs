// Acesso de viagem (sem limite de horas): Pix R$ 25 e liberação manual dos pré-pagos, fila de comandos para o MikroTik,
// reautenticação do aparelho preso em Hosts, revogar/bloquear/desbloquear/desconectar, transferência de MAC e fim da viagem.
// Banco REAL (PGlite) + funções reais + modelo do script RouterOS (tests/helpers/router-sim.mjs). Nenhum Pix real.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, req, read, FN_BASE, MAC_A, MAC_B } from './helpers/harness.mjs';
import { RouterSim } from './helpers/router-sim.mjs';

const MAC_C = 'AA:BB:CC:DD:EE:03';
let h; let router; let adm; let op;
before(async () => { h = await createHarness(); adm = await h.makeUser('admin@example.org', 'admin'); op = await h.makeUser('operador@example.org', 'operator'); });
after(async () => { await h.close(); });
beforeEach(async () => {
  for (const t of ['hotspot_router_commands', 'hotspot_access', 'hotspot_blocks', 'hotspot_orders', 'hotspot_known_hosts',
    'hotspot_passengers', 'hotspot_passenger_history', 'hotspot_device_state', 'hotspot_device_credit']) await h.q(`delete from public.${t}`);
  await h.q("delete from public.hotspot_settings where key in ('hosts_feed_at', 'maintenance_at')");
  await h.q('delete from public.admin_audit_log');
  await h.useTripPlan();
  h.mp.reset(); h.state.failRpc = null;
  router = new RouterSim(h);
});

const reg = async (mac, name = 'Maria Souza Lima', email = 'maria@example.com') =>
  read(await h.passenger(req(`${FN_BASE}/passenger`, { method: 'POST', body: { mac, name, email } })));
const portal = async (mac) => (await read(await h.passenger(req(`${FN_BASE}/passenger?mac=${mac}`)))).data;
const act = (mac, op_, token = adm.token, note) => h.admin('device_action', { mac, op: op_, note }, token);
const pix = async (mac) => {
  const c = await h.createPix(mac); const pid = [...h.mp.payments.keys()].at(-1);
  return { c, pid, approve: async () => { h.mp.approve(pid); return h.webhook(pid); } };
};
const access = async (mac) => (await h.q('select * from public.hotspot_access where device_mac = $1', [mac]))[0];
const cmds = (mac) => h.q('select kind, status, result, attempts from public.hotspot_router_commands where device_mac = $1 order by created_at', [mac]);
const row = async (mac) => (await h.admin('passenger', { mac }, adm.token)).data.person;
const onboard = async (mac) => { router.connect(mac); await router.poll(); await reg(mac); };

test('Cenário A: sem crédito — conecta, aparece em Hosts como "Não identificado", não navega', async () => {
  router.connect(MAC_A); await router.poll();
  assert.equal(router.canBrowseNow(MAC_A), false);
  const p = await row(MAC_A);
  assert.equal(p.status, 'not_identified'); assert.equal(p.full_name, null); assert.equal(p.online, true); assert.equal(p.host_authorized, false);
  await reg(MAC_A);
  assert.equal((await row(MAC_A)).status, 'waiting');
  await router.poll(); await router.poll();
  assert.equal(router.canBrowseNow(MAC_A), false, 'cadastro NÃO libera internet');
  const st = await portal(MAC_A);
  assert.equal(st.access, 'none'); assert.equal(st.internet, false); assert.equal(st.registered, true);
});

test('Cenário B (falha real): Pix aprovado com o celular JÁ conectado — o roteador cria o usuário E autentica, sem remover Hosts à mão', async () => {
  await onboard(MAC_A);
  const p = await pix(MAC_A);
  assert.equal(p.c.status, 200); assert.equal(h.mp.creates()[0].body.transaction_amount, 25);
  assert.equal((await portal(MAC_A)).pix_pending, true);
  await router.poll();
  assert.equal(router.users.get(MAC_A).comment, 't:pix', 'Pix pendente: só a cortesia');
  assert.equal(router.users.get(MAC_A).limit, 120, 'cortesia de 2 minutos de uso');
  await p.approve();
  assert.equal((await portal(MAC_A)).access, 'provisioning', 'pago != liberado');
  assert.equal((await row(MAC_A)).status, 'provisioning');
  await router.poll();
  assert.equal(router.users.get(MAC_A).limit, 0, 'sem limit-uptime (sem limite de horas)');
  assert.equal(router.canBrowseNow(MAC_A), true, 'autenticado no mesmo ciclo, com o aparelho já em Hosts');
  assert.deepEqual(router.removedHosts, [], 'nenhuma entrada de Hosts removida (login direto)');
  assert.equal(router.cmdAcks.at(-1).r, 'auth');
  await router.poll(); // próximo ciclo: o feed informa "autenticado"
  const st = await portal(MAC_A);
  assert.equal(st.access, 'active'); assert.equal(st.internet, true);
  assert.equal((await row(MAC_A)).status, 'internet_active');
  assert.ok((await access(MAC_A)).authenticated_at, 'autenticação confirmada pelo roteador');
  assert.ok((await h.q('select provisioned_at from public.hotspot_orders'))[0].provisioned_at);
});

test('Cenário B (plano B): se o RouterOS recusar "active login", remove SÓ o host daquele MAC uma vez e o login por MAC acontece', async () => {
  await onboard(MAC_A); await onboard(MAC_B);
  router.loginCmdWorks = false;
  const p = await pix(MAC_A); await p.approve(); await router.poll();
  assert.equal(router.canBrowseNow(MAC_A), true);
  assert.deepEqual(router.removedHosts, [MAC_A], 'só o MAC liberado');
  assert.equal(router.hostTable.has(MAC_B), true); assert.equal(router.canBrowseNow(MAC_B), false);
  for (let i = 0; i < 5; i++) await router.poll();
  assert.deepEqual(router.removedHosts, [MAC_A], 'sem remoções repetidas a cada ciclo');
});

test('modelo do bug: usuário criado DEPOIS do host não autentica sozinho; a reautenticação automática resolve', async () => {
  router.connect(MAC_A);
  router.users.set(MAC_A, { limit: 0, uptime: 0, comment: 'v:viagem', disabled: false }); // criado por fora, depois do host
  assert.equal(router.canBrowseNow(MAC_A), false, 'reproduz a falha: em Hosts, fora de Active');
  await router.poll();
  assert.equal(router.canBrowseNow(MAC_A), true, 'reautenticação automática');
  const before_ = router.removedHosts.length; router.loginCmdWorks = false;
  for (let i = 0; i < 3; i++) { router.healWindow(); await router.poll(); }
  assert.equal(router.removedHosts.length, before_, 'quem já está em Active não é derrubado');
});

test('reautenticação automática: no máximo 3 por ciclo e cada MAC 1 vez por janela (sem loop); nunca em usuário desativado', async () => {
  router.loginCmdWorks = false;
  const macs = Array.from({ length: 6 }, (_, i) => `02:00:00:00:00:${String(i).padStart(2, '0')}`);
  for (const m of macs) { router.connect(m); router.users.set(m, { limit: 0, uptime: 0, comment: 'v:viagem', disabled: true }); }
  await router.poll();
  assert.equal(router.removedHosts.length, 0, 'usuário DESATIVADO (revogado/bloqueado) nunca é reautenticado');
  for (const m of macs) router.users.get(m).disabled = false;
  router.macLoginAllowed = () => false; // aparelho que não autentica de jeito nenhum
  router.healWindow(); await router.poll();
  assert.equal(router.removedHosts.length, 3, 'limite por ciclo');
  await router.poll();
  assert.equal(router.removedHosts.length, 6);
  await router.poll(); await router.poll();
  assert.equal(router.removedHosts.length, 6, 'cada MAC no máximo 1 vez por janela');
});

test('Cenário C: liberação manual do pré-pago (R$ 20) — sem Pix, sem horas, auditada, autentica e o portal confirma', async () => {
  await onboard(MAC_A);
  const r = await act(MAC_A, 'grant', adm.token, 'Lista de pré-pagos conferida');
  assert.equal(r.status, 200); assert.equal(r.data.result, 'granted');
  assert.equal(h.mp.calls.length, 0, 'nenhuma cobrança');
  assert.equal((await h.q('select count(*)::int n from public.hotspot_orders'))[0].n, 0, 'nenhum pedido/receita inventado');
  assert.equal((await act(MAC_A, 'grant')).data.result, 'already', 'clicar de novo não duplica');
  assert.equal((await cmds(MAC_A)).length, 1);
  await router.poll(); await router.poll();
  assert.equal(router.canBrowseNow(MAC_A), true); assert.equal(router.users.get(MAC_A).limit, 0);
  const a = await access(MAC_A);
  assert.equal(a.source, 'manual_prepaid_20'); assert.equal(a.granted_by, 'admin@example.org'); assert.equal(a.note, 'Lista de pré-pagos conferida');
  const audit = await h.q("select action, actor_email from public.admin_audit_log where action = 'device_grant'");
  assert.equal(audit.length, 2); assert.equal(audit[0].actor_email, 'admin@example.org');
  assert.equal((await portal(MAC_A)).internet, true);
  const again = await read(await h.createPayment(req(`${FN_BASE}/create-payment`, { method: 'POST', body: { mac: MAC_A } })));
  assert.equal(again.status, 409); assert.equal(again.data.already_active, true); assert.equal(h.mp.calls.length, 0);
});

test('nome/e-mail declarado NUNCA libera: outro aparelho com o mesmo nome continua aguardando', async () => {
  await onboard(MAC_A); await act(MAC_A, 'grant'); await router.poll();
  await onboard(MAC_B);
  await router.poll(); await router.poll();
  assert.equal(router.canBrowseNow(MAC_B), false);
  assert.equal((await row(MAC_B)).status, 'waiting');
});

test('Cenário D: reconexão — desliga e liga o Wi-Fi, volta autenticado sem pagar e sem ação do admin', async () => {
  await onboard(MAC_A); await act(MAC_A, 'grant'); await router.poll();
  router.disconnect(MAC_A); await router.poll();
  assert.equal((await row(MAC_A)).access_state, 'active', 'desconectado != não autorizado');
  router.connect(MAC_A);
  assert.equal(router.canBrowseNow(MAC_A), true);
  await router.poll();
  assert.equal((await row(MAC_A)).status, 'internet_active');
  assert.equal(h.mp.calls.length, 0);
});

test('Cenário E: janela do portal fechada para pagar no app do banco — estado vem do servidor e não há segunda cobrança', async () => {
  await onboard(MAC_A);
  const first = await pix(MAC_A);
  assert.equal((await portal(MAC_A)).pix_pending, true);
  const again = await h.createPix(MAC_A);
  assert.equal(again.data.reused, true); assert.equal(again.data.order_id, first.c.data.order_id);
  assert.equal(h.mp.creates().length, 1, 'uma única cobrança');
  await first.approve();
  await router.poll();
  assert.equal(router.canBrowseNow(MAC_A), true, 'provisionado sem nenhum navegador aberto');
  const after_ = await read(await h.createPayment(req(`${FN_BASE}/create-payment`, { method: 'POST', body: { mac: MAC_A } })));
  assert.equal(after_.status, 409, 'depois de pago nunca oferece nova cobrança'); assert.equal(h.mp.creates().length, 1);
});

test('Cenário E (webhook perdido): o portal reaberto reconcilia pelo pedido e libera', async () => {
  await onboard(MAC_A);
  const p = await pix(MAC_A);
  h.mp.approve(p.pid);
  const s = await h.status(p.c.data);
  assert.equal(s.data.status, 'paid');
  await router.poll();
  assert.equal(router.canBrowseNow(MAC_A), true);
});

test('Cenário F: roteador fora do ar — fica "liberando", aplica depois uma única vez; ACK perdido não duplica', async () => {
  await onboard(MAC_A);
  router.online = false;
  await act(MAC_A, 'grant');
  await router.poll(); await router.poll();
  assert.equal((await row(MAC_A)).status, 'provisioning');
  assert.equal((await h.admin('live', {}, adm.token)).data.summary.commands_open, 1);
  router.online = true; router.dropCmdAcks = 1;
  await router.poll();
  assert.equal(router.canBrowseNow(MAC_A), true);
  await h.q("update public.hotspot_router_commands set sent_at = now() - interval '2 minutes'");
  await router.poll();
  const c = await cmds(MAC_A);
  assert.equal(c.length, 1); assert.equal(c[0].status, 'applied'); assert.equal(c[0].attempts, 2);
  assert.equal(router.users.size, 1);
});

test('Cenário F: comando sem ACK após 5 tentativas vira "Erro ao aplicar" (sem loop) e o admin pode reautenticar', async () => {
  await onboard(MAC_A); await act(MAC_A, 'grant');
  router.dropCmdAcks = 99;
  for (let i = 0; i < 6; i++) { await router.poll(); await h.q("update public.hotspot_router_commands set sent_at = now() - interval '2 minutes' where status = 'sent'"); }
  await h.rpc('hotspot_router_commands_pull', { p_limit: 10 });
  assert.equal((await cmds(MAC_A))[0].status, 'failed');
  assert.equal((await row(MAC_A)).status, 'auth_error');
  router.dropCmdAcks = 0;
  assert.equal((await act(MAC_A, 'reauth')).status, 200);
  await router.poll();
  assert.equal((await cmds(MAC_A)).at(-1).status, 'applied');
});

test('Cenário G: bloqueado — nunca reautorizado (nem por Pix, liberação, reconexão ou reautenticação automática)', async () => {
  await onboard(MAC_A); await act(MAC_A, 'grant'); await router.poll();
  assert.equal(router.canBrowseNow(MAC_A), true);
  assert.equal((await act(MAC_A, 'block', adm.token, 'Uso indevido')).data.result, 'blocked');
  await router.poll();
  assert.equal(router.canBrowseNow(MAC_A), false); assert.equal(router.users.get(MAC_A).disabled, true);
  router.disconnect(MAC_A); router.connect(MAC_A); router.healWindow(); await router.poll(); await router.poll();
  assert.equal(router.canBrowseNow(MAC_A), false, 'reconexão + reautenticação automática não reabrem');
  assert.equal((await act(MAC_A, 'grant')).status, 400, 'liberar exige desbloquear antes');
  assert.equal((await act(MAC_A, 'reauth')).status, 400);
  const p = await read(await h.createPayment(req(`${FN_BASE}/create-payment`, { method: 'POST', body: { mac: MAC_A } })));
  assert.equal(p.status, 403, 'não vende Pix que não poderia ser entregue'); assert.equal(h.mp.calls.length, 0);
  assert.equal((await portal(MAC_A)).access, 'blocked');
  assert.equal((await row(MAC_A)).status, 'blocked');
  assert.equal((await act(MAC_A, 'unblock')).data.result, 'unblocked_restored');
  await router.poll();
  assert.equal(router.canBrowseNow(MAC_A), true);
  await onboard(MAC_B); await act(MAC_B, 'block'); await router.poll();
  assert.equal((await act(MAC_B, 'unblock')).data.result, 'unblocked_no_access');
  await router.poll(); await router.poll();
  assert.equal(router.canBrowseNow(MAC_B), false, 'desbloquear não dá internet grátis');
});

test('Cenário G: Pix aprovado de quem foi bloqueado no meio do pagamento — dinheiro registrado, nada liberado até desbloquear', async () => {
  await onboard(MAC_A);
  const p = await pix(MAC_A);
  await act(MAC_A, 'block');
  await p.approve();
  await router.poll(); await router.poll();
  assert.equal(router.canBrowseNow(MAC_A), false);
  assert.equal((await h.q('select payment_status from public.hotspot_orders'))[0].payment_status, 'paid');
  assert.equal((await access(MAC_A)).state, 'active', 'direito pago preservado para suporte');
  await act(MAC_A, 'unblock'); await router.poll();
  assert.equal(router.canBrowseNow(MAC_A), true);
});

test('revogar: derruba a sessão, desativa o usuário e NÃO volta por reconexão, reboot, sync ou pedido antigo pago', async () => {
  await onboard(MAC_A);
  const p = await pix(MAC_A); await p.approve(); await router.poll();
  assert.equal(router.canBrowseNow(MAC_A), true);
  assert.equal((await act(MAC_A, 'revoke', adm.token, 'Teste')).data.result, 'revoked');
  await router.poll();
  assert.equal(router.canBrowseNow(MAC_A), false);
  router.reboot(); router.disconnect(MAC_A); router.connect(MAC_A); router.healWindow();
  for (let i = 0; i < 3; i++) await router.poll();
  assert.equal(router.canBrowseNow(MAC_A), false);
  assert.equal((await h.q('select payment_status from public.hotspot_orders'))[0].payment_status, 'paid', 'registro financeiro preservado');
  assert.equal((await portal(MAC_A)).access, 'revoked');
  const r = await read(await h.createPayment(req(`${FN_BASE}/create-payment`, { method: 'POST', body: { mac: MAC_A } })));
  assert.equal(r.status, 403);
  await act(MAC_A, 'grant'); await router.poll();
  assert.equal(router.canBrowseNow(MAC_A), true, 'o admin pode liberar de novo, explicitamente');
});

test('desconectar (kick): é temporário — com direito válido, o login por MAC volta', async () => {
  await onboard(MAC_A); await act(MAC_A, 'grant'); await router.poll();
  assert.equal((await act(MAC_A, 'kick')).data.result, 'queued');
  await router.poll();
  assert.equal(router.sessions.has(MAC_A), false);
  assert.equal((await access(MAC_A)).state, 'active', 'não revoga');
  router.healWindow(); await router.poll();
  assert.equal(router.canBrowseNow(MAC_A), true);
});

test('Cenário H: 30 pré-pagos + 10 Pix ao mesmo tempo — cada um só o seu, sem interferência', async () => {
  const macs = Array.from({ length: 40 }, (_, i) => `02:11:00:00:00:${i.toString(16).padStart(2, '0').toUpperCase()}`);
  for (const m of macs) router.connect(m);
  await router.poll();
  for (const m of macs) await reg(m, 'Passageiro Teste Silva', 'passageiro@example.com');
  const outsider = '02:11:00:00:00:FF'; router.connect(outsider); await router.poll();
  await Promise.all(macs.slice(0, 30).map((m) => act(m, 'grant')));
  for (const m of macs.slice(30)) { const p = await pix(m); await p.approve(); }
  for (let i = 0; i < 6; i++) await router.poll();
  for (const m of macs) assert.equal(router.canBrowseNow(m), true, m);
  assert.equal(router.canBrowseNow(outsider), false);
  assert.equal((await h.q("select count(*)::int n from public.hotspot_router_commands where kind = 'grant'"))[0].n, 40);
  const s = (await h.admin('live', {}, adm.token)).data.summary;
  assert.equal(s.manual, 30); assert.equal(s.pix, 10); assert.equal(s.revenue_total_cents, 25000);
});

test('Cenário I: acesso ilimitado — sem expiração por tempo, mesmo depois de dias de uso', async () => {
  await onboard(MAC_A); await act(MAC_A, 'grant'); await router.poll();
  router.users.get(MAC_A).uptime = 5 * 24 * 3600;
  router.healWindow(); await router.poll();
  assert.equal(router.canBrowseNow(MAC_A), true);
  assert.equal(router.expReports.length, 0, 'nunca aparece como esgotado');
});

test('Cenário J: MAC privado trocou — o MAC novo NÃO herda; transferência pelo admin move o direito (nunca fica nos dois)', async () => {
  await onboard(MAC_A); const p = await pix(MAC_A); await p.approve(); await router.poll();
  await onboard(MAC_B);
  await router.poll();
  assert.equal(router.canBrowseNow(MAC_B), false);
  assert.equal((await h.admin('transfer', { from: MAC_A, to: MAC_B }, op.token)).status, 403, 'operador não transfere');
  assert.equal((await h.admin('transfer', { from: MAC_A, to: MAC_B }, adm.token)).status, 200);
  await router.poll();
  assert.equal(router.canBrowseNow(MAC_B), true); assert.equal(router.canBrowseNow(MAC_A), false);
  assert.equal((await access(MAC_A)).state, 'revoked'); assert.equal((await access(MAC_B)).source, 'transfer');
  assert.equal((await h.q('select count(*)::int n from public.hotspot_orders'))[0].n, 1, 'sem novo pagamento');
  assert.equal((await h.admin('transfer', { from: MAC_A, to: MAC_C }, adm.token)).status, 400, 'origem já sem acesso');
});

test('Pix e liberação manual quase simultâneos: um único direito e nenhum comando duplicado', async () => {
  await onboard(MAC_A);
  const p = await pix(MAC_A);
  await Promise.all([act(MAC_A, 'grant'), p.approve()]);
  assert.equal((await h.q('select count(*)::int n from public.hotspot_access'))[0].n, 1);
  assert.equal((await h.q("select count(*)::int n from public.hotspot_router_commands where status in ('queued','sent')"))[0].n, 1);
  await router.poll();
  assert.equal(router.canBrowseNow(MAC_A), true);
});

test('pedidos ANTIGOS de horas (R$ 5) continuam valendo; usuário de viagem não volta a ser limitado por eles', async () => {
  await onboard(MAC_A);
  await h.useLegacyPlan();
  const p = await pix(MAC_A); await p.approve(); await router.poll();
  assert.equal(router.users.get(MAC_A).limit, 5 * 3600, 'fluxo antigo intacto');
  await h.useTripPlan();
  assert.equal((await row(MAC_A)).status, 'legacy_active');
  await act(MAC_A, 'grant'); await router.poll();
  assert.equal(router.users.get(MAC_A).limit, 0, 'liberação de viagem remove o limite de horas');
  await h.q("insert into public.hotspot_orders (device_mac, amount_cents, grant_seconds, payment_status, paid_at) values ($1, 500, 18000, 'paid', now())", [MAC_A]);
  await router.poll();
  assert.equal(router.users.get(MAC_A).limit, 0);
  assert.equal((await h.q('select count(*)::int n from public.hotspot_orders where provisioned_at is not null'))[0].n, 2);
});

test('estorno de Pix da viagem revoga o acesso daquele pagamento', async () => {
  await onboard(MAC_A); const p = await pix(MAC_A); await p.approve(); await router.poll();
  h.mp.set(p.pid, 'refunded', 'refunded'); await h.webhook(p.pid);
  assert.equal((await access(MAC_A)).state, 'revoked');
  await router.poll();
  assert.equal(router.canBrowseNow(MAC_A), false);
});

test('fim da viagem: exige digitar ENCERRAR; revoga todos e preserva o histórico; operador não pode', async () => {
  await onboard(MAC_A); await onboard(MAC_B);
  await act(MAC_A, 'grant'); const p = await pix(MAC_B); await p.approve(); await router.poll();
  assert.equal((await h.admin('end_trip', { confirm: 'ENCERRAR' }, op.token)).status, 403);
  assert.equal((await h.admin('end_trip', { confirm: 'sim' }, adm.token)).status, 400);
  assert.equal((await h.admin('end_trip', { confirm: 'ENCERRAR' }, adm.token)).data.revoked, 2);
  await router.poll();
  assert.equal(router.canBrowseNow(MAC_A), false); assert.equal(router.canBrowseNow(MAC_B), false);
  assert.equal((await h.q("select count(*)::int n from public.hotspot_orders where payment_status = 'paid'"))[0].n, 1);
  assert.ok((await h.admin('live', {}, adm.token)).data.summary.trip_ended_at);
});

test('segurança: ações exigem admin; operador só lê; sem sessão 401; entradas inválidas 400; MAC nunca visto não é liberado', async () => {
  await onboard(MAC_A);
  assert.equal((await act(MAC_A, 'grant', null)).status, 401);
  assert.equal((await act(MAC_A, 'grant', op.token)).status, 403);
  assert.equal((await h.admin('live', {}, op.token)).status, 200);
  assert.equal((await act('zz', 'grant')).status, 400);
  assert.equal((await act(MAC_A, 'rm -rf')).status, 400);
  assert.equal((await act('02:99:99:99:99:99', 'grant')).status, 400, 'MAC inventado');
  assert.equal((await h.q('select count(*)::int n from public.hotspot_access'))[0].n, 0);
  for (const role of ['anon', 'authenticated']) {
    for (const t of ['hotspot_access', 'hotspot_blocks', 'hotspot_router_commands']) {
      await assert.rejects(h.pg.transaction(async (tx) => { await tx.exec(`set local role ${role}`); await tx.query(`select * from public.${t}`); }), /permission denied/i);
    }
    for (const call of ["public.hotspot_portal_state('AA:BB:CC:DD:EE:01')", 'public.hotspot_router_commands_pull(10)',
      "public.hotspot_admin_device_action(gen_random_uuid(),'x','AA:BB:CC:DD:EE:01','grant',null)",
      "public.hotspot_access_grant('AA:BB:CC:DD:EE:01','pix',null,'x',null)", "public.hotspot_admin_end_trip(gen_random_uuid(),'x','ENCERRAR')"]) {
      await assert.rejects(h.pg.transaction(async (tx) => { await tx.exec(`set local role ${role}`); await tx.query(`select ${call}`); }), /permission denied/i, `${role}: ${call}`);
    }
  }
});

test('portal: estado por MAC só para aparelho presente e sem dados de colegas', async () => {
  await onboard(MAC_A);
  const st = await portal(MAC_A);
  assert.equal(st.known, true); assert.equal(st.name_hint, 'Maria');
  assert.doesNotMatch(JSON.stringify(st), /maria@example|Souza|AA:BB/);
  const other = await portal(MAC_B);
  assert.equal(other.known, false); assert.equal(other.registered, false);
});

test('router-sync: linha de comando com largura fixa; ACK validado (id, MAC, resultado) e exige a chave do roteador', async () => {
  await onboard(MAC_A); await act(MAC_A, 'grant');
  const pulled = await h.routerPull(undefined, 'text');
  const line = pulled.text.split('\n').find((l) => l.startsWith('C '));
  assert.equal(line.length, 58); assert.match(line, /^C [0-9a-f-]{36} G AA:BB:CC:DD:EE:01$/);
  const id = line.slice(2, 38);
  assert.equal((await h.routerCmdAck(id, MAC_A, 'ok', 'chave-errada')).status, 401);
  assert.equal((await h.routerCmdAck(id, MAC_A, 'drop table')).status, 400);
  assert.equal((await h.routerCmdAck(id, MAC_B, 'ok')).status, 409, 'MAC de outro aparelho');
  assert.equal((await h.routerCmdAck(id, MAC_A, 'ok')).status, 200);
  assert.equal((await h.routerCmdAck(id, MAC_A, 'ok')).data.already, true);
  assert.equal(RouterSim.parseCmd('C ' + id + ' X ' + MAC_A), null, 'tipo fora da lista é ignorado pelo roteador');
});

test('roteador fora do ar: liberar e logo revogar deixa só o comando de revogação na fila (o último pedido do admin vence)', async () => {
  await onboard(MAC_A);
  router.online = false;
  await act(MAC_A, 'grant'); await act(MAC_A, 'revoke');
  const open = await h.q("select kind from public.hotspot_router_commands where status in ('queued','sent')");
  assert.deepEqual(open.map((x) => x.kind), ['revoke']);
  router.online = true; await router.poll();
  assert.equal(router.canBrowseNow(MAC_A), false);
});

test('tempo corrido: plano de 4 h pago acaba 4 h depois do pagamento, usando ou não; comprar de novo soma; vencido pode comprar', async () => {
  await h.q("update public.hotspot_plans set active = false, is_default = false");
  await h.q("insert into public.hotspot_plans (name, price_cents, grant_seconds, active, is_default, wall_clock) values ('4 horas', 300, 14400, true, true, true)");
  await onboard(MAC_A);
  const p = await pix(MAC_A); await p.approve(); await router.poll();
  assert.equal(router.canBrowseNow(MAC_A), true); assert.ok(router.users.get(MAC_A).limit > 14390 && router.users.get(MAC_A).limit <= 14400, 'teto de uso = tempo restante (proteção sem servidor)');
  const exp = (await access(MAC_A)).expires_at; const secs = (new Date(exp) - Date.now()) / 1000;
  assert.ok(secs > 14390 && secs <= 14400, 'fim = pagamento + 4 h');
  const p2 = await pix(MAC_A); await p2.approve();
  const secs2 = (new Date((await access(MAC_A)).expires_at) - Date.now()) / 1000;
  assert.ok(secs2 > 28790 && secs2 <= 28800, 'segunda compra soma');
  await h.q("update public.hotspot_access set expires_at = now() - interval '1 second'");
  await router.poll(); await router.poll();
  assert.equal(router.canBrowseNow(MAC_A), false, 'venceu: o roteador desativa');
  assert.equal((await portal(MAC_A)).access, 'none', 'portal volta à compra');
  const again = await h.createPix(MAC_A);
  assert.equal(again.status, 200, 'pode comprar de novo');
  await h.useTripPlan();
});


// ============================== auditoria ==============================
const wallPlan = async (secs = 14400) => {
  await h.q("update public.hotspot_plans set active = false, is_default = false");
  await h.q("insert into public.hotspot_plans (name, price_cents, grant_seconds, active, is_default, wall_clock) values ('Corrido', 300, $1, true, true, true)", [secs]);
};

test('cortesia: estado REAL no portal (preparando -> ativa), acaba após 2 min de uso, e o Pix pago a substitui por acesso definitivo', async () => {
  await onboard(MAC_A);
  const p = await pix(MAC_A);
  assert.equal((await portal(MAC_A)).trial, 'preparing', 'não anuncia a cortesia antes do roteador confirmar');
  await router.poll();
  assert.equal((await portal(MAC_A)).trial, 'active');
  assert.equal(router.canBrowseNow(MAC_A), true);
  router.use(MAC_A, 120);
  assert.equal(router.canBrowseNow(MAC_A), false, 'cortesia esgotada corta');
  router.healWindow(); await router.poll();
  assert.equal(router.canBrowseNow(MAC_A), false, 'a reautenticação automática não renova a cortesia');
  await p.approve(); await router.poll();
  assert.equal(router.canBrowseNow(MAC_A), true); assert.equal(router.users.get(MAC_A).limit, 0, 'pago: sem limite');
});

test('cortesia falha honestamente: aparelho fora da rede -> "failed", nunca "ativa"', async () => {
  await onboard(MAC_A); await pix(MAC_A);
  router.disconnect(MAC_A); await router.poll();
  assert.equal((await portal(MAC_A)).trial, 'failed');
});

test('cortesia: não vale para aparelho bloqueado ou com acesso; limite global por janela', async () => {
  await onboard(MAC_A); await act(MAC_A, 'block');
  assert.equal((await h.rpc('hotspot_trial_grant', { p_mac: MAC_A })).result, 'not_eligible');
});

test('renovação + estorno individual: estornar a 2a compra tira só o tempo dela; estornar a 1a mantém o tempo da 2a', async () => {
  await wallPlan(3600);
  await onboard(MAC_A);
  const a = await pix(MAC_A); await a.approve(); await router.poll();
  const b = await pix(MAC_A); await b.approve(); await router.poll();
  const left = async () => (new Date((await access(MAC_A)).expires_at) - Date.now()) / 1000;
  assert.ok((await left()) > 7190, '2 h somadas');
  h.mp.set(b.pid, 'refunded', 'refunded'); await h.webhook(b.pid);
  assert.ok((await left()) < 3610 && (await left()) > 3590, 'estorno da renovação tira só 1 h');
  h.mp.set(a.pid, 'refunded', 'refunded'); await h.webhook(a.pid);
  assert.equal((await access(MAC_A)).state, 'revoked', 'sem compra válida: encerra');
  await h.useTripPlan();
});

test('renovação de plano ilimitado já ativo não trava novas compras (pedido marcado como liberado)', async () => {
  await onboard(MAC_A);
  const a = await pix(MAC_A); await a.approve(); await router.poll();
  await h.q("update public.hotspot_orders set payment_status = 'pending', paid_at = null, provisioned_at = null where false");
  assert.equal((await h.q("select count(*)::int n from public.hotspot_orders where payment_status = 'paid' and provisioned_at is null"))[0].n, 0);
});

test('reconciliação: revogação sem ACK e aparelho ainda autenticado -> nova revogação até o roteador cortar', async () => {
  await onboard(MAC_A); await act(MAC_A, 'grant'); await router.poll();
  router.dropCmdAcks = 99; await act(MAC_A, 'revoke');
  router.online = false; // revoga no banco, mas o roteador "não aplicou"
  await h.q("update public.hotspot_router_commands set status = 'failed' where kind = 'revoke'");
  router.online = true; router.dropCmdAcks = 0; router.users.get(MAC_A).disabled = false; router.sessions.add(MAC_A);
  await router.poll(); await router.poll(); await router.poll();
  assert.equal(router.canBrowseNow(MAC_A), false, 'reconciliado sem depender do ACK antigo');
});

test('Pix pago DEPOIS de o organizador revogar não reativa o acesso (fica registrado para decisão manual)', async () => {
  await onboard(MAC_A);
  const p = await pix(MAC_A);
  await act(MAC_A, 'grant'); await act(MAC_A, 'revoke');
  await p.approve();
  assert.equal((await access(MAC_A)).state, 'revoked');
  assert.equal((await h.q("select count(*)::int n from public.admin_audit_log where action = 'paid_not_granted'"))[0].n, 1);
});

test('transferência de tempo corrido mantém o mesmo fim (não vira ilimitado)', async () => {
  await wallPlan(3600);
  await onboard(MAC_A); const p = await pix(MAC_A); await p.approve(); await router.poll();
  await onboard(MAC_B);
  const fim = (await access(MAC_A)).expires_at;
  assert.equal((await h.admin('transfer', { from: MAC_A, to: MAC_B }, adm.token)).status, 200);
  assert.equal(String((await access(MAC_B)).expires_at), String(fim));
  await h.useTripPlan();
});

test('plano de 20 dias pode ser comprado (validação de 30 dias coerente)', async () => {
  await wallPlan(20 * 86400);
  await onboard(MAC_A);
  assert.equal((await pix(MAC_A)).c.status, 200);
  await h.useTripPlan();
});

test('cadastro travado após 15 min: outro aparelho na rede não troca o nome usado na conferência dos pré-pagos', async () => {
  await onboard(MAC_A);
  await h.q("update public.hotspot_passengers set registered_at = now() - interval '20 minutes'");
  const r = await reg(MAC_A, 'Outra Pessoa Silva', 'outra@example.com');
  assert.equal(r.status, 409); assert.equal(r.data.locked, true);
  assert.equal((await h.q('select full_name from public.hotspot_passengers'))[0].full_name, 'Maria Souza Lima');
});

test('Pix vencido aqui (5 min) mas aberto no MP é cancelado no MP antes de gerar outro; se já foi pago, é aplicado', async () => {
  await onboard(MAC_A);
  const old = await pix(MAC_A);
  await h.q("update public.hotspot_orders set expires_at = now() - interval '10 minutes', created_at = now() - interval '12 minutes'");
  await h.rpc('hotspot_expire_stale', {});
  const novo = await h.createPix(MAC_A);
  assert.equal(novo.status, 200); assert.notEqual(novo.data.order_id, old.c.data.order_id);
  assert.equal(h.mp.get(old.pid).status, 'cancelled', 'Pix antigo cancelado no Mercado Pago: sem cobrança dupla');
});

test('reconciliação também alcança quem pagou por Pix de tempo corrido (revogação sem ACK após vencer)', async () => {
  await wallPlan(3600);
  await onboard(MAC_A); const p = await pix(MAC_A); await p.approve(); await router.poll();
  router.dropCmdAcks = 99;
  await h.q("update public.hotspot_access set expires_at = now() - interval '1 second'");
  await router.poll();                                   // vence; o R se perde
  router.users.get(MAC_A).disabled = false; router.users.get(MAC_A).limit = 0; router.sessions.add(MAC_A); // "não aplicou"
  await h.q("update public.hotspot_router_commands set status = 'failed' where kind = 'revoke'");
  router.dropCmdAcks = 0;
  await h.q("update public.hotspot_router_commands set done_at = now() - interval '1 minute' where kind = 'revoke'");
  await h.q("update public.hotspot_router_commands set created_at = now() - interval '2 hours', done_at = now() - interval '2 hours' where kind = 'trial'");
  await router.poll(); await router.poll(); await router.poll();
  assert.equal(router.canBrowseNow(MAC_A), false);
  await h.useTripPlan();
});

test('Pix antigo vencido aqui mas PAGO no MP: aplicado antes de reservar, sem gerar segunda cobrança', async () => {
  await onboard(MAC_A);
  const old = await pix(MAC_A);
  await h.q("update public.hotspot_orders set expires_at = now() - interval '10 minutes', created_at = now() - interval '12 minutes'");
  await h.rpc('hotspot_expire_stale', {});
  h.mp.approve(old.pid);                                 // pagou depois de vencer no portal; webhook perdido
  const creates = h.mp.creates().length;
  const r = await h.createPix(MAC_A);
  assert.equal(r.status, 409); assert.equal(r.data.already_active, true);
  assert.equal(h.mp.creates().length, creates, 'nenhum Pix novo');
});

test('cortesia após o tempo vencer: o usuário desativado por vencimento vira cortesia de 2 min', async () => {
  await wallPlan(3600);
  await onboard(MAC_A); const p = await pix(MAC_A); await p.approve(); await router.poll();
  await h.q("update public.hotspot_access set expires_at = now() - interval '1 second'");
  await router.poll(); assert.equal(router.canBrowseNow(MAC_A), false);
  await h.q("update public.hotspot_router_commands set created_at = now() - interval '2 hours', done_at = now() - interval '2 hours' where kind = 'trial'"); // passou 1 h
  await pix(MAC_A); await router.poll();
  assert.equal(router.users.get(MAC_A).comment, 't:pix'); assert.equal(router.canBrowseNow(MAC_A), true);
  assert.equal((await portal(MAC_A)).trial, 'active');
  await h.useTripPlan();
});
