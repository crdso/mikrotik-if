// VERIFICAÇÕES ESTÁTICAS (não executam fluxos): consistência entre arquivos, sintaxe,
// segredos, permissões do SQL e política de segurança do portal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { ROOT } from './helpers/harness.mjs';

const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (['node_modules', '.git', 'tests', 'dist-site'].includes(name)) continue;
    const full = path.join(dir, name);
    statSync(full).isDirectory() ? walk(full, out) : out.push(full);
  }
  return out;
}

test('SQL: toda função criada é restrita a service_role; toda tabela tem RLS', () => {
  const sql = read('supabase/migrations/202611170001_hotspot_orders.sql');
  const created = [...sql.matchAll(/create or replace function public\.(\w+)\(([^)]*)\)/g)].map((m) => m[1]);
  assert.ok(created.length >= 9);
  const granted = sql.slice(sql.indexOf('foreach f in array'));
  for (const fn of created) assert.match(granted, new RegExp(`'${fn}\\(`), `${fn} sem revoke/grant`);
  assert.match(sql, /revoke all on function public\.%s from public, anon, authenticated/);
  assert.match(sql, /grant execute on function public\.%s to service_role/);
  for (const t of [...sql.matchAll(/create table if not exists public\.(\w+)/g)].map((m) => m[1])) {
    assert.match(sql, new RegExp(`alter table public\\.${t} enable row level security`), `${t} sem RLS`);
    assert.match(sql, new RegExp(`revoke all privileges on table public\\.${t} from public, anon, authenticated`), `${t} sem revoke`);
  }
  assert.doesNotMatch(sql, /create policy/i, 'nenhuma policy pública');
  assert.doesNotMatch(sql, /security definer/i, 'funções rodam com os privilégios de quem chama (service_role)');
  for (const fn of created) {
    const body = sql.slice(sql.indexOf(`function public.${fn}(`));
    assert.match(body.slice(0, 700), /set search_path = public, pg_temp/, `${fn} sem search_path fixo`);
  }
});

test('Edge Functions: config.toml cobre todas as funções; nenhum segredo hardcoded', () => {
  const dirs = readdirSync(path.join(ROOT, 'supabase/functions')).filter((d) => !d.startsWith('_'));
  const toml = read('supabase/config.toml');
  for (const d of dirs) assert.match(toml, new RegExp(`\\[functions\\.${d}\\][\\s\\S]*?verify_jwt = false`), d);
  const patterns = [/APP_USR-[0-9a-f-]{10,}/i, /TEST-\d{6,}-/, /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/, /sb_secret_[A-Za-z0-9]{12,}/, /whsec_[A-Za-z0-9]{8,}/];
  for (const f of walk(ROOT)) {
    if (/\.(png|ico|lock)$/.test(f) || f.includes('package-lock')) continue;
    const text = readFileSync(f, 'utf8');
    for (const p of patterns) assert.doesNotMatch(text, p, `possível segredo em ${path.relative(ROOT, f)}`);
  }
});

test('Edge Functions: só leem segredos pelo ambiente e nunca registram segredos no log', () => {
  for (const f of ['create-payment', 'mp-webhook', 'payment-status', 'router-sync']) {
    const src = read(`supabase/functions/${f}/index.ts`);
    assert.doesNotMatch(src, /console\.(log|error)\([^)]*(MP_ACCESS_TOKEN|ROUTER_SHARED_KEY|MP_WEBHOOK_SECRET|SERVICE_ROLE|read_token)/, f);
    assert.match(src, /Deno\.serve\(handler\)/);
  }
  const common = read('supabase/functions/_shared/common.ts');
  assert.doesNotMatch(common, /Deno\.env\.get\('(MP_ACCESS_TOKEN|MP_WEBHOOK_SECRET|ROUTER_SHARED_KEY)'\)\s*\|\|\s*'[^']+'/, 'sem valores padrão para segredos');
  assert.match(common, /PRICE_CENTS = 500/);
  assert.match(common, /GRANT_SECONDS = 5 \* 60 \* 60/);
});

