-- Cortesia de 2 minutos para pagar o Pix (revisão 11). ADITIVA.
-- Ao gerar (ou reabrir) um Pix, o aparelho ganha 2 minutos de internet para abrir o app do banco e pagar. O MikroTik
-- cria um usuário com limit-uptime de 2 minutos (comando "T"); o próprio Hotspot corta depois disso. Se o Pix for pago,
-- o comando "G" de sempre troca o usuário para acesso ilimitado. No máximo 1 cortesia por aparelho a cada 60 minutos.
alter table public.hotspot_router_commands drop constraint if exists hotspot_router_commands_kind_check;
alter table public.hotspot_router_commands add constraint hotspot_router_commands_kind_check
  check (kind in ('grant', 'revoke', 'kick', 'reauth', 'trial'));

insert into public.hotspot_settings (key, value) values ('trial_every_minutes', '60')
on conflict (key) do nothing;

create or replace function public.hotspot_trial_grant(p_mac text)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_mac text := upper(btrim(coalesce(p_mac, '')));
  v_every integer := public.hotspot_setting('trial_every_minutes', '60')::integer;
begin
  if v_mac !~ '^([0-9A-F]{2}:){5}[0-9A-F]{2}$' then return jsonb_build_object('result', 'invalid_mac'); end if;
  if exists (select 1 from public.hotspot_blocks where device_mac = v_mac)
     or exists (select 1 from public.hotspot_access where device_mac = v_mac) then
    return jsonb_build_object('result', 'not_eligible');
  end if;
  if not exists (select 1 from public.hotspot_orders where device_mac = v_mac and payment_status = 'pending' and unlimited) then
    return jsonb_build_object('result', 'no_pending_pix');
  end if;
  perform pg_advisory_xact_lock(hashtext('hotspot_trial:' || v_mac));
  if exists (select 1 from public.hotspot_router_commands where device_mac = v_mac and kind = 'trial'
              and created_at > now() - make_interval(mins => v_every)) then
    return jsonb_build_object('result', 'already');
  end if;
  perform public.hotspot_queue_command(v_mac, 'trial', 'cortesia_pix');
  return jsonb_build_object('result', 'queued');
end
$$;


-- Liberar, reautenticar ou revogar cancela a cortesia ainda não aplicada (o comando mais forte vence).
create or replace function public.hotspot_queue_command(p_mac text, p_kind text, p_by text)
returns uuid
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if p_kind in ('grant', 'reauth') then
    update public.hotspot_router_commands set status = 'superseded', done_at = now()
     where device_mac = p_mac and kind in ('revoke', 'trial') and status in ('queued', 'sent');
  elsif p_kind = 'revoke' then
    update public.hotspot_router_commands set status = 'superseded', done_at = now()
     where device_mac = p_mac and kind in ('grant', 'reauth', 'trial') and status in ('queued', 'sent');
  end if;
  select id into v_id from public.hotspot_router_commands
   where device_mac = p_mac and kind = p_kind and status in ('queued', 'sent');
  if found then
    return v_id;
  end if;
  insert into public.hotspot_router_commands (device_mac, kind, created_by)
  values (p_mac, p_kind, left(p_by, 120)) returning id into v_id;
  return v_id;
end
$$;

do $$
declare
  f text;
begin
  foreach f in array array['hotspot_trial_grant(text)', 'hotspot_queue_command(text,text,text)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end
$$;
