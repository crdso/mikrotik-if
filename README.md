# mikrotik-if — Hotspot MikroTik com pagamento Pix

> **EN:** Generic pay-by-Pix Wi-Fi hotspot for MikroTik. One product (default: BRL 5.00 = 5 cumulative hours), automatic MAC-based release, Supabase (Postgres + Edge Functions) backend, Mercado Pago Pix, static Netlify portal. Works with RouterOS **6.43+ (tested design target: 6.48.6 / hEX lite)** and 7. Documentation is in Portuguese.

Sistema genérico para vender acesso Wi-Fi por **Pix** em qualquer rede com **Hotspot MikroTik**: o passageiro conecta ao Wi-Fi aberto, paga R$ 5,00 no Pix e recebe **5 horas de uso acumulado**, liberadas automaticamente por MAC. Quando o tempo acaba, o Hotspot corta e ele pode comprar de novo.

> ## Estado do projeto
> Código revisado em auditoria e **testado em simulação** (banco Postgres real em memória + Mercado Pago e MikroTik simulados + portal no navegador). **Ainda não foi executado** com Mercado Pago, Supabase, Netlify, MikroTik ou celulares **reais**. Os comandos RouterOS não foram executados em equipamento. Veja [o que não foi provado](docs/testes.md#o-que-os-testes-não-provam). Não cobre usuários reais antes de seguir o [guia de instalação](docs/instalacao.md) e fazer os testes finais.

## Funcionalidades

- **R$ 5,00 = 5 horas acumuladas**, por aparelho; comprar de novo **soma** ao tempo restante e nunca credita o mesmo pagamento duas vezes.
- **Pix dinâmico** (QR Code e Copia e Cola) pela API oficial do Mercado Pago; **webhook com assinatura**, leitura do status real na API e **reconciliação** se a notificação não chegar.
- **Liberação automática** sem digitar usuário/senha: o MikroTik consulta o backend (HTTPS de dentro para fora — funciona atrás de CGNAT, sem abrir portas).
- **Compatível com RouterOS 6.43+ e 7** (protocolo de texto simples, sem JSON no roteador).
- **Independente do Access Point:** o AP só faz a ponte Wi-Fi; nenhuma lógica no AP.
- Portal responsivo, em tela pequena (320 px), com recuperação do pedido, contagem regressiva e estados de erro; CSP restritiva.
- Segurança: RLS sem policies, funções SQL só para `service_role`, limites contra abuso, comparação de chave em tempo constante, TLS validado no roteador.

## Como funciona (resumo)

```text
Passageiro ─Wi-Fi─> AP (ponte) ─> MikroTik Hotspot ─> Internet
     └─ login.html ─> Portal (Netlify) ─> create-payment ─> Mercado Pago (Pix)
                         ▲                      │ webhook assinado
                         └─ payment-status ─ Supabase (Postgres) ◄─ mp-webhook
MikroTik (wifi-poll, HTTPS) ──> router-sync: lista pedidos pagos, credita, envia ACK
```

Detalhes em [docs/arquitetura.md](docs/arquitetura.md).

## Documentação

| Documento | Conteúdo |
|---|---|
| [docs/instalacao.md](docs/instalacao.md) | **Ordem de implantação** e testes finais |
| [docs/arquitetura.md](docs/arquitetura.md) | Componentes, fluxo, estados, camadas de segurança |
| [docs/mikrotik.md](docs/mikrotik.md) | RouterOS 6.48/7: diagnóstico, CA, Hotspot, Walled Garden, script, reversão |
| [docs/operacao-e-seguranca.md](docs/operacao-e-seguranca.md) | Painel, isolamento, backup, logs, reinicialização, emergência, capacidade |
| [docs/supabase.md](docs/supabase.md) | Banco, funções, segredos, rotação de chave |
| [docs/mercado-pago.md](docs/mercado-pago.md) | Pix, webhook, estados do pagamento |
| [docs/netlify.md](docs/netlify.md) | Portal e limitações do portal cativo |
| [docs/testes.md](docs/testes.md) | Como testar e o que cada teste prova |
| [docs/auditoria.md](docs/auditoria.md) | Problemas encontrados e correções |

## Estrutura

```text
site/        Portal estático (index.html, app.js, style.css, config.js, _headers)
supabase/    config.toml, migrations/ (SQL) e functions/ (4 Edge Functions + _shared)
router/      login.html, hotspot-poll.rsc (RouterOS 6+), diagnostico.rsc (somente leitura)
scripts/     prepare-site.mjs (gera dist-site/), smoke.mjs (verificação sem cobrança)
tests/ dev/  Testes automatizados e servidor local de demonstração
docs/        Documentação
```

## Início rápido (desenvolvimento local)

```sh
npm install
npm test                 # suíte completa
npm run dev              # http://localhost:8787/?mac=AA:BB:CC:DD:EE:10 (tudo simulado)
```

`npm run dev` não usa nenhuma credencial nem serviço real. Controles de teste (apenas local): `POST :8788/__dev/pay?mac=...` aprova o Pix; `POST :8788/__dev/router?online=1` liga o roteador simulado.

## Variáveis de ambiente (segredos do Supabase)

Veja `.env.example`. **Nunca versione valores reais.** Cadastre com `supabase secrets set` (detalhes em [docs/supabase.md](docs/supabase.md)):
`MP_ACCESS_TOKEN`, `MP_WEBHOOK_SECRET`, `ROUTER_SHARED_KEY`, `SITE_ORIGIN` (e, opcionalmente, `ROUTER_SHARED_KEY_NEXT`).

## Limitações conhecidas

- **Estorno depois da liberação não revoga** o acesso já concedido (o pedido vira `refunded`; ajuste manual no Hotspot).
- **MAC** pode ser falsificado ou aleatório (endereço Wi-Fi privado): aceitável para um MVP, não é autenticação forte.
- O app do banco costuma não abrir dentro do portal cativo: o portal orienta copiar o código e pagar com dados móveis ou outro aparelho.
- Sem painel administrativo; operação por SQL e pelo painel do Mercado Pago.
- Hardware antigo (64 MB de RAM, 1 núcleo): **desempenho não garantido** sem teste real; veja [capacidade](docs/operacao-e-seguranca.md#8-capacidade-hardware-antigo-40-dispositivos).
- Tempo usado após reinício do roteador: persistência **não verificada**.

## Licença

Ainda não definida pelo mantenedor. Até que uma licença seja adicionada, aplicam-se os direitos autorais padrão.
