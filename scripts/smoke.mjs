#!/usr/bin/env node
// Verificação pós-implantação SEM EFEITO FINANCEIRO: não cria Pix, não cobra ninguém.
// Confere se as funções publicadas respondem como esperado (CORS, rejeições, chave do roteador).
//
// Uso (PowerShell):
//   $env:SUPABASE_URL="https://SEU-PROJETO.supabase.co"
//   $env:SITE_ORIGIN="https://SEU-SITE.netlify.app"
//   $env:ROUTER_SHARED_KEY="a-mesma-chave-do-supabase"   # opcional
//   node scripts/smoke.mjs
//
// A chave do roteador (se informada) só é enviada ao SUPABASE_URL que você configurou.
const base = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const origin = (process.env.SITE_ORIGIN || '').replace(/\/+$/, '');
const routerKey = process.env.ROUTER_SHARED_KEY || '';
if (!/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(base) || !/^https:\/\//.test(origin)) {
  console.error('Defina SUPABASE_URL (https://<projeto>.supabase.co) e SITE_ORIGIN (https://<site>).');
  process.exit(2);
}
const fn = `${base}/functions/v1`;
let failed = 0;
async function check(name, run) {
  try { await run(); console.log(`  OK   ${name}`); }
  catch (e) { failed++; console.log(`  FALHA ${name}: ${e.message}`); }
}
const eq = (a, b, what) => { if (a !== b) throw new Error(`${what}: esperado ${b}, veio ${a}`); };

console.log(`Verificando ${fn} (origem do portal: ${origin})`);
await check('CORS: preflight de create-payment aceita a origem do portal', async () => {
  const r = await fetch(`${fn}/create-payment`, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
  eq(r.status, 204, 'status'); eq(r.headers.get('access-control-allow-origin'), origin, 'allow-origin');
});
await check('CORS: outra origem NÃO é aceita', async () => {
  const r = await fetch(`${fn}/create-payment`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
  eq(r.headers.get('access-control-allow-origin'), null, 'allow-origin');
});
await check('create-payment recusa chamada sem Origin do portal (403)', async () => {
  const r = await fetch(`${fn}/create-payment`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  eq(r.status, 403, 'status');
});
await check('create-payment recusa MAC inválido (400, nenhum pedido criado)', async () => {
  const r = await fetch(`${fn}/create-payment`, { method: 'POST', headers: { Origin: origin, 'content-type': 'application/json' }, body: JSON.stringify({ mac: 'invalido', email: 'a@b.co' }) });
  eq(r.status, 400, 'status');
});
await check('payment-status devolve 404 para pedido inexistente', async () => {
  const u = '00000000-0000-4000-8000-000000000000';
  const r = await fetch(`${fn}/payment-status?id=${u}&token=${u}`, { headers: { Origin: origin } });
  eq(r.status, 404, 'status');
});
await check('mp-webhook recusa chamada sem assinatura (401)', async () => {
  const r = await fetch(`${fn}/mp-webhook?data.id=1&type=payment`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"type":"payment"}' });
  eq(r.status, 401, 'status');
});
await check('router-sync recusa chamada sem chave (401)', async () => {
  const r = await fetch(`${fn}/router-sync`);
  eq(r.status, 401, 'status');
});
if (routerKey) {
  await check('router-sync aceita a chave configurada e devolve a lista (GET apenas lê)', async () => {
    const r = await fetch(`${fn}/router-sync`, { headers: { 'X-Router-Key': routerKey } });
    eq(r.status, 200, 'status');
    const j = await r.json();
    if (!Array.isArray(j.orders)) throw new Error('resposta sem "orders"');
    console.log(`       (pedidos pagos aguardando o roteador: ${j.orders.length})`);
  });
} else {
  console.log('  --   router-sync com chave: pulado (ROUTER_SHARED_KEY não informada)');
}
console.log(failed ? `\n${failed} verificação(ões) falharam.` : '\nTodas as verificações passaram. Nenhuma cobrança foi criada.');
process.exit(failed ? 1 : 0);
