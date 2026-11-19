# Portal (Netlify)

O portal é **estático** (`site/`): `index.html`, `app.js`, `style.css`, `config.js` e `_headers`. Sem cadastro, sem senha de Wi-Fi, sem dependências externas.

## Recursos

- Oferta clara (**R$ 5 = 5 horas**), Pix (QR Code e **Copia e Cola**), contagem regressiva, estados de aguardando, aprovado/liberando, liberado, expirado e erro.
- **Recuperação do pedido** ao reabrir o navegador (armazenamento local + reaproveitamento do Pix pendente do mesmo aparelho).
- **Pagamento por outro caminho:** o passageiro copia o código e paga em outro aparelho ou com dados móveis; o pedido continua associado ao MAC original (o MAC vem do roteador, não do que o passageiro digita) e a liberação ocorre no aparelho certo.
- Sem confiar no navegador: a tela "liberada" depende do estado `internet_ready` vindo do servidor (ACK do roteador).
- Acessível e para telas pequenas (testado em 320 e 360 px): alvos de toque ≥ 48 px, sem rolagem horizontal, `prefers-reduced-motion`.
- Cabeçalhos de segurança e CSP (`_headers`): `default-src 'none'`, `script-src 'self'`, `connect-src` apenas o seu projeto Supabase.

## Publicação (importando do GitHub)

O repositório já traz o `netlify.toml` (comando `node scripts/prepare-site.mjs`, pasta publicada `dist-site`). Não é preciso copiar arquivos.

1. **Netlify → Add new project → Import an existing project → GitHub →** escolha o repositório.
2. Os campos de build vêm do `netlify.toml`; deixe como estão.
3. Em *Site configuration → Environment variables*, crie a variável **pública** `SUPABASE_PROJECT_REF` com o Reference ID do projeto Supabase (alternativa: `SUPABASE_URL=https://<Reference ID>.supabase.co`). Sem ela o build falha com mensagem clara.
4. Faça o deploy. **Etapa posterior (depende da URL final):** cadastre a URL do site como `SITE_ORIGIN` no Supabase (sem `/` no fim) e rode `scripts/smoke.mjs`.
5. Nunca cadastre na Netlify `MP_ACCESS_TOKEN`, `MP_WEBHOOK_SECRET`, `ROUTER_SHARED_KEY` nem a chave `service_role`. O portal não usa nenhuma; o build só recebe o Reference ID, que é público.

Publicação manual (sem GitHub): `SUPABASE_PROJECT_REF=<id> node scripts/prepare-site.mjs` e arraste a pasta `dist-site/` em *Add new site → Deploy manually*.

Cabeçalhos de segurança e CSP vêm de `site/_headers` (copiado para `dist-site/`). Não há redirecionamentos: o portal é uma página única que recebe `?mac=...`.

## Portal cativo (celulares)

O sistema operacional abre uma janela restrita para o portal. Limitações reais, **não testadas em celulares**:

- O app do banco costuma **não abrir** de dentro da janela do portal cativo, e o Wi-Fi sem internet pode impedir o app de funcionar. Por isso o portal orienta: copiar o código, pagar com dados móveis ou em outro aparelho, voltar e aguardar.
- Ao liberar a internet, iOS e Android costumam fechar o portal sozinhos; o botão "Abrir a internet" e a instrução de religar o Wi-Fi cobrem os casos em que não fecham.
- Para o portal abrir, o Walled Garden não pode liberar domínios de teste de conectividade; para o portal funcionar, **precisa** liberar só o Netlify e o Supabase do projeto (veja [mikrotik.md](mikrotik.md)).
- Fallback pelo navegador: se a janela automática não abrir, o passageiro acessa qualquer site HTTP (por exemplo, `neverssl.com`) e cai no portal.
