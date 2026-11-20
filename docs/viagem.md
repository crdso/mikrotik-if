# Modelo da viagem: acesso ilimitado, liberação manual e Pix R$ 25

Este é o modelo **atual** do Wifi a Bordo. O modelo antigo (R$ 5 por 5 horas) continua funcionando **só para os
pedidos que já existiam**: nenhum pagamento, crédito ou histórico foi apagado ou convertido.

## Fluxo do passageiro

```text
conecta ao Wi-Fi aberto ─> portal cativo ─> nome completo + e-mail (obrigatórios)
   ─> "Aguardando liberação..."  (o cadastro já aparece no /admin, sem Pix)
        ├─ pagou R$ 20 ao organizador ─> o admin confere e clica "Liberar acesso"
        └─ não pagou ─> "Pagar R$ 25,00 com Pix" ─> Mercado Pago confirma (approved)
   ─> o backend registra o DIREITO de acesso e enfileira um comando para o MikroTik
   ─> o wifi-poll aplica (usuário sem limit-uptime) e pede o login por MAC daquele aparelho
   ─> o roteador informa "autenticado" ─> o portal mostra "Acesso liberado! Aproveite a viagem"
```

* Nome/e-mail **não liberam nada**: qualquer um pode digitar o nome de outra pessoa. A liberação dos pré-pagos é a
  conferência humana do organizador; a dos demais é o Pix aprovado.
* O estado do portal vem **do servidor** (não do navegador): fechar a janela do portal cativo para pagar no app do
  banco, reabrir o portal ou trocar de navegador não perde nada. Pedir o Pix de novo devolve **o mesmo** Pix pendente.
  Depois de liberado, o aparelho nunca recebe nova cobrança.
* Sem limite de horas e sem limite individual de velocidade (perfil de usuário do Hotspot sem `rate-limit`).

## Estados separados (painel `/admin`, aba "Ao vivo")

| Situação | Significado |
| --- | --- |
| Não identificado | O MikroTik vê o aparelho, mas ninguém preencheu nome/e-mail |
| Aguardando liberação | Cadastrado; sem Pix aprovado e sem liberação manual |
| Pix pendente | Pix gerado e ainda não pago |
| Liberando no roteador… | Direito registrado; comando na fila ou aplicado há menos de 60 s |
| Internet ativa | O MikroTik confirmou a sessão autenticada (`/ip hotspot host` com flag autorizado, ou ACK "auth") |
| Autorizado, sem sessão | **Alerta**: tem direito, está na rede, mas não autenticou (o roteador tenta reautenticar sozinho) |
| Autorizado · desconectado | Tem direito e não está na rede agora (volta sozinho ao reconectar) |
| Erro ao aplicar | O roteador não confirmou o comando após 5 tentativas → use **Reautenticar** |
| Revogado / Bloqueado | Sem internet; nenhum Pix é oferecido |

"Na rede" = visto pelo MikroTik nos últimos 90 s. A presença chega a cada ciclo do `wifi-poll` (~20 s): o painel
atualiza sozinho a cada 4 s, mas o dado físico **só é tão novo quanto o último ciclo do roteador** (o horário aparece
no topo). Cadastros e liberações aparecem no painel na próxima atualização (≤ 4 s).

## Ações do administrador (somente perfil "admin"; tudo auditado)

| Ação | Efeito |
| --- | --- |
| **Liberar acesso** | Pré-pago R$ 20 conferido: cria o direito "manual_prepaid_20" (sem Pix, sem receita no MP) e manda o comando |
| **Desconectar** | Derruba a sessão agora. **Temporário**: com direito válido o login por MAC volta |
| **Revogar** | Cancela o direito, desativa o usuário no Hotspot e derruba a sessão. Não volta por reconexão, reboot nem pedido antigo pago |
| **Bloquear** | Como revogar, e ainda impede liberação/Pix para o MAC até desbloquear. Contornável se o iPhone trocar de MAC privado |
| **Desbloquear** | Só devolve a internet se ainda havia direito ativo; senão continua aguardando (não dá internet grátis) |
| **Reautenticar** | Recuperação: reaplica o usuário e pede novo login só daquele MAC. Não cria crédito nem cobrança |
| **Transferir** | MAC privado do iPhone mudou: move o direito do MAC antigo para o novo (nunca fica nos dois) |
| **Encerrar viagem** | Digite ENCERRAR: revoga todos os direitos ativos. Pagamentos e histórico ficam guardados |

