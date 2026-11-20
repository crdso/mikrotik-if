-- "Excluir" no painel Ao vivo (revisão 13): zera o estado de acesso de UM aparelho para ele voltar ao começo
-- (cadastro -> aguardando -> Pix/liberação). Remove o direito de acesso (ativo, revogado ou vencido), o histórico de
-- cortesias e os comandos pendentes; o roteador desativa o usuário (comando R). NÃO apaga pagamentos nem o bloqueio.
create or replace function public.hotspot_admin_device_reset(p_actor uuid, p_actor_email text, p_mac text)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_mac text := upper(btrim(coalesce(p_mac, '')));
  v_a public.hotspot_access%rowtype;
begin
  if not exists (select 1 from public.admin_users where user_id = p_actor and role = 'admin') then
    raise exception 'forbidden';
  end if;
  if v_mac !~ '^([0-9A-F]{2}:){5}[0-9A-F]{2}$' then raise exception 'mac invalido'; end if;
  perform pg_advisory_xact_lock(hashtext('hotspot_access:' || v_mac));
  select * into v_a from public.hotspot_access where device_mac = v_mac;
  delete from public.hotspot_router_commands where device_mac = v_mac and (kind = 'trial' or status in ('queued', 'sent'));
  delete from public.hotspot_access where device_mac = v_mac;
  perform public.hotspot_queue_command(v_mac, 'revoke', coalesce(nullif(p_actor_email, ''), 'admin'));
  insert into public.admin_audit_log (actor, actor_email, action, entity, entity_id, before_data, after_data)
  values (p_actor, p_actor_email, 'device_reset', 'device', v_mac,
          case when v_a.device_mac is not null then jsonb_build_object('state', v_a.state, 'source', v_a.source) end,
          jsonb_build_object('result', 'reset'));
  return jsonb_build_object('result', 'reset');
end
$$;

do $$
declare
  f text;
begin
  foreach f in array array['hotspot_admin_device_reset(uuid,text,text)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end
$$;
