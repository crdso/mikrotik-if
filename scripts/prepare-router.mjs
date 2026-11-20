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
// Opcionais: TLS_MODE (yes-without-crl | yes; nunca "no"), POLL_INTERVAL (ex.: 20s), ROUTER_OUT,
//            TEST_MAC (MAC do seu celular de teste, usado nos exemplos do roteiro).
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
// Host do portal anterior: usado SÓ para remover a regra antiga do Walled Garden (migração de URL).
const oldPortalHost = String(env.OLD_PORTAL_HOST || ['3trcstarlink', 'netlify', 'app'].join('.')).trim();
if (!/^[a-z0-9][a-z0-9.-]*.[a-z]{2,}$/i.test(oldPortalHost)) die('OLD_PORTAL_HOST inválido.');
const outDir = path.resolve(root, env.ROUTER_OUT || 'router-dist');
if (!outDir.startsWith(root + path.sep)) die('A pasta de saída deve ficar dentro do projeto.');
const read = (p) => readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');

function must(text, needle, file) { if (!text.includes(needle)) die(`modelo ${file} mudou: não achei "${needle}".`); }

// ---- arquivos do roteador ----------------------------------------------------
let login = read('router/login.html');
must(login, 'https://SEU-SITE.netlify.app', 'login.html');
login = login.replaceAll('https://SEU-SITE.netlify.app', portal);

let poll = read('router/hotspot-poll.rsc');
must(poll, 'SEU-PROJETO.supabase.co', 'hotspot-poll.rsc'); must(poll, ':local profile "wifi-5h"', 'hotspot-poll.rsc'); must(poll, ':local tls "yes-without-crl"', 'hotspot-poll.rsc'); must(poll, ':local hprof "hsprof1"', 'hotspot-poll.rsc');
poll = poll.replaceAll('SEU-PROJETO.supabase.co', apiHost).replace(':local profile "wifi-5h"', `:local profile "${userProfile}"`).replace(':local tls "yes-without-crl"', `:local tls "${tls}"`).replace(':local hprof "hsprof1"', `:local hprof "${serverProfile}"`);

let diag = read('router/diagnostico.rsc');
must(diag, 'SEU-PROJETO.supabase.co', 'diagnostico.rsc');
diag = diag.replaceAll('SEU-PROJETO.supabase.co', apiHost);

// ---- roteiro de instalação ---------------------------------------------------
const MAC = String(env.TEST_MAC || 'AA:BB:CC:DD:EE:FF').trim().toUpperCase();
if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(MAC)) die('TEST_MAC inválido (use AA:BB:CC:DD:EE:FF, maiúsculas com dois-pontos).');
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


