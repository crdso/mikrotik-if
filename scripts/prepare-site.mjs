#!/usr/bin/env node
// Gera a pasta pronta para a Netlify (dist-site/) a partir de site/, trocando o
// código do projeto Supabase em config.js e na CSP de _headers.
//
// Uso:  node scripts/prepare-site.mjs <codigo-do-projeto-supabase> [pasta-de-saida]
// Ex.:  node scripts/prepare-site.mjs abcdefghijklmnopqrst
//
// O código do projeto aparece na URL do painel (…/project/<codigo>) e em
// Settings > General > Reference ID. Não é um segredo, mas também não use a
// chave anon/service_role aqui: este portal não precisa de nenhuma delas.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [ref, outArg] = process.argv.slice(2);
if (!ref || !/^[a-z0-9]{10,30}$/.test(ref) || /seu-projeto/i.test(ref)) {
  console.error('Uso: node scripts/prepare-site.mjs <codigo-do-projeto-supabase> [pasta-de-saida]\n' +
    'O código tem só letras minúsculas e números (ex.: abcdefghijklmnopqrst).');
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
console.log('Próximo passo: arraste a pasta inteira para a Netlify (Deploy manual).');
