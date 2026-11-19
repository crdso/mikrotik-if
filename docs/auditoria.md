# Auditoria técnica — Wi-Fi a Bordo

Escopo: todos os arquivos da pasta `mikrotik/` (site, supabase, router, README, COMECE-AQUI).
Método: leitura integral, correção, testes automatizados (banco real em PGlite + Mercado Pago/MikroTik simulados), testes de mutação e teste manual do portal no navegador.
**Nada foi implantado, nenhuma credencial real foi usada, nenhuma cobrança foi feita, nenhum roteador foi configurado.**

Legenda de severidade: **Alta** = perde dinheiro/acesso ou permite acesso indevido; **Média** = falha operacional ou de segurança com condição; **Baixa** = robustez/documentação.

## 1. Problemas encontrados e correções

| # | Sev. | Problema (como estava) | Correção | Como foi verificado |
|---|---|---|---|---|
| 1 | Alta | **Pagou e não liberou.** O webhook só atualizava pedidos `pending`. Se o pedido tivesse sido marcado `failed` (falha local ao criar o Pix) ou `expired`, um Pix aprovado depois era ignorado. | `hotspot_apply_payment` aceita `approved` a partir de `pending`, `failed` ou `expired` (o MP é a fonte da verdade). | db, functions e e2e (pagamento após expirar); mutação detectada |
| 2 | Alta | **Cobrança duplicada.** Cada clique/requisição criava novo pedido e novo Pix (a chave de idempotência era um UUID novo por chamada). | `hotspot_reserve_order` (atômico, com lock por MAC): reaproveita o Pix pendente; se já pagou e aguarda o roteador, devolve `paid_waiting`. | db, functions (duplo clique = 1 cobrança) |
| 3 | Alta | **Segunda compra apagava o tempo restante.** O script removia o usuário e recriava, contradizendo "5 horas acumuladas". | O script **soma** 5 h ao `limit-uptime` atual; marcador `o:<id>` no comentário evita somar em dobro quando o ACK se perde. | e2e (modelo do algoritmo). **O RouterOS real não foi testado.** |
| 4 | Alta | **Pix sem prazo e sem reconciliação.** Se o webhook falhasse (segredo errado, atraso), ninguém era liberado; o prazo era o padrão do MP (24 h). Reenvios legítimos tardios eram rejeitados pela janela de 10 min da assinatura. | Pix de 30 min (`date_of_expiration`); `payment-status` reconcilia com o MP (limitado a 1×/10 s por pedido); removida a janela de tempo da assinatura (o pagamento é sempre relido no MP, então repetir uma notificação é inofensivo). | functions: reconciliação sem webhook, notificação antiga aceita |
| 5 | Média | **Sem proteção contra abuso.** Qualquer um criava Pix/pedidos ilimitados. | Limites no banco: 5 pedidos/10 min por aparelho e 200/10 min no total (HTTP 429). | db, functions |
| 6 | Média | **Webhook devolvia 422** para pagamentos inválidos (o MP reenviaria por dias) e 500 para JSON ruim. | Responde 200 e registra em log o que o banco recusou; 500 apenas para erro temporário (MP/banco fora), para o MP tentar de novo; 404 do MP (notificação de teste) = 200 "ignorado". | functions |
| 7 | Média | **Moeda não era conferida** e o valor esperado era uma constante solta. | O pedido grava `amount_cents`; o banco confere valor, `BRL`, `pix` e vínculo pedido↔pagamento (unicidade do `payment_id`). | db, functions (valores 1, 4,99, 50, moeda, meio) |
| 8 | Média | **Chave do roteador comparada em tempo não constante**; erro de segredo ausente fora do `try`. | Comparação por digest SHA-256 em tempo constante; tudo dentro do tratamento de erro. | functions |
| 9 | Média | **CORS/origem:** `SITE_ORIGIN` lido só na carga do módulo (trocar o segredo exigia novo deploy); resposta `Allow-Origin: null`; só uma origem. | Lido a cada chamada; sem cabeçalho CORS para origem não permitida; aceita várias origens separadas por vírgula. | functions |
| 10 | Média | **Estado do pedido fraco no banco:** sem constraints; `payment_status` sem `refunded`; qualquer `UPDATE` podia marcar liberado sem pagamento. | Constraints (`provisioned` exige `paid_at`; `paid` exige data); status `refunded`; transições só por funções SQL atômicas. | db (UPDATE direto é rejeitado) |
| 11 | Média | **Funções SQL expostas por padrão:** o Postgres concede `EXECUTE` a `PUBLIC`; com a API do Supabase, a chave pública poderia chamá-las. | `revoke ... from public, anon, authenticated`; `grant` só a `service_role`; `search_path` fixo. | db (anon/authenticated recebem "permission denied"); mutação detectada |
| 12 | Média | **Estornos não tratados.** | `refunded`/`charged_back` → `refunded`; pedido estornado antes da liberação **nunca** chega ao roteador; replay de "aprovado" não o revive. | db, functions, e2e. Limitação: acesso já concedido não é revogado (ver README). |
| 13 | Média | **Script RouterOS:** idioma inválido para detectar execução simultânea; sem checar falha de rede; log inundado a cada 10 s sem internet; removia sessão ativa. | `/system script job find`; contador global de falhas (log na 1ª e a cada 30); soma de tempo sem derrubar sessão. | Estático (delimitadores, TLS). **Sintaxe real só no MikroTik.** |
| 14 | Média | **Portal:** estado só em `sessionStorage` (perdido ao fechar o portal cativo); sem prazo, expirado, falha de rede ou timeout; cópia sem alternativa; JS/CSS inline (impede CSP). | `localStorage` com `try/catch`, recuperação do pedido, contagem regressiva, telas de pago/expirado/falha/sem rede, timeout de 15 s, cópia com 3 alternativas, CSP sem inline, alvo de toque ≥ 48 px, sem rolagem horizontal a 320 px. | Teste manual no navegador; estático |
| 15 | Baixa | `login-by=mac,http-chap` recomendado para produção. | Documentado: `mac,http-chap` só para testes manuais; produção `login-by=mac`. | Documentação |
| 16 | Baixa | Validação de UUID frouxa (`[0-9a-f-]{36}`); JSON inválido virava 500; corpo sem limite. | UUID estrito; 400 para JSON inválido; 413 acima de 4 KB. | functions |
| 17 | Baixa | `SUPABASE_SERVICE_ROLE_KEY` sempre enviada como `Bearer`; chaves novas (`sb_secret_…`) não são JWT. | `Authorization` só quando a chave parece JWT; `apikey` sempre. | **Não verificado na plataforma real** |
| 18 | Baixa | **Documentação:** nome de rede diferente entre arquivos (dois nomes diferentes para a mesma rede); afirmações sobre a CLI "v3" sem fonte; ordem com dependência circular (`SITE_ORIGIN` × URL da Netlify); instrução de "executar exatamente a migration" sem tratar reexecução. | Nome único; sem afirmações não verificadas; fluxo Supabase → MP → Netlify → MikroTik com `SITE_ORIGIN` ajustado ao final da Netlify; migration idempotente. | Estático (consistência) |
| 19 | Info | **Topologia:** AP externo em modo roteador/repetidor/WDS troca o MAC dos clientes — todos dividiriam um acesso. | Documentado em destaque com teste (`/ip hotspot host print`). | Documentação |
| 20 | Info | Domínios de teste de conectividade no Walled Garden impediriam o portal cativo de abrir. | Documentado o que **não** liberar. | Documentação |
| 21 | Info | Sem forma de apagar dados após a operação. | `hotspot_purge(dias)`; guia de limpeza do MikroTik. | db |

