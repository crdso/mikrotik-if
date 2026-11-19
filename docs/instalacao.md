# Guia de instalação (ordem de implantação)

Ordem: **Supabase → Mercado Pago → Netlify → teste de Pix real → MikroTik → testes nos celulares.**
O MikroTik é configurado por último: até lá, todo o pagamento já deve estar provado.

> **Estado:** testado só em simulação (veja [testes.md](testes.md)). Nunca executado com contas, roteador ou celulares reais. **Não cobre passageiros antes do passo 6.**

## 0. Pré-requisitos

- [ ] Autorização por escrito para **cobrar** pelo acesso (plano do provedor de internet, regras locais, responsável pelo veículo). Este projeto não verifica nada disso.
- [ ] Contas: Supabase, Mercado Pago (Pix habilitado), Netlify.
- [ ] Node 24 e a Supabase CLI no computador; `npm install` na pasta do projeto; `npm test` sem falhas.
- [ ] MikroTik com Hotspot **já funcionando** e backup feito ([mikrotik.md](mikrotik.md) §2). Rodar `router/diagnostico.rsc` (somente leitura) e guardar o resultado.

## 1. Supabase — [supabase.md](supabase.md)

1. Projeto novo; migration no SQL Editor.
2. `supabase link` e publicar as 4 funções.
3. Segredos: `ROUTER_SHARED_KEY`, `SITE_ORIGIN` (provisório) — os do Mercado Pago vêm no passo 2.
4. `scripts/smoke.mjs` (sem cobrança).

## 2. Mercado Pago — [mercado-pago.md](mercado-pago.md)

1. Aplicação, Access Token de produção → `MP_ACCESS_TOKEN`.
2. Webhook de produção apontando para `mp-webhook` → `MP_WEBHOOK_SECRET`.
3. "Simular notificação": resposta sem `401`.

## 3. Netlify — [netlify.md](netlify.md)

1. `node scripts/prepare-site.mjs SEU_REFERENCE_ID` → publicar a pasta `dist-site/`.
2. Cadastrar `SITE_ORIGIN` com a URL final; rodar `scripts/smoke.mjs` de novo.
3. Abrir a URL **sem** `?mac=`: deve mostrar "Conecte ao Wi-Fi a Bordo".

## 4. Teste de Pix real — sem MikroTik (autorizado e pago por você)

1. Abra `https://SEU-PORTAL/?mac=AA:BB:CC:DD:EE:99` (MAC inventado) → e-mail → **Gerar Pix** (gerar não cobra).
2. Pague R$ 5,00 pelo app do seu banco (Copia e Cola). O portal deve mostrar "Pagamento confirmado" e ficar em "liberando".
3. No SQL Editor: o pedido deve estar `paid`, com `paid_at` e sem `provisioned_at`; no Mercado Pago, valor R$ 5,00 e `external_reference` = id do pedido.
4. Limpe: `select public.hotspot_purge(0);` (antes de ligar o roteador, para ele não creditar o MAC de teste).

## 5. MikroTik — [mikrotik.md](mikrotik.md)

Na ordem do guia: diagnóstico → CA → perfil `wifi-5h` → `login-by` com `mac` → Walled Garden → `login.html` → script (rodar à mão, ler o Log) → agendador. **Cada passo tem reversão.** Endurecimento do painel e isolamento: [operacao-e-seguranca.md](operacao-e-seguranca.md).

## 6. Testes finais nos celulares

1. Celular A no Wi-Fi: abrir um site HTTP leva ao portal; **não** navega antes de pagar.
2. Pagar de outro aparelho (ou com dados móveis). Em até ~30–40 s (consulta de 20 s + portal de 4 s) aparece "Internet liberada" e o celular A navega.
3. Celular B (não pagou) segue bloqueado.
4. Velocidade ≈ 1 Mbps subida / 4 Mbps descida por usuário.
5. Corte por tempo (usuário manual de 2 minutos) e **novo corte → tela de login → nova compra**.
6. **Compra dupla:** comprar de novo antes de acabar soma o tempo (`/ip hotspot user print detail`).
7. **Reinicialização:** reiniciar o MikroTik com um usuário ativo; conferir se continua e **se o tempo usado foi preservado**.
8. **Queda da internet de origem** por 1 minuto: o `wifi-poll` volta sozinho; nada é liberado sem pagamento.
9. iPhone **e** Android reais; um com endereço Wi-Fi privado ligado e outro desligado.
10. CPU/memória do roteador com vários aparelhos (`/system resource print`).

Qualquer falha nos itens 1–3 = **não cobre ainda**.

## 7. Depende de credenciais, contas ou equipamento reais (não provado)

| Item | Por quê |
|---|---|
| Criação real de Pix, QR, webhook assinado real | Token e segredo reais do Mercado Pago |
| Execução no runtime do Supabase | Testado em Node com adaptador, não no ambiente real |
| Todo o RouterOS (script, TLS, CA, `login-by=mac`, Walled Garden, corte por tempo, uptime após reboot) | Só num MikroTik real |
| Portal cativo de iPhone/Android | Só com celulares reais |
| Desempenho com ~40 aparelhos no hEX lite | Só com teste real |
| Contrato do provedor de internet e regras locais | Documentos, não código |

## Problemas comuns

| Sintoma | Onde olhar |
|---|---|
| Portal diz "Conecte ao Wi-Fi a Bordo" | URL sem `?mac=`; `login.html` ainda com `SEU-SITE`; Hotspot sem preencher `$(mac)` |
| "Não consegui falar com o servidor" | Walled Garden sem o Supabase; `SITE_ORIGIN` diferente da URL real; CSP gerada sem o projeto certo |
| Pix gera, mas não confirma | `MP_WEBHOOK_SECRET` errado (log do `mp-webhook` mostra `401`); o portal ainda reconcilia em ~10 s |
| "Pagamento confirmado", mas não libera | Roteador offline ou `wifi-poll` com erro: `/log print where message~"wifi-poll"`; chave diferente; relógio/CA |
| Todos dividem 1 acesso | AP em modo roteador/repetidor |
