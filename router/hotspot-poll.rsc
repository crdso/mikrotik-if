# =============================================================================
# wifi-poll — aplica no Hotspot as liberacoes do Wifi a Bordo (Pix aprovado ou liberacao do administrador).
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
# Cada linha "G" = um pedido PAGO do modelo ANTIGO de horas: MAC, id do pedido, tempo a creditar.
#   C 123e4567-e89b-12d3-a456-426614174000 G AA:BB:CC:DD:EE:FF
# Cada linha "C" = um COMANDO (modelo novo, acesso durante toda a viagem, sem limite de tempo):
#   G = liberar (cria/reativa o usuario com limit-uptime=0, isto e, SEM limite) e tenta autenticar ja
#   R = revogar/bloquear (desativa o usuario e derruba a sessao; o backend nunca reenvia G enquanto revogado/bloqueado)
#   K = derrubar a sessao agora (temporario: com direito valido, o login por MAC volta)
#   A = reautenticar (recuperacao de aparelho preso em Hosts)
#   L = como G, para tempo corrido: "C <id> L <MAC> <segundos>" grava limit-uptime = uso atual + restante (teto local)
#   T = cortesia de 2 min para pagar o Pix (usuario "t:pix", limit-uptime 2m); falha volta como erro, nunca como "ok"
# Resultado volta por POST cmd=<id>&mac=<MAC>&r=<ok|auth|login|nohost|err>.
#
# Por que reautenticar: o Hotspot tenta o login por MAC quando o aparelho APARECE em /ip hotspot host. Se o
# usuario e criado DEPOIS (Pix aprovado com o celular ja conectado), nada dispara nova tentativa e o aparelho fica
# em Hosts sem entrar em Active. O script pede o login ("/ip hotspot active login") so para esse MAC e, se o
# RouterOS recusar o comando, remove SO a entrada daquele MAC em Hosts (ela volta sozinha no proximo pacote e o
# login por MAC e tentado de novo). Nunca mexe em quem ja esta em Active, em usuarios desativados ou em outros MACs.
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
:global wifiTelLast
:if ([:typeof $wifiTelLast] = "nothing") do={ :set wifiTelLast 0s }
:global wifiHealDone
:if ([:typeof $wifiHealDone] = "nothing") do={ :set wifiHealDone "" }
:global wifiHealAt
:if ([:typeof $wifiHealAt] = "nothing") do={ :set wifiHealAt 0s }

:local api "https://SEU-PROJETO.supabase.co/functions/v1/router-sync"
:local secret "COLOQUE_A_MESMA_ROUTER_SHARED_KEY"
:local tls "yes-without-crl"
:local profile "wifi-5h"
:local maxGrant 2d
:local expMargin 10s
# Telemetria para o painel: a cada telEvery o script envia, em blocos pequenos, uso/limite e sessao de cada aparelho.
# Nao ha uma requisicao por aparelho (ate 10 por bloco) e nada e gravado na memoria flash.
:local telEvery 60s
# Servidor Hotspot (o gerador troca pelo seu). A pasta HTML (ex.: flash/hotspot) e LIDA deste perfil a cada
# execucao (html-directory); e la que ficam os avisos "hsx-<MAC>.txt".
:local hprof "hsprof1"
# Monitor do painel: portas da Starlink (WAN) e do Access Point (LAN). Confira os nomes em /interface print.
:local wanIf "ether1"
:local lanIf "ether2"
# Reautenticacao automatica: no maximo healMax aparelhos por execucao; cada MAC no maximo 1 vez a cada healEvery.
:local healMax 3
:local healEvery 3m

# Pede o login por MAC de UM aparelho que tem usuario valido mas nao esta em Active.
# Retorna: auth (ja autenticado) | login (login pedido) | nohost (fora da rede agora) | err
:local heal do={
    :if ([:len [/ip hotspot active find where mac-address=$m]] > 0) do={ :return "auth" }
    :local hh [/ip hotspot host find where mac-address=$m]
    :if ([:len $hh] = 0) do={ :return "nohost" }
    :local hip ""
    :do { :set hip [/ip hotspot host get ($hh->0) address] } on-error={ :return "nohost" }
    :local r "login"
    :do {
        /ip hotspot active login user=$m password="" mac-address=$m ip=$hip
    } on-error={
        # Plano B: remove SO as entradas deste MAC em Hosts (voltam no proximo pacote e o login por MAC e tentado de novo)
        :foreach x in=$hh do={ :do { /ip hotspot host remove $x } on-error={ :set r "err" } }
    }
    :delay 500ms
    :if ([:len [/ip hotspot active find where mac-address=$m]] > 0) do={ :set r "auth" }
    :return $r
}

