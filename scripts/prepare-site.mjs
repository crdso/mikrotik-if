#!/usr/bin/env node
// Gera a pasta publicável do portal (dist-site/) a partir de site/, trocando o
// código do projeto Supabase em config.js e na CSP de _headers.
//
// O código do projeto (Reference ID) vem, nesta ordem, de:
//   1. argumento:            node scripts/prepare-site.mjs <codigo> [pasta-de-saida]
//   2. variável de ambiente: SUPABASE_PROJECT_REF=<codigo>          (usada no build da Netlify)
//   3. variável de ambiente: SUPABASE_URL=https://<codigo>.supabase.co
//
// O Reference ID é um identificador PÚBLICO (aparece na URL do painel e nas chamadas do
// navegador). Nunca use aqui a chave anon, a service_role nem qualquer outro segredo:
// o portal não precisa de nenhuma chave.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [argRef, outArg] = process.argv.slice(2);
const urlRef = /^https:\/\/([a-z0-9]+)\.supabase\.co\/?$/.exec(process.env.SUPABASE_URL || '')?.[1];
const ref = (argRef || process.env.SUPABASE_PROJECT_REF || urlRef || '').trim();

if (!/^[a-z0-9]{10,30}$/.test(ref) || /seu-projeto/i.test(ref)) {
  console.error(
    'Falta o código (Reference ID) do projeto Supabase.\n' +
    '  - Na Netlify: Site configuration > Environment variables > SUPABASE_PROJECT_REF\n' +
    '  - Local:      node scripts/prepare-site.mjs <codigo>\n' +
    'O código tem só letras minúsculas e números e aparece na URL do painel do Supabase.');
  process.exit(1);
}
const out = path.resolve(root, outArg || 'dist-site');
if (!out.startsWith(root + path.sep)) { console.error('A pasta de saída deve ficar dentro do projeto.'); process.exit(1); }

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(path.join(root, 'site'), out, { recursive: true });

const host = `${ref}.supabase.co`;
const cfgPath = path.join(out, 'config.js');
const hdrPath = path.join(out, '_headers');
const cfg = readFileSync(cfgPath, 'utf8').replaceAll('SEU-PROJETO.supabase.co', host);
const hdr = readFileSync(hdrPath, 'utf8').replaceAll('SEU-PROJETO.supabase.co', host);
if (/SEU-PROJETO/.test(cfg + hdr)) { console.error('Ainda há SEU-PROJETO nos arquivos gerados.'); process.exit(1); }
writeFileSync(cfgPath, cfg);
writeFileSync(hdrPath, hdr);

console.log(`Pronto: ${path.relative(root, out)}/  (${readdirSync(out).join(', ')})`);
console.log(`Funções em: https://${host}/functions/v1`);