## 2. O que foi acrescentado (estava faltando)

Prazo/expiração do Pix; reconciliação sem webhook; limite de abuso; estados `expired`/`failed`/`refunded`; heartbeat do roteador (`router_online`); `hotspot_purge`; `scripts/prepare-site.mjs` (gera `dist-site/` com projeto e CSP ajustados); `scripts/smoke.mjs` (verificação pós-deploy sem cobrança); servidor local de demonstração; 75 testes + testes de mutação; documentação de dependências de hardware.

## 3. Resultados dos testes (executados nesta auditoria)

| Suíte | Tipo | Resultado |
|---|---|---|
| `tests/db.test.mjs` | Real (Postgres/PGlite) | 19 de 19 passaram |
| `tests/functions.test.mjs` | Simulado (MP simulado, banco real) | 34 de 34 passaram |
| `tests/e2e.test.mjs` | Simulado (modelo do roteador) | 12 de 12 passaram |
| `tests/static.test.mjs` | Estático | 10 de 10 passaram |
| **`npm test`** | | **75 de 75 passaram** |
| `npm run test:mutation` | 14 falhas plantadas (valor, assinatura, autenticação, permissões, CORS, TLS, CSP…) | **14 de 14 detectadas**; arquivos restaurados e conferidos por hash |
| Portal no navegador (Chromium do app, 320 e 360 px) | Manual | Fluxo completo OK (Pix, copiar, QR, pago→liberando→liberado com recarga no meio, expirado, sem rede, sem MAC); sem erro de CSP no console; sem rolagem horizontal |
| `scripts/prepare-site.mjs` | Executado | Gera `dist-site/` correto; recusa código inválido e pasta de saída fora do projeto |
| `scripts/smoke.mjs` | **Só sintaxe e recusa de entrada inválida** | Não executado contra serviço real |

Falhas encontradas durante os testes e corrigidas: um gerador de MACs do próprio teste, um padrão de "segredo" que pegava um comentário e uma checagem de `*` que pegava a linha `/*` do `_headers` — todos erros dos testes, não do produto. A primeira rodada de mutação também teve uma mutação inválida (trecho duplicado), corrigida e reexecutada.

## 4. O que NÃO foi provado

