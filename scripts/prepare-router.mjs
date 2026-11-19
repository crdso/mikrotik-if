#!/usr/bin/env node
// Gera os arquivos do MikroTik JÁ COM os valores da SUA instalação, em router-dist/
// (pasta ignorada pelo Git). O repositório continua genérico; os valores reais ficam só aqui.
//
// Uso (PowerShell):
//   $env:PORTAL_URL="https://seu-portal.netlify.app"
//   $env:SUPABASE_PROJECT_REF="abcdefghijklmnopqrst"
//   $env:HOTSPOT_USER_PROFILE="plano-5h"      # perfil de USUÁRIO que já existe (padrão: wifi-5h)
//   $env:HOTSPOT_SERVER_PROFILE="hsprof1"     # perfil do SERVIDOR Hotspot que já existe
//   node scripts/prepare-router.mjs
//
// Opcionais: TLS_MODE (yes-without-crl | yes; nunca "no"), POLL_INTERVAL (ex.: 20s), ROUTER_OUT.
// A ROUTER_SHARED_KEY NUNCA entra em nenhum arquivo gerado: você a digita no WinBox.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;
const die = (msg) => { console.error(`Erro: ${msg}`); process.exit(1); };

const portal = String(env.PORTAL_URL || '').trim().replace(/\/+$/, '');
const ref = String(env.SUPABASE_PROJECT_REF || '').trim();
const userProfile = String(env.HOTSPOT_USER_PROFILE || 'wifi-5h').trim();
const serverProfile = String(env.HOTSPOT_SERVER_PROFILE || 'hsprof1').trim();
const tls = String(env.TLS_MODE || 'yes-without-crl').trim();
const interval = String(env.POLL_INTERVAL || '20s').trim();