# Evita duas execuções ao mesmo tempo; uma trava "velha" (3 min) é ignorada.
:local run true
:local now [/system resource get uptime]
:if ($wifiPollBusy = true) do={
    :if (($now - $wifiPollStart) < 3m) do={ :set run false }
}

:if ($run) do={
    :set wifiPollBusy true
    :set wifiPollStart $now

    # Pasta HTML do perfil (sem valor ou com ".." os avisos locais ficam desligados; o resto do script segue normal).
    :local hdir ""
    :do { :set hdir [/ip hotspot profile get [find where name=$hprof] html-directory] } on-error={ :set hdir "" }
    :if (([:len $hdir] = 0) || ([:typeof [:find $hdir ".."]] != "nil")) do={
        :set hdir ""
        :log warning "wifi-poll: html-directory do perfil Hotspot nao encontrado; avisos de tempo esgotado desativados"
    }

    :local ok false
    :local resp ""
    :do {
        # Aparelhos presentes no Hotspot (ate 60), "AA-BB-CC-DD-EE-FF|IP|a;..." no cabecalho X-Hosts ("a" = autenticado,
        # "n" = nao). O servidor so aceita cadastro/Pix de quem o roteador ve e o painel mostra quem esta navegando.
        # Falha aqui envia sem a lista.
        :local hosts ""
        :local hc 0
        :do {
            :foreach hh in=[/ip hotspot host find] do={
                :if ($hc < 60) do={
                    :local hm [:tostr [/ip hotspot host get $hh mac-address]]
                    :if ([:len $hm] = 17) do={
                        :local hip ""
                        :do { :set hip [:tostr [/ip hotspot host get $hh address]] } on-error={ :set hip "" }
                        :local ha "n"
                        :do { :if ([/ip hotspot host get $hh authorized] = true) do={ :set ha "a" } } on-error={ :set ha "n" }
                        :set hosts ($hosts . [:pick $hm 0 2] . "-" . [:pick $hm 3 5] . "-" . [:pick $hm 6 8] . "-" . [:pick $hm 9 11] . "-" . [:pick $hm 12 14] . "-" . [:pick $hm 15 17] . "|" . $hip . "|" . $ha . ";")
                        :set hc ($hc + 1)
                    }
                }
            }
        } on-error={ :set hosts "" }
        :local hdr ("X-Router-Key: " . $secret)
        :if ([:len $hosts] > 0) do={ :set hdr ($hdr . ",X-Hosts: " . $hosts) }
        :local r [/tool fetch url=$api mode=https http-method=get check-certificate=$tls http-header-field=$hdr output=user as-value]
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
            # remove "\r" final (resposta com CRLF nao pode descartar a linha em silencio)
            :if (([:len $line] > 0) && ([:pick $line ([:len $line] - 1) [:len $line]] = "\r")) do={ :set line [:pick $line 0 ([:len $line] - 1)] }

            # ---- comando "C <id> <tipo> <MAC>" (58 caracteres) ----
            :if (([:len $line] >= 58) && ([:len $line] <= 66) && ([:pick $line 0 2] = "C ")) do={
                :local cid [:pick $line 2 38]
                :local k [:pick $line 39 40]
                :local mac [:pick $line 41 58]
                :local valid true
                :if (([:pick $line 38 39] != " ") || ([:pick $line 40 41] != " ")) do={ :set valid false }
                # MAC em MAIUSCULAS e id hexadecimal: valida o conteudo, nao so as posicoes
                :if (!($mac ~ "^([0-9A-F][0-9A-F]:){5}[0-9A-F][0-9A-F]\$")) do={ :set valid false }
                :if (!($cid ~ "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\$")) do={ :set valid false }
                :if (($k != "G") && ($k != "L") && ($k != "R") && ($k != "K") && ($k != "A") && ($k != "T")) do={ :set valid false }
                # "L": liberacao de tempo corrido com teto de USO = segundos restantes (protecao se o servidor sumir)
                :local cap 0s
                :if ($k = "L") do={
                    :if (([:len $line] < 60) || ([:pick $line 58 59] != " ")) do={ :set valid false } else={
                        :local digits [:pick $line 59 [:len $line]]
                        :for d from=0 to=([:len $digits] - 1) do={ :if ([:typeof [:find "0123456789" [:pick $digits $d ($d + 1)]]] = "nil") do={ :set valid false } }
                        :if ($valid) do={ :set cap [:totime ($digits . "s")] }
                        :if (($cap <= 0s) || ($cap > 30d)) do={ :set valid false }
                    }
                } else={ :if ([:len $line] != 58) do={ :set valid false } }
                :if ($valid) do={
                    :local res "err"
                    :do {
                        :if (($k = "G") || ($k = "L")) do={
                            :local u [/ip hotspot user find where name=$mac]
                            :local oldlim 0s
                            :if ([:len $u] = 0) do={
                                /ip hotspot user add name=$mac password="" mac-address=$mac profile=$profile limit-uptime=0s comment="v:viagem"
                                :set u [/ip hotspot user find where name=$mac]
                            } else={
                                :set oldlim [/ip hotspot user get ($u->0) limit-uptime]
                                /ip hotspot user set $u disabled=no mac-address=$mac profile=$profile limit-uptime=0s comment="v:viagem"
                            }
                            :if ($k = "L") do={ /ip hotspot user set $u limit-uptime=([/ip hotspot user get ($u->0) uptime] + $cap) comment="v:tempo" }
                            # Sessao aberta com limite antigo (cortesia, horas ou tempo corrido anterior): o tempo da sessao e
                            # fixado no login; derruba SO este MAC para relogar ja com o limite novo (queda de ~1 s).
                            :if (($oldlim > 0s) || ($k = "L")) do={ :foreach a in=[/ip hotspot active find where mac-address=$mac] do={ /ip hotspot active remove $a } }
                            :do { /file remove [/file find where name=($hdir . "/hsx-" . [:pick $mac 0 2] . "-" . [:pick $mac 3 5] . "-" . [:pick $mac 6 8] . "-" . [:pick $mac 9 11] . "-" . [:pick $mac 12 14] . "-" . [:pick $mac 15 17] . ".txt")] } on-error={ }
                            :set wifiHealDone ($wifiHealDone . $mac . ",")
                            :set res [$heal m=$mac]
                        }
                        :if ($k = "T") do={
                            # Cortesia de 2 min para pagar o Pix: so cria/renova usuario de cortesia ("t:"); nunca mexe
                            # em usuario de viagem, de horas antigas ou desativado (revogado/bloqueado).
                            :local u [/ip hotspot user find where name=$mac]
                            :if ([:len $u] = 0) do={
                                /ip hotspot user add name=$mac password="" mac-address=$mac profile=$profile limit-uptime=2m comment="t:pix"
                                :set res [$heal m=$mac]
                            } else={
                                :if ([/ip hotspot user get ($u->0) disabled] = true) do={
                                    # So chega T para desativado por TEMPO VENCIDO (bloqueio/revogacao do organizador nunca
                                    # recebem cortesia no servidor): vira usuario de cortesia de 2 min.
                                    /ip hotspot user set ($u->0) disabled=no comment="t:pix" limit-uptime=([/ip hotspot user get ($u->0) uptime] + 2m)
                                    :foreach a in=[/ip hotspot active find where mac-address=$mac] do={ /ip hotspot active remove $a }
                                    :set res [$heal m=$mac]
                                } else={
                                    :if ([/ip hotspot user get ($u->0) comment] = "t:pix") do={
                                        /ip hotspot user set ($u->0) limit-uptime=([/ip hotspot user get ($u->0) uptime] + 2m)
                                        :foreach a in=[/ip hotspot active find where mac-address=$mac] do={ /ip hotspot active remove $a }
                                    }
                                    # usuario de viagem/horas ativo: nao mexe; informa o estado REAL da sessao
                                    :set res [$heal m=$mac]
                                }
                            }
                        }
                        :if ($k = "A") do={
                            :local u [/ip hotspot user find where name=$mac disabled=no]
                            :if ([:len $u] > 0) do={
                                :set wifiHealDone ($wifiHealDone . $mac . ",")
                                :set res [$heal m=$mac]
                            } else={ :set res "err" }
                        }
                        :if ($k = "R") do={
                            # Cada passo roda mesmo que outro falhe; qualquer falha vira "err" (o servidor reenvia).
                            :set res "ok"
                            :do { :foreach x in=[/ip hotspot user find where name=$mac or mac-address=$mac] do={ /ip hotspot user set $x disabled=yes } } on-error={ :set res "err" }
                            :do { :foreach a in=[/ip hotspot active find where mac-address=$mac] do={ /ip hotspot active remove $a } } on-error={ :set res "err" }
                            :do { :foreach c in=[/ip hotspot cookie find where mac-address=$mac] do={ /ip hotspot cookie remove $c } } on-error={ :set res "err" }
                        }
                        :if ($k = "K") do={
                            :foreach a in=[/ip hotspot active find where mac-address=$mac] do={ /ip hotspot active remove $a }
                            :set res "ok"
                        }
                    } on-error={ :set res "err" }
                    :log info ("wifi-poll: comando " . $k . " " . $res)
                    :do {
                        /tool fetch url=$api mode=https http-method=post http-data=("cmd=" . $cid . "&mac=" . $mac . "&r=" . $res) check-certificate=$tls http-header-field=("X-Router-Key: " . $secret . ",Content-Type: application/x-www-form-urlencoded") output=none
                    } on-error={ :log warning "wifi-poll: falha ao confirmar comando" }
                } else={ :log warning "wifi-poll: comando invalido ignorado" }
            }

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
                        :local trip false
                        :if ([:len $u] > 0) do={ :if ([:typeof [:find [/ip hotspot user get $u comment] "v:"]] != "nil") do={ :set trip true } }
                        :if ($trip) do={
                            # Usuario de viagem (sem limite): pedido antigo de horas NAO limita nem reativa; so confirma.
                            :log info ("wifi-poll: pedido antigo ignorado (acesso de viagem) " . $tag)
                        } else={
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
                        }
                        # Credito novo/somado: o aviso de "tempo esgotado" deste aparelho deixa de valer.
                        :do { /file remove [/file find where name=($hdir . "/hsx-" . [:pick $mac 0 2] . "-" . [:pick $mac 3 5] . "-" . [:pick $mac 6 8] . "-" . [:pick $mac 9 11] . "-" . [:pick $mac 12 14] . "-" . [:pick $mac 15 17] . ".txt")] } on-error={ }
                        /tool fetch url=$api mode=https http-method=post http-data=("order=" . $oid . "&mac=" . $mac) check-certificate=$tls http-header-field=("X-Router-Key: " . $secret . ",Content-Type: application/x-www-form-urlencoded") output=none
                    } on-error={ :log warning ("wifi-poll: falha ao aplicar/confirmar " . $tag) }
                } else={ :log warning "wifi-poll: linha invalida ignorada" }
            }
        }

        # Reautenticacao automatica: aparelho em Hosts, NAO autenticado, com usuario ATIVO do Wifi a Bordo (viagem, ou
        # horas antigas ainda com saldo). Limitado (healMax por execucao, 1 vez por MAC a cada healEvery): sem loops.
        :do {
            :if (($now - $wifiHealAt) >= $healEvery) do={ :set wifiHealAt $now; :set wifiHealDone "" }
            :local nh 0
            :foreach hh in=[/ip hotspot host find where authorized=no bypassed=no] do={
                :if ($nh < $healMax) do={
                    :local hm [:tostr [/ip hotspot host get $hh mac-address]]
                    :if (([:len $hm] = 17) && ([:typeof [:find $wifiHealDone $hm]] = "nil")) do={
                        :local u [/ip hotspot user find where name=$hm disabled=no comment~"[ov]:"]
                        :if ([:len $u] > 0) do={
                            :local lim [/ip hotspot user get ($u->0) limit-uptime]
                            :if (($lim = 0s) || ([/ip hotspot user get ($u->0) uptime] < $lim)) do={
                                :set wifiHealDone ($wifiHealDone . $hm . ",")
                                :set nh ($nh + 1)
                                :log info ("wifi-poll: reautenticacao automatica " . [$heal m=$hm])
                            }
                        }
                    }
                }
            }
        } on-error={ :log warning "wifi-poll: erro na reautenticacao automatica" }

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
                            :if (([:len $fid] = 0) && ([:len $hdir] > 0)) do={
                                /file print file=($hdir . "/hsx-" . [:pick $nm 0 2] . "-" . [:pick $nm 3 5] . "-" . [:pick $nm 6 8] . "-" . [:pick $nm 9 11] . "-" . [:pick $nm 12 14] . "-" . [:pick $nm 15 17]) where name="hsx-nenhum"
                                :delay 2s
                                :set fid [/file find where name=$fp]
                                :if ([:len $fid] = 0) do={
                                    :local alt [/file find where name~"hsx-"]
                                    :if ([:len $alt] > 0) do={ :log warning ("wifi-poll: aviso criado em outro local: " . [/file get ($alt->0) name] . " (esperado " . $fp . ")") } else={ :log warning ("wifi-poll: aviso nao criado: " . $fp) }
                                }
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

        # Telemetria (a cada telEvery): quantas sessoes autenticadas existem e, por aparelho, "MAC_IP_uso_limite_A".
        # Uso e limite vao no formato de tempo do RouterOS (o servidor entende 1h2m3s e 01:02:03). So leitura no roteador.
        :do {
            :if (($now - $wifiTelLast) >= $telEvery) do={
                :set wifiTelLast $now
                # Metricas do equipamento (somente leitura, 1 envio a cada telEvery). Erro aqui nunca afeta o resto.
                :do {
                    :local mc [/system resource get cpu-load]
                    :local mf [/system resource get free-memory]
                    :local mt [/system resource get total-memory]
                    :local mu [/system resource get uptime]
                    :local mv [/system resource get version]
                    :local mb [/system resource get board-name]
                    :local wr 0; :local wt 0; :local lr 0; :local lt 0
                    :do { :set wr [/interface get [find name=$wanIf] rx-byte]; :set wt [/interface get [find name=$wanIf] tx-byte] } on-error={ }
                    :do { :set lr [/interface get [find name=$lanIf] rx-byte]; :set lt [/interface get [find name=$lanIf] tx-byte] } on-error={ }
                    :local pl ""
                    :foreach e in=[/interface ethernet find] do={
                        :local en [/interface ethernet get $e name]
                        :local er ""
                        :local ru "0"
                        :if ([/interface get [find name=$en] running] = true) do={ :set ru "1" }
                        :if ($ru = "1") do={ :do { /interface ethernet monitor $e once do={ :set er $"rate" } } on-error={ } }
                        :set pl ($pl . $en . "/" . $ru . "/" . $er . "|")
                    }
                    :local cn 0
                    :do { :set cn [/ip firewall connection print count-only] } on-error={ }
                    :local md ("cpu:" . $mc . ",mf:" . $mf . ",mt:" . $mt . ",up:" . $mu . ",ver:" . $mv . ",brd:" . $mb . ",wi:" . $wanIf . ",li:" . $lanIf . ",wr:" . $wr . ",wt:" . $wt . ",lr:" . $lr . ",lt:" . $lt . ",h:" . [:len [/ip hotspot host find]] . ",a:" . [:len [/ip hotspot active find]] . ",cn:" . $cn . ",p:" . $pl)
                    /tool fetch url=$api mode=https http-method=post http-data=("m=" . $md) check-certificate=$tls http-header-field=("X-Router-Key: " . $secret . ",Content-Type: application/x-www-form-urlencoded") output=none
                } on-error={ :log warning "wifi-poll: falha ao enviar metricas" }
                :local online [:len [/ip hotspot active find]]
                :local batch ""
                :local nb 0
                :local sentAny false
                :foreach eu in=[/ip hotspot user find where comment~"[ov]:"] do={
                    :local nm [/ip hotspot user get $eu name]
                    :if ([:len $nm] = 17) do={
                        :local act [/ip hotspot active find where user=$nm]
                        :local ip ""
                        :local fl "0"
                        :if ([:len $act] > 0) do={ :set fl "1"; :set ip [/ip hotspot active get ($act->0) address] }
                        :set batch ($batch . $nm . "_" . $ip . "_" . [/ip hotspot user get $eu uptime] . "_" . [/ip hotspot user get $eu limit-uptime] . "_" . $fl . ",")
                        :set nb ($nb + 1)
                        :if ($nb >= 10) do={
                            /tool fetch url=$api mode=https http-method=post http-data=("online=" . $online . "&tel=" . $batch) check-certificate=$tls http-header-field=("X-Router-Key: " . $secret . ",Content-Type: application/x-www-form-urlencoded") output=none
                            :set batch ""
                            :set nb 0
                            :set sentAny true
                        }
                    }
                }
                :if (($nb > 0) || ($sentAny = false)) do={
                    /tool fetch url=$api mode=https http-method=post http-data=("online=" . $online . "&tel=" . $batch) check-certificate=$tls http-header-field=("X-Router-Key: " . $secret . ",Content-Type: application/x-www-form-urlencoded") output=none
                }
            }
        } on-error={ :log warning "wifi-poll: falha ao enviar telemetria" }
    } else={
        :set wifiPollFails ($wifiPollFails + 1)
        :if (($wifiPollFails = 1) || (($wifiPollFails % 30) = 0)) do={
            :log warning ("wifi-poll: sem resposta do servidor (" . $wifiPollFails . " seguidas)")
        }
    }
    :set wifiPollBusy false
}
