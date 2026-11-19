# Supabase

Crie um **projeto dedicado** (não reutilize o de outro sistema). Anote o **Reference ID** (Settings → General).

## 1. Banco

SQL Editor → cole **todo** o arquivo `supabase/migrations/202611170001_hotspot_orders.sql` → Run. É idempotente (reexecutar não apaga pedidos). O arquivo cria:

- `hotspot_orders` (pedido = pagamento + crédito + ACK) e `hotspot_router_state` (última consulta do roteador);
- funções `hotspot_*` com **toda** a lógica de transição (reserva, aplicar pagamento, status, pull/ack do roteador, resumo de créditos, limpeza);
- RLS ligado **sem policies**, `revoke` para `anon`/`authenticated` e `grant execute` somente a `service_role`.

Consultas úteis de suporte (SQL Editor):

```sql
select id, device_mac, payment_status, paid_at, provisioned_at, grant_seconds
  from public.hotspot_orders order by created_at desc limit 50;
select public.hotspot_credit_summary('AA:BB:CC:DD:EE:FF');   -- créditos de um aparelho
select public.hotspot_purge(0);                              -- apaga pedidos encerrados (privacidade)
```

## 2. Funções (Edge Functions)

```sh
supabase login
supabase link --project-ref SEU_REFERENCE_ID
supabase functions deploy create-payment
supabase functions deploy payment-status
supabase functions deploy mp-webhook
supabase functions deploy router-sync
```

`supabase/config.toml` marca `verify_jwt = false` (Mercado Pago e roteador não têm JWT do Supabase; cada função autentica por conta própria). Se algum teste retornar `401` onde se esperava `403`/`400`, a verificação de JWT ficou ligada: publique de novo com `--no-verify-jwt`.

## 3. Segredos (nunca em arquivo versionado)

| Nome | Conteúdo | Quem usa |
|---|---|---|
| `MP_ACCESS_TOKEN` | Token de produção do Mercado Pago | create-payment, mp-webhook, payment-status |
| `MP_WEBHOOK_SECRET` | Chave secreta da assinatura do webhook | mp-webhook |
| `ROUTER_SHARED_KEY` | 32+ bytes aleatórios (letras, números, `-`, `_`; **sem vírgula**) | router-sync |
| `ROUTER_SHARED_KEY_NEXT` | (opcional) chave nova durante a rotação | router-sync |
| `SITE_ORIGIN` | URL exata do portal, sem `/` final (várias, separadas por vírgula) | todas as públicas |

`SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` já existem no ambiente das funções: **não copie para o portal nem para o repositório**.

Cadastre sem colar nada em chats ou arquivos: use o terminal local.

```sh
# gerar a chave do roteador (guarde em gerenciador de senhas)
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
# cadastrar (o valor é digitado/colado só no seu terminal)
supabase secrets set ROUTER_SHARED_KEY=...
supabase secrets set SITE_ORIGIN=https://seu-portal.exemplo
```

Para os segredos do Mercado Pago, o painel do Supabase (*Edge Functions → Secrets*) também serve.

**Rotação da chave do roteador:** `supabase secrets set ROUTER_SHARED_KEY_NEXT=<nova>` → atualize o `secret` no script do roteador → promova (`ROUTER_SHARED_KEY=<nova>`) e remova `ROUTER_SHARED_KEY_NEXT`.

## 4. Verificação sem cobrança

```sh
SUPABASE_URL=https://SEU_REFERENCE_ID.supabase.co SITE_ORIGIN=https://seu-portal.exemplo node scripts/smoke.mjs
```

O script não cria Pix nem cobra: testa CORS, rejeições (origem, MAC inválido, webhook sem assinatura, roteador sem chave) e, se `ROUTER_SHARED_KEY` for informada, a leitura do `router-sync`.
