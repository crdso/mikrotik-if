// @ts-nocheck
// Código compartilhado das Edge Functions (Deno / Supabase). Sem dependências externas.
// Variáveis de ambiente são lidas a cada chamada (e não na carga do módulo),
// para que a troca de um segredo (ex.: SITE_ORIGIN) valha sem novo deploy.

// ---- Regras de negócio (fonte única; o banco confere o valor de novo) ------
export const PRICE_BRL = 5;
export const PRICE_CENTS = 500;
export const GRANT_SECONDS = 5 * 60 * 60; // 5 horas de uso acumulado
export const PIX_TTL_MINUTES = 30;
export const RECONCILE_SECONDS = 10; // intervalo mínimo entre consultas ao Mercado Pago por pedido

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v) => UUID_RE.test(String(v ?? ''));

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function env(name) {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing secret: ${name}`);
  return value;
}

// ---- CORS / origem ----------------------------------------------------------
// SITE_ORIGIN aceita uma ou mais origens separadas por vírgula, sem barra final.
export function allowedOrigins() {
  return (Deno.env.get('SITE_ORIGIN') || '')
    .split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
}
export function browserAllowed(req) {
  const origin = req.headers.get('origin') || '';
  return Boolean(origin) && allowedOrigins().includes(origin);
}
export function cors(req) {
  const headers = { 'Vary': 'Origin', 'Cache-Control': 'no-store' };
  const origin = req.headers.get('origin') || '';
  if (origin && allowedOrigins().includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Headers'] = 'content-type';
    headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    headers['Access-Control-Max-Age'] = '600';
  }
  return headers;
}
export function preflight(req) {
  if (req.method !== 'OPTIONS') return null;
  return new Response(null, { status: 204, headers: cors(req) });
}
export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    },
  });
}
export async function readJson(req, maxChars = 4096) {
  const text = await req.text();
  if (text.length > maxChars) throw new HttpError(413, 'Corpo grande demais');
  try { return JSON.parse(text); } catch { throw new HttpError(400, 'JSON inválido'); }
}

// Lê um corpo JSON ({"a":1}) ou de formulário (a=1&b=2). O RouterOS 6 não gera JSON.
export async function readBody(req, maxChars = 4096) {
  const text = (await req.text()).trim();
  if (text.length > maxChars) throw new HttpError(413, 'Corpo grande demais');
  if (text.startsWith('{')) {
    try { return JSON.parse(text); } catch { throw new HttpError(400, 'JSON inválido'); }
  }
  return Object.fromEntries(new URLSearchParams(text));
}

// Segundos -> notação de tempo do RouterOS (ex.: 18000 -> "5h0m0s").
export function rosTime(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m${s % 60}s`;
}

// Chave do roteador: ROUTER_SHARED_KEY e, opcionalmente, ROUTER_SHARED_KEY_NEXT
// (permite trocar a chave sem derrubar a sincronização: publique a nova como
// NEXT, atualize o roteador, depois promova a nova para ROUTER_SHARED_KEY).
export async function routerAuthorized(req) {
  const provided = req.headers.get('x-router-key') || '';
  if (!provided) return false;
  let ok = await safeEqual(provided, env('ROUTER_SHARED_KEY'));
  const next = Deno.env.get('ROUTER_SHARED_KEY_NEXT');
  if (next) ok = (await safeEqual(provided, next)) || ok;
  return ok;
}

