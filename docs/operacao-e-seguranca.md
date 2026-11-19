# Operação e segurança

> Os comandos de RouterOS deste documento são **propostas para revisar** contra a sua configuração real e **não foram executados**. Antes de qualquer alteração de firewall ou serviços, abra a sessão em **Safe Mode** (botão *Safe Mode* do WinBox ou `Ctrl+X` no terminal): se a conexão cair, o RouterOS desfaz as alterações da sessão sozinho.

## 1. Painel administrativo

Passageiros e administradores compartilham a mesma rede (bridge). Hotspot não autenticado não alcança o roteador, mas **um passageiro autenticado alcança os serviços do roteador** se nada o impedir.

- Desative o que não usa: `/ip service disable telnet,ftp,www,api,api-ssl`. (O portal do Hotspot é servido pelo próprio Hotspot, não pelo serviço `www`.)
- Restrinja WinBox e SSH ao computador de administração: `/ip service set winbox,ssh address=<IP-do-admin>/32` (use IP fixo no computador de administração, senão você mesmo perde o acesso).
- Firewall (`input`): aceite do administrador e descarte administração vinda da bridge:

```routeros
/ip firewall filter add chain=input src-address=<IP-do-admin> action=accept comment="admin" place-before=0
/ip firewall filter add chain=input in-interface=bridge protocol=tcp dst-port=21,22,23,8291,8728,8729 action=drop comment="bloqueia administracao vinda dos passageiros"
```

  Não descarte a porta 80 nem as portas do Hotspot (64872-64875): o redirecionamento do portal depende delas.
- Desative descoberta e acesso por camada 2 na interface dos passageiros (`/ip neighbor discovery` e `/tool mac-server`; confira a sintaxe do seu 6.48 com `?`).
- Senha forte no usuário `admin` (ou crie outro e desative o padrão) e **no painel do Access Point**. O AP costuma estar em `192.168.88.x`: passageiros alcançam a página dele; defina senha e, se existir, desative a administração pela rede sem fio.

## 2. Isolamento dos passageiros

- **Entre passageiros:** habilite "isolamento de clientes / AP isolation" no Access Point (o nome varia por fabricante; **não verificado** nos modelos atuais). Sem isso, passageiros autenticados enxergam uns aos outros na mesma rede.
- **Para a rede principal:** o veículo não deve ter outra rede atrás do MikroTik além da dos passageiros. Se houver, bloqueie no `forward`: `chain=forward src-address=<faixa-dos-passageiros> dst-address=<rede-principal> action=drop`.
- **AP só em bridge:** DHCP e NAT desligados; nenhuma lógica de pagamento no AP. Troque de AP à vontade (TP-Link, Mercusys, Intelbras, Wi-Fi 5/6 ou Wi-Fi integrado do MikroTik): o sistema só precisa que o **MAC original do celular chegue ao MikroTik**. Modo "roteador", "repetidor" ou WDS trocam o MAC: todos dividiriam um acesso. Teste: `/ip hotspot host print` deve mostrar um MAC por celular.

## 3. Manipulação de MAC e reutilização de compras

- Uma compra credita **um** pedido a **um** MAC, uma única vez (marcador no comentário do usuário + ACK idempotente no servidor).
- O usuário Hotspot tem `mac-address=<MAC>` e `shared-users=1`: outro aparelho não usa o crédito e não há duas sessões simultâneas.
- **Limite honesto:** o MAC pode ser falsificado (quem copia o MAC de um passageiro pagante, enquanto este está offline, usa o crédito) ou ser aleatório por rede (iOS/Android "endereço privado"). Em MAC aleatório estável por SSID funciona; se o passageiro desligar/religar a opção depois de pagar, o aparelho muda de MAC e precisa de suporte. Autenticação forte por credencial individual não faz parte deste MVP.

## 4. Backup

