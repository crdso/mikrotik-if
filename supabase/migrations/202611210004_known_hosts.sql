-- Vínculo entre o Hotspot e a criação de pedidos (revisão 7, auditoria de segurança). ADITIVA.
--
-- Problema: o MAC chega do navegador; qualquer pessoa na internet podia chamar create-payment com MACs inventados
-- e esgotar a cota global (200 pedidos/10 min), bloqueando as vendas reais (negação de serviço barata).
-- Correção: a cada consulta (20 s) o MikroTik informa os MACs presentes em /ip hotspot host. Enquanto essa lista
-- estiver chegando ("feed" recente), só aparelhos vistos pelo roteador podem gerar Pix. Se a lista parar de chegar
-- (roteador antigo, falha), volta ao comportamento anterior para não derrubar as vendas (fail-open documentado).

create table if not exists public.hotspot_known_hosts (
  device_mac text primary key check (device_mac ~ '^([0-9A-F]{2}:){5}[0-9A-F]{2}$'),
  seen_at timestamptz not null default now()
);
alter table public.hotspot_known_hosts enable row level security;
revoke all privileges on table public.hotspot_known_hosts from public, anon, authenticated;

insert into public.hotspot_settings (key, value) values
  ('hosts_feed_window_seconds', '120'),
  ('hosts_seen_window_seconds', '900')
on conflict (key) do nothing;

-- Roteador: lista "MAC;MAC;..." (até 100). Ignora entradas inválidas. Só marca o feed como recente se houver ao
-- menos um MAC válido (lista vazia não bloqueia ninguém).
create or replace function public.hotspot_router_report_hosts(p_macs text)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_mac text;
  v_ok integer := 0;
begin
  if p_macs is null or char_length(p_macs) > 2000 then
    return jsonb_build_object('accepted', 0);
  end if;
  for v_mac in
    select distinct upper(translate(btrim(x), '-', ':')) from unnest(string_to_array(p_macs, ';')) as x
     where length(btrim(x)) > 0 limit 100
  loop
    if v_mac !~ '^([0-9A-F]{2}:){5}[0-9A-F]{2}$' then continue; end if;
    insert into public.hotspot_known_hosts (device_mac, seen_at) values (v_mac, now())
    on conflict (device_mac) do update set seen_at = now();
    v_ok := v_ok + 1;
  end loop;
  if v_ok > 0 then
    insert into public.hotspot_settings (key, value) values ('hosts_feed_at', now()::text)
    on conflict (key) do update set value = excluded.value, updated_at = now();
  end if;
  delete from public.hotspot_known_hosts where seen_at < now() - interval '1 day';
  return jsonb_build_object('accepted', v_ok);
end
$$;

-- 'ok' (aparelho visto pelo roteador), 'unknown' (feed recente e MAC ausente) ou 'no_feed' (sem lista recente).
create or replace function public.hotspot_device_gate(p_mac text)
returns text
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_mac text := upper(btrim(coalesce(p_mac, '')));
  v_feed timestamptz;
  v_feed_win integer := public.hotspot_setting('hosts_feed_window_seconds', '120')::integer;
  v_seen_win integer := public.hotspot_setting('hosts_seen_window_seconds', '900')::integer;
begin
  begin
    v_feed := nullif(public.hotspot_setting('hosts_feed_at', ''), '')::timestamptz;
  exception when others then v_feed := null;
  end;
  if v_feed is null or v_feed < now() - make_interval(secs => v_feed_win) then
    return 'no_feed';
  end if;
  if exists (select 1 from public.hotspot_known_hosts
              where device_mac = v_mac and seen_at > now() - make_interval(secs => v_seen_win)) then
    return 'ok';
  end if;
  return 'unknown';
end
$$;

-- Mesma função do checkout (revisão 6) com o portão do Hotspot antes de qualquer contagem ou escrita.
create or replace function public.hotspot_reserve_plan_order(p_mac text, p_plan_id uuid default null)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_p public.hotspot_plans%rowtype;
  v_n integer;
  v_r jsonb;
begin
  if upper(btrim(coalesce(p_mac, ''))) !~ '^([0-9A-F]{2}:){5}[0-9A-F]{2}$' then
    return jsonb_build_object('action', 'invalid_mac');
  end if;
  if public.hotspot_device_gate(p_mac) = 'unknown' then
    return jsonb_build_object('action', 'unknown_device');
  end if;
  if p_plan_id is not null then
    select * into v_p from public.hotspot_plans where id = p_plan_id for share;
  else
    select * into v_p from public.hotspot_plans where active and is_default limit 1 for share;
    if not found then
      select count(*) into v_n from public.hotspot_plans where active;
      if v_n = 1 then
        select * into v_p from public.hotspot_plans where active limit 1 for share;
      end if;
    end if;
  end if;
  if v_p.id is null or not v_p.active then
    return jsonb_build_object('action', 'plan_unavailable');
  end if;
  v_r := public.hotspot_reserve_order(p_mac, v_p.price_cents, v_p.grant_seconds, v_p.id, v_p.name);
  return v_r || jsonb_build_object('plan_name', v_p.name, 'amount_cents', v_p.price_cents, 'grant_seconds', v_p.grant_seconds);
end
$$;

-- Permissões: somente service_role (nunca anon/authenticated).
do $$
declare
  f text;
begin
  foreach f in array array[
    'hotspot_router_report_hosts(text)',
    'hotspot_device_gate(text)',
    'hotspot_reserve_plan_order(text,uuid)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end
$$;
