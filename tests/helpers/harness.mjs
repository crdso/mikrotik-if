// Infra de testes: banco REAL (PGlite = Postgres em WebAssembly) com a migration
// verdadeira + Mercado Pago SIMULADO + PostgREST SIMULADO (apenas /rpc), tudo
// local. As Edge Functions de produção rodam sem modificação sobre um shim do Deno.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { createHmac, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const ENV = {
  SUPABASE_URL: 'https://proj.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'eyJ.fake-service-role.key',
  MP_ACCESS_TOKEN: 'TEST-fake-access-token',
  MP_WEBHOOK_SECRET: 'fake-webhook-secret',
  ROUTER_SHARED_KEY: 'fake-router-key_abc123',
  SITE_ORIGIN: 'https://site.netlify.app',
};
export const FN_BASE = `${ENV.SUPABASE_URL}/functions/v1`;
export const MAC_A = 'AA:BB:CC:DD:EE:01';
export const MAC_B = 'AA:BB:CC:DD:EE:02';

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

// ---------------------------------------------------------------------------
// Mercado Pago simulado
// ---------------------------------------------------------------------------
export class FakeMercadoPago {
  constructor() { this.reset(); }
  reset() {
    this.payments = new Map();
    this.byKey = new Map();
    this.nextId = 90000001;
    this.calls = [];           // {method, path, headers, body}
    this.failCreate = false;   // POST /v1/payments -> 500
    this.failGet = false;      // GET  -> 503
    this.createTamper = null;  // (payment, body) => void  (simula resposta inesperada)
  }
  json(status, body) { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); }
  async handle(url, init = {}) {
    const u = new URL(url);
    const method = (init.method || 'GET').toUpperCase();
    const headers = Object.fromEntries(new Headers(init.headers || {}));
    const body = init.body ? JSON.parse(init.body) : undefined;
    this.calls.push({ method, path: u.pathname, headers, body });
    if (headers.authorization !== `Bearer ${ENV.MP_ACCESS_TOKEN}`) return this.json(401, { message: 'Invalid access token' });

    if (method === 'POST' && u.pathname === '/v1/payments') {
      if (this.failCreate) return this.json(500, { message: 'internal error' });
      const key = headers['x-idempotency-key'];
      if (!key) return this.json(400, { message: 'x-idempotency-key header is required' });
      if (this.byKey.has(key)) return this.json(200, this.payments.get(this.byKey.get(key)));
      if (typeof body.transaction_amount !== 'number' || !body.payment_method_id || !body.payer?.email)
        return this.json(400, { message: 'invalid parameters' });
      const id = this.nextId++;
      const p = {
        id, status: 'pending', status_detail: 'pending_waiting_transfer',
        transaction_amount: body.transaction_amount, currency_id: 'BRL',
        payment_method_id: body.payment_method_id, payment_type_id: 'bank_transfer',
        external_reference: body.external_reference, description: body.description,
        date_of_expiration: body.date_of_expiration, notification_url: body.notification_url,
        point_of_interaction: { transaction_data: {
          qr_code: `00020126580014br.gov.bcb.pix0136fake-${id}5204000053039865405${body.transaction_amount.toFixed(2)}5802BR6304ABCD`,
          qr_code_base64: PNG_1X1, ticket_url: `https://www.mercadopago.com.br/sandbox/payments/${id}/ticket`,
        } },
      };
      if (this.createTamper) this.createTamper(p, body);
      this.payments.set(String(id), p);
      this.byKey.set(key, String(id));
      return this.json(201, p);
    }
    const m = /^\/v1\/payments\/([^/]+)$/.exec(u.pathname);
    if (m && method === 'GET') {
      if (this.failGet) return this.json(503, { message: 'unavailable' });
      const p = this.payments.get(decodeURIComponent(m[1]));
      return p ? this.json(200, p) : this.json(404, { message: 'Payment not found', status: 404 });
    }
    if (m && method === 'PUT') {
      const p = this.payments.get(decodeURIComponent(m[1]));
      if (!p) return this.json(404, { message: 'Payment not found' });
      if (body?.status === 'cancelled' && p.status === 'pending') { p.status = 'cancelled'; p.status_detail = 'by_collector'; }
      return this.json(200, p);
    }
    return this.json(404, { message: 'route not found' });
  }
  get(id) { return this.payments.get(String(id)); }
  set(id, status, detail = null, extra = {}) {
    const p = this.get(id); p.status = status; p.status_detail = detail ?? p.status_detail; Object.assign(p, extra); return p;
  }
  approve(id) { return this.set(id, 'approved', 'accredited', { date_approved: new Date().toISOString() }); }
  gets() { return this.calls.filter((c) => c.method === 'GET'); }
  creates() { return this.calls.filter((c) => c.method === 'POST'); }
}

