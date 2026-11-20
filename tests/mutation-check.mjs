// "Teste dos testes": quebra o código de propósito (uma falha por vez) e confirma que a
// suíte DETECTA. Cada mutação é revertida no final (mesmo em caso de erro).
// Uso: npm run test:mutation      (leva alguns minutos; não faz parte do `npm test`)
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SQL = 'supabase/migrations/202611170001_hotspot_orders.sql';
const SQL2 = 'supabase/migrations/202611190002_device_credit.sql';
const ALL = ['tests/db.test.mjs', 'tests/functions.test.mjs', 'tests/e2e.test.mjs', 'tests/device-credit.test.mjs', 'tests/static.test.mjs'];

const mutations = [
  { name: 'SQL: ignora o valor pago na aprovação', file: SQL,
    find: 'or p_amount_cents is distinct from v_o.amount_cents then', repl: 'or false then', tests: ALL },
  { name: 'SQL: pedido failed/expired não pode mais ser pago', file: SQL,
    find: "if v_o.payment_status = 'refunded' then", repl: "if v_o.payment_status <> 'pending' then", tests: ALL },
  { name: 'SQL: anon/authenticated mantêm EXECUTE nas funções', file: SQL,
    find: "from public, anon, authenticated', f);", repl: "from public', f);", tests: ALL },
  { name: 'SQL: roteador enxerga pedidos NÃO pagos', file: SQL,
    find: "where payment_status = 'paid' and provisioned_at is null\n           order by created_at asc",
    repl: "where provisioned_at is null\n           order by created_at asc", tests: ALL },
  { name: 'SQL: ACK aceita MAC diferente do pedido', file: SQL,
    find: '     and device_mac = v_mac\n     and payment_status = \'paid\'\n     and provisioned_at is null\n   returning id into v_id;',
    repl: '     and payment_status = \'paid\'\n     and provisioned_at is null\n   returning id into v_id;', tests: ALL },
  { name: 'SQL: sem limite de pedidos por aparelho', file: SQL,
    find: 'if v_n >= 5 then', repl: 'if v_n >= 5000 then', tests: ALL },
  { name: 'TS: webhook sem verificar a assinatura', file: 'supabase/functions/mp-webhook/index.ts',
    find: "if (!ok) return json({ error: 'Invalid signature' }, 401);", repl: "if (false) return json({ error: 'Invalid signature' }, 401);", tests: ALL },
  { name: 'TS: router-sync sem autenticação', file: 'supabase/functions/router-sync/index.ts',
    find: "if (!(await routerAuthorized(req))) return json({ error: 'Unauthorized' }, 401);", repl: "if (false) return json({ error: 'Unauthorized' }, 401);", tests: ALL },
  { name: 'TS: preço vem do navegador', file: 'supabase/functions/create-payment/index.ts',
    find: 'transaction_amount: PRICE_BRL,', repl: 'transaction_amount: Number(input?.amount ?? PRICE_BRL),', tests: ALL },
  { name: 'TS: reconciliação aceita pagamento de outro pedido', file: 'supabase/functions/payment-status/index.ts',
    find: 'String(payment?.external_reference) === id', repl: 'true', tests: ALL },
  { name: 'TS: CORS aceita qualquer origem', file: 'supabase/functions/_shared/common.ts',
    find: "return Boolean(origin) && allowedOrigins().includes(origin);", repl: 'return true;', tests: ALL },
  { name: 'RSC: desliga a validação do certificado TLS', file: 'router/hotspot-poll.rsc',
    find: ':local tls "yes-without-crl"', repl: ':local tls "no"', tests: ['tests/static.test.mjs'] },
  { name: 'RSC: usa comando que só existe no RouterOS 7', file: 'router/hotspot-poll.rsc',
    find: ':local maxGrant 2d', repl: ':local maxGrant 2d\n:onerror e in={ :put 1 } do={ :put 2 }', tests: ['tests/static.test.mjs'] },
  { name: 'RSC: aceita crédito acima do teto', file: 'router/hotspot-poll.rsc',
    find: ':local maxGrant 2d', repl: ':local maxGrant 999d', tests: ['tests/static.test.mjs'] },
  { name: 'SQL: portal nunca enxerga o crédito como esgotado', file: SQL2,
    find: "and o.provisioned_at is not null) then 'exhausted'", repl: "and o.provisioned_at is not null) then 'active'", tests: ALL },
  { name: 'SQL: aviso de esgotado aceito para MAC sem crédito concedido', file: SQL2,
    find: 'if v_last is null then continue; end if;', repl: '', tests: ALL },
  { name: 'Gerador do roteador aceita TLS sem validação', file: 'scripts/prepare-router.mjs',
    find: "if (!['yes-without-crl', 'yes'].includes(tls))", repl: 'if (false)', tests: ['tests/static.test.mjs'] },
  { name: 'Portal: volta a exibir suporte/telefone', file: 'site/index.html',
    find: '<noscript>', repl: '<p>Suporte: procure o responsável</p><noscript>', tests: ['tests/static.test.mjs'] },
  { name: 'Portal: CSP permissiva', file: 'site/_headers',
    find: "default-src 'none'", repl: "default-src * 'unsafe-inline'", tests: ['tests/static.test.mjs'] },
  { name: 'Portal: JS inline no HTML', file: 'site/index.html',
    find: '<script src="/app.js"></script>', repl: '<script>alert(1)</script>', tests: ['tests/static.test.mjs'] },
];

let survivors = 0;
const only = process.argv[2]; // opcional: roda só as mutações cujo nome contém este texto
for (const m of mutations.filter((x) => !only || x.name.includes(only))) {
  const file = path.join(ROOT, m.file);
  const original = readFileSync(file, 'utf8');
  const count = original.split(m.find).length - 1;
  if (count !== 1) { console.log(`?? ${m.name}: trecho encontrado ${count}x (esperado 1) — mutação inválida`); survivors++; continue; }
  try {
    writeFileSync(file, original.replace(m.find, m.repl));
    const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...m.tests], { cwd: ROOT, encoding: 'utf8' });
    const failed = r.status !== 0;
    console.log(`${failed ? 'DETECTADA ' : 'SOBREVIVEU'}  ${m.name}`);
    if (!failed) survivors++;
  } finally { writeFileSync(file, original); }
}
console.log(survivors ? `\n${survivors} mutação(ões) NÃO foram detectadas.` : '\nTodas as mutações foram detectadas pela suíte.');
process.exit(survivors ? 1 : 0);
