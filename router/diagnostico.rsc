# =============================================================================
# diagnostico.rsc — SOMENTE LEITURA. Não altera nenhuma configuração.
# Rode ANTES de instalar o wifi-poll, colando no terminal do WinBox ou com
#   /import file-name=diagnostico.rsc
# Troque SEU-PROJETO pela URL do seu projeto Supabase e mande o resultado
# (sem senhas) para conferir. Nenhum segredo é enviado: o endereço "?ping"
# é público e só responde "pong".
# =============================================================================
:put "=== Equipamento ==="
:put ("versao: " . [/system resource get version])
:put ("placa: " . [/system resource get board-name] . " / " . [/system resource get architecture-name])
:put ("RAM livre: " . [/system resource get free-memory] . " de " . [/system resource get total-memory])
:put ("disco livre: " . [/system resource get free-hdd-space] . " de " . [/system resource get total-hdd-space])
:put ("CPU agora: " . [/system resource get cpu-load] . "%")
:put ("relogio: " . [/system clock get date] . " " . [/system clock get time] . " (precisa estar CERTO para validar HTTPS)")
:put ("certificados no roteador: " . [:len [/certificate find]])

:put "=== Recursos da linguagem (esperado entre parenteses) ==="
:do { :put ("totime 5h0m0s -> " . [:totime "5h0m0s"] . " (05:00:00)") } on-error={ :put "FALHOU: :totime com texto" }
:do { :put ("soma de tempos -> " . ([:totime "1h"] + [:totime "5h0m0s"]) . " (06:00:00)") } on-error={ :put "FALHOU: soma de tempo" }
:do { :put ("find ausente -> " . [:typeof [:find "abc" "x"]] . " (nil)") } on-error={ :put "FALHOU: :find" }
:do { :put ("find com inicio -> " . [:find "a\nb\nc" "\n" 2] . " (3)") } on-error={ :put "FALHOU: :find com posicao inicial" }
:do { :put ("pick -> " . [:pick "ABCDEFG" 2 4] . " (CD)") } on-error={ :put "FALHOU: :pick" }
:do { :put ("modulo -> " . (31 % 30) . " (1)") } on-error={ :put "FALHOU: %" }
:global diagTest "ok"
:put ("variavel global -> " . $diagTest . " (ok)")

:put "=== Hotspot existente (nao sera alterado) ==="
:do { :put ("servidores hotspot: " . [:len [/ip hotspot find]]) } on-error={ :put "sem hotspot?" }
:do { :foreach p in=[/ip hotspot profile find] do={ :put ("server profile " . [/ip hotspot profile get $p name] . " login-by=" . [/ip hotspot profile get $p login-by]) } } on-error={ :put "nao li os server profiles" }
:do { :foreach p in=[/ip hotspot user profile find] do={ :put ("user profile " . [/ip hotspot user profile get $p name] . " rate-limit=" . [/ip hotspot user profile get $p rate-limit]) } } on-error={ :put "nao li os user profiles" }

:put "=== Conectividade HTTPS (use a URL do SEU projeto) ==="
:local ping "https://SEU-PROJETO.supabase.co/functions/v1/router-sync?ping=1"
# 1) Só o aperto de mão TLS, sem validar certificado (apenas diagnóstico; sem segredos).
:do {
    :local r [/tool fetch url=$ping mode=https check-certificate=no output=user as-value]
    :put ("TLS sem validar -> OK, resposta: " . ($r->"data"))
} on-error={ :put "TLS sem validar -> FALHOU (o roteador nao negocia TLS com o Supabase: veja o guia, secao alternativas)" }
# 2) Validando a cadeia de certificados (e o que o wifi-poll faz).
:foreach m in={"yes-without-crl";"yes"} do={
    :do {
        :local r [/tool fetch url=$ping mode=https check-certificate=$m output=user as-value]
        :put ("check-certificate=" . $m . " -> OK, resposta: " . ($r->"data"))
    } on-error={ :put ("check-certificate=" . $m . " -> FALHOU (CA nao importada, relogio errado ou valor nao suportado)") }
}
:put "=== fim ==="