// ---- Validações -------------------------------------------------------------
export function normalizeMac(mac) {
  const value = String(mac ?? '').trim().toUpperCase();
  return /^([A-F0-9]{2}:){5}[A-F0-9]{2}$/.test(value) ? value : null;
}
export function validEmail(email) {
  return typeof email === 'string' && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Comparação em tempo constante (compara SHA-256 dos dois valores).
export async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [da, dbb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(String(a))),
    crypto.subtle.digest('SHA-256', enc.encode(String(b))),
  ]);
  const x = new Uint8Array(da), y = new Uint8Array(dbb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

// ---- Banco: SOMENTE funções RPC (a lógica vive no SQL) ---------------------
export async function rpc(name, args = {}) {
  const url = Deno.env.get('SUPABASE_URL') || '';
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  if (!url || !key) throw new Error('Supabase credentials missing');
  const headers = { apikey: key, 'Content-Type': 'application/json' };
  // Chaves novas (sb_secret_...) não são JWT e vão só em "apikey".
  if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`;
  const res = await fetch(`${url}/rest/v1/rpc/${name}`, {
    method: 'POST', headers, body: JSON.stringify(args), signal: AbortSignal.timeout(10000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`rpc ${name} HTTP ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

// ---- Mercado Pago -----------------------------------------------------------
export class MpError extends Error {
  constructor(status, body) { super(`Mercado Pago HTTP ${status}`); this.status = status; this.body = body; }
}
async function mpRequest(method, path, { body, idempotencyKey } = {}) {
  const headers = { Authorization: `Bearer ${env('MP_ACCESS_TOKEN')}`, 'Content-Type': 'application/json' };
  if (idempotencyKey) headers['X-Idempotency-Key'] = idempotencyKey;
  const res = await fetch(`https://api.mercadopago.com${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* corpo não-JSON */ }
  if (!res.ok) throw new MpError(res.status, data);
  return data;
}
export const mpGetPayment = (id) => mpRequest('GET', `/v1/payments/${encodeURIComponent(id)}`);
export const mpCreatePix = (body, idempotencyKey) => mpRequest('POST', '/v1/payments', { body, idempotencyKey });
export const mpCancelPayment = (id) => mpRequest('PUT', `/v1/payments/${encodeURIComponent(id)}`, { body: { status: 'cancelled' } });

// O Mercado Pago espera datas no formato yyyy-MM-dd'T'HH:mm:ss.SSS-03:00.
export function mpDate(date) {
  return new Date(date.getTime() - 3 * 3600 * 1000).toISOString().replace('Z', '-03:00');
}

// Converte um pagamento lido da API do Mercado Pago nos argumentos da função SQL.
export function paymentApplyArgs(orderId, payment) {
  const amount = Number(payment.transaction_amount);
  return {
    p_order_id: orderId,
    p_payment_id: String(payment.id),
    p_mp_status: String(payment.status ?? ''),
    p_mp_status_detail: payment.status_detail == null ? null : String(payment.status_detail),
    p_amount_cents: Number.isFinite(amount) ? Math.round(amount * 100) : null,
    p_currency: payment.currency_id == null ? null : String(payment.currency_id),
    p_method: payment.payment_method_id == null ? null : String(payment.payment_method_id),
  };
}

// ---- Assinatura do webhook do Mercado Pago ----------------------------------
// manifest = "id:<data.id minúsculo>;request-id:<x-request-id>;ts:<ts>;"
// (campos ausentes são omitidos, conforme a documentação do Mercado Pago).
// Não impomos janela de tempo: o webhook nunca é confiado — o pagamento sempre
// é relido na API do Mercado Pago —, então reenviar uma notificação antiga é
// inofensivo, e rejeitar reenvios legítimos tardios faria perder pagamentos.
export async function verifyMpSignature({ signatureHeader, requestId, dataId, secret }) {
  const ts = /(?:^|,)\s*ts=([^,\s]+)/.exec(signatureHeader || '')?.[1];
  const v1 = /(?:^|,)\s*v1=([a-fA-F0-9]{64})(?:,|$)/.exec(signatureHeader || '')?.[1];
  if (!ts || !v1 || !dataId || !secret) return false;
  let manifest = `id:${String(dataId).toLowerCase()};`;
  if (requestId) manifest += `request-id:${requestId};`;
  manifest += `ts:${ts};`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(manifest)));
  const hex = [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
  return safeEqual(hex, v1.toLowerCase());
}
