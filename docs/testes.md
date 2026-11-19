# Testes

```sh
npm install              # instala só o PGlite (Postgres em WebAssembly), usado nos testes
npm test                 # suíte completa (Node 24)
npm run test:mutation    # "teste dos testes": planta falhas e confere se a suíte as detecta
npm run dev              # portal + backend SIMULADOS em http://localhost:8787/?mac=AA:BB:CC:DD:EE:10
```

## O que cada camada é

| Tipo | O que roda de verdade | O que é simulado | Arquivo |
|---|---|---|---|
| **Real (local)** | A migration SQL em Postgres real (PGlite): regras, permissões, RLS, constraints, expiração | — | `tests/db.test.mjs` |
| **Simulado** | O código real das Edge Functions e o banco | Mercado Pago (corpo, cabeçalhos, valores, falhas) e PostgREST | `tests/functions.test.mjs` |
| **Simulado** | Backend e banco | O **algoritmo** do script do MikroTik, reproduzido em JavaScript (não é RouterOS) | `tests/router-protocol.test.mjs`, `tests/e2e.test.mjs` |
| **Simulado** | Funções e banco | Segredos ausentes (falha segura) | `tests/secrets-missing.test.mjs` |
| **Estático** | Leitura dos arquivos; `prepare-site` e `netlify.toml` | — | `tests/static.test.mjs` |
| **Manual** | Portal no navegador (320 e 360 px) com backend simulado | Pagamento e roteador | feito na auditoria |

## Cenários cobertos

Pagamentos duplicados e notificações repetidas/simultâneas · falhas e indisponibilidade do webhook, do Mercado Pago e do banco · reconciliação sem webhook · pagamento aprovado **depois** de expirar · valor, moeda, meio e referência adulterados · assinatura ausente/errada · crédito acumulado e duração vinda do servidor · compra repetida antes do fim · **falha de sincronização** e recuperação · **reinicialização** do roteador (ACK perdido sem crédito duplo) · execução simultânea do script · linhas malformadas/maliciosas no protocolo · tentativa de acesso sem pagar · **pagamento aprovado sem liberação** ainda · expiração do tempo contratado e nova compra · estorno antes/depois da liberação · 40 passageiros simultâneos · rotação de chave · permissões e RLS do banco.

## Verificações no Supabase real (sem pagamentos)

Feitas uma vez, contra o projeto publicado, **sem Mercado Pago e sem cobrança**: migration aplicada, RLS ligado e sem políticas, privilégios de `anon`/`authenticated` nulos nas tabelas e nas funções, chave pública recusada (`42501`) ao ler/gravar/chamar funções pela API REST, autoteste das funções dentro de uma transação desfeita, **concorrência com sessões distintas do Postgres** (reservas simultâneas do mesmo aparelho criam um pedido; aprovações simultâneas viram uma única `paid`), funções publicadas e importando o código compartilhado, e falha segura sem segredos. O CI do GitHub roda `npm test` a cada push.

## O que os testes NÃO provam

- **Nenhum comando RouterOS foi executado.** O `.rsc` só passa por verificações estáticas (delimitadores, compatibilidade com o RouterOS 6, TLS validado, constantes). O modelo em JavaScript prova a **lógica**, não a **sintaxe nem o comportamento do RouterOS**. Use `router/diagnostico.rsc` no equipamento.
- Mercado Pago, Supabase e Netlify **reais** (credenciais) e os celulares reais.
- Concorrência real no Postgres **dentro do `npm test`**: o PGlite executa uma conexão por vez. (Ela foi verificada uma vez no Supabase real, veja acima.)
- Persistência do tempo usado (`uptime`) após reinício do roteador: o modelo **assume** que persiste; teste no equipamento.

## Teste de mutação

`npm run test:mutation` altera o código de propósito, uma falha por vez (ignorar o valor pago, remover a verificação de assinatura, abrir o CORS, desligar a validação TLS, usar comando do RouterOS 7 etc.), roda a suíte e exige que ela **falhe**. Cada arquivo é restaurado ao final.