1. **Todo o RouterOS.** `hotspot-poll.rsc`, o perfil, `login-by=mac`, Walled Garden, scheduler, corte por `limit-uptime`, soma de tempo e comportamento com celular ocioso só existem como lógica **modelada em JavaScript** e verificação estática de delimitadores. Comandos como `:onerror`, `:serialize`/`:deserialize`, `/tool fetch` com os parâmetros usados e a aritmética de tempo precisam rodar num MikroTik real (RouterOS 7.14+).
2. **Mercado Pago real:** criação de Pix, formato de `date_of_expiration`, entrega e assinatura do webhook, taxas, limites da conta.
3. **Supabase real:** o código roda em Node com um shim de `Deno`; não foi executado no runtime das Edge Functions nem verificada a chave `SUPABASE_SERVICE_ROLE_KEY` da plataforma.
4. **Concorrência real:** o PGlite usa uma conexão; o lock consultivo por MAC é correto por construção, mas não foi exercitado por sessões paralelas.
5. **Portal cativo de iPhone e Android**, abertura/fechamento automático, pagar no mesmo aparelho, Walled Garden com DNS/IP reais da Netlify/Supabase.
6. **Tipos TypeScript:** `@ts-nocheck`; nada rodou `tsc`/`deno check`.
7. Starlink (Ethernet, bypass, uso em movimento, revenda) e exigências da Anatel: contrato e equipamento.

---

## Revisão 3 — compatibilidade com RouterOS 6.48 e preparação do repositório público

Contexto: o equipamento real é um hEX lite com **RouterOS 6.48.6**, e o script da revisão anterior exigia **7.14+**.

| # | Sev. | Problema | Correção | Verificação |
|---|---|---|---|---|
| 22 | Alta | O `hotspot-poll.rsc` usava `:serialize`, `:deserialize` e `:onerror` (só existem a partir do RouterOS 7.13) e `/system script job` para a trava: **não funcionaria no equipamento real**. | Script reescrito para RouterOS 6.43+: resposta em **texto de largura fixa**, validação campo a campo, `:do { } on-error={ }`, trava por variável global com carimbo, ACK por formulário. O mesmo script roda no RouterOS 7. | Estático + modelo em JavaScript; **não executado em RouterOS** |
| 23 | Média | O servidor não decidia a duração do crédito (constante no script). | `grant_seconds` por pedido no banco, enviado como `5h0m0s`; teto de 2 dias no script; resposta < 1 KB e no máximo 10 pedidos por consulta (64 MB de RAM). | db, router-protocol |
| 24 | Média | Sem como provar no equipamento o que a documentação não pôde confirmar (o wiki do RouterOS 6 foi redirecionado). | `router/diagnostico.rsc`: somente leitura; testa versão, memória, relógio, `:totime`, soma de tempo, `:find`, HTTPS com e sem validação. Endereço público `?ping` na função do roteador. | Estático (garante que é só leitura) |
| 25 | Média | O RouterOS 6 não traz CA instalada, e o guia anterior dizia só "não desabilite a validação". | Guia para importar **apenas** a raiz necessária, com conferência da impressão digital; medição do TLS do Supabase (raiz ISRG Root X1; TLS 1.2 com `ECDHE-RSA-AES128-GCM`); alternativas se o TLS falhar. | Medição em rede (leitura); **não testado no roteador** |
| 26 | Média | Rotação de chave do roteador derrubaria a sincronização. | `ROUTER_SHARED_KEY_NEXT` aceita as duas chaves durante a troca. | router-protocol |
| 27 | Baixa | Sem resumo de créditos e sem guia de emergência, reinicialização, isolamento e painel administrativo. | `hotspot_credit_summary`, `docs/operacao-e-seguranca.md` (propostas **não aplicadas**). | db; documentação |
| 28 | Baixa | Textos e testes com referências específicas de um local/uso. | Texto genérico ("passageiro", "a bordo"). | Varredura de texto |

Testes adicionados nesta revisão: 14 (protocolo de texto, linhas maliciosas, reinicialização, trava de execução simultânea, falha de sincronização, webhooks duplicados simultâneos, crédito vindo do servidor, rotação de chave, resumo de créditos).

## Revisão 4 — publicação do backend e preparação do repositório

| # | Sev. | Item | Resultado |
|---|---|---|---|
| 29 | Baixa | Webhook sem assinatura respondia 500 quando o segredo ainda não existia | Responde 401 antes de olhar os segredos; teste dedicado |
| 30 | Média | Sem prova de que a falta de segredos é segura | `tests/secrets-missing.test.mjs` (8 casos): nenhum cenário de segredo ausente libera internet |
| 31 | Média | Publicar o portal exigia copiar arquivos à mão | `netlify.toml` + `prepare-site` por variável pública (`SUPABASE_PROJECT_REF`); teste garante que nenhuma chave entra no que é publicado |
| 32 | Baixa | Sem CI | `.github/workflows/ci.yml` roda `npm ci` e `npm test` |
| 33 | Info | Concorrência só simulada | Verificada em sessões distintas do Postgres real (reserva e aprovação) |
| 34 | Info | Aviso do Supabase sobre `rls_auto_enable` executável por `anon` | Função **da plataforma**, preexistente; **não alterada** (decisão do mantenedor) |