Com o roteador fora do ar o comando fica "aguardando o roteador" e é aplicado quando ele voltar, sem duplicar.

## A falha de autenticação depois do Pix (e a correção)

**Sintoma real:** Pix aprovado, usuário criado em `/ip hotspot user`, aparelho em `/ip hotspot host` sem o flag de
autorizado e **fora** de `/ip hotspot active`. Remover o host e reconectar fazia funcionar.

**Mecanismo:** o Hotspot do RouterOS tenta o login por MAC quando o aparelho **aparece** na tabela de hosts. Quando o
usuário é criado **depois** (o passageiro já estava conectado enquanto pagava), nada dispara uma nova tentativa; o
aparelho continua "visto, não autenticado" até sumir de Hosts (timeout) ou ser removido.

**Correção no `wifi-poll`:**

1. Ao aplicar uma liberação, o script chama `/ip hotspot active login user=<MAC> password="" mac-address=<MAC>
   ip=<IP do host>` **só para aquele MAC**. O usuário tem `mac-address` fixo, então ninguém consegue usar o
   login de outro aparelho.
2. Se o RouterOS recusar esse comando, o plano B remove **somente a entrada daquele MAC** em Hosts (o aparelho
   volta no próximo pacote e o login por MAC é tentado de novo). Nunca remove usuários, créditos ou outros hosts.
3. Reautenticação automática a cada ciclo para aparelhos em Hosts **não autenticados** cujo usuário está **ativo**
   (viagem, ou horas antigas com saldo): no máximo 3 por ciclo e cada MAC no máximo 1 vez a cada 3 minutos. Quem já
   está em Active, usuários desativados (revogados/bloqueados) e outros MACs nunca são tocados.
4. O resultado volta ao backend (ACK `auth`/`login`/`nohost`/`err`) e o feed de presença confirma a sessão.

## Protocolo com o RouterOS 6 (texto, largura fixa)

```text
OK
G AA:BB:CC:DD:EE:FF <uuid do pedido> 5h0m0s     <- só pedidos ANTIGOS de horas ainda não aplicados
C <uuid do comando> G AA:BB:CC:DD:EE:FF         <- comando (58 caracteres): G liberar | R revogar/bloquear |
                                                   K desconectar | A reautenticar
```

ACK: `POST cmd=<uuid>&mac=<MAC>&r=ok|auth|login|nohost|err`. Tudo autenticado pelo `X-Router-Key`; o roteador valida
cada campo e nunca executa texto vindo da rede. Comando sem ACK volta à fila após 60 s; depois de 5 envios vira
"Erro ao aplicar". Um usuário de viagem (`comment=v:viagem`) **nunca** é limitado por uma linha `G` antiga.

## iPhone e MAC privado

* Orientação no portal: Ajustes › Wi-Fi › ⓘ › Endereço Wi-Fi Privado › **Fixo** (não é obrigatório desligar).
* Se o MAC mudar, o aparelho aparece como **outro** dispositivo e **não herda** a liberação (nem pelo mesmo nome/
  e-mail). Confira a pessoa e use **Transferir** no painel.
* Se a janela do portal fechar: abrir o Safari em `http://example.com` traz o portal de volta.
* O iOS decide quando abre a janela automática; não é possível garantir 100% das vezes.

## Fim da viagem e dados pessoais

* "Encerrar viagem" revoga todos os acessos (o roteador desativa os usuários no próximo ciclo).
* Nome/e-mail são apagados pela retenção automática (padrão 30 dias) ou na hora pelo painel (Configurações);
  os pedidos pagos são mantidos, anonimizados.
