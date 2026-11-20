// Servidor LOCAL de demonstração/teste. NÃO usa credenciais nem serviços reais:
// banco = PGlite em memória, Mercado Pago = simulador, MikroTik = modelo em JS.
//   Portal:  http://localhost:8787/?mac=AA:BB:CC:DD:EE:10   (como a Netlify)
//   API:     http://localhost:8788/functions/v1/...          (como o Supabase; origem diferente => CORS real)
// Controles de teste (só aqui, nunca em produção):
//   POST :8788/__dev/pay?mac=AA:BB:..   aprova o Pix mais recente do MAC e entrega o webhook assinado
//   POST :8788/__dev/router?online=1|0  liga/desliga o roteador simulado (consulta a cada 3 s)
//   POST :8788/__dev/connect?mac=AA:BB:..  o aparelho conecta ao Wi-Fi (entra em Hosts)
//   GET  :8788/__dev/state              pedidos e usuários do roteador simulado
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createHarness, ROOT } from '../tests/helpers/harness.mjs';
import { RouterSim } from '../tests/helpers/router-sim.mjs';

const SITE_PORT = Number(process.env.SITE_PORT || 8787);
const API_PORT = Number(process.env.API_PORT || 8788);
const SITE = `http://localhost:${SITE_PORT}`;
const API = `http://localhost:${API_PORT}`;

