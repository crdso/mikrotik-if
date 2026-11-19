# Portal (Netlify)

O portal é **estático** (`site/`): `index.html`, `app.js`, `style.css`, `config.js` e `_headers`. Sem cadastro, sem senha de Wi-Fi, sem dependências externas.

## Recursos

- Oferta clara (**R$ 5 = 5 horas**), Pix (QR Code e **Copia e Cola**), contagem regressiva, estados de aguardando, aprovado/liberando, liberado, expirado e erro.
- **Recuperação do pedido** ao reabrir o navegador (armazenamento local + reaproveitamento do Pix pendente do mesmo aparelho).
- **Pagamento por outro caminho:** o passageiro copia o código e paga em outro aparelho ou com dados móveis; o pedido continua associado ao MAC original (o MAC vem do roteador, não do que o passageiro digita) e a liberação ocorre no aparelho certo.
- Sem confiar no navegador: a tela "liberada" depende do estado `internet_ready` vindo do servidor (ACK do roteador).
- Acessível e para telas pequenas (testado em 320 e 360 px): alvos de toque ≥ 48 px, sem rolagem horizontal, `prefers-reduced-motion`.
- Cabeçalhos de segurança e CSP (`_headers`): `default-src 'none'`, `script-src 'self'`, `connect-src` apenas o seu projeto Supabase.

## Publicação

```sh
node scripts/prepare-site.mjs SEU_REFERENCE_ID     # gera dist-site/ (troca o projeto no config.js e na CSP)
```

Netlify → *Add new site → Deploy manually* → arraste a pasta **`dist-site/`** inteira. Depois cadastre `SITE_ORIGIN` no Supabase com a URL final (sem `/` no fim) e rode `scripts/smoke.mjs`.

## Portal cativo (celulares)

O sistema operacional abre uma janela restrita para o portal. Limitações reais, **não testadas em celulares**:

- O app do banco costuma **não abrir** de dentro da janela do portal cativo, e o Wi-Fi sem internet pode impedir o app de funcionar. Por isso o portal orienta: copiar o código, pagar com dados móveis ou em outro aparelho, voltar e aguardar.
- Ao liberar a internet, iOS e Android costumam fechar o portal sozinhos; o botão "Abrir a internet" e a instrução de religar o Wi-Fi cobrem os casos em que não fecham.
- Para o portal abrir, o Walled Garden não pode liberar domínios de teste de conectividade; para o portal funcionar, **precisa** liberar só o Netlify e o Supabase do projeto (veja [mikrotik.md](mikrotik.md)).
- Fallback pelo navegador: se a janela automática não abrir, o passageiro acessa qualquer site HTTP (por exemplo, `neverssl.com`) e cai no portal.
