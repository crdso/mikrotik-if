# MikroTik (RouterOS 6.48 e 7) — configuração do Hotspot pago

Este guia assume um roteador **que já tem o Hotspot funcionando** (cliente conecta, vê a tela de login, autentica, navega, e o tempo limitado de um usuário de teste é respeitado). **Nada aqui recria ou reconfigura a rede**: tudo é acréscimo reversível, e cada passo tem o comando para desfazer.

> **Estado:** os comandos e o script abaixo **não foram executados em equipamento real**. Foram escritos para RouterOS 6.43+ e conferidos só de forma estática e por um modelo em JavaScript. A documentação oficial do RouterOS 6 não pôde ser lida durante o desenvolvimento (o wiki antigo foi redirecionado); por isso o `router/diagnostico.rsc` existe: ele **prova no seu roteador** cada recurso do qual o script depende, sem alterar nada.

Equipamento de referência: hEX lite (RB750r2), RouterOS 6.48.6 (mipsbe, 64 MB de RAM, 16 MB de flash, 1 núcleo de 850 MHz). Não atualize o RouterOS, não use Netinstall nem reset para seguir este guia.

## 1. Por que o script foi reescrito para o RouterOS 6

O script original usava recursos que só existem a partir do **RouterOS 7.13**: `:serialize`, `:deserialize` (JSON) e `:onerror`. No RouterOS 6 eles **não existem** ([fórum da MikroTik](https://forum.mikrotik.com/t/feature-request-native-json-parsing-function/177303) e notas de versão 7.13). Solução adotada:

| Item | RouterOS 7 (antes) | RouterOS 6 (agora) |
|---|---|---|
| Formato da resposta | JSON | **Texto de largura fixa** (`G <MAC> <id> <tempo>`), até 10 linhas, < 1 KB |
| Leitura | `:deserialize` | `:find` / `:pick` por posição, com validação de cada campo |
| Erros | `:onerror ... do=` | `:do { } on-error={ }` |
| Anti-execução dupla | `/system script job` | Variável global com carimbo de tempo (trava velha de 3 min é ignorada) |
| ACK | POST com JSON | POST `order=<uuid>&mac=<MAC>` (formulário) |
| Tempo a creditar | constante no script | Enviado pelo servidor (`5h0m0s`), com teto de segurança de 2 dias no script |

O mesmo script roda no RouterOS 7. O backend ainda aceita `?fmt=json` e ACK em JSON.

**Recursos confirmados** (busca na documentação): `/tool fetch` com `http-method`, `http-data`, `http-header-field` e `as-value` existe desde o RouterOS 6.43; `check-certificate` existe no v6 (valores `no`/`yes`). **A confirmar no seu roteador** (o diagnóstico testa): se `yes-without-crl` é aceito no 6.48.6, a soma de valores de tempo e `:totime` com texto `5h0m0s`.

## 2. Antes de começar: backup

```routeros
/system backup save name=pre-wifi-a-bordo
/export file=pre-wifi-a-bordo
```

Baixe os dois arquivos (WinBox → Files) para o seu computador, **fora do repositório**. O `.backup` e o `.rsc` podem conter senhas de usuários, chaves Wi-Fi e do Hotspot: são segredos. O `.gitignore` já bloqueia `*.backup` e `*.export`; nomeie os exports de backup com a extensão `.export` ou guarde-os fora da pasta do projeto. Nunca os envie ao GitHub.

## 3. Diagnóstico (somente leitura)

1. Edite `router/diagnostico.rsc` trocando `SEU-PROJETO` pelo Reference ID do seu projeto Supabase (a função `router-sync` precisa estar publicada: o endereço `?ping=1` é público e responde `pong`).
2. Arraste o arquivo para *Files* no WinBox e rode no terminal: `/import file-name=diagnostico.rsc`.
3. Leia o resultado:
   - **Equipamento:** versão, RAM livre, disco, CPU, **relógio** (precisa estar correto, senão o HTTPS não valida).
   - **Recursos da linguagem:** cada linha mostra o valor esperado entre parênteses. Qualquer `FALHOU` precisa de ajuste antes de seguir.
   - **Hotspot existente:** lista os *server profiles* (com `login-by` atual — **anote**) e os *user profiles*.
   - **HTTPS:** primeiro sem validar certificado (só aperto de mão TLS; sem segredos), depois validando com `yes-without-crl` e `yes`.

Interpretação do bloco HTTPS:

| Resultado | Significa | O que fazer |
|---|---|---|
| "sem validar" FALHOU | O roteador não negocia TLS com o Supabase | Veja a seção 9 (alternativas) |
| "sem validar" OK, validando FALHOU | CA não importada, relógio errado ou valor não suportado | Seção 4; ajuste `:local tls` no script (`yes` ou `yes-without-crl`) |
| Algum modo validando OK | Pronto | Use esse valor em `:local tls` |

Observação sobre o TLS. Medido de fora, no domínio `supabase.co`: exige **TLS 1.2 ou superior** e, no TLS 1.2, aceitou apenas `ECDHE-RSA-AES128-GCM-SHA256` entre as cifras testadas. **Resultado real num hEX lite com RouterOS 6.48.6** (diagnóstico executado pelo proprietário do equipamento): o `fetch` negociou TLS com o domínio de um projeto Supabase e **`check-certificate=yes-without-crl` e `check-certificate=yes` funcionaram** com a CA correta importada; a cadeia daquele projeto terminava em **GTS Root R4 (Google Trust Services)**. A CA exigida depende do domínio/projeto e pode mudar: use a que o diagnóstico indicar.

## 4. Certificado da CA (o RouterOS 6 não traz nenhuma)

O roteador valida o servidor contra a CA **que você importar**. Importe **somente** a raiz necessária (economiza RAM e flash; evite importar pacotes inteiros de CAs).

1. Descubra qual raiz o seu projeto usa: rode o diagnóstico (seção 3). Se a validação falhar por falta de CA, o servidor apresenta uma cadeia que termina numa raiz pública conhecida (por exemplo **GTS Root R4**, do Google Trust Services, ou **ISRG Root X1**, da Let's Encrypt).
2. Baixe a raiz **somente do site oficial da autoridade** (Google Trust Services: https://pki.goog/ ; Let's Encrypt: https://letsencrypt.org/certificates/) e **confira a impressão digital** publicada por ela antes de enviar ao roteador:

```sh
openssl x509 -in raiz.pem -noout -fingerprint -sha256
```

   Se a impressão digital não bater com a publicada pela autoridade, **não importe**. (Medido durante o desenvolvimento: a raiz ISRG Root X1 tem SHA-256 `96:BC:EC:06:26:49:76:F3:74:60:77:9A:CF:28:C5:A7:CF:E8:A3:C0:AA:E1:1A:8F:FC:EE:05:C0:BD:DF:08:C6`.)
3. Envie o arquivo (Files) e importe (**não importe duas vezes**: confira antes com `/certificate print`):

```routeros
/certificate import file-name=raiz.pem passphrase=""
/certificate print
```

   Confirme que o certificado aparece com a marca de confiável (`T`). Se não, `/certificate set <numero> trusted=yes`. Depois apague o `.pem` de *Files*.
4. Rode o diagnóstico de novo. Se a validação ainda falhar, o servidor pode estar apresentando outra cadeia: o diagnóstico mostra o erro; importe a raiz indicada pela cadeia (mesmo procedimento de conferir a impressão digital).

Reversão: `/certificate remove <numero>`.

## 5. Hotspot: duas adições (reversíveis)

**5.1 Perfil de usuário do plano** — **use o que já existe**. Se o seu roteador já tem um perfil com o limite desejado (por exemplo `plano-5h` com `rate-limit=1M/4M`), **não crie outro**: informe o nome dele ao gerar os arquivos (`HOTSPOT_USER_PROFILE`, veja a seção 11). Só se não existir nenhum perfil adequado:

```routeros
/ip hotspot user profile add name=wifi-5h shared-users=1 rate-limit=1M/4M
```

`rate-limit=1M/4M` é **upload/download** do passageiro (rx/tx do ponto de vista do roteador). Confira `shared-users=1` no perfil (`/ip hotspot user profile print detail where name=<perfil>`): garante **uma sessão por MAC**. Reversão: remova **apenas** um perfil que você mesmo criou neste passo.

**5.2 Login automático por MAC** (altera o *server profile* em uso — **anote o `login-by` atual antes**; o diagnóstico o mostra):

```routeros
/ip hotspot profile print
# Exemplo: se hoje for login-by=cookie,http-chap e o perfil se chamar hsprof1, ACRESCENTE mac:
/ip hotspot profile set [find name=hsprof1] login-by=mac,cookie,http-chap
```

Isso é **aditivo**: quem não tem usuário por MAC continua vendo a tela de login. Faça em horário sem uso e deixe o comando de volta pronto: `/ip hotspot profile set [find name=hsprof1] login-by=<valor anotado>`. Quando tudo estiver validado, para produção prefira apenas `login-by=mac` (menos superfície de tentativa de senha). O usuário criado pelo script tem `mac-address=<MAC>`: outro aparelho não o utiliza.

## 5.3 Autenticação por MAC no RouterOS 6: o que **não** está confirmado e como testar

A documentação consultada confirma o princípio (com `login-by` contendo `mac`, o Hotspot autentica sozinho o aparelho cujo MAC existe como usuário), mas **não confirmou**: (a) o formato exato do nome do usuário (o projeto usa **MAIÚSCULAS com dois-pontos**, como o Hotspot informa em `$(mac)`), (b) o uso de senha vazia, (c) se alterar `limit-uptime` vale para uma **sessão já ativa**. Há relatos de que o modo `mac-as-username-and-password` (propriedade `mac-auth-mode` do perfil do servidor, quando existir) pode falhar; o usado aqui é o padrão (`mac` como nome, senha vazia). O vínculo ao aparelho vem de `mac-address=<MAC>` no usuário e `shared-users=1` no perfil.

Teste **no seu roteador**, nesta ordem (os comandos exatos estão no roteiro gerado, passos 3 e 6):

1. **Teste A (sem script, sem pagamento):** crie à mão um usuário com o MAC do seu celular e `limit-uptime=3m`; o celular deve entrar **sem tela de login** e ser **cortado em ~3 min**, voltando à tela de login.
2. **Teste B (crédito vindo do backend):** crie um crédito de teste de 3 min (SQL de operador, no roteiro) e rode o `wifi-poll`; o usuário deve ser criado com `limit-uptime=3m` e o celular entrar sozinho.
3. **Teste C (acúmulo 3 + 3 min):** com a sessão ativa, adicione um segundo crédito e rode o script; `limit-uptime` deve virar `6m`. **Anote** se a sessão ativa foi estendida ou se caiu no limite antigo e voltou sozinha (login por MAC): o projeto **não força** a queda da sessão ativa para não interromper o passageiro.

Se o Teste A falhar, **pare**: o restante depende dele.

## 6. Walled Garden (o que o passageiro vê **antes** de pagar)

Libere **somente** o portal e o projeto Supabase:

```routeros
/ip hotspot walled-garden ip add action=accept dst-host=SEU-SITE.netlify.app protocol=tcp dst-port=443 comment=wifi-a-bordo
/ip hotspot walled-garden ip add action=accept dst-host=SEU-PROJETO.supabase.co protocol=tcp dst-port=443 comment=wifi-a-bordo
```

- **Não** use `*.netlify.app` nem `*.supabase.co`: isso liberaria sites alheios de graça.
- **Não** libere domínios de teste de conectividade do Android/iPhone (`connectivitycheck.gstatic.com`, `captive.apple.com`, etc.): se liberados, o celular acha que há internet e não abre o portal.
- Regras `dst-host` dependem do DNS do roteador; se o provedor trocar de IP, a regra acompanha, mas **teste com um celular não autenticado**.
- O app do banco **não** funciona por dentro do Wi-Fi bloqueado: o passageiro copia o código Pix e paga com dados móveis ou outro aparelho (o portal explica isso).

Reversão: `/ip hotspot walled-garden ip remove [find comment=wifi-a-bordo]`.

## 7. Página de login

1. Faça **cópia do original**: no WinBox, *Files → hotspot → login.html* → copiar para `login.html.orig`.
2. Edite `router/login.html` trocando `SEU-SITE.netlify.app` nos **3** lugares e substitua `hotspot/login.html`. Se o `html-directory` do Hotspot não for `hotspot`, use o real (`/ip hotspot profile print`).

Reversão: copie `login.html.orig` de volta.

## 8. Script e agendamento

1. WinBox → *System → Scripts → Add*: nome `wifi-poll`, política `read, write, test`, cole o conteúdo de `router/hotspot-poll.rsc` já com a URL do Supabase e a `ROUTER_SHARED_KEY`. (Colar scripts longos no terminal pode truncar; prefira o WinBox.)
2. Rode **à mão**: `/system script run wifi-poll` e leia: `/log print where message~"wifi-poll"` e `/ip hotspot user print`.
3. Só depois agende (comece com 20 s; o hardware é fraco):

```routeros
/system scheduler add name=wifi-poll interval=20s on-event="/system script run wifi-poll" start-time=startup policy=read,write,test
```

4. Meça com a rede em uso: `/system resource print` (CPU, memória) e `/tool profile`. Se o HTTPS pesar, aumente o intervalo. **Nenhum desempenho é garantido sem teste real com ~40 aparelhos.**

Reversão: `/system scheduler remove [find name=wifi-poll]` e `/system script remove [find name=wifi-poll]`.

## 9. Se o TLS não funcionar no RouterOS 6.48.6

O sistema precisa de uma consulta HTTPS saindo do roteador (funciona atrás de CGNAT; **não** abre porta alguma). Se o diagnóstico mostrar que o `fetch` não negocia TLS com o Supabase, as alternativas, **em ordem de preferência**:

1. **Ajustes simples:** conferir o relógio (NTP), importar a CA correta, testar `check-certificate=yes` em vez de `yes-without-crl`.
2. **Atualizar o RouterOS dentro da linha 6.x** (decisão sua, **nunca automática**): versões mais novas podem ter correções de TLS. Faça backup antes e leia as notas da versão.
3. **Relé local** (compatível, sem tocar no roteador): um pequeno dispositivo sempre ligado na rede de administração (por exemplo, um mini-computador Linux) faz o HTTPS com o Supabase e oferece ao MikroTik o mesmo protocolo de texto **em HTTP, só na LAN de administração**, com a mesma chave. Reduz a proteção do trecho local (a LAN de administração não pode ser alcançada pelos passageiros) e **não está implementado** neste repositório.
4. Hardware com RouterOS 7 — o mesmo script roda.

**Não use `check-certificate=no`** no `wifi-poll`: o servidor deixaria de ser autenticado e a chave do roteador poderia ser capturada por um intermediário.

## 10. Reversão total

```routeros
/system scheduler remove [find name=wifi-poll]
/system script remove [find name=wifi-poll]
/ip hotspot walled-garden ip remove [find comment=wifi-a-bordo]
/ip hotspot profile set [find name=hsprof1] login-by=<valor anotado>
/ip hotspot user remove [find where name~":"]
```

e restaure `login.html.orig`. **Não** remova o perfil de usuário se ele já existia antes (por exemplo `plano-5h`), nem as regras do Walled Garden criadas antes. O ajuste de `login-by` e os usuários por MAC são os únicos itens que mudam o comportamento já validado; o resto é acréscimo isolado.

Veja também [operacao-e-seguranca.md](operacao-e-seguranca.md) (proteção do painel, isolamento, emergência, reinicialização).

## 11. Gerar os arquivos com os valores da sua instalação

O repositório é genérico (`SEU-SITE`, `SEU-PROJETO`, perfil `wifi-5h`). Para obter os arquivos prontos para o **seu** roteador, sem editar nada à mão e sem versionar valores reais:

```powershell
$env:PORTAL_URL="https://seu-portal.netlify.app"
$env:SUPABASE_PROJECT_REF="abcdefghijklmnopqrst"
$env:HOTSPOT_USER_PROFILE="plano-5h"        # perfil de usuário que já existe
$env:HOTSPOT_SERVER_PROFILE="hsprof1"       # perfil do servidor Hotspot que já existe
npm run prepare-router
```

Saída em `router-dist/` (ignorada pelo Git): `login.html`, `hotspot-poll.rsc`, `diagnostico.rsc`, `INSTALACAO-WINBOX.txt` (passo a passo com verificação e reversão) e `CHECKLIST-MERCADO-PAGO.txt`. O gerador **recusa** `TLS_MODE=no`, valida os nomes e **nunca grava a `ROUTER_SHARED_KEY`**: ela é digitada só no WinBox (a mesma cadastrada nos Secrets do Supabase).