if (!/^https:\/\/[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(portal)) die('PORTAL_URL deve ser https://dominio (sem caminho).');
if (!/^[a-z0-9]{10,30}$/.test(ref)) die('SUPABASE_PROJECT_REF inválido (só letras minúsculas e números).');
for (const [name, v] of [['HOTSPOT_USER_PROFILE', userProfile], ['HOTSPOT_SERVER_PROFILE', serverProfile]]) {
  if (!/^[A-Za-z0-9_.-]{1,40}$/.test(v)) die(`${name} inválido (letras, números, ".", "_" e "-").`);
}
if (!['yes-without-crl', 'yes'].includes(tls)) die('TLS_MODE deve ser "yes-without-crl" ou "yes". A validação do certificado nunca pode ser desligada.');
if (!/^\d{1,3}[smh]$/.test(interval)) die('POLL_INTERVAL inválido (ex.: 20s).');

const portalHost = new URL(portal).host;
const apiHost = `${ref}.supabase.co`;
const outDir = path.resolve(root, env.ROUTER_OUT || 'router-dist');
if (!outDir.startsWith(root + path.sep)) die('A pasta de saída deve ficar dentro do projeto.');
const read = (p) => readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');

function must(text, needle, file) { if (!text.includes(needle)) die(`modelo ${file} mudou: não achei "${needle}".`); }

// ---- arquivos do roteador ----------------------------------------------------
let login = read('router/login.html');
must(login, 'https://SEU-SITE.netlify.app', 'login.html');
login = login.replaceAll('https://SEU-SITE.netlify.app', portal);

let poll = read('router/hotspot-poll.rsc');
must(poll, 'SEU-PROJETO.supabase.co', 'hotspot-poll.rsc'); must(poll, ':local profile "wifi-5h"', 'hotspot-poll.rsc'); must(poll, ':local tls "yes-without-crl"', 'hotspot-poll.rsc');
poll = poll.replaceAll('SEU-PROJETO.supabase.co', apiHost).replace(':local profile "wifi-5h"', `:local profile "${userProfile}"`).replace(':local tls "yes-without-crl"', `:local tls "${tls}"`);

let diag = read('router/diagnostico.rsc');
must(diag, 'SEU-PROJETO.supabase.co', 'diagnostico.rsc');
diag = diag.replaceAll('SEU-PROJETO.supabase.co', apiHost);

// ---- roteiro de instalação ---------------------------------------------------
const MAC = 'AA:BB:CC:DD:EE:FF';
const install = `=====================================================================
 INSTALAÇÃO NO MIKROTIK — RouterOS 6.48.x  (gerado por scripts/prepare-router.mjs)
=====================================================================
Valores desta instalação
  Portal ........................ ${portal}
  Backend (Supabase) ............ https://${apiHost}
  Perfil de USUÁRIO existente ... ${userProfile}   (NÃO será criado nem apagado)
  Perfil do SERVIDOR Hotspot .... ${serverProfile}
  Validação TLS (fetch) ......... ${tls}
  Intervalo do wifi-poll ........ ${interval}

ESTE ARQUIVO NÃO PODE IR PARA O GITHUB. Nada aqui foi executado em equipamento:
execute UM passo por vez e confira a VERIFICAÇÃO. Se algo falhar, aplique o
ROLLBACK daquele passo e PARE (me mande o resultado, sem senhas).

REGRAS
  - Não atualize o RouterOS, não use reset, Netinstall nem restore.
  - Não recrie o Hotspot, o perfil "${userProfile}", os certificados nem o Walled Garden
    (as regras com comment=wifi-a-bordo já existem).
  - A ROUTER_SHARED_KEY é digitada SÓ dentro do WinBox (passo 5). Nunca em chat, arquivo ou Git.

---------------------------------------------------------------------
PASSO 0 — Conferir o estado atual (SOMENTE LEITURA)
---------------------------------------------------------------------
  /system resource print
  /ip hotspot print
  /ip hotspot profile print detail where name=${serverProfile}
  /ip hotspot user profile print detail where name=${userProfile}
  /ip hotspot walled-garden ip print where comment=wifi-a-bordo
  /file print where name~"backup"

  ANOTE:  login-by atual de ${serverProfile} = ____________________   (usado no rollback do passo 2)
          shared-users de ${userProfile}      = ____   (o ideal é 1: uma sessão por MAC)
  VERIFICAÇÃO: o backup existe em Files e uma cópia está no seu computador.
  (Opcional, se shared-users não for 1:  /ip hotspot user profile set [find name=${userProfile}] shared-users=1
   — reversível: volte ao valor anotado.)

---------------------------------------------------------------------
PASSO 1 — Diagnóstico (já feito; repita só se algo mudou)
---------------------------------------------------------------------
  Arquivo: diagnostico.rsc   ->   /import file-name=diagnostico.rsc
  Esperado (já obtido por você): check-certificate=${tls} -> OK, resposta: pong

---------------------------------------------------------------------
PASSO 2 — Acrescentar "mac" ao login-by do Hotspot  (ALTERA ${serverProfile}; reversível)
---------------------------------------------------------------------
  :local cur [/ip hotspot profile get [find name=${serverProfile}] login-by]
  :put ("login-by atual: " . $cur)
  :if ([:typeof [:find $cur "mac"]] = "nil") do={ /ip hotspot profile set [find name=${serverProfile}] login-by=("mac," . $cur) }
  :put ("login-by novo: " . [/ip hotspot profile get [find name=${serverProfile}] login-by])

  VERIFICAÇÃO: /ip hotspot profile print detail where name=${serverProfile}   (login-by começa com mac)
               Um celular SEM usuário continua vendo a tela de login (nada mudou para ele).
  ROLLBACK:    /ip hotspot profile set [find name=${serverProfile}] login-by=<valor anotado no passo 0>

---------------------------------------------------------------------
PASSO 3 — TESTE da autenticação por MAC, SEM script e SEM pagamento
---------------------------------------------------------------------
  Prova o formato de usuário/senha e o vínculo ao MAC (o que a pesquisa não confirmou).
  3.1  Conecte o celular ao Wi-Fi e NÃO faça login.
  3.2  /ip hotspot host print        -> anote o MAC do celular (ex.: ${MAC}).
  3.3  Crie o usuário de teste (troque o MAC; MAIÚSCULAS com dois-pontos):
       /ip hotspot user add name=${MAC} mac-address=${MAC} password="" profile=${userProfile} limit-uptime=3m comment=teste-mac
  3.4  No celular: desligue e ligue o Wi-Fi (ou abra um site http).
       ESPERADO: navega SEM tela de login.   /ip hotspot active print   mostra o usuário.
  3.5  Após ~3 min de uso: o acesso termina e a tela de login volta.
  SE aparecer a tela de login no 3.4:
       - compare o MAC do host (3.2) com o nome do usuário (/ip hotspot user print detail where comment=teste-mac);
       - tente o nome em minúsculas:  /ip hotspot user set [find comment=teste-mac] name=<mac em minúsculas>
       - se continuar, NÃO siga para o passo 4: me envie o resultado de /ip hotspot host print e /ip hotspot user print detail.
  ROLLBACK:    /ip hotspot user remove [find comment=teste-mac]

---------------------------------------------------------------------
PASSO 4 — Página de login que leva ao portal
---------------------------------------------------------------------
  4.1  Pasta do Hotspot: /ip hotspot profile print detail where name=${serverProfile}   (campo html-directory)
  4.2  WinBox > Files > <html-directory>/login.html: ARRASTE para o computador e guarde como login.html.original
  4.3  Arraste "login.html" (desta pasta) para Files, dentro de <html-directory>, substituindo o arquivo.
  VERIFICAÇÃO: celular sem usuário abre ${portal}/?mac=... (tela com preço e botão "Gerar Pix").
  ROLLBACK:    envie login.html.original de volta para <html-directory>/login.html

---------------------------------------------------------------------
PASSO 5 — Script wifi-poll (AINDA SEM AGENDAR)
---------------------------------------------------------------------
  5.1  WinBox > System > Scripts > Add:  Name = wifi-poll ; Policy = read, write, test (somente);
       Source = conteúdo de hotspot-poll.rsc (desta pasta).
  5.2  No Source, troque  COLOQUE_A_MESMA_ROUTER_SHARED_KEY  pela ROUTER_SHARED_KEY
       (a MESMA cadastrada no Supabase). Digite/cole só no WinBox.
       Para gerar uma chave nova (no seu computador):
         node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
  5.3  /system script run wifi-poll
       /log print where message~"wifi-poll"
       ESPERADO: sem mensagem de erro (sem pedidos pagos, nada é criado).
       "sem resposta do servidor" = chave diferente, relógio errado ou certificado/TLS (rode o diagnóstico).
  ROLLBACK:    /system script remove [find name=wifi-poll]

---------------------------------------------------------------------
PASSO 6 — Teste de crédito e de acúmulo, SEM Mercado Pago (ferramenta do operador)
---------------------------------------------------------------------
  No Supabase > SQL Editor (MAC do seu celular). Cria um crédito de TESTE de 3 minutos:
    insert into public.hotspot_orders (device_mac, amount_cents, grant_seconds, payment_status, payment_id, paid_at)
    values ('${MAC}', 500, 180, 'paid', 'TESTE-MANUAL-1', now());
  Depois:  /system script run wifi-poll
  ESPERADO:
    /ip hotspot user print detail where name=${MAC}      limit-uptime=3m  e comment com "o:" + 8 caracteres
    /log print where message~"wifi-poll"                  "credito novo"
    O celular entra sozinho; corte em ~3 min; a tela de login volta.
  6.2  ACÚMULO 3 + 3 min: antes do fim, insira o 2º crédito (payment_id 'TESTE-MANUAL-2', 180) e rode o script.
       limit-uptime deve ir para 6m.  ANOTE o que aconteceu com a sessão ATIVA (continuou ou caiu e voltou sozinha).
  6.3  IDEMPOTÊNCIA: rode o script de novo: nada deve mudar.
  LIMPEZA (obrigatória):
    delete from public.hotspot_orders where payment_id like 'TESTE-MANUAL-%';
    /ip hotspot user remove [find name=${MAC}]
  Isto é uma ferramenta de operador, não um endpoint. Nunca deixe créditos de teste.

---------------------------------------------------------------------
PASSO 7 — Agendar
---------------------------------------------------------------------
  /system scheduler add name=wifi-poll interval=${interval} on-event="/system script run wifi-poll" start-time=startup policy=read,write,test
  VERIFICAÇÃO: /system scheduler print ; após 1 min: /log print where message~"wifi-poll" (sem erros)
               /system resource print   -> cpu-load com os celulares conectados (hEX lite: observe; sem garantia de desempenho)
  ROLLBACK:    /system scheduler remove [find name=wifi-poll]

---------------------------------------------------------------------
PASSO 8 — Reinício (recomendado, só depois do 7)
---------------------------------------------------------------------
  Com um usuário de teste de 5 min com ~2 min já usados:  /system reboot
  VERIFICAR: o agendador voltou (/system scheduler print), o usuário existe e o TEMPO USADO foi preservado.
  Se o tempo usado voltar a zero, avise: queda de energia devolveria tempo aos passageiros.

---------------------------------------------------------------------
REVERSÃO TOTAL (ordem inversa)
---------------------------------------------------------------------
  /system scheduler remove [find name=wifi-poll]
  /system script remove [find name=wifi-poll]
  (restaurar login.html.original em <html-directory>)
  /ip hotspot profile set [find name=${serverProfile}] login-by=<valor anotado no passo 0>
  /ip hotspot user remove [find comment=teste-mac]
  NÃO remova: o perfil ${userProfile}, o Walled Garden (comment=wifi-a-bordo), o certificado importado.
`;

const mp = `=====================================================================
 CHECKLIST FINAL — MERCADO PAGO (faça por ÚLTIMO)  (gerado por scripts/prepare-router.mjs)
=====================================================================
Pré-requisito: passos 0 a 8 do INSTALACAO-WINBOX.txt concluídos e o teste de crédito (passo 6) aprovado.
Nenhum valor secreto deve ser colado em chats, arquivos ou no GitHub. Use somente os painéis abaixo.

1) SEGREDOS (Supabase > projeto ${ref} > Edge Functions > Secrets > Add new secret)
   - ROUTER_SHARED_KEY  : já cadastrada no começo (a mesma do roteador)
   - SITE_ORIGIN        : ${portal}   (já cadastrada)
   - MP_ACCESS_TOKEN    : Mercado Pago > Seu negócio/Developers > Suas integrações > sua aplicação >
                          Credenciais de PRODUÇÃO > Access Token
   - MP_WEBHOOK_SECRET  : criado no passo 2 abaixo (Mercado Pago > Webhooks > "Chave secreta")
2) WEBHOOK (Mercado Pago > Suas integrações > sua aplicação > Webhooks > Configurar notificações, MODO PRODUÇÃO)
   - URL do webhook : https://${apiHost}/functions/v1/mp-webhook
   - Evento         : Pagamentos (payment)
   - Salve e copie a Chave secreta -> cadastre como MP_WEBHOOK_SECRET (passo 1).
3) VERIFICAÇÃO SEM COBRAR
   - Mercado Pago > Webhooks > "Simular notificação": a resposta NÃO pode ser 401
     (esperado: ignorada com payment_not_found). 401 = chave secreta errada.
   - No seu computador (PowerShell):
       $env:SUPABASE_URL="https://${apiHost}"
       $env:SITE_ORIGIN="${portal}"
       node scripts/smoke.mjs
4) TESTE FINAL DE R$ 5 (você mesmo, com o seu dinheiro; estorno depois pelo painel do Mercado Pago, se quiser)
   a) Celular no Wi-Fi 3TRC_Starlink, sem login -> abre o portal -> e-mail -> "Gerar Pix".
   b) Pague com outro aparelho/dados móveis (Copia e Cola ou QR).
   c) Em até ~30-40 s: "Internet liberada" e o celular navega.
   d) Confira no SQL Editor: select id, payment_status, paid_at, provisioned_at from public.hotspot_orders order by created_at desc limit 3;
      (paid + provisioned_at preenchido) e no Mercado Pago o valor R$ 5,00.
   e) Compre de novo antes de acabar: /ip hotspot user print detail  -> limit-uptime somado.
5) Se falhar: INSTALACAO-WINBOX.txt (reversão) e os logs das funções no painel do Supabase.
`;

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
const files = { 'login.html': login, 'hotspot-poll.rsc': poll, 'diagnostico.rsc': diag, 'INSTALACAO-WINBOX.txt': install, 'CHECKLIST-MERCADO-PAGO.txt': mp };
for (const [name, content] of Object.entries(files)) writeFileSync(path.join(outDir, name), content);

console.log(`Pronto: ${path.relative(root, outDir)}/  (${Object.keys(files).join(', ')})`);
console.log(`Portal ${portalHost} | Supabase ${apiHost} | perfil "${userProfile}" | servidor "${serverProfile}" | TLS ${tls} | ${interval}`);
console.log('A ROUTER_SHARED_KEY NÃO foi gravada em nenhum arquivo: digite-a no WinBox (passo 5.2).');
