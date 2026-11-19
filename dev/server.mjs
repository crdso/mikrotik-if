// Servidor LOCAL de demonstração/teste. NÃO usa credenciais nem serviços reais:
// banco = PGlite em memória, Mercado Pago = simulador, MikroTik = modelo em JS.
//   Portal:  http://localhost:8787/?mac=AA:BB:CC:DD:EE:10   (como a Netlify)
//   API:     http://localhost:8788/functions/v1/...          (como o Supabase; origem diferente => CORS real)
// Controles de teste (só aqui, nunca em produção):
//   POST :8788/__dev/pay?mac=AA:BB:..   aprova o Pix mais recente do MAC e entrega o webhook assinado
//   POST :8788/__dev/router?online=1|0  liga/desliga o roteador simulado (consulta a cada 3 s)
//   GET  :8788/__dev/state              pedidos e usuários do roteador simulado
import http from 'node:http';
import { readFileSync } from 'node:fs';
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
setInterval(() => { router.poll().catch((e) => console.error('router sim:', e.message)); }, 3000);

const csp = /Content-Security-Policy:\s*(.+)/.exec(readFileSync(path.join(ROOT, 'site/_headers'), 'utf8'))[1]
  .replace('https://SEU-PROJETO.supabase.co', API);
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

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
  const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  if (!/^[\w.-]+$/.test(file) || file.startsWith('_')) { res.writeHead(404, common); return res.end('not found'); }
  try {
    const body = readFileSync(path.join(ROOT, 'site', file));
    res.writeHead(200, { ...common, 'content-type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404, common); res.end('not found'); }
}).listen(SITE_PORT, () => console.log(`Portal  → ${SITE}/?mac=AA:BB:CC:DD:EE:10`));

const functions = { 'create-payment': h.createPayment, 'payment-status': h.paymentStatus, 'mp-webhook': h.webhookHandler, 'router-sync': h.routerSync };
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
    if (url.pathname === '/__dev/router' && req.method === 'POST') {
      router.online = url.searchParams.get('online') === '1';
      return sendJson(res, 200, { router_online: router.online });
    }
    if (url.pathname === '/__dev/state') {
      return sendJson(res, 200, { router_online: router.online, router_users: Object.fromEntries(router.users), orders: await h.orders() });
    }
    const name = /^\/functions\/v1\/([\w-]+)$/.exec(url.pathname)?.[1];
    if (name && functions[name]) return send(res, await functions[name](await toRequest(req)));
    sendJson(res, 404, { error: 'not found' });
  } catch (e) { console.error(e); sendJson(res, 500, { error: String(e.message) }); }
}).listen(API_PORT, () => console.log(`API     → ${API}/functions/v1  (controles em /__dev/)`));
