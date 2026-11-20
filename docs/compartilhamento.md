# Compartilhamento de internet por notebook (Hotspot Móvel / ICS)

Análise para o ambiente real: hEX lite, RouterOS 6.48.6, Hotspot `hotspot1`, perfil `plano-5h` (1M/4M, `shared-users=1`), cerca de 40 usuários. **Nada aqui é instalado automaticamente.** Não existe proteção 100% garantida contra esse uso.

## O que acontece
1. O notebook paga e o MikroTik libera o MAC dele (login por MAC).
2. O passageiro liga o Hotspot Móvel do Windows (Internet Connection Sharing, que faz **NAT**).
3. Os celulares ligados ao notebook saem para o MikroTik **com o MAC e o IP do notebook**.

## O que o MikroTik enxerga
- Só um host: o notebook. Os aparelhos atrás do NAT não aparecem no ARP, no DHCP nem na lista do Hotspot.
- `shared-users=1` limita quantas **sessões simultâneas do mesmo usuário** existem, não quantos aparelhos estão atrás de um único host. Por isso não impede esse caso.
- Se o compartilhamento fosse por ponte (bridge, sem NAT), cada celular teria o próprio MAC e cairia no portal; o problema é só o modo NAT.

## Efeitos que já limitam o abuso (sem mudar nada)
- O perfil `plano-5h` limita **o usuário**: 1M/4M é dividido entre notebook e celulares que ele ligar. Quem compartilha divide a velocidade.
- As 5 horas correm enquanto houver tráfego do notebook; todos consomem o mesmo saldo.
- Não há ganho de número de aparelhos por compra, só diluição do mesmo pacote.

## Medidas possíveis no RouterOS 6.48.6
| Medida | Como funciona | Limites |
|---|---|---|
| TTL | Aparelhos atrás do NAT chegam com TTL decrementado em 1 (Android/iOS 64 → 63; Windows 128 → 127). | Contornável (o notebook pode fixar o TTL, ou usar VPN/proxy/SOCKS, que não aparecem por TTL). Qualquer roteador/AP em modo roteador legítimo no meio também altera o TTL. |
| Limite de conexões por IP | `connection-limit` ou contagem de conexões por origem. | Notebook legítimo abre muitas conexões; risco alto de falso positivo. |
| Inspeção de pacotes | Não há como separar clientes atrás de NAT de forma confiável sem DPI. | Fora do alcance do hEX lite. |
| Perfil mais restritivo | Reduzir `rate-limit` ou usar `limit-bytes-total`. | Atinge também quem usa legitimamente. |

Conclusão prática: **TTL é o único método viável**, funciona contra o uso comum (ICS e a maioria dos celulares), mas é parcial e pode gerar falsos positivos. Não recomendo bloquear de início.

## Desempenho (hEX lite, ~40 usuários)
Regras de mangle apenas contadoras (sem ação) têm custo baixo para o tráfego esperado (limite por usuário de 4M, e o enlace é o Starlink). Um `drop` por TTL no `forward` também é barato, mas deve entrar só depois de medir.

## Teste controlado e reversível (somente medir, sem bloquear)
Execute no WinBox, com um notebook de teste **autorizado** e um segundo celular conectado ao Hotspot Móvel dele:

```
/ip firewall mangle add chain=prerouting in-interface=bridge action=passthrough ttl=equal:127 comment=wab-ttl-127
/ip firewall mangle add chain=prerouting in-interface=bridge action=passthrough ttl=equal:63 comment=wab-ttl-63
/ip firewall mangle print stats where comment~"wab-ttl"
```

Resultado esperado: com o compartilhamento ligado, os contadores de TTL 127/63 sobem; sem ele, ficam perto de zero (em uma rede com o AP em modo bridge). Remoção:

```
/ip firewall mangle remove [find where comment~"wab-ttl"]
```

## Situação no equipamento (auditoria de 20/11/2026)
- **Instalado:** duas regras de mangle **somente contadoras** (`wab-ttl-127` e `wab-ttl-63`), com `connection-state=new` e `in-interface=bridge` — contam só o 1º pacote de cada conexão nova, custo mínimo de CPU. Nada é bloqueado.
- **FastTrack desativado:** a regra padrão `fasttrack-connection` fazia o tráfego pular as filas do Hotspot e escapar do `rate-limit` do plano (1M/4M). Sem ela, quem compartilha a conexão realmente divide 1M/4M. Reverter: `/ip firewall filter set [find where action=fasttrack-connection] disabled=no`.
- **Ainda não medido:** comparar contadores com um notebook de teste autorizado compartilhando e sem compartilhar (depende de um teste físico seu). Falsos positivos ainda não observados porque não houve tráfego de passageiros.
- Para ver: `/ip firewall mangle print stats where comment~"wab-ttl"` — remover: `/ip firewall mangle remove [find where comment~"wab-ttl"]`.

## Recomendação
1. Manter como está e **medir por alguns dias** com as regras contadoras acima, para saber o tamanho real do problema.
2. Se o problema se confirmar, usar o bloqueio **só** de TTL 63/127 vindo de hosts já autenticados, com período de teste e regra de desativação rápida (`disable`), nunca direto em produção durante o uso.
3. Aceitar que há contorno possível (TTL ajustado, VPN, proxy). O objetivo é desencorajar o uso comum, não garantir impedimento total.
