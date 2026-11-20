// VERIFICAÇÕES ESTÁTICAS (não executam fluxos): consistência entre arquivos, sintaxe,
// segredos, permissões do SQL e política de segurança do portal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import vm from 'node:vm';
import { execSync } from 'node:child_process';
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

test('SQL: toda função criada é restrita a service_role; toda tabela tem RLS (todas as migrations)', () => {
  for (const file of readdirSync(path.join(ROOT, 'supabase/migrations')).filter((n) => n.endsWith('.sql')).sort()) {
  const sql = read(`supabase/migrations/${file}`);
  const created = [...sql.matchAll(/create or replace function public\.(\w+)\(([^)]*)\)/g)].map((m) => m[1]);
  assert.ok(created.length >= 1, file);
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
  assert.doesNotMatch(common, /PRICE_(BRL|CENTS)|GRANT_SECONDS/, 'preço e duração vêm do plano (banco), nunca de constantes');
  const cp = read('supabase/functions/create-payment/index.ts');
  assert.match(cp, /hotspot_reserve_plan_order/); assert.match(cp, /amountCents/);
  assert.doesNotMatch(cp, /input\??\.(amount|price|grant|seconds|price_cents|grant_seconds)/, 'o navegador não envia preço nem duração');
});

test('Portal: nada de JS/CSS inline, handlers inline ou recursos externos (compatível com a CSP)', () => {
  const html = read('site/index.html');
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, 'script inline');
  assert.doesNotMatch(html, /<style/i, 'style inline');
  assert.doesNotMatch(html, /\sstyle\s*=/i, 'atributo style');
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, 'handler inline');
  assert.doesNotMatch(html, /(src|href)\s*=\s*"https?:\/\//i, 'recurso externo');
  assert.match(html, /name="viewport"/);
  const css = read('site/style.css'); assert.doesNotMatch(css, /@import|url\(\s*['"]?https?:/i);
});

test('Portal: app.js compila e todos os ids que usa existem no HTML', () => {
  const js = read('site/app.js');
  new vm.Script(js, { filename: 'app.js' });
  const html = read('site/index.html');
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const used = new Set([...js.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
  for (const p of ['loading', 'reg', 'wait', 'pix', 'paid', 'done', 'ended', 'invalid']) used.add(p);
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
  // Reautenticação (correção da falha de login por MAC): só usuários ATIVOS, só hosts não autenticados, com limite
  assert.ok(live.includes(':local u [/ip hotspot user find where name=$hm disabled=no comment~"[ov]:"]'), 'nunca reautentica usuário desativado');
  assert.ok(live.includes('[/ip hotspot host find where authorized=no bypassed=no]'), 'só hosts não autenticados');
  assert.match(live, /:local healMax 3\n:local healEvery 3m/);
  assert.equal((live.match(/\/ip hotspot host remove/g) || []).length, 1, 'remoção de host só no plano B, para um MAC');
  assert.doesNotMatch(live, /\/ip hotspot user remove|\/ip hotspot host remove \[find\]/, 'nunca apaga usuários nem todos os hosts');
  assert.match(live, /limit-uptime=0s comment="v:viagem"/, 'acesso de viagem sem limite de tempo');
  assert.equal((live.match(/check-certificate=\$tls/g) || []).length, 6, 'GET, ACK, ACK de comando, aviso de esgotado e os 2 envios de telemetria usam a validação');
  assert.match(live, /"expired=" \. \$toRep/); assert.match(live, /:local expMargin 10s/); assert.match(live, /\[\/ip hotspot user get \$eu uptime\] \+ \$expMargin\) >= \$lim/);
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
  assert.match(read('supabase/functions/router-sync/index.ts'), /rosTime\(o\.grant_seconds\)/, 'a duração enviada ao roteador é a do pedido');
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
  assert.match(docs, /Wifi a Bordo|nome da rede/i);
  for (const secret of ['MP_ACCESS_TOKEN', 'MP_WEBHOOK_SECRET', 'ROUTER_SHARED_KEY', 'SITE_ORIGIN']) {
    assert.match(docs, new RegExp(secret)); assert.match(read('.env.example'), new RegExp(`^${secret}=`, 'm'));
  }
  assert.match(read('.env.example'), /^MP_ACCESS_TOKEN=SEU_TOKEN/m);
  assert.match(read('.gitignore'), /^\.env$/m); assert.match(read('.gitignore'), /^node_modules\/$/m);
  assert.match(read('site/index.html'), /R\$ 25,00/); assert.match(read('site/index.html'), /toda a viagem/);
  assert.ok(existsSync(path.join(ROOT, 'scripts/prepare-site.mjs')));
});

test('Repositório público: sem termos locais, e-mails reais, caminhos pessoais ou arquivos de segredo', async () => {
  // Avalia exatamente o que o Git versionaria (rastreado + novo não ignorado). Arquivos locais
  // ignorados (backups, router-dist, capturas) ficam de fora; se não houver Git, varre tudo.
  const { spawnSync } = await import('node:child_process');
  const g = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' });
  let all = [];
  if (g.status === 0 && g.stdout.trim()) {
    all = g.stdout.split(/\r?\n/).filter(Boolean).map((f) => path.join(ROOT, f)).filter((f) => existsSync(f));
  } else {
    const skipDirs = new Set(['node_modules', '.git', 'dist-site']);
    (function scan(dir) {
      for (const name of readdirSync(dir)) {
        if (skipDirs.has(name)) continue;
        const full = path.join(dir, name);
        statSync(full).isDirectory() ? scan(full) : all.push(full);
      }
    })(ROOT);
  }
  const self = path.join(ROOT, 'tests', 'static.test.mjs');
  // "viagem" é o nome público do produto ("Internet para toda a viagem"); a sigla da instituição é montada em partes
  const banned = new RegExp(['escola', '\\baluno', '\\b' + ['IF', 'TO'].join('') + '\\b'].join('|'), 'i');
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

test('Netlify: netlify.toml correto, build por variável pública e nenhuma chave no que é publicado', async () => {
  const { spawnSync } = await import('node:child_process');
  const { rmSync } = await import('node:fs');
  const toml = read('netlify.toml');
  const live = toml.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  assert.match(live, /command = "node scripts\/prepare-site\.mjs"/);
  assert.match(live, /publish = "dist-site"/);
  assert.doesNotMatch(live, /MP_ACCESS_TOKEN|MP_WEBHOOK_SECRET|ROUTER_SHARED_KEY|SERVICE_ROLE|service_role|eyJ/, 'segredos fora do netlify.toml');
  assert.match(toml, /SUPABASE_PROJECT_REF/);
  const ci = read('.github/workflows/ci.yml');
  assert.match(ci, /npm test/); assert.doesNotMatch(ci, /secrets\./, 'o CI não usa segredos');

  const script = path.join(ROOT, 'scripts', 'prepare-site.mjs');
  const baseEnv = { ...process.env }; for (const k of ['SUPABASE_PROJECT_REF', 'SUPABASE_URL']) delete baseEnv[k];
  const run = (args, env) => spawnSync(process.execPath, [script, ...args], { cwd: ROOT, env: { ...baseEnv, ...env }, encoding: 'utf8' });
  const out = path.join(ROOT, 'dist-site-test');
  try {
    const noRef = run(['', 'dist-site-test'], {});
    assert.equal(noRef.status, 1); assert.match(noRef.stderr, /SUPABASE_PROJECT_REF/, 'o build falha com mensagem clara sem a variável');
    const bad = run([], { SUPABASE_PROJECT_REF: 'SEU-PROJETO' });
    assert.equal(bad.status, 1);
    const viaRef = run(['', 'dist-site-test'], { SUPABASE_PROJECT_REF: 'abcdefghijklmnopqrst' });
    assert.equal(viaRef.status, 0, viaRef.stderr);
    assert.match(readFileSync(path.join(out, 'config.js'), 'utf8'), /https:\/\/abcdefghijklmnopqrst\.supabase\.co\/functions\/v1/);
    assert.match(readFileSync(path.join(out, '_headers'), 'utf8'), /connect-src https:\/\/abcdefghijklmnopqrst\.supabase\.co/);
    assert.deepEqual(readdirSync(out).sort(), ['_headers', '_redirects', 'admin', 'app.js', 'art.svg', 'config.js', 'index.html', 'style.css']);
    assert.deepEqual(readdirSync(path.join(out, 'admin')).sort(), ['admin.css', 'admin.js', 'index.html', 'keys.js'], 'painel publicado só com arquivos estáticos esperados');
    const published = [...readdirSync(out).filter((f) => f !== 'admin'), ...readdirSync(path.join(out, 'admin')).map((f) => `admin/${f}`)];
    for (const f of published) {
      const body = readFileSync(path.join(out, f), 'utf8');
      // o painel envia o cabeçalho "apikey" (chave PUBLICÁVEL do Auth); nenhum outro termo sensível pode aparecer
      assert.doesNotMatch(body, /service_role|MP_ACCESS_TOKEN|MP_WEBHOOK_SECRET|ROUTER_SHARED_KEY|sb_secret_/i, `segredo/chave em ${f}`);
      if (!f.startsWith('admin/')) assert.doesNotMatch(body, /apikey/i, `apikey em ${f}`);
      assert.doesNotMatch(body, /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./, `JWT em ${f}`);
    }
    assert.match(readFileSync(path.join(out, 'admin', 'keys.js'), 'utf8'), /sb_publishable_[A-Za-z0-9_-]+/, 'só a chave publicável');
    const viaUrl = run(['', 'dist-site-test'], { SUPABASE_URL: 'https://zzzzzzzzzzzzzzzzzzzz.supabase.co' });
    assert.equal(viaUrl.status, 0, viaUrl.stderr);
    assert.match(readFileSync(path.join(out, 'config.js'), 'utf8'), /zzzzzzzzzzzzzzzzzzzz\.supabase\.co/);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test('Portal Wifi a Bordo: fluxo da viagem (cadastro -> Aguardando liberação + Pix R$ 25 -> liberado), sem horas e sem localStorage', () => {
  const html = read('site/index.html');
  for (const t of ['Wifi a Bordo', 'Internet no ônibus', 'Identifique-se para continuar', 'Nome completo', 'Seu e-mail', 'Digite seu e-mail',
    'Aguardando liberação...', 'Se você já pagou R$ 20 ao organizador, aguarde a liberação', 'Pagar R$ 25,00 com Pix', 'R$ 25,00',
    'Acesso liberado! Aproveite a viagem', 'Acesso ilimitado durante toda a viagem', 'Sem limite<br>de horas',
    'Endereço Wi-Fi Privado', 'Fixo', 'http://example.com']) assert.ok(html.includes(t), `texto ausente: ${t}`);
  assert.doesNotMatch(html, /5 horas|R\$ 5,00|Comprar mais|tempo de internet acabou/i, 'oferta antiga de horas não aparece');
  assert.doesNotMatch(html, /Wi-Fi a Bordo|WI-FI A BORDO/, 'nome antigo do produto visível');
  assert.doesNotMatch(html, /Suporte|WhatsApp|telefone|procure o respons/i, 'sem seção de suporte nem contatos pessoais');
  assert.match(html, /<label for="regemail"/); assert.match(html, /type="email"[^>]*required/); assert.match(html, /<label for="fullname"/);
  for (const id of ['loading', 'reg', 'wait', 'pix', 'paid', 'done', 'ended', 'invalid', 'feedback', 'pay', 'waitstate']) assert.match(html, new RegExp(`id="${id}"`));
  const svg = read('site/art.svg');
  assert.ok(svg.length < 6000, `ilustração com ${svg.length} bytes`);
  assert.doesNotMatch(svg, /<script|<foreignObject|href=|xlink|style=|on[a-z]+=/i, 'SVG sem scripts, links ou estilos inline');
  assert.match(read('site/style.css'), /url\(\/art\.svg\)/);
  assert.doesNotMatch(read('site/style.css'), /@import|url\(\s*['"]?https?:/);
  const js = read('site/app.js');
  assert.doesNotMatch(js, /localStorage|sessionStorage|document\.cookie/, 'o estado vem do servidor, nunca do navegador');
  assert.match(js, /api\('passenger\?mac=' \+ encodeURIComponent\(mac\)\)/, 'estado do aparelho consultado no servidor');
  assert.match(js, /post\('create-payment', testPlanId \? \{ mac, plan_id: testPlanId \} : \{ mac \}\)/,'o navegador envia só o aparelho; preço e produto são do servidor');
  assert.doesNotMatch(js, /price_cents:|grant_seconds:|amount:/, 'preço e duração nunca são enviados pelo navegador');
  assert.deepEqual((js.match(/plan_id:[^,}]*/g) || []).map((x) => x.trim()),['plan_id: testPlanId'], 'só o identificador do plano do link de teste');
  assert.match(js, /TEST_PLAN \? all\.find\(\(x\) => x\.id === TEST_PLAN\)/, 'plano de teste só aparece com o link');
  assert.doesNotMatch(js, /location\.(href|replace|assign)\s*=|window\.open/, 'o portal nunca redireciona (sem loop com o Hotspot)');
  assert.match(js, /s\.access === 'active' && s\.internet\) \{ enterDone\(\)/, '"liberado" só com a sessão autenticada confirmada pelo roteador');
});

test('prepare-router: gera os arquivos com os valores reais, recusa TLS inseguro e nunca grava a chave', async () => {
  const { spawnSync } = await import('node:child_process');
  const { rmSync } = await import('node:fs');
  const script = path.join(ROOT, 'scripts', 'prepare-router.mjs');
  const base = { ...process.env }; for (const k of ['PORTAL_URL', 'SUPABASE_PROJECT_REF', 'HOTSPOT_USER_PROFILE', 'HOTSPOT_SERVER_PROFILE', 'TLS_MODE', 'POLL_INTERVAL', 'ROUTER_OUT']) delete base[k];
  const run = (env) => spawnSync(process.execPath, [script], { cwd: ROOT, env: { ...base, ROUTER_OUT: 'router-dist-test', TEST_MAC: 'BA:28:2A:91:55:50', ...env }, encoding: 'utf8' });
  const ok = { PORTAL_URL: 'https://portal-exemplo.netlify.app', SUPABASE_PROJECT_REF: 'abcdefghijklmnopqrst', HOTSPOT_USER_PROFILE: 'plano-5h', HOTSPOT_SERVER_PROFILE: 'hsprof1' };
  const out = path.join(ROOT, 'router-dist-test');
  try {
    assert.equal(run({}).status, 1, 'sem variáveis obrigatórias');
    for (const bad of [{ TLS_MODE: 'no' }, { PORTAL_URL: 'http://inseguro.exemplo' }, { PORTAL_URL: 'https://x.exemplo/caminho' }, { SUPABASE_PROJECT_REF: 'SEU-PROJETO' },
      { HOTSPOT_USER_PROFILE: 'plano 5h; /system reset-configuration' }, { HOTSPOT_SERVER_PROFILE: '"' }, { POLL_INTERVAL: '20 segundos' }]) {
      assert.equal(run({ ...ok, ...bad }).status, 1, JSON.stringify(bad));
    }
    const r = run(ok); assert.equal(r.status, 0, r.stderr);
    const f = (n) => readFileSync(path.join(out, n), 'utf8');
    const poll = f('hotspot-poll.rsc');
    assert.match(poll, /:local profile "plano-5h"/); assert.doesNotMatch(poll, /wifi-5h/);
    assert.match(poll, /:local hprof "hsprof1"/, 'perfil do servidor Hotspot de onde se lê o html-directory');
    assert.doesNotMatch(poll, /:local hdir "[^"]/, 'pasta HTML não é fixa');
    assert.match(f('ROTEIRO-CURTO.txt'), /flash\/hotspot\/hsx-BA-28-2A-91-55-50\.txt|flash\/hotspot\/hsx-BC-37-D3-C4-12-2E\.txt/, 'caminho esperado do aviso');
    assert.match(poll, /https:\/\/abcdefghijklmnopqrst\.supabase\.co\/functions\/v1\/router-sync/);
    assert.match(poll, /:local tls "yes-without-crl"/); assert.doesNotMatch(poll, /check-certificate=no\b/);
    assert.match(poll, /:local secret "COLOQUE_A_MESMA_ROUTER_SHARED_KEY"/, 'chave só como placeholder');
    assert.equal((f('login.html').match(/https:\/\/portal-exemplo\.netlify\.app/g) || []).length, 3);
    assert.doesNotMatch(f('login.html') + poll + f('diagnostico.rsc'), /https:\/\/SEU-|SEU-PROJETO\.supabase|SEU-SITE\.netlify\.app\/\?/);
    const shortG = f('ROTEIRO-CURTO.txt');
    for (const t of ['plano-5h', 'hsprof1', 'login.html.original', 'ROLLBACK', 'o:', 'Seu tempo de internet acabou', 'NÃO repita']) assert.ok(shortG.includes(t), `roteiro curto sem "${t}"`);
    assert.doesNotMatch(shortG, /user profile add|\/certificate import|\/system reset|login-by=/i, 'roteiro curto não refaz o que já foi comprovado');
    for (const l of shortG.split(/\r?\n/).filter((x) => /walled-garden ip add/.test(x) && !/ROLLBACK/.test(x) && !/^\s*\/ip hotspot walled-garden ip add/.test(x))) {
      assert.match(l, /:if \(\[:len \[\/ip hotspot walled-garden ip find where dst-host=[^\]]+\]\] = 0\)/, 'regra nova só se ainda não existir (sem duplicar)');
    }
    assert.doesNotMatch(shortG, /walled-garden ip remove \[find comment=/, 'não remove por comentário (apagaria a regra do Supabase)');
    assert.match(f('CHECKLIST-MERCADO-PAGO.txt'), /NÃO ativa o webhook[\s\S]*Pagamentos \(payment\)/);
    const guide = f('INSTALACAO-WINBOX.txt');
    for (const t of ['plano-5h', 'hsprof1', 'login-by', 'ROLLBACK', 'VERIFICAÇÃO', 'TESTE-MANUAL-1', 'teste-mac', 'NÃO remova: o perfil plano-5h']) assert.ok(guide.includes(t), `roteiro sem "${t}"`);
    assert.doesNotMatch(guide, /user profile add|walled-garden ip add|\/certificate import|\/system reset/i, 'não recria perfil, Walled Garden nem certificado; sem reset');
    assert.match(f('CHECKLIST-MERCADO-PAGO.txt'), /MP_ACCESS_TOKEN[\s\S]*MP_WEBHOOK_SECRET[\s\S]*mp-webhook/);
    const keyLike = /(?=[A-Za-z0-9_-]*[A-Za-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{43}/; // 43 caracteres base64url com letra e dígito
    for (const n of readdirSync(out)) assert.doesNotMatch(f(n), keyLike, `possível chave em ${n}`);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test('Identidade Wifi a Bordo: sem nome antigo, sem neverssl, instruções novas e layout desktop', () => {
  const tracked = execSync('git ls-files --cached --others --exclude-standard', { cwd: ROOT, encoding: 'utf8' }).split(/\r?\n/).filter(Boolean)
    .filter((f) => !/^(node_modules|router-dist|capturas|dist-site|tests\/static\.test\.mjs)/.test(f) && !/\.(backup|png|jpg)$/.test(f) && f !== 'login.html' && f !== 'diagnostico.rsc');
  for (const f of tracked) {
    const txt = read(f);
    assert.doesNotMatch(txt, /neverssl/i, `${f}: neverssl não pode aparecer`);
    if (f !== 'scripts/prepare-router.mjs') assert.doesNotMatch(txt, /3\s?trc[ _-]?starlink/i, `${f}: nome antigo`);
  }
  // o único vestígio do host antigo é montado em partes, só para remover a regra antiga do Walled Garden
  assert.match(read('scripts/prepare-router.mjs'), /\['3trcstarlink', 'netlify', 'app'\]\.join/);
  const html = read('site/index.html');
  assert.match(html, /<title>Wifi a Bordo/); assert.match(html, /<h1 class="brand">Wifi a Bordo<\/h1>/);
  assert.ok(html.includes('Se a tela não abrir automaticamente, use a opção de login da rede exibida pelo seu dispositivo.'));
  assert.ok(html.includes('Quando o pagamento for aprovado, a internet será liberada automaticamente.'));
  assert.match(html, /<aside class="info">/);
  assert.doesNotMatch(html, /href="https?:/i, 'nenhum link externo no portal');
  const css = read('site/style.css');
  for (const w of ['960px', '1600px', '640px']) assert.ok(css.includes(`min-width:${w}`), `breakpoint ${w}`);
  assert.match(read('supabase/functions/_shared/common.ts'), /SERVICE_NAME = 'Wifi a Bordo'/);
});

test('RouterOS: aviso local de tempo esgotado só mexe em arquivos hsx-*.txt da pasta do Hotspot, sempre com tratamento de erro', () => {
  const rsc = read('router/hotspot-poll.rsc');
  const live = rsc.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n');
  const fileLines = live.split('\n').filter((l) => /\/file\b/.test(l));
  assert.ok(fileLines.length >= 4, 'cria, ajusta, remove ao creditar e remove ao voltar a ter crédito');
  for (const l of fileLines) assert.match(l, /hsx-|\$fp|\$fid|\$ofid/, `/file só com arquivos hsx-: ${l.trim()}`);
  assert.doesNotMatch(live, /\/file\s+(remove|set)\s+\[find\s*\]|\/file remove \*|\/file remove \[find where name~/i, 'nunca remove arquivos em massa');
  assert.match(live, /:local hprof "hsprof1"/); assert.doesNotMatch(live, /:local hdir "[^"]/, 'a pasta não é fixa: vem do perfil'); assert.match(live, /contents="EXP"/);
  assert.ok(live.includes('/ip hotspot profile get [find where name=$hprof] html-directory'), 'lê o html-directory do perfil Hotspot');
  assert.ok(live.includes('([:len $fid] = 0) && ([:len $hdir] > 0)'), 'nunca cria arquivo se a pasta for desconhecida (evita gravar na raiz)');
  assert.ok(live.includes('[:find $hdir ".."]'), 'rejeita ".." na pasta');
  assert.match(live, /aviso criado em outro local/, 'avisa se o arquivo cair fora da pasta esperada');
  assert.doesNotMatch(read('scripts/prepare-router.mjs'), /HOTSPOT_HTML_DIR/);
  assert.match(live, /:delay 2s/, 'espera a gravação do arquivo antes de ajustar o conteúdo');
  const login = read('router/login.html');
  assert.match(login, /XMLHttpRequest/); assert.match(login, /\/hsx-/); assert.match(login, /exp=1/);
  assert.equal((login.match(/https:\/\/SEU-SITE\.netlify\.app/g) || []).length, 3);
  assert.doesNotMatch(login, /fetch\(|sendBeacon|supabase/i, 'a página de login não fala com a internet');
});

test('Painel /admin: sem innerHTML/eval, sem estilos ou scripts inline, só chave publicável e API do servidor', () => {
  const js = read('site/admin/admin.js'); const html = read('site/admin/index.html');
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/, 'dados do banco nunca viram HTML');
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>|<style|\sstyle\s*=|\son[a-z]+\s*=/i, 'compatível com a CSP');
  assert.match(html, /name="robots" content="noindex,nofollow"/);
  assert.doesNotMatch(js, /setAttribute\('style'|\.style\.cssText/, 'sem estilo inline por atributo');
  new vm.Script(js, { filename: 'admin.js' });
  assert.match(read('site/admin/keys.js'), /^window\.ADMIN_PUBLISHABLE_KEY = 'sb_publishable_[A-Za-z0-9_-]+';$/m);
  assert.doesNotMatch(js, /\/rest\/v1\//, 'o painel nunca acessa tabelas direto: só admin-api e o login do Auth');
  assert.match(js, /\/admin-api/); assert.match(js, /\/auth\/v1\/token/);
  assert.match(read('site/_redirects'), /\/admin\/\*\s+\/admin\/index\.html\s+200/);
  assert.match(read('site/_headers'), /\/admin\/\*\n  X-Robots-Tag: noindex/);
  const cfg = read('supabase/config.toml');
  for (const fn of ['plans', 'admin-api']) assert.ok(cfg.includes(`[functions.${fn}]`), `${fn} no config.toml`);
});