const h = await createHarness();
process.env.SITE_ORIGIN = SITE; // as funções leem o segredo a cada chamada
const router = new RouterSim(h);
router.online = false;
// ---- DEMONSTRAÇÃO LOCAL do painel (nunca roda em produção): usuário e dados fictícios no banco em memória ----
const DEMO = { email: 'admin@example.com', password: 'somente-demonstracao-local', token: 'dev-token-local-demo-only' };
async function seedDemo() {
  const u = await h.makeUser(DEMO.email, 'admin');
  h.authUsers.set(DEMO.token, { id: u.id, email: DEMO.email });
  await h.q("insert into public.hotspot_plans (name, price_cents, grant_seconds, active, sort_order) values ('1 hora', 200, 3600, false, -2), ('3 horas', 400, 10800, false, -1)");
  const macs = Array.from({ length: 14 }, (_, i) => `AA:BB:CC:00:00:${(i + 16).toString(16).toUpperCase().padStart(2, '0')}`);
  let n = 0;
  for (let d = 9; d >= 0; d--) {
    const count = 3 + ((d * 7) % 6);
    for (let k = 0; k < count; k++) {
      n++;
      const mac = macs[n % macs.length];
      const plan = k % 3 === 0 ? ['1 hora', 200, 3600] : ['5 horas', 500, 18000];
      const when = new Date(Date.now() - d * 86400000 - (k * 37 + 5) * 3 * 60000);
      const st = n % 11 === 0 ? 'expired' : n % 13 === 0 ? 'failed' : 'paid';
      const paid = st === 'paid';
      await h.q(`insert into public.hotspot_orders (device_mac, amount_cents, grant_seconds, payment_status, paid_at, provisioned_at, plan_name, created_at, payment_id, expires_at)
                 values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [mac, plan[1], plan[2], st, paid ? when : null, paid ? when : null, plan[0], when, String(95000000 + n), paid ? null : new Date(when.getTime() + 1800000)]);
    }
  }
  const tel = () => h.rpc('hotspot_router_report_state', { p_online: 5, p_rows: [
    { mac: macs[1], ip: '192.168.88.21', uptime: 4800, lim: 18000, active: true },
    { mac: macs[2], ip: '192.168.88.22', uptime: 900, lim: 3600, active: true },
    { mac: macs[3], ip: '192.168.88.23', uptime: 17990, lim: 18000, active: false },
    { mac: macs[4], ip: '192.168.88.24', uptime: 7300, lim: 18000, active: true },
    { mac: macs[5], ip: '192.168.88.25', uptime: 120, lim: 10800, active: true }] });
  await tel(); setInterval(() => tel().catch(() => {}), 30000);
}
if (process.env.DEV_DEMO !== '0') { router.online = true; await seedDemo(); }
setInterval(() => { router.poll().catch((e) => console.error('router sim:', e.message)); }, 3000);

const csp = /Content-Security-Policy:\s*(.+)/.exec(readFileSync(path.join(ROOT, 'site/_headers'), 'utf8'))[1]
  .replace('https://SEU-PROJETO.supabase.co', API);
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };

async function toRequest(nodeReq) {
  const chunks = []; for await (const c of nodeReq) chunks.push(c);
  const headers = new Headers();
  for (const [k, v] of Object.entries(nodeReq.headers)) if (typeof v === 'string') headers.set(k, v);
  const body = Buffer.concat(chunks);
  return new Request(`${API}${nodeReq.url}`, { method: nodeReq.method, headers, body: ['GET', 'HEAD'].includes(nodeReq.method) ? undefined : body });
}
async function send(res, response) {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}
const sendJson = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(body)); };

http.createServer((req, res) => {
  const url = new URL(req.url, SITE);
  const common = { 'Content-Security-Policy': csp, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' };
  if (url.pathname === '/config.js') {
    res.writeHead(200, { ...common, 'content-type': types['.js'] });
    return res.end(`window.HOTSPOT_CONFIG = { functionsUrl: '${API}/functions/v1' };`);
  }
  if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) {          // painel: arquivos reais ou a página única
    const rel = url.pathname.replace(/^\/admin\/?/, '');
    const name = /^[\w.-]+$/.test(rel) && existsSync(path.join(ROOT, 'site', 'admin', rel)) ? rel : 'index.html';
    res.writeHead(200, { ...common, 'content-type': types[path.extname(name)] || 'text/html; charset=utf-8' });
    return res.end(readFileSync(path.join(ROOT, 'site', 'admin', name)));
  }
  const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  if (!/^[\w.-]+$/.test(file) || file.startsWith('_')) { res.writeHead(404, common); return res.end('not found'); }
  try {
    const body = readFileSync(path.join(ROOT, 'site', file));
    res.writeHead(200, { ...common, 'content-type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404, common); res.end('not found'); }
}).listen(SITE_PORT, () => console.log(`Portal  → ${SITE}/?mac=AA:BB:CC:DD:EE:10`));

const functions = { 'create-payment': h.createPayment, 'payment-status': h.paymentStatus, 'mp-webhook': h.webhookHandler, 'router-sync': h.routerSync, plans: h.plans, passenger: h.passenger, 'admin-api': h.adminApi };
http.createServer(async (req, res) => {
  const url = new URL(req.url, API);
  try {
    if (url.pathname === '/__dev/pay' && req.method === 'POST') {
      const mac = (url.searchParams.get('mac') || '').toUpperCase();
      const [row] = await h.q("select payment_id from public.hotspot_orders where device_mac=$1 and payment_status='pending' and payment_id is not null order by created_at desc limit 1", [mac]);
      if (!row) return sendJson(res, 404, { error: 'nenhum Pix pendente para este MAC' });
      h.mp.approve(row.payment_id);
      const r = await h.webhook(row.payment_id);
      return sendJson(res, 200, { payment_id: row.payment_id, webhook: r.data });
    }
    if (url.pathname === '/__dev/connect') { // simula o aparelho entrando no Wi-Fi (aparece em /ip hotspot host)
      const m = String(url.searchParams.get('mac') || '').toUpperCase(); router.online = true; router.connect(m); await router.poll();
      return sendJson(res, 200, { connected: m, browsing: router.canBrowseNow(m) });
    }
    if (url.pathname === '/__dev/router' && req.method === 'POST') {
      router.online = url.searchParams.get('online') === '1';
      return sendJson(res, 200, { router_online: router.online });
    }
    if (url.pathname === '/__dev/exhaust' && req.method === 'POST') {   // o aparelho consome todo o crédito
      const mac = (url.searchParams.get('mac') || '').toUpperCase();
      const u = router.users.get(mac);
      if (!u) return sendJson(res, 404, { error: 'roteador simulado não tem este usuário' });
      u.uptime = u.limit; router.online = true;
      await router.poll();
      return sendJson(res, 200, { exhausted: true, reports: router.expReports.length });
    }
    if (url.pathname === '/__dev/state') {
      return sendJson(res, 200, { router_online: router.online, router_users: Object.fromEntries(router.users), orders: await h.orders() });
    }
    if (url.pathname.startsWith('/auth/') && req.method === 'OPTIONS') {            // CORS do Auth simulado
      res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'apikey, content-type, authorization', 'access-control-allow-methods': 'POST, OPTIONS' });
      return res.end();
    }
    if (url.pathname === '/auth/v1/token' && req.method === 'POST') {            // Auth SIMULADO (só demonstração local)
      const body = JSON.parse((await toRequest(req).then((r) => r.text())) || '{}');
      if (url.searchParams.get('grant_type') === 'password' && body.email === DEMO.email && body.password === DEMO.password) {
        return sendJson(res, 200, { access_token: DEMO.token, refresh_token: 'dev-refresh', expires_in: 3600 });
      }
      if (url.searchParams.get('grant_type') === 'refresh_token' && body.refresh_token === 'dev-refresh') {
        return sendJson(res, 200, { access_token: DEMO.token, refresh_token: 'dev-refresh', expires_in: 3600 });
      }
      return sendJson(res, 400, { error: 'invalid_grant' });
    }
    const name = /^\/functions\/v1\/([\w-]+)$/.exec(url.pathname)?.[1];
    if (name && functions[name]) return send(res, await functions[name](await toRequest(req)));
    sendJson(res, 404, { error: 'not found' });
  } catch (e) { console.error(e); sendJson(res, 500, { error: String(e.message) }); }
}).listen(API_PORT, () => console.log(`API     → ${API}/functions/v1  (controles em /__dev/)`));