- Antes de qualquer mudança: `/system backup save` e `/export` (veja [mikrotik.md](mikrotik.md)). Guarde **fora do repositório** e fora do roteador; contêm segredos.
- Banco: o Supabase mantém backups conforme o plano do projeto; para um dado pontual, exporte `hotspot_orders` no SQL Editor (sem e-mails: eles não são gravados).
- A ROUTER_SHARED_KEY, o token do Mercado Pago e o segredo do webhook ficam num gerenciador de senhas; nunca em arquivo versionado.

## 5. Logs sem dados sensíveis

- O `wifi-poll` registra apenas marcadores curtos de pedido (`o:1a2b3c4d`) e contagem de falhas — nunca a chave, o MAC completo de pagamento ou valores.
- As Edge Functions registram erros técnicos (status HTTP, ids de pedido/pagamento), nunca tokens, chaves ou e-mails.
- No roteador, mantenha o log em memória (padrão) e **não envie logs a serviços externos** sem filtrar; evite gravar log em disco por causa do desgaste da flash de 16 MB.

## 6. Reinicialização e falhas da Starlink

- O agendador é criado com `start-time=startup`; variáveis globais somem no reboot (a trava é recriada), usuários Hotspot e comentários **persistem** (fazem parte da configuração).
- O que **não** foi verificado: se o **tempo já consumido** (`uptime` do usuário) é preservado após reinício ou queda de energia. Teste: com um usuário de teste de 5 minutos, use 2, reinicie o roteador e confira se restam 3. Se o contador zerar, queda de energia devolve tempo aos passageiros — risco de prejuízo pequeno, mas precisa ser conhecido.
- Sem internet, o `wifi-poll` falha e tenta de novo a cada ciclo (log só na 1ª falha e a cada 30). Pagamentos aprovados ficam como "pagos, aguardando o roteador" e são creditados quando a conexão volta, sem duplicar. Quem já tem crédito continua navegando se o roteador tiver internet; o corte por tempo é local.

## 7. Procedimento de emergência: liberar quem comprovadamente pagou

Use somente depois de confirmar **no painel do Mercado Pago** um pagamento **aprovado de R$ 5,00** (anote o id do pagamento).

1. No SQL Editor: `select id, payment_status, paid_at, provisioned_at from public.hotspot_orders where device_mac = 'AA:BB:CC:DD:EE:FF' order by created_at desc;`
2. Se o pedido está `paid` e sem `provisioned_at`: o roteador está offline ou com erro — corrija a conexão ou rode `/system script run wifi-poll` e acompanhe o Log. O crédito sai sozinho.
3. Se o pedido não existe/está `pending` apesar do pagamento aprovado: aguarde ~10 s pela reconciliação ou abra o portal do passageiro; se persistir, veja os logs das funções.
4. Último recurso (roteador): crie o usuário **com o marcador do pedido**, para o script não creditar de novo se o pedido aparecer depois:

```routeros
/ip hotspot user add name=AA:BB:CC:DD:EE:FF mac-address=AA:BB:CC:DD:EE:FF profile=wifi-5h limit-uptime=5h comment="o:<8 primeiros caracteres do id do pedido>"
```

   (Se o usuário já existe, some o tempo: `/ip hotspot user set [find name=AA:BB:CC:DD:EE:FF] limit-uptime=(<atual> + 5h)`.) Registre a ocorrência.

## 8. Capacidade (hardware antigo, ~40 dispositivos)

hEX lite: 64 MB de RAM, 1 núcleo de 850 MHz, 16 MB de flash. O HTTPS (TLS) a cada consulta e as filas de limite de banda por usuário consomem CPU. O projeto reduz o custo: respostas de texto < 1 KB, no máximo 10 pedidos por consulta, intervalo configurável (20 s sugerido). **Não há garantia de desempenho sem teste real**: meça CPU/memória com a rede em uso (`/system resource print`, `/tool profile`) e ajuste o intervalo. Se a CPU ficar saturada, o primeiro passo é aumentar o intervalo; o segundo, trocar o equipamento.
