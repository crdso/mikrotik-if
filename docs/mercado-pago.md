# Mercado Pago (Pix)

Usa a **API de Pagamentos** oficial. Valor fixo de R$ 5,00, Pix dinâmico, QR Code e Pix Copia e Cola.

## O que o código faz

| Requisito | Implementação |
|---|---|
| Valor fixo | `transaction_amount: 5` definido no servidor; o navegador não influencia preço, descrição nem meio |
| Idempotência | Cabeçalho `X-Idempotency-Key` = id do pedido; reenvio do mesmo aparelho devolve o mesmo Pix |
| Identificação | `external_reference` = id do pedido |
| Validade | `date_of_expiration` de 30 min; status local `expired` com tolerância de 2 min |
| Webhook | Assinatura HMAC-SHA256 (`x-signature`, `x-request-id`, `data.id` em minúsculas); **o corpo nunca é confiado** |
| Verificação | `GET /v1/payments/{id}` e conferência no banco: status `approved`, valor, moeda `BRL`, meio `pix`, vínculo com o pedido, unicidade do pagamento |
| Pendente / recusado / cancelado / expirado | `pending`/`in_process` aguardam; `rejected` → `failed`; `cancelled` (expirado) → `expired`; qualquer outro → `failed` |
| Estorno | `refunded`/`charged_back` → `refunded` (sem novo crédito; acesso já concedido não é revogado) |
| Reconciliação | Se o webhook não chegar, `payment-status` consulta o Mercado Pago (no máx. 1× a cada 10 s por pedido) |
| Pagamento aprovado após expirar | Libera mesmo assim (o Mercado Pago é a fonte da verdade) |
| Credenciais | Só como segredos de servidor; nunca no portal, em log ou no repositório |

## Configuração

1. **Developers → Suas integrações:** crie uma aplicação (API de pagamentos). A conta precisa ter **Pix habilitado**.
2. Copie o **Access Token de produção** e cadastre como segredo (`supabase secrets set MP_ACCESS_TOKEN=...` no seu terminal — **não cole tokens em chats**).
3. **Webhooks — ação separada no painel do Mercado Pago Developers** (cadastrar as secrets no Supabase **não** ativa o webhook): em *Suas integrações → sua aplicação → Webhooks → Configurar notificações*, no modo **produção**, informe a URL `https://SEU_REFERENCE_ID.supabase.co/functions/v1/mp-webhook` e marque o evento **Pagamentos** (`payment`, o único necessário). Ao salvar, o painel mostra a **chave secreta** da assinatura: cadastre-a como `MP_WEBHOOK_SECRET`.
4. Use "Simular notificação" no painel: o resultado esperado é uma resposta **sem `401`** (o pagamento simulado não existe e a função devolve `payment_not_found`). `401` indica segredo errado. Isso só prova a assinatura.
5. **Primeiro pagamento real de R$ 5, feito por você mesmo**, antes de ligar o MikroTik; depois estorne pelo painel, se quiser.

## O que não foi verificado

Criação real de Pix, formato aceito de `date_of_expiration`, entrega real do webhook assinado, taxas e limites da conta: só com credenciais reais. Os testes usam um simulador fiel à documentação, não a API.
