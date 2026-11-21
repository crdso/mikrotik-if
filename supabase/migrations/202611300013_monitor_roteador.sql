-- Monitor do MikroTik (revisão 16). ADITIVA e independente do fluxo financeiro.
-- O wifi-poll (a cada ~60 s, junto da telemetria já existente) envia UMA linha de métricas somente-leitura:
-- CPU, RAM, uptime, versão, contadores de bytes da WAN (Starlink) e da LAN (Link1One), estado/velocidade das portas,
-- sessões, hosts e conexões. O servidor calcula Mbps pela diferença entre duas amostras com horário conhecido e
-- DESCARTA a taxa quando houve reinício (uptime menor) ou o contador voltou (delta negativo). Retenção configurável.
create table if not exists public.hotspot_router_metrics (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  cpu smallint check (cpu between 0 and 100),
  mem_free bigint check (mem_free >= 0),
  mem_total bigint check (mem_total > 0),
  uptime_s bigint check (uptime_s >= 0),
  version text check (char_length(version) <= 40),
  board text check (char_length(board) <= 40),
  wan_if text check (char_length(wan_if) <= 20),
  lan_if text check (char_length(lan_if) <= 20),
  wan_rx bigint, wan_tx bigint, lan_rx bigint, lan_tx bigint,
  wan_rx_mbps numeric(9, 2), wan_tx_mbps numeric(9, 2), lan_rx_mbps numeric(9, 2), lan_tx_mbps numeric(9, 2),
  ports jsonb not null default '[]'::jsonb,
  hosts integer check (hosts between 0 and 5000),
  active integer check (active between 0 and 5000),
  conns integer check (conns between 0 and 1000000)
);
create index if not exists hotspot_router_metrics_at on public.hotspot_router_metrics (at desc);
alter table public.hotspot_router_metrics enable row level security;
revoke all privileges on table public.hotspot_router_metrics from public, anon, authenticated;

insert into public.hotspot_settings (key, value) values ('metrics_retention_hours', '48')
on conflict (key) do nothing;

create or replace function public.hotspot_router_report_metrics(p jsonb)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_prev public.hotspot_router_metrics%rowtype;
  v_dt numeric;
  v_keep integer := greatest(1, least(public.hotspot_setting('metrics_retention_hours', '48')::integer, 720));
  v_ok boolean;
begin
  select * into v_prev from public.hotspot_router_metrics order by at desc limit 1;
  v_dt := extract(epoch from (now() - v_prev.at));
  -- taxa só com amostra anterior válida: intervalo plausível e SEM reinício do roteador entre as duas
  v_ok := v_prev.id is not null and v_dt between 5 and 900
          and (p->>'uptime_s')::bigint >= coalesce(v_prev.uptime_s, 0);
  insert into public.hotspot_router_metrics (cpu, mem_free, mem_total, uptime_s, version, board, wan_if, lan_if,
       wan_rx, wan_tx, lan_rx, lan_tx, wan_rx_mbps, wan_tx_mbps, lan_rx_mbps, lan_tx_mbps, ports, hosts, active, conns)
  values ((p->>'cpu')::smallint, (p->>'mem_free')::bigint, (p->>'mem_total')::bigint, (p->>'uptime_s')::bigint,
       p->>'version', p->>'board', p->>'wan_if', p->>'lan_if',
       (p->>'wan_rx')::bigint, (p->>'wan_tx')::bigint, (p->>'lan_rx')::bigint, (p->>'lan_tx')::bigint,
       case when v_ok and (p->>'wan_rx')::bigint >= v_prev.wan_rx then least(round(((p->>'wan_rx')::bigint - v_prev.wan_rx) * 8 / v_dt / 1e6, 2), 9999999) end,
       case when v_ok and (p->>'wan_tx')::bigint >= v_prev.wan_tx then least(round(((p->>'wan_tx')::bigint - v_prev.wan_tx) * 8 / v_dt / 1e6, 2), 9999999) end,
       case when v_ok and (p->>'lan_rx')::bigint >= v_prev.lan_rx then least(round(((p->>'lan_rx')::bigint - v_prev.lan_rx) * 8 / v_dt / 1e6, 2), 9999999) end,
       case when v_ok and (p->>'lan_tx')::bigint >= v_prev.lan_tx then least(round(((p->>'lan_tx')::bigint - v_prev.lan_tx) * 8 / v_dt / 1e6, 2), 9999999) end,
       coalesce(p->'ports', '[]'::jsonb), (p->>'hosts')::integer, (p->>'active')::integer, (p->>'conns')::integer);
  delete from public.hotspot_router_metrics where at < now() - make_interval(hours => v_keep);
  return jsonb_build_object('ok', true, 'rate', v_ok);
end
$$;

-- Painel (admin e operador): última amostra, série curta e o que o script ANTIGO já informa (sessões, hosts, contato).
create or replace function public.hotspot_admin_router_monitor(p_minutes integer)
returns jsonb
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_min integer := greatest(5, least(coalesce(p_minutes, 60), 2880));
  v_last jsonb;
  v_series jsonb;
  v_state record;
begin
  select to_jsonb(m) into v_last from public.hotspot_router_metrics m order by at desc limit 1;
  select coalesce(jsonb_agg(jsonb_build_object('at', at, 'cpu', cpu,
           'mem_used_pct', case when mem_total > 0 then round((mem_total - mem_free) * 100.0 / mem_total, 1) end,
           'wan_rx', wan_rx_mbps, 'wan_tx', wan_tx_mbps, 'lan_rx', lan_rx_mbps, 'lan_tx', lan_tx_mbps, 'active', active)
           order by at), '[]'::jsonb)
    into v_series from public.hotspot_router_metrics where at > now() - make_interval(mins => v_min);
  select last_seen_at, last_telemetry_at, sessions_online into v_state from public.hotspot_router_state where id = 1;
  return jsonb_build_object(
    'now', now(), 'last', v_last, 'series', v_series,
    'router_seen_at', v_state.last_seen_at, 'telemetry_at', v_state.last_telemetry_at,
    'sessions_online', v_state.sessions_online,
    'hosts_fresh', (select count(*) from public.hotspot_known_hosts where seen_at > now() - interval '90 seconds'),
    'hosts_authorized', (select count(*) from public.hotspot_known_hosts where seen_at > now() - interval '90 seconds' and authorized),
    'commands_open', (select count(*) from public.hotspot_router_commands where status in ('queued', 'sent')),
    'commands_failed_1h', (select count(*) from public.hotspot_router_commands where status = 'failed' and created_at > now() - interval '1 hour'));
end
$$;

do $$
declare
  f text;
begin
  foreach f in array array['hotspot_router_report_metrics(jsonb)', 'hotspot_admin_router_monitor(integer)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end
$$;