test('Portal: nada de JS/CSS inline, handlers inline ou recursos externos (compatível com a CSP)', () => {
  const html = read('site/index.html');
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, 'script inline');
  assert.doesNotMatch(html, /<style/i, 'style inline');
  assert.doesNotMatch(html, /\sstyle\s*=/i, 'atributo style');
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, 'handler inline');
  assert.doesNotMatch(html, /(src|href)\s*=\s*"https?:\/\/(?!neverssl\.com)/i, 'recurso externo');
  assert.match(html, /name="viewport"/);
  const css = read('site/style.css'); assert.doesNotMatch(css, /@import|url\(\s*['"]?https?:/i);
});

test('Portal: app.js compila e todos os ids que usa existem no HTML', () => {
  const js = read('site/app.js');
  new vm.Script(js, { filename: 'app.js' });
  const html = read('site/index.html');
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const used = new Set([...js.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
  for (const p of ['buy', 'pix', 'paid', 'done', 'ended', 'invalid']) used.add(p);
  for (const id of used) assert.ok(ids.has(id), `id "${id}" usado em app.js não existe em index.html`);
  assert.doesNotMatch(js, /innerHTML|document\.write|eval\(/, 'sem sinks de XSS');
  new vm.Script(read('site/config.js'));
});

test('Portal: _headers tem CSP restritiva, sem unsafe-inline e conectando só ao Supabase', () => {
  const headers = read('site/_headers');
  assert.match(headers, /default-src 'none'/);
  assert.match(headers, /script-src 'self'/);
  assert.match(headers, /connect-src https:\/\/SEU-PROJETO\.supabase\.co/);
  assert.match(headers, /frame-ancestors 'none'/);
  const policy = /Content-Security-Policy:\s*(.+)/.exec(headers)[1]; // (a linha "/*" é só o caminho da Netlify)
  assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval|\*/);
});

function stripRouterOS(src) {
  // remove comentários de linha inteira e o conteúdo de strings
  return src.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n').replace(/"(?:\\.|[^"\\])*"/g, '""');
}
test('RouterOS (.rsc): delimitadores balanceados, TLS validado, constantes batem com o backend', () => {
  const rsc = read('router/hotspot-poll.rsc');
  const code = stripRouterOS(rsc);
  for (const [o, c] of [['{', '}'], ['[', ']'], ['(', ')']]) {
    assert.equal(code.split(o).length, code.split(c).length, `${o}${c} desbalanceado`);
  }
  const live = rsc.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n'); // sem comentários, strings intactas
  assert.doesNotMatch(live, /check-certificate=no\b/, 'nunca desligar a validação TLS');
  assert.match(live, /:local tls "(yes-without-crl|yes)"/, 'validação de certificado ligada');
  assert.equal((live.match(/check-certificate=\$tls/g) || []).length, 2, 'GET e POST usam a validação');
  assert.match(live, /:local maxGrant 2d/);
  assert.match(live, /:local profile "wifi-5h"/);
  assert.match(live, /X-Router-Key/);
  assert.match(live, /limit-uptime=\(\$cur \+ \$dur\)/, 'soma ao tempo restante');
  assert.match(rsc, /SEU-PROJETO\.supabase\.co/); assert.match(rsc, /COLOQUE_A_MESMA_ROUTER_SHARED_KEY/);
  // Compatibilidade RouterOS 6: nada que só exista no 7.13+ (fora dos comentários).
  for (const v7 of [':serialize', ':deserialize', ':onerror', ':jobname', 'json.no-string-conversion']) {
    assert.ok(!live.includes(v7), `${v7} não existe no RouterOS 6`);
  }
  assert.match(live, /\} on-error=\{/, 'tratamento de erro no estilo do RouterOS 6');
  assert.doesNotMatch(read('router/diagnostico.rsc').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n'),
    /\/(ip|system|interface|certificate)[^\n]*\s(add|set|remove|import|reset|disable|enable)\b/, 'diagnóstico é só leitura');
  assert.match(read('supabase/functions/_shared/common.ts'), /GRANT_SECONDS = 5 \* 60 \* 60/);
  assert.match(read('docs/mikrotik.md'), /\/ip hotspot user profile add name=wifi-5h shared-users=1 rate-limit=1M\/4M/);
});

test('RouterOS: posições do texto no script batem com o formato emitido pelo backend', () => {
  const rsc = read('router/hotspot-poll.rsc');
  assert.match(rsc, /\[:pick \$line 2 19\]/); assert.match(rsc, /\[:pick \$line 20 56\]/); assert.match(rsc, /\[:pick \$line 57 \[:len \$line\]\]/);
  assert.match(rsc, /\[:pick \$line 0 2\] = "G "/); // (a linha de teste usa as mesmas posições)
  assert.match(rsc, /"order=" \. \$oid \. "&mac=" \. \$mac/);
  const sync = read('supabase/functions/router-sync/index.ts');
  assert.match(sync, /`G \$\{o\.mac\} \$\{o\.id\} \$\{rosTime\(o\.grant_seconds\)\}`/);
  assert.match(sync, /data\?\.order_id \?\? data\?\.order/); assert.match(sync, /data\?\.mac/);
  assert.match(sync, /MAX_PER_POLL = 10/);
});

test('login.html: placeholders do portal e $(mac) presentes (3 destinos a trocar)', () => {
  const html = read('router/login.html');
  assert.equal((html.match(/https:\/\/SEU-SITE\.netlify\.app/g) || []).length, 3);
  assert.ok((html.match(/\$\(mac\)/g) || []).length >= 3);
});

test('Documentação: nome da rede e valores consistentes; sem segredos reais no .env.example', () => {
  const docFiles = readdirSync(path.join(ROOT, 'docs')).map((f) => `docs/${f}`);
  const docs = ['README.md', ...docFiles].map(read).join('\n');
  assert.doesNotMatch(docs, /WIFI-[A-Z]/, 'nome de rede divergente');
  for (const f of docFiles) assert.ok(read('README.md').includes(f), `README não aponta para ${f}`);
  assert.match(docs, /Wi-Fi a Bordo/i);
  for (const secret of ['MP_ACCESS_TOKEN', 'MP_WEBHOOK_SECRET', 'ROUTER_SHARED_KEY', 'SITE_ORIGIN']) {
    assert.match(docs, new RegExp(secret)); assert.match(read('.env.example'), new RegExp(`^${secret}=`, 'm'));
  }
  assert.match(read('.env.example'), /^MP_ACCESS_TOKEN=SEU_TOKEN/m);
  assert.match(read('.gitignore'), /^\.env$/m); assert.match(read('.gitignore'), /^node_modules\/$/m);
  assert.match(read('site/index.html'), /R\$ 5,00/); assert.match(read('site/index.html'), /5 horas/);
  assert.ok(existsSync(path.join(ROOT, 'scripts/prepare-site.mjs')));
});

test('Repositório público: sem termos locais, e-mails reais, caminhos pessoais ou arquivos de segredo', () => {
  const skipDirs = new Set(['node_modules', '.git', 'dist-site']);
  const all = [];
  (function scan(dir) {
    for (const name of readdirSync(dir)) {
      if (skipDirs.has(name)) continue;
      const full = path.join(dir, name);
      statSync(full).isDirectory() ? scan(full) : all.push(full);
    }
  })(ROOT);
  const self = path.join(ROOT, 'tests', 'static.test.mjs');
  const banned = /escola|viagem|ônibus|onibus|\baluno/i;
  const email = /[A-Za-z0-9._%+-]+@(?!example\.|b\.co|email\.com|placeholder)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
  const personalPath = /[A-Za-z]:\Users\|\/Users\/[a-z]|\/home\/[a-z]/i;
  for (const f of all) {
    const rel = path.relative(ROOT, f);
    assert.doesNotMatch(rel, /(^|[\/])\.env($|\.)(?!example)|\.(pem|key|p12|pfx|backup|export)$/i, `arquivo sensível: ${rel}`);
    if (f === self || /package-lock\.json$/.test(f)) continue;
    const text = readFileSync(f, 'utf8');
    assert.doesNotMatch(text, banned, `termo local em ${rel}`);
    assert.doesNotMatch(text, email, `e-mail real em ${rel}`);
    assert.doesNotMatch(text, personalPath, `caminho pessoal em ${rel}`);
  }
});
