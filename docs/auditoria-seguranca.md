# Auditoria de segurança (20/11/2026)

Registro público e **sem segredos** da auditoria do Wifi a Bordo (MikroTik, Access Point, backend e portal). Nada aqui contém chaves, senhas ou dados de passageiros.

## Topologia verificada
- MikroTik hEX lite (RB750r2), RouterOS 6.48.6, firmware de boot 3.33. WAN em `ether1`; `ether2`–`ether5` na bridge do Hotspot.
- Access Point na `ether2`, **Intelbras WRG 140 E**, interface web só em HTTP. PC de administração cabeado na `ether5`.
- Pacote `ipv6` **desativado** no MikroTik e WAN fora da bridge: sem caminho IPv6 dos passageiros para a internet pelo roteador.

## Achados e situação
| Gravidade | Achado | Situação |
|---|---|---|
| Crítico | Access Point aceita **credenciais padrão** de fábrica | **Pendente (dono)**: trocar a senha no AP |
| Alto | WinBox, SSH, Telnet, FTP, API e API-SSL do MikroTik abertos para toda a rede; passageiros autenticados alcançavam as portas administrativas (o Hotspot só filtra quem não pagou) | **Corrigido**: Telnet/FTP/API/API-SSL desligados; WinBox/SSH só do IP do PC; regra de firewall só para o MAC do PC; MAC-WinBox/MAC-Telnet/descoberta só na `ether5`; MAC-Ping desligado |
| Alto | Chave do roteador em texto puro dentro do script (aparece em `/export`, inclusive com `hide-sensitive`) e foi exposta durante a auditoria | **Pendente (dono)**: rotacionar com `ROUTER_SHARED_KEY_NEXT` (passo a passo em `docs/supabase.md`); cópia extra do script removida do roteador |
| Alto | RouterOS 6.48.6 abaixo de 6.49.18 (aviso oficial CVE-2024-54772) | **Corrigido**: atualizado para 6.49.23 (linha 6, `mipsbe`) com backup prévio; o firmware de boot (RouterBOOT 3.33) segue como está |
| Médio | Checkout aceitava qualquer MAC vindo da internet: era possível esgotar a cota global de pedidos (negação de vendas) | **Corrigido**: o roteador informa os aparelhos presentes (`X-Hosts`); com essa lista ativa, só eles geram Pix |
| Médio | FastTrack padrão fazia o tráfego escapar do limite de velocidade do plano | **Corrigido**: regra desativada (reversível) |
| Médio | Usuário `admin` do Hotspot com perfil `default` (sem limite de tempo/velocidade) | Mantido (uso do dono); recomendação: usar só quando necessário ou atribuir limite |
| Baixo | Usuário de teste `teste2min` e cookie antigos | **Corrigido**: usuário desativado e cookie removido |
| Baixo | SSID aberto (sem criptografia) e sem isolamento confirmado entre passageiros | **Pendente (dono)**: ativar isolamento de clientes no AP, se o modelo oferecer |
| Info | Lease DHCP do PC administrativo dinâmico dentro do pool | **Corrigido**: lease estático |

## Rollback (MikroTik)
- Backup binário e exportação feitos **antes** de qualquer mudança (guardados fora do repositório).
- Cada mudança é reversível com um comando (`/ip service set ... disabled=no`, `/tool mac-server set allowed-interface-list=LAN`, `/ip firewall filter remove [find where comment~"wab-sec"]`, `/ip firewall filter set [find where action=fasttrack-connection] disabled=no`).

## Limites conhecidos
- Sem fail-open silencioso (migração 202611220005): se o roteador parar de enviar a lista, o checkout passa a aceitar apenas MACs vistos nas últimas 24 h (`hosts_stale_window_seconds`); MACs inventados continuam barrados e compradores que já usaram o Wi-Fi continuam atendidos. Só antes do PRIMEIRO envio da lista (implantação inicial) o portão fica aberto (`no_feed`). Limpeza diária automática (`hotspot_maintenance`, chamada pelo router-sync) apaga pedidos falhos/expirados >30 dias e pendentes >7 dias; nunca apaga pagos/reembolsados.
- WebFig (serviço `www`, porta 80 do roteador): restrito a 192.168.88.254/32; o Hotspot já redireciona a porta 80 de quem está no bridge para o portal (regra dinâmica `hotspot=local-dst`), então o portal não depende do serviço `www`.
- Um passageiro **dentro** da rede ainda pode trocar o MAC do próprio aparelho; isso não dá internet grátis (o Hotspot exige crédito por MAC), mas pode gerar alguns pedidos extras (limite de 5 por MAC a cada 10 min).
- Compartilhamento por notebook (NAT): ver `docs/compartilhamento.md`.