const shortGuide = `=====================================================================
 ROTEIRO CURTO — o que FALTA no MikroTik  (gerado por scripts/prepare-router.mjs)
=====================================================================
Comprovados no equipamento: diagnóstico, CA, "mac" no login-by de
${serverProfile}, mac-auth-password vazio e o teste de login por MAC com corte por tempo.
NÃO repita esses passos. Perfil de usuário reaproveitado: ${userProfile}. Walled Garden e certificado: já existem.
Cada etapa abaixo tem verificação e rollback. A chave só no WinBox.

A0) WALLED GARDEN: trocar SOMENTE a regra do portal antigo pela do portal novo (não toca no Supabase)
   1. Veja antes:   /ip hotspot walled-garden ip print detail where dst-host~"netlify.app" or dst-host~"supabase.co"
   2. Remova a regra do portal ANTIGO (só ela):
      /ip hotspot walled-garden ip remove [find where dst-host=${oldPortalHost}]
   3. Crie a do portal novo SOMENTE se ainda não existir (não duplica):
      :if ([:len [/ip hotspot walled-garden ip find where dst-host=${portalHost}]] = 0) do={ /ip hotspot walled-garden ip add action=accept dst-host=${portalHost} protocol=tcp dst-port=443 comment=wifi-a-bordo }
   4. Confira:      /ip hotspot walled-garden ip print where comment=wifi-a-bordo
      ESPERADO: uma regra para ${portalHost} e a do ${apiHost} (inalterada), ambas tcp/443.
   ROLLBACK: /ip hotspot walled-garden ip remove [find where dst-host=${portalHost}]
             /ip hotspot walled-garden ip add action=accept dst-host=${oldPortalHost} protocol=tcp dst-port=443 comment=wifi-a-bordo
   (Se existir regra http/80 do portal antigo, apenas liste e me mostre; não apague às cegas.)

A) LIMPAR O TESTE ANTERIOR — JÁ FEITO por você (remoção do usuário de teste); pule se já removeu
   /ip hotspot user print detail where name=${MAC} or comment~"teste"
   Confira que listou SÓ o usuário de teste do seu celular. Então:
   /ip hotspot active remove [find user=${MAC}]
   /ip hotspot user remove [find name=${MAC}]
   (Se aparecer outro usuário legítimo na lista, NÃO o remova.)

B) PÁGINA DE LOGIN  (leva o aparelho ao portal; consulta o aviso local "hsx-<MAC>.txt" de tempo esgotado)
   (SUBSTITUI o login.html que você já instalou: o novo pergunta ao próprio roteador se o tempo daquele MAC acabou)
   1. /ip hotspot profile print detail where name=${serverProfile}     -> anote html-directory
   2. WinBox > Files > <html-directory>/login.html : arraste para o PC (login.html.original)
   3. Arraste "login.html" desta pasta para <html-directory>/ (substituir)
   VERIFICAÇÃO: celular sem crédito abre ${portal}/?mac=...  (tela de compra)
   ROLLBACK: devolva login.html.original para <html-directory>/login.html

C0) BACKUP DO SCRIPT QUE JÁ FUNCIONA (antes de trocar; permite voltar na hora)
   /system script add name=wifi-poll-anterior policy=read,write,test source=[/system script get wifi-poll source]
   (a cópia contém a mesma chave do roteador: ela fica só no roteador e deve ser apagada depois que tudo estiver aprovado)
   ROLLBACK COMPLETO (volta ao script de antes):
   /system script set wifi-poll source=[/system script get wifi-poll-anterior source]

C) SCRIPT wifi-poll CONSOLIDADO (crédito + aviso de tempo esgotado + telemetria para o painel; ainda sem agendar)
   (Já existe o script wifi-poll: ABRA-O, apague todo o Source e cole o novo hotspot-poll.rsc; a ROUTER_SHARED_KEY é digitada de novo.)
   Policy do script: read,write,test  (a gravação do aviso usa /file, que exige "write")
   Pasta do Hotspot: o script LÊ o html-directory do perfil ${serverProfile} a cada execução (no seu equipamento: flash/hotspot).
   Confira:  /ip hotspot profile print detail where name=${serverProfile}   -> html-directory=flash/hotspot
   Troque COLOQUE_A_MESMA_ROUTER_SHARED_KEY pela ROUTER_SHARED_KEY (a que já está no Supabase).
   /system script run wifi-poll
   /log print where message~"wifi-poll"
   ESPERADO: nenhum erro. Me avise "script instalado": eu confiro no Supabase que o roteador consultou.
   ROLLBACK: /system script remove [find name=wifi-poll]

D) TESTE DE CRÉDITO SEM MERCADO PAGO (eu crio o crédito de teste de 3 min e limpo depois)
   1. Me avise; eu insiro o crédito para ${MAC}.
   2. /system script run wifi-poll
   3. /ip hotspot user print detail where name=${MAC}
      ESPERADO: limit-uptime=3m ; comment com "o:" + 8 caracteres ; o celular navega sem login.
   4. Rode o script de novo (2): NADA deve mudar (sem horas duplicadas).
   5. Aguarde cair (~3 min) e rode:  /system script run wifi-poll
      Abra o portal no celular: deve mostrar "Seu tempo de internet acabou".
      ANOTE a URL que o Hotspot abriu: se tiver "&err=..." me diga o texto.
   6. Toque em "Comprar mais 5 horas" só para ver o Pix (NÃO pague). Eu limpo os dados de teste.
   7. ACÚMULO: se quiser provar 3+3 min, me avise ANTES de o primeiro crédito acabar.

D2) TESTE DO AVISO "Seu tempo de internet acabou" (depois do corte por tempo do passo D)
   1. Com o celular já cortado:  /system script run wifi-poll
   2. /file print where name~"hsx-"
      ESPERADO: o arquivo flash/hotspot/hsx-${MAC.replaceAll(":", "-")}.txt (mesma pasta do login.html) com contents=EXP.
      Se ele aparecer em OUTRA pasta, o log dirá "aviso criado em outro local: ..." — não siga; me envie esse texto.
      (Se não aparecer: me envie /log print where message~"wifi-poll" e a saída de /ip hotspot profile print detail where name=${serverProfile}.)
   3. No celular: desligue e ligue o Wi-Fi da rede (ou abra http://example.com). A janela de login deve abrir o portal em
      ${portal}/?mac=...&exp=1  mostrando "Seu tempo de internet acabou".
   4. Teste de neutralidade: com OUTRO aparelho/MAC (sem aviso), o portal deve mostrar a compra normal (sem "&exp=1").
   5. Quando houver novo crédito para o MAC, o aviso some sozinho no próximo wifi-poll (/file print where name~"hsx-").
   ROLLBACK (só dos avisos): /file remove [find where name~"hsx-"]
   Limpeza do teste: o aviso deste MAC de teste pode ser removido com o comando acima.

D3) TELEMETRIA PARA O PAINEL (envio de sessões e uso a cada 60 s)
   1. /system script run wifi-poll   (e de novo depois de ~1 minuto: a telemetria só é enviada a cada 60 s)
   2. /log print where message~"wifi-poll"   -> ESPERADO: nenhum "falha ao enviar telemetria".
   3. Painel https://wifiabordo.netlify.app/admin > Dashboard: "Dispositivos online" deve mostrar o nº de /ip hotspot active print count-only
      e, em Dispositivos, o MAC de teste com tempo usado/limite iguais a /ip hotspot user print detail where name=${MAC}.
   4. Se "falha ao enviar telemetria" aparecer: pare, me envie o log (sem chaves). O restante do script (créditos) não depende disso.
   ROLLBACK: o passo C0 acima.

E) AGENDAR  (só depois do D, D2 e D3 aprovados)
   /system scheduler add name=wifi-poll interval=${interval} on-event="/system script run wifi-poll" start-time=startup policy=read,write,test
   /system scheduler print
   /log print where message~"wifi-poll"
   ROLLBACK: /system scheduler remove [find name=wifi-poll]

F) REINÍCIO (recomendado)
   Com um usuário de teste que já usou ~2 min:  /system reboot
   Verifique: scheduler voltou, usuário existe, TEMPO USADO preservado (/ip hotspot user print detail).
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
2) WEBHOOK — AÇÃO SEPARADA NO PAINEL DO MERCADO PAGO (cadastrar as 2 secrets no Supabase NÃO ativa o webhook)
   Mercado Pago Developers > Suas integrações > sua aplicação > Webhooks > Configurar notificações:
   - Aba/modo         : PRODUÇÃO (não "Teste")
   - URL de produção  : https://${apiHost}/functions/v1/mp-webhook
   - Evento           : Pagamentos (payment)   <- é o único evento necessário
   - Salvar. O painel mostra a "Chave secreta" (assinatura): copie e cadastre como MP_WEBHOOK_SECRET (passo 1).
   - Sem esse cadastro o Mercado Pago não avisa o pagamento; o portal ainda reconcilia por conta própria
     em ~10 s, mas o webhook é o caminho principal e deve ficar ativo.
3) VERIFICAÇÃO SEM COBRAR
   - Mercado Pago > Webhooks > "Simular notificação": a resposta NÃO pode ser 401
     (esperado: ignorada com payment_not_found). 401 = chave secreta errada.
   - No seu computador (PowerShell):
       $env:SUPABASE_URL="https://${apiHost}"
       $env:SITE_ORIGIN="${portal}"
       node scripts/smoke.mjs
4) TESTE FINAL DE R$ 5 (você mesmo, com o seu dinheiro; estorno depois pelo painel do Mercado Pago, se quiser)
   a) Celular na rede Wifi a Bordo, sem login -> abre o portal -> e-mail -> "Gerar Pix".
   b) Pague com outro aparelho/dados móveis (Copia e Cola ou QR).
   c) Em até ~30-40 s: "Internet liberada" e o celular navega.
   d) Confira no SQL Editor: select id, payment_status, paid_at, provisioned_at from public.hotspot_orders order by created_at desc limit 3;
      (paid + provisioned_at preenchido) e no Mercado Pago o valor R$ 5,00.
   e) Compre de novo antes de acabar: /ip hotspot user print detail  -> limit-uptime somado.
5) Se falhar: INSTALACAO-WINBOX.txt (reversão) e os logs das funções no painel do Supabase.
`;

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
const files = { 'login.html': login, 'hotspot-poll.rsc': poll, 'diagnostico.rsc': diag, 'ROTEIRO-CURTO.txt': shortGuide, 'INSTALACAO-WINBOX.txt': install, 'CHECKLIST-MERCADO-PAGO.txt': mp };
for (const [name, content] of Object.entries(files)) writeFileSync(path.join(outDir, name), content);

console.log(`Pronto: ${path.relative(root, outDir)}/  (${Object.keys(files).join(', ')})`);
console.log(`Portal ${portalHost} | Supabase ${apiHost} | perfil "${userProfile}" | servidor "${serverProfile}" | TLS ${tls} | ${interval}`);
console.log('A ROUTER_SHARED_KEY NÃO foi gravada em nenhum arquivo: digite-a no WinBox (passo 5.2).');