// ---------------------------------------------------------------------------
// Utilitários de requisição
// ---------------------------------------------------------------------------
export function req(url, { method = 'GET', headers = {}, body, origin = ENV.SITE_ORIGIN } = {}) {
  const h = new Headers(headers);
  if (origin) h.set('origin', origin);
  if (body !== undefined && !h.has('content-type')) h.set('content-type', 'application/json');
  return new Request(url, { method, headers: h, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
}
export async function read(res) {
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* não JSON */ }
  return { status: res.status, data, text, headers: res.headers };
}

// Webhook assinado como o Mercado Pago (reimplementação independente via node:crypto).
export function signedWebhook({ dataId, secret = ENV.MP_WEBHOOK_SECRET, ts = Math.floor(Date.now() / 1000),
  requestId = `req-${randomUUID()}`, type = 'payment', sigOverride, omitSignature = false, queryId } = {}) {
  const manifest = `id:${String(dataId).toLowerCase()};request-id:${requestId};ts:${ts};`;
  const v1 = createHmac('sha256', secret).update(manifest).digest('hex');
  const headers = { 'content-type': 'application/json', 'x-request-id': requestId };
  if (!omitSignature) headers['x-signature'] = sigOverride ?? `ts=${ts},v1=${v1}`;
  return new Request(`${FN_BASE}/mp-webhook?data.id=${queryId ?? dataId}&type=${type}`, {
    method: 'POST', headers,
    body: JSON.stringify({ action: `${type}.updated`, type, data: { id: String(dataId) } }),
  });
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
let handlersPromise = null;
async function loadHandlers() {
  if (!handlersPromise) {
    Object.assign(process.env, ENV);
    globalThis.Deno = { env: { get: (k) => process.env[k] }, serve: () => {} };
    handlersPromise = (async () => {
      const imp = async (n) => (await import(pathToFileURL(path.join(ROOT, 'supabase', 'functions', n, 'index.ts')).href)).handler;
      const common = await import(pathToFileURL(path.join(ROOT, 'supabase', 'functions', '_shared', 'common.ts')).href);
      return {
        createPayment: await imp('create-payment'), webhook: await imp('mp-webhook'),
        paymentStatus: await imp('payment-status'), routerSync: await imp('router-sync'), common,
      };
    })();
  }
  return handlersPromise;
}

export async function createHarness() {
  const handlers = await loadHandlers();
  const pg = new PGlite();
  // Papéis do Supabase, com privilégios padrão como na plataforma real.
  await pg.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  `);
  // Aplica TODAS as migrations, em ordem, como o Supabase faz.
  const dir = path.join(ROOT, 'supabase', 'migrations');
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()) await pg.exec(readFileSync(path.join(dir, f), 'utf8'));

  const mp = new FakeMercadoPago();
  const state = { rpcCalls: [], failRpc: null };

  async function rpcAsServiceRole(name, args = {}) {
    if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error('bad rpc name');
    const keys = Object.keys(args);
    for (const k of keys) if (!/^[a-z_][a-z0-9_]*$/.test(k)) throw new Error('bad rpc arg');
    const named = keys.map((k, i) => `${k} => $${i + 1}`).join(', ');
    return pg.transaction(async (tx) => {
      await tx.exec('set local role service_role');
      const r = await tx.query(`select to_jsonb(public.${name}(${named})) as r`, keys.map((k) => args[k]));
      return r.rows[0].r;
    });
  }

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.startsWith('https://api.mercadopago.com/')) return mp.handle(url, init);
    if (url.startsWith(`${ENV.SUPABASE_URL}/rest/v1/rpc/`)) {
      const name = url.slice(`${ENV.SUPABASE_URL}/rest/v1/rpc/`.length);
      const headers = Object.fromEntries(new Headers(init.headers || {}));
      if (headers.apikey !== ENV.SUPABASE_SERVICE_ROLE_KEY) return new Response('{"message":"Invalid API key"}', { status: 401 });
      state.rpcCalls.push(name);
      if (state.failRpc && state.failRpc(name)) return new Response('{"message":"db down"}', { status: 503 });
      try {
        const out = await rpcAsServiceRole(name, init.body ? JSON.parse(init.body) : {});
        return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
      } catch (e) {
        return new Response(JSON.stringify({ message: String(e.message) }), { status: 400, headers: { 'content-type': 'application/json' } });
      }
    }
    return realFetch(input, init);
  };

  const h = {
    pg, mp, state, ...handlers,
    webhookHandler: handlers.webhook, // (h.webhook abaixo é o atalho de teste)
    rpc: rpcAsServiceRole,
    q: async (sql, params) => (await pg.query(sql, params)).rows,
    orders: () => pg.query('select * from public.hotspot_orders order by created_at').then((r) => r.rows),
    order: (id) => pg.query('select * from public.hotspot_orders where id = $1', [id]).then((r) => r.rows[0]),
    close: async () => { globalThis.fetch = realFetch; await pg.close(); },

    // Atalhos de fluxo -------------------------------------------------------
    async createPix(mac = MAC_A, email = 'passageiro@example.com', extra = {}) {
      const res = await read(await handlers.createPayment(req(`${FN_BASE}/create-payment`, { method: 'POST', body: { mac, email, ...extra } })));
      return res;
    },
    async status(order) {
      return read(await handlers.paymentStatus(req(`${FN_BASE}/payment-status?id=${order.order_id}&token=${order.read_token}`)));
    },
    async webhook(paymentId, opts = {}) { return read(await handlers.webhook(signedWebhook({ dataId: paymentId, ...opts }))); },
    routerHeaders: { 'x-router-key': ENV.ROUTER_SHARED_KEY },
    // fmt: 'json' (padrão nos testes antigos) ou 'text' (o formato real do roteador)
    async routerPull(key = ENV.ROUTER_SHARED_KEY, fmt = 'json') {
      const q = fmt === 'json' ? '?fmt=json' : '';
      return read(await handlers.routerSync(req(`${FN_BASE}/router-sync${q}`, { headers: key === null ? {} : { 'x-router-key': key }, origin: null })));
    },
    async routerRaw(path = '', init = {}) {
      return read(await handlers.routerSync(req(`${FN_BASE}/router-sync${path}`, { origin: null, ...init })));
    },
    // ACK como o RouterOS 6 envia: formulário "order=<uuid>&mac=<MAC>".
    async routerAckForm(order, mac, key = ENV.ROUTER_SHARED_KEY) {
      return read(await handlers.routerSync(req(`${FN_BASE}/router-sync`, {
        method: 'POST', origin: null, body: `order=${order}&mac=${mac}`,
        headers: { 'x-router-key': key, 'content-type': 'application/x-www-form-urlencoded' } })));
    },
    // Aviso do roteador: "expired=MAC1,MAC2," (crédito esgotado).
    async routerReportExpired(list, key = ENV.ROUTER_SHARED_KEY) {
      return read(await handlers.routerSync(req(`${FN_BASE}/router-sync`, {
        method: 'POST', origin: null, body: `expired=${list}`,
        headers: { 'x-router-key': key, 'content-type': 'application/x-www-form-urlencoded' } })));
    },
    async routerAck(order_id, mac, key = ENV.ROUTER_SHARED_KEY) {
      return read(await handlers.routerSync(req(`${FN_BASE}/router-sync`, { method: 'POST', headers: { 'x-router-key': key }, body: { order_id, mac }, origin: null })));
    },
    // Pix criado + pago pelo Mercado Pago + webhook entregue.
    async payOrder(mac = MAC_A) {
      const created = await h.createPix(mac);
      const paymentId = [...h.mp.payments.keys()].at(-1);
      h.mp.approve(paymentId);
      const wh = await h.webhook(paymentId);
      return { created: created.data, paymentId, webhook: wh };
    },
  };
  return h;
}
