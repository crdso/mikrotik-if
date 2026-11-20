# =============================================================================
# wifi-poll — credita no Hotspot os pagamentos Pix aprovados.
# Escrito para RouterOS 6.43+ (hEX lite com 6.48.x); também roda no RouterOS 7.
# Não usa JSON, :onerror, :serialize nem :deserialize (só existem a partir do 7.13).
#
# *** NÃO TESTADO EM EQUIPAMENTO REAL. Rode router/diagnostico.rsc primeiro,
# *** depois este script À MÃO e leia o Log, antes de agendar. ***
#
# TROQUE os dois valores marcados:
#   api    -> URL da função router-sync do SEU projeto Supabase
#   secret -> o MESMO valor de ROUTER_SHARED_KEY (só letras, números, "-" e "_")
#
# Protocolo (texto simples, até 10 linhas por consulta):
#   OK
#   G AA:BB:CC:DD:EE:FF 123e4567-e89b-12d3-a456-426614174000 5h0m0s
# Cada linha "G" = um pedido PAGO: MAC, id do pedido, tempo a creditar.
#
# Segurança e idempotência:
#   * só HTTPS com certificado validado (a CA precisa estar importada; veja o guia);
#   * cada linha é validada campo a campo; nada vindo da rede é executado como código;
#   * limite de segurança por pedido (maxGrant);
#   * cada pedido aplicado é anotado no comentário do usuário ("o:<8 chars do id>"):
#     se o ACK falhar e o pedido voltar, NÃO soma de novo, só repete o ACK;
#   * o log nunca contém a chave nem dados de pagamento.
#
# Efeito por pedido: cria o usuário Hotspot (nome = MAC, limit-uptime = tempo)
# OU, se já existe, SOMA o tempo ao limit-uptime atual (acumula o que restava).
# =============================================================================
:global wifiPollBusy
:global wifiPollStart
:global wifiPollFails
:if ([:typeof $wifiPollBusy] = "nothing") do={ :set wifiPollBusy false }
:if ([:typeof $wifiPollFails] = "nothing") do={ :set wifiPollFails 0 }
:global wifiExpSent
:if ([:typeof $wifiExpSent] = "nothing") do={ :set wifiExpSent "" }

:local api "https://SEU-PROJETO.supabase.co/functions/v1/router-sync"
:local secret "COLOQUE_A_MESMA_ROUTER_SHARED_KEY"
:local tls "yes-without-crl"
:local profile "wifi-5h"
:local maxGrant 2d
:local expMargin 10s
# Pasta HTML do servidor Hotspot (/ip hotspot profile print: html-directory). Aqui ficam os avisos "hsx-<MAC>.txt".
:local hdir "hotspot"

# Evita duas execuções ao mesmo tempo; uma trava "velha" (3 min) é ignorada.
:local run true
:local now [/system resource get uptime]
:if ($wifiPollBusy = true) do={
    :if (($now - $wifiPollStart) < 3m) do={ :set run false }
}

