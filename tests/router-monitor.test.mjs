// Monitor do MikroTik: métricas somente leitura enviadas pelo wifi-poll (~60 s) e lidas pelo painel.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, req, read, FN_BASE, ENV } from './helpers/harness.mjs';

let h; let adm; let op;
before(async () => { h = await createHarness(); adm = await h.makeUser('admin@example.org', 'admin'); op = await h.makeUser('operador@example.org', 'operator'); });
after(async () => { await h.close(); });
beforeEach(async () => { await h.q('delete from public.hotspot_router_metrics'); });

const line = (o = {}) => {
  const v = { cpu: 35, mf: 30000000, mt: 67108864, up: '1d02:03:04', ver: '6.49.23 (stable)', brd: 'hEX lite', wi: 'ether1', li: 'ether2',
    wr: 1000000000, wt: 200000000, lr: 300000000, lt: 900000000, h: 32, a: 28, cn: 1500, p: 'ether1/1/100Mbps|ether2/1/1Gbps|ether5/0/', ...o };
  return Object.entries(v).map(([k, x]) => `${k}:${x}`).join(',');
};
const send = (m, key = ENV.ROUTER_SHARED_KEY) => h.routerSync(req(`${FN_BASE}/router-sync`, {
  method: 'POST', origin: null, body: `m=${m}`, headers: { 'x-router-key': key, 'content-type': 'application/x-www-form-urlencoded' } })).then(read);
const age = (s) => h.q(`update public.hotspot_router_metrics set at = at - interval '${s} seconds'`);
const monitor = (token = adm.token) => h.admin('router_monitor', { minutes: 60 }, token);

test('Mbps reais pela diferença de contadores entre duas amostras com horário conhecido', async () => {
  assert.equal((await send(line())).data.rate, false, 'primeira amostra: sem taxa');
  await age(60);
  const r = await send(line({ wr: 1000000000 + 750000000, wt: 200000000 + 75000000, lr: 300000000 + 7500000, lt: 900000000 + 600000000, up: '1d02:04:04' }));
  assert.equal(r.status, 200); assert.equal(r.data.rate, true);
  const m = (await monitor()).data.last;
  assert.ok(Math.abs(Number(m.wan_rx_mbps) - 100) < 0.5); assert.ok(Math.abs(Number(m.wan_tx_mbps) - 10) < 0.1);
  assert.ok(Math.abs(Number(m.lan_rx_mbps) - 1) < 0.05); assert.ok(Math.abs(Number(m.lan_tx_mbps) - 80) < 0.5);
  assert.equal(m.cpu, 35); assert.equal(Number(m.uptime_s), 93844); assert.equal(m.version, '6.49.23 (stable)');
  assert.deepEqual(m.ports.map((p) => [p.name, p.running, p.rate]), [['ether1', true, '100Mbps'], ['ether2', true, '1Gbps'], ['ether5', false, null]]);
});

test('reinício do roteador ou contador zerado: a amostra não gera taxa falsa', async () => {
  await send(line()); await age(60);
  await send(line({ up: '00:01:00', wr: 5000, wt: 5000, lr: 5000, lt: 5000 }));      // reiniciou
  let m = (await monitor()).data.last;
  assert.equal(m.wan_rx_mbps, null); assert.equal(m.lan_tx_mbps, null);
  await age(60);
  await send(line({ up: '00:02:00', wr: 1000, wt: 6000, lr: 6000, lt: 6000 }));       // contador da WAN voltou
  m = (await monitor()).data.last;
  assert.equal(m.wan_rx_mbps, null, 'delta negativo descartado'); assert.ok(m.wan_tx_mbps !== null);
});

test('leituras inválidas: campo ruim vira nulo; sem CPU e RAM a linha é recusada; tamanho limitado', async () => {
  assert.equal((await send(line({ cpu: 'abc', mf: 'x' }))).status, 400);
  assert.equal((await send(line({ cpu: 250 }))).status, 200);
  assert.equal((await monitor()).data.last.cpu, null, 'CPU fora de 0-100 é descartada');
  assert.equal((await send('cpu:1,p:' + 'x'.repeat(2000))).status, 400);
  await send(line({ ver: '<script>x</script>', brd: 'a;b=c' }));
  const m = (await monitor()).data.last;
  assert.doesNotMatch(String(m.version) + m.board, /[<>;=]/);
});

test('métricas exigem a chave do roteador; painel só para administrador/operador logado', async () => {
  assert.equal((await send(line(), 'chave-errada')).status, 401);
  assert.equal((await monitor(null)).status, 401);
  assert.equal((await monitor(op.token)).status, 200, 'operador lê o monitor');
  for (const role of ['anon', 'authenticated']) {
    await assert.rejects(h.pg.transaction(async (tx) => { await tx.exec(`set local role ${role}`); await tx.query('select * from public.hotspot_router_metrics'); }), /permission denied/i);
  }
});

test('sem métricas (script antigo): o painel recebe o que já existe (sessões, hosts, contato) e last = null', async () => {
  await h.routerPull(undefined, 'text'); await h.routerTelemetry('', 25);
  const d = (await monitor()).data;
  assert.equal(d.last, null); assert.equal(d.sessions_online, 25); assert.ok(d.router_seen_at);
});

test('retenção: amostras mais antigas que o limite configurado são apagadas', async () => {
  await send(line()); await age(49 * 3600);
  await send(line());
  assert.equal((await h.q('select count(*)::int n from public.hotspot_router_metrics'))[0].n, 1);
});

test('Supabase fora do ar: o envio de métricas falha isolado (500) sem afetar a consulta de comandos', async () => {
  h.state.failRpc = (n) => n === 'hotspot_router_report_metrics';
  assert.equal((await send(line())).status, 500);
  h.state.failRpc = null;
  assert.equal((await h.routerPull(undefined, 'text')).status, 200);
});
