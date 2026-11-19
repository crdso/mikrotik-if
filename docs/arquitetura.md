# Arquitetura

Sistema genérico de **Hotspot MikroTik com pagamento Pix**: um produto único (por padrão **R$ 5,00 = 5 horas de uso acumulado**), liberação automática por MAC, backend serverless e portal estático.

```text
Passageiro ──Wi-Fi aberto──> Access Point (só ponte) ──> MikroTik Hotspot ──> Internet (Starlink/outra)
     │  (sem pagar o Hotspot só mostra login.html, que redireciona ao portal)
     ▼
Portal (Netlify, estático) ──create-payment──> Supabase Edge Function ──> Mercado Pago (Pix R$ 5)
     ▲                                              │
     │ payment-status (4 s)                         │ webhook assinado ─> mp-webhook
     │                                              ▼
     └────────── Postgres (pedidos, créditos) <── hotspot_apply_payment  (único caminho para "paid")
                                                    ▲
MikroTik wifi-poll (HTTPS, de dentro para fora) ────┘ router-sync: lista pedidos pagos, recebe ACK
```

## Componentes

| Componente | Papel | Onde roda |
|---|---|---|
| Access Point | Só entrega o Wi-Fi em **bridge** (sem DHCP, sem NAT, sem lógica) | Qualquer AP; ou Wi-Fi integrado do MikroTik |
| MikroTik | Bloqueio, autenticação por MAC, **contagem de tempo**, limite de banda (`1M/4M`) | RouterOS 6.43+ ou 7 |
| `router/hotspot-poll.rsc` | Consulta o backend e credita pedidos pagos | MikroTik (scheduler) |
| Portal | Oferta, Pix (QR e Copia e Cola), acompanhamento, recuperação | Netlify (arquivos estáticos) |
| Edge Functions | `create-payment`, `payment-status`, `mp-webhook`, `router-sync` | Supabase |
| Banco | Pedidos, créditos, estados; **todas** as transições em funções SQL | Supabase Postgres |
| Mercado Pago | Cobrança Pix, webhook, status real do pagamento | API oficial |

## Princípios de projeto

1. **Quem libera internet é o backend, não o navegador.** O portal só mostra estado. Um pedido só vira `paid` por `hotspot_apply_payment`, com dados lidos da **API do Mercado Pago** (nunca do corpo do webhook nem do que o usuário informa).
2. **O roteador consulta o backend** (HTTPS de dentro para fora): funciona atrás de CGNAT, sem abrir porta nem expor serviços do MikroTik.
3. **Idempotência de ponta a ponta:** pedido por MAC com reserva atômica; chave de idempotência = id do pedido; webhook repetível; ACK repetível; marcador `o:<id>` no usuário do Hotspot impede crédito duplo mesmo se o ACK se perder ou o roteador reiniciar.
4. **Sem lógica de pagamento no AP:** o sistema só exige que o MAC do celular chegue ao MikroTik.
5. **Falhas degradam sem liberar:** servidor, Mercado Pago ou internet fora do ar nunca liberam acesso; o pagamento aprovado espera e é creditado depois, uma vez.

## Fluxo de um pagamento

1. O Hotspot serve `login.html` com o MAC (`$(mac)`) e redireciona ao portal (`?mac=...`).
2. O portal chama `create-payment` (MAC + e-mail). O servidor reserva um pedido (ou devolve o Pix pendente do mesmo aparelho), cria o Pix de R$ 5 no Mercado Pago com `X-Idempotency-Key = id do pedido`, `external_reference = id do pedido` e validade de 30 min.
3. O passageiro copia o código (ou usa o QR em outro aparelho) e paga.
4. O Mercado Pago chama `mp-webhook`; o servidor valida a **assinatura HMAC**, relê o pagamento na API e chama `hotspot_apply_payment` (valor, moeda BRL, meio `pix`, vínculo com o pedido, unicidade do pagamento).
5. Se o webhook falhar, `payment-status` reconcilia sozinho (no máximo 1 consulta ao Mercado Pago a cada 10 s por pedido).
6. O `wifi-poll` lê `router-sync` (`G <MAC> <id> <tempo>`), cria ou **soma** o `limit-uptime` do usuário Hotspot (nome = MAC) e envia o **ACK**. O portal mostra "Internet liberada" após o ACK.
7. O Hotspot corta no `limit-uptime`; o passageiro pode comprar de novo (o tempo restante é preservado e somado).

## Estados do pedido

`pending → paid → (ACK) provisioned`; também `failed`, `expired`, `refunded`. Um Pix aprovado depois de `failed`/`expired` ainda libera. Estorno antes do ACK nunca chega ao roteador; **estorno depois do ACK não revoga** o acesso já concedido (limitação conhecida).

## Segurança por camada

| Camada | Proteção |
|---|---|
| Portal | CSP restritiva, sem script/estilo inline, sem recursos externos, nenhuma chave |
| API pública | Origem (`SITE_ORIGIN`), `id` + `read_token` aleatórios, limites por aparelho (5/10 min) e global (200/10 min), tamanho máximo de corpo |
| Webhook | Assinatura HMAC, releitura na API, validação no banco |
| Roteador → API | `X-Router-Key` (256 bits recomendados, comparação em tempo constante, rotação com `ROUTER_SHARED_KEY_NEXT`), TLS validado, respostas pequenas |
| Banco | RLS ligado, sem policies; só `service_role` executa funções; constraints de integridade |
| MikroTik | Painel restrito ao administrador, serviços desnecessários desativados, usuário com `mac-address`, `shared-users=1` |

Detalhes de operação em [operacao-e-seguranca.md](operacao-e-seguranca.md).