:if ($run) do={
    :set wifiPollBusy true
    :set wifiPollStart $now

    :local ok false
    :local resp ""
    :do {
        :local r [/tool fetch url=$api mode=https http-method=get check-certificate=$tls http-header-field=("X-Router-Key: " . $secret) output=user as-value]
        :set resp ($r->"data")
        :set ok true
    } on-error={ :set ok false }

    :if ($ok) do={
        :set wifiPollFails 0
        :local len [:len $resp]
        :local pos 0
        :while ($pos < $len) do={
            :local nl [:find $resp "\n" $pos]
            :if ([:typeof $nl] = "nil") do={ :set nl $len }
            :local line [:pick $resp $pos $nl]
            :set pos ($nl + 1)

            :if (([:len $line] >= 62) && ([:len $line] <= 90) && ([:pick $line 0 2] = "G ")) do={
                :local mac [:pick $line 2 19]
                :local oid [:pick $line 20 56]
                :local valid true
                :if (([:pick $line 19 20] != " ") || ([:pick $line 56 57] != " ")) do={ :set valid false }
                :foreach p in={2;5;8;11;14} do={ :if ([:pick $mac $p ($p + 1)] != ":") do={ :set valid false } }
                :foreach p in={8;13;18;23} do={ :if ([:pick $oid $p ($p + 1)] != "-") do={ :set valid false } }
                :local dur 0s
                :do { :set dur [:totime [:pick $line 57 [:len $line]]] } on-error={ :set valid false }
                :if (($dur <= 0s) || ($dur > $maxGrant)) do={ :set valid false }

                :if ($valid) do={
                    :local tag ("o:" . [:pick $oid 0 8])
                    :do {
                        :local u [/ip hotspot user find where name=$mac]
                        :if ([:len $u] = 0) do={
                            /ip hotspot user add name=$mac password="" mac-address=$mac profile=$profile limit-uptime=$dur comment=$tag
                            :log info ("wifi-poll: credito novo " . $tag)
                        } else={
                            :local cm [/ip hotspot user get $u comment]
                            :if ([:typeof [:find $cm $tag]] = "nil") do={
                                :local cur [/ip hotspot user get $u limit-uptime]
                                :local newc ($cm . "," . $tag)
                                :if ([:len $newc] > 65) do={ :set newc [:pick $newc ([:len $newc] - 65) [:len $newc]] }
                                /ip hotspot user set $u limit-uptime=($cur + $dur) comment=$newc
                                :log info ("wifi-poll: credito somado " . $tag)
                            }
                        }
                        # Credito novo/somado: o aviso de "tempo esgotado" deste aparelho deixa de valer.
                        :do { /file remove [/file find where name=($hdir . "/hsx-" . [:pick $mac 0 2] . "-" . [:pick $mac 3 5] . "-" . [:pick $mac 6 8] . "-" . [:pick $mac 9 11] . "-" . [:pick $mac 12 14] . "-" . [:pick $mac 15 17] . ".txt")] } on-error={ }
                        /tool fetch url=$api mode=https http-method=post http-data=("order=" . $oid . "&mac=" . $mac) check-certificate=$tls http-header-field=("X-Router-Key: " . $secret . ",Content-Type: application/x-www-form-urlencoded") output=none
                    } on-error={ :log warning ("wifi-poll: falha ao aplicar/confirmar " . $tag) }
                } else={ :log warning "wifi-poll: linha invalida ignorada" }
            }
        }

        # Aparelhos com credito ESGOTADO (uptime + margem >= limit-uptime): avisa o backend para o portal
        # mostrar "Seu tempo de internet acabou". O bloqueio em si e do Hotspot (nao e alterado aqui).
        # A margem cobre o arredondamento do contador. wifiExpSent guarda quem ja foi avisado;
        # usuarios que voltam a ter credito saem da lista. Qualquer erro aqui e registrado e ignorado.
        :do {
            :local keep ""
            :local toRep ""
            :local cnt 0
            :foreach eu in=[/ip hotspot user find where comment~"o:"] do={
                :local lim [/ip hotspot user get $eu limit-uptime]
                :local nm [/ip hotspot user get $eu name]
                :if (($lim > 0s) && ([:len $nm] = 17)) do={
                    :local fp ($hdir . "/hsx-" . [:pick $nm 0 2] . "-" . [:pick $nm 3 5] . "-" . [:pick $nm 6 8] . "-" . [:pick $nm 9 11] . "-" . [:pick $nm 12 14] . "-" . [:pick $nm 15 17] . ".txt")
                    :if (([/ip hotspot user get $eu uptime] + $expMargin) >= $lim) do={
                        # Evidencia LOCAL para a pagina de login (o Hotspot nao repassa $(error) no login por MAC):
                        # arquivo servido pelo proprio Hotspot, que o login.html consulta so para o MAC do aparelho.
                        :do {
                            :local fid [/file find where name=$fp]
                            :if ([:len $fid] = 0) do={
                                /file print file=($hdir . "/hsx-" . [:pick $nm 0 2] . "-" . [:pick $nm 3 5] . "-" . [:pick $nm 6 8] . "-" . [:pick $nm 9 11] . "-" . [:pick $nm 12 14] . "-" . [:pick $nm 15 17]) where name="hsx-nenhum"
                                :delay 2s
                                :set fid [/file find where name=$fp]
                            }
                            :if ([:len $fid] > 0) do={
                                :if ([/file get $fid contents] != "EXP") do={ /file set $fid contents="EXP" }
                            }
                        } on-error={ :log warning "wifi-poll: falha ao gravar aviso de tempo esgotado" }
                        :if ([:typeof [:find $wifiExpSent $nm]] = "nil") do={
                            :if ($cnt < 10) do={ :set toRep ($toRep . $nm . ","); :set cnt ($cnt + 1) }
                        } else={ :set keep ($keep . $nm . ",") }
                    } else={
                        # Voltou a ter credito (ou o limite foi aumentado): remove o aviso.
                        :do { :local ofid [/file find where name=$fp]; :if ([:len $ofid] > 0) do={ /file remove $ofid } } on-error={ }
                    }
                }
            }
            :if ($cnt > 0) do={
                :do {
                    /tool fetch url=$api mode=https http-method=post http-data=("expired=" . $toRep) check-certificate=$tls http-header-field=("X-Router-Key: " . $secret . ",Content-Type: application/x-www-form-urlencoded") output=none
                    :set keep ($keep . $toRep)
                } on-error={ :log warning "wifi-poll: falha ao avisar creditos esgotados" }
            }
            :set wifiExpSent $keep
        } on-error={ :log warning "wifi-poll: erro ao verificar creditos esgotados" }
    } else={
        :set wifiPollFails ($wifiPollFails + 1)
        :if (($wifiPollFails = 1) || (($wifiPollFails % 30) = 0)) do={
            :log warning ("wifi-poll: sem resposta do servidor (" . $wifiPollFails . " seguidas)")
        }
    }
    :set wifiPollBusy false
}
