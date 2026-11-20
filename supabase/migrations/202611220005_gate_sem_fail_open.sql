-- Auditoria final: (1) o portão do Hotspot deixa de abrir para qualquer MAC quando a lista do roteador para de
-- chegar; (2) limpeza automática de pedidos inúteis. ADITIVA (só substitui funções e acrescenta configurações).
--
-- Portão ('ok' | 'unknown' | 'no_feed'):
--   * 'no_feed'  SOMENTE se o roteador nunca enviou a lista (implantação inicial / roteador antigo).
--   * lista recente (<= hosts_feed_window_seconds): vale quem foi visto nos últimos hosts_seen_window_seconds (15 min).
--   * lista antiga (roteador parou de informar): vale quem foi visto nas últimas hosts_stale_window_seconds (24 h).
--     Antes isso liberava a criação de Pix para qualquer MAC inventado (fail-open). Agora um atacante continua
--     barrado e quem já usou o Wi-Fi continua podendo comprar.

insert into public.hotspot_settings (key, value) values
  ('hosts_stale_window_seconds', '86400'),
  ('failed_orders_retention_days', '30'),
  ('pending_orders_retention_days', '7')
on conflict (key) do nothing;

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
  v_stale_win integer := public.hotspot_setting('hosts_stale_window_seconds', '86400')::integer;
  v_win integer;
begin
  begin
    v_feed := nullif(public.hotspot_setting('hosts_feed_at', ''), '')::timestamptz;
  exception when others then v_feed := null;
  end;
  if v_feed is null then
    return 'no_feed';
  end if;
  v_win := case when v_feed < now() - make_interval(secs => v_feed_win) then v_stale_win else v_seen_win end;
  if exists (select 1 from public.hotspot_known_hosts
              where device_mac = v_mac and seen_at > now() - make_interval(secs => v_win)) then
    return 'ok';
  end if;
  return 'unknown';
end
$$;

-- Limpeza diária (chamada de dentro do router-sync; no máximo uma vez por dia). Nunca apaga pedidos pagos ou
-- reembolsados (são o registro do crédito).
create or replace function public.hotspot_maintenance()
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_last timestamptz;
  v_fail integer := public.hotspot_setting('failed_orders_retention_days', '30')::integer;
  v_pend integer := public.hotspot_setting('pending_orders_retention_days', '7')::integer;
  v_a integer; v_b integer;
begin
  begin
    v_last := nullif(public.hotspot_setting('maintenance_at', ''), '')::timestamptz;
  exception when others then v_last := null;
  end;
  if v_last is not null and v_last > now() - interval '1 day' then
    return jsonb_build_object('ran', false);
  end if;
  insert into public.hotspot_settings (key, value) values ('maintenance_at', now()::text)
  on conflict (key) do update set value = excluded.value, updated_at = now();
  delete from public.hotspot_orders
   where payment_status in ('failed', 'expired') and created_at < now() - make_interval(days => greatest(v_fail, 1));
  get diagnostics v_a = row_count;
  delete from public.hotspot_orders
   where payment_status = 'pending' and created_at < now() - make_interval(days => greatest(v_pend, 1));
  get diagnostics v_b = row_count;
  delete from public.hotspot_known_hosts where seen_at < now() - interval '1 day';
  return jsonb_build_object('ran', true, 'failed_expired_deleted', v_a, 'pending_deleted', v_b);
end
$$;

do $$
declare
  f text;
begin
  foreach f in array array['hotspot_device_gate(text)', 'hotspot_maintenance()'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end
$$;
