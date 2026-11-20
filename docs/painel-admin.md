# Painel administrativo e planos

Endereço: `https://<seu-portal>/admin` (página privada, `noindex`, independente do portal do passageiro). Rotas: `/admin` (Dashboard), `/admin/pagamentos`, `/admin/dispositivos`, `/admin/planos`, `/admin/relatorios`, `/admin/config`.

## Como funciona a segurança
1. O login usa o **Supabase Auth** (e-mail e senha). O navegador só tem a chave *publicável* (`site/admin/keys.js`), que sozinha não dá acesso a nada: todas as tabelas têm RLS e nenhum privilégio para `anon`/`authenticated`.
2. Toda ação passa pela Edge Function **`admin-api`**, que valida o token no Auth e confere se o usuário está na tabela **`admin_users`**. Estar autenticado **não basta**: o cadastro público do Auth não dá acesso ao painel.
3. Perfis: **admin** (tudo) e **operator** (somente leitura: não altera planos nem configurações e não lê a auditoria). O banco confere o perfil de novo nas funções de escrita.
4. Alterações de planos e configurações vão para `admin_audit_log` (quem, quando, valores antes/depois).
5. Nenhuma chave secreta (service role, `ROUTER_SHARED_KEY`, Mercado Pago) vai para o navegador ou para o repositório.

## Criar a primeira conta de administrador (sem senha no repositório)
1. Supabase → **Authentication → Users → Add user → Create new user**: informe seu e-mail e uma senha forte (só você a conhece) e marque *Auto Confirm User*.
2. Supabase → **SQL Editor** (troque o e-mail):
   ```sql
   insert into public.admin_users (user_id, role)
   select id, 'admin' from auth.users where email = 'SEU_EMAIL';
   ```
   (para um operador somente leitura use `'operator'`).
3. Supabase → **Authentication → Sign In / Providers**: desligue **Allow new users to sign up** (o painel não depende do cadastro público).
4. Abra `/admin` e entre com o e-mail e a senha.

## O que cada indicador significa
- **Vendas aprovadas / Receita**: pedidos com `payment_status = 'paid'`, sem marca `is_test`, no período (data do pagamento, fuso `America/Fortaleza`), somados **em centavos no banco**. Pendentes, expirados, recusados, cancelados e estornados **não entram**; estornos aparecem separados.
- **Variação**: contra o período imediatamente anterior de mesmo tamanho (sem base → "sem comparação").
- **Ticket médio**: receita ÷ vendas (vazio quando não há vendas).
- **Passes ativos**: aparelhos com crédito concedido e ainda não reportado como esgotado pelo roteador (`hotspot_device_credit_state = 'active'`).
- **Dispositivos online**: número de sessões autenticadas informado pelo MikroTik (`/ip hotspot active`). Só é exibido quando a telemetria é recente; senão aparece "Indisponível" com a última informação.
- **Equipamentos online**: `hotspot_router_state.last_seen_at` (atualizado a cada consulta autenticada do `wifi-poll`) dentro do limite configurável (padrão 180 s).
- **Tempo restante** por aparelho: `limit-uptime − uptime` do último relatório do roteador. Com relatório antigo aparece "última informação HH:MM"; sem relatório, "Não disponível". Desconectar não zera o tempo; novas compras somam ao limite.
- **Aprovado ≠ liberado**: "Pix aprovado" e "Crédito provisionado" são situações diferentes; "aprovado aguardando provisionamento" gera alerta após o tempo configurado.
- **Receita não é saldo**: o painel mostra o faturamento registrado no banco; **não** consulta o saldo da conta Mercado Pago. Taxas (`fee_details`) só aparecem quando o Mercado Pago as informa; o líquido estimado só é calculado se todas as vendas do período têm taxa conhecida.
- **Testes**: pedidos com `is_test = true` ficam fora de todos os relatórios financeiros.

## Planos e preços (`/admin/planos`)
- Tabela `hotspot_plans` (nome, descrição, preço em centavos, duração em segundos, ativo, destaque, padrão, ordem). Limites: R$ 1,00 a R$ 500,00 e 1 minuto a 48 horas por compra (o `wifi-poll` aceita até 2 dias por crédito; planos maiores exigem revisar e testar o roteador).
- Cada pedido **congela** o preço e a duração no momento da criação (`amount_cents`, `grant_seconds`, `plan_id`, `plan_name`). Alterar um plano vale só para compras futuras; pagamentos e Pix pendentes mantêm o valor original e o webhook valida o valor contra o pedido.
- O navegador envia só `plan_id`; o servidor decide o valor. Com um único plano ativo o portal não mostra seleção.
- Trocar de plano com Pix pendente: o servidor relê o Pix antigo no Mercado Pago; se estiver **pendente**, cancela e cria o novo; se já estiver **aprovado**, aplica o pagamento (nada é cancelado nem perdido) e não cria outro Pix.
- O perfil de usuário do MikroTik (`plano-5h`, 1M/4M) é reaproveitado por todos os planos; ele não determina a duração.

## Telemetria do MikroTik
O `wifi-poll` envia, a cada 60 s e em blocos de até 10 aparelhos, o número de sessões ativas e, por aparelho, `MAC_IP_uso_limite_ativo`. É só leitura no roteador, usa a mesma chave e a mesma validação TLS e não grava na memória flash. O servidor aceita apenas aparelhos que já têm pedido. **Esse trecho só pode ser confirmado no equipamento físico** (roteiro D3).
