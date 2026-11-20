-- Excluir aparelho (revisão 15). O botão "Excluir" do painel Ao vivo passa a REMOVER o aparelho de verdade.
-- Antes: só apagava o direito; cadastro, presença e pedidos faziam a linha voltar (hotspot_people junta essas tabelas).
-- Agora: apaga cadastro, histórico de cadastro, direito, bloqueio, cortesias, comandos pendentes e estado legado do MAC;
-- o roteador desativa o usuário e derruba a sessão (comando R); fica um MARCO de exclusão (hotspot_device_resets).
--  * Pedidos/pagamentos NÃO são apagados (obrigação financeira; aba Pagamentos). Os anteriores ao marco não voltam à
--    ficha, não contam como crédito e, se forem pagos depois, NÃO liberam acesso (auditoria paid_not_granted).
--  * Aparelho ainda conectado fica OCULTO (o MAC só é usado pela segurança do portal). Reaparece como NOVO quando se
--    cadastra de novo no portal ou quando o roteador deixa de vê-lo por mais de 2 min e ele volta.
create table if not exists public.hotspot_device_resets (
  device_mac text primary key check (device_mac ~ '^([0-9A-F]{2}:){5}[0-9A-F]{2}$'),
  reset_at timestamptz not null default now(),
  reset_by text,
  hidden boolean not null default true
);
alter table public.hotspot_device_resets enable row level security;
revoke all privileges on table public.hotspot_device_resets from public, anon, authenticated;

create or replace function public.hotspot_admin_device_reset(p_actor uuid, p_actor_email text, p_mac text)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_mac text := upper(btrim(coalesce(p_mac, '')));
  v_by text := coalesce(nullif(p_actor_email, ''), 'admin');
  v_a public.hotspot_access%rowtype;
  v_pending integer;
  v_paid integer;
begin
  if not exists (select 1 from public.admin_users where user_id = p_actor and role = 'admin') then
    raise exception 'forbidden';
  end if;
  if v_mac !~ '^([0-9A-F]{2}:){5}[0-9A-F]{2}$' then raise exception 'mac invalido'; end if;
  perform pg_advisory_xact_lock(hashtext('hotspot_access:' || v_mac));
  select * into v_a from public.hotspot_access where device_mac = v_mac;
  -- Pix ainda pendente: encerra aqui (se for pago mesmo assim, fica registrado e NÃO libera acesso)
  update public.hotspot_orders set payment_status = 'expired', updated_at = now()
   where device_mac = v_mac and payment_status = 'pending';
  get diagnostics v_pending = row_count;
  select count(*) into v_paid from public.hotspot_orders where device_mac = v_mac and payment_status in ('paid', 'refunded');
  delete from public.hotspot_router_commands where device_mac = v_mac and (kind = 'trial' or status in ('queued', 'sent'));
  delete from public.hotspot_access where device_mac = v_mac;
  delete from public.hotspot_blocks where device_mac = v_mac;
  delete from public.hotspot_passengers where device_mac = v_mac;
  delete from public.hotspot_passenger_history where device_mac = v_mac;
  delete from public.hotspot_device_credit where device_mac = v_mac;
  delete from public.hotspot_device_state where device_mac = v_mac;
  update public.hotspot_orders set payer_name = null, payer_email = null
   where device_mac = v_mac and (payer_name is not null or payer_email is not null);
  insert into public.hotspot_device_resets (device_mac, reset_at, reset_by, hidden) values (v_mac, now(), left(v_by, 120), true)
  on conflict (device_mac) do update set reset_at = now(), reset_by = excluded.reset_by, hidden = true;
  perform public.hotspot_queue_command(v_mac, 'revoke', v_by);   -- roteador: desativa usuário, derruba sessão e cookie
  insert into public.admin_audit_log (actor, actor_email, action, entity, entity_id, before_data, after_data)
  values (p_actor, p_actor_email, 'device_delete', 'device', v_mac,
          case when v_a.device_mac is not null then jsonb_build_object('state', v_a.state, 'source', v_a.source) end,
          jsonb_build_object('pix_pendentes_encerrados', v_pending, 'pedidos_financeiros_preservados', v_paid));
  return jsonb_build_object('result', 'deleted', 'pix_pending_closed', v_pending, 'payments_kept', v_paid);
end
$$;

create or replace function public.hotspot_people()
returns table (
  mac text, ip text, full_name text, email text, identified boolean, registered_at timestamptz,
  online boolean, host_authorized boolean, last_contact timestamptz,
  paid_count integer, total_paid_cents bigint, pix_pending boolean, pix_paid boolean,
  access_state text, access_source text, access_granted_at timestamptz, access_granted_by text,
  authenticated_at timestamptz, revoked_at timestamptz, blocked boolean, blocked_at timestamptz,
  cmd_kind text, cmd_status text, cmd_result text, cmd_at timestamptz,
  legacy_credit text, status text
)
language sql
stable
set search_path = public, pg_temp
as $$
  with cfg as (
    select public.hotspot_setting('presence_seconds', '90')::integer as pres
  ), macs as (
    select device_mac from public.hotspot_known_hosts
    union select device_mac from public.hotspot_passengers
    union select o.device_mac from public.hotspot_orders o
     where not exists (select 1 from public.hotspot_device_resets r where r.device_mac = o.device_mac and o.created_at <= r.reset_at)
    union select device_mac from public.hotspot_access
    union select device_mac from public.hotspot_blocks
  ), ord as (
    select o.device_mac,
           (count(*) filter (where o.payment_status = 'paid' and not o.is_test))::integer as pc,
           coalesce(sum(o.amount_cents) filter (where o.payment_status = 'paid' and not o.is_test), 0)::bigint as tp,
           coalesce(bool_or(o.payment_status = 'pending' and (o.expires_at is null or o.expires_at > now())), false) as pp,
           coalesce(bool_or(o.payment_status = 'paid' and o.unlimited), false) as pu,
           coalesce(bool_or(not o.unlimited and o.payment_status in ('paid', 'refunded') and o.provisioned_at is not null), false) as legacy
      from public.hotspot_orders o
     where not exists (select 1 from public.hotspot_device_resets r      -- pedidos anteriores à exclusão não voltam à ficha
                        where r.device_mac = o.device_mac and o.created_at <= r.reset_at)
     group by o.device_mac
  ), cmd as (
    select distinct on (c.device_mac) c.device_mac, c.kind, c.status, c.result, coalesce(c.done_at, c.sent_at, c.created_at) as at
      from public.hotspot_router_commands c
     where c.status <> 'superseded'
     order by c.device_mac, c.created_at desc
  ), x as (
    select m.device_mac as mac, p.full_name, p.email, (p.device_mac is not null) as identified, p.registered_at,
           coalesce(o.pc, 0) as pc, coalesce(o.tp, 0) as tp, coalesce(o.pp, false) as pp, coalesce(o.pu, false) as pu,
           coalesce(k.seen_at > now() - make_interval(secs => cfg.pres), false) as fresh,
           coalesce(k.authorized, false) as kauth, k.seen_at, k.ip,
           a.state as ast, a.source as asrc, a.granted_at, a.granted_by, a.authenticated_at, a.revoked_at,
           (b.device_mac is not null) as blk, b.blocked_at,
           c.kind as ckind, c.status as cstat, c.result as cres, c.at as cat,
           case when coalesce(o.legacy, false) then public.hotspot_device_credit_state(m.device_mac) end as legacy
      from macs m cross join cfg
      left join public.hotspot_passengers p on p.device_mac = m.device_mac
      left join public.hotspot_known_hosts k on k.device_mac = m.device_mac
      left join public.hotspot_access a on a.device_mac = m.device_mac
      left join public.hotspot_blocks b on b.device_mac = m.device_mac
      left join cmd c on c.device_mac = m.device_mac
      left join ord o on o.device_mac = m.device_mac
  )
  , y as (
    -- sessão confirmada: o feed de presença diz "autenticado" OU o ACK "auth" do roteador é mais novo que o último feed
    select x.*, coalesce(x.fresh and (x.kauth or (x.cres = 'auth' and x.cstat = 'applied' and x.cat >= x.seen_at)), false) as authed
      from x
  )
  select x.mac, x.ip, x.full_name, x.email, x.identified, x.registered_at,
         x.fresh, x.authed, x.seen_at,
         x.pc, x.tp, x.pp, x.pu,
         x.ast, x.asrc, x.granted_at, x.granted_by, x.authenticated_at, x.revoked_at, x.blk, x.blocked_at,
         x.ckind, x.cstat, x.cres, x.cat, x.legacy,
         case
           when x.blk then 'blocked'
           when x.ast = 'active' and x.ckind in ('grant', 'reauth') and x.cstat = 'failed' then 'auth_error'
           when x.ast = 'active' and x.ckind in ('grant', 'reauth') and x.cstat in ('queued', 'sent') then 'provisioning'
           when x.ast = 'active' and x.authed then 'internet_active'
           when x.ast = 'active' and x.fresh and x.ckind in ('grant', 'reauth') and x.cat > now() - interval '60 seconds'
             then 'provisioning' -- carência: o roteador acabou de aplicar e ainda está autenticando
           when x.ast = 'active' and x.fresh then 'authorized_not_authenticated'
           when x.ast = 'active' then 'authorized_offline'
           when x.ast = 'revoked' then 'revoked'
           when x.pp then 'pix_pending'
           when x.legacy = 'active' then 'legacy_active'
           when x.legacy = 'exhausted' then 'legacy_exhausted'
           when x.identified then 'waiting'
           else 'not_identified'
         end
    from y as x
   where not exists (select 1 from public.hotspot_device_resets r where r.device_mac = x.mac and r.hidden);
$$;

create or replace function public.hotspot_router_report_hosts(p_macs text)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_ent text;
  v_parts text[];
  v_mac text;
  v_ipraw text;
  v_ip text;
  v_auth boolean;
  v_ok integer := 0;
  v_prefix text := public.hotspot_setting('lan_prefix', '192.168.88.');
begin
  if p_macs is null or char_length(p_macs) > 4000 then
    return jsonb_build_object('accepted', 0);
  end if;
  for v_ent in
    select distinct upper(translate(btrim(x), '-', ':')) from unnest(string_to_array(p_macs, ';')) as x
     where length(btrim(x)) > 0 limit 150
  loop
    v_parts := string_to_array(v_ent, '|');
    v_mac := upper(translate(btrim(v_parts[1]), '-', ':'));
    if v_mac !~ '^([0-9A-F]{2}:){5}[0-9A-F]{2}$' then continue; end if;
    v_ipraw := nullif(btrim(coalesce(v_parts[2], '')), '');
    v_ip := null;
    if v_ipraw ~ '^[0-9]{1,3}$' then
      if v_ipraw::integer <= 255 and v_prefix ~ '^[0-9]{1,3}([.][0-9]{1,3}){2}[.]$' then v_ip := v_prefix || v_ipraw::integer; end if;
    elsif v_ipraw ~ '^[0-9]{1,3}([.][0-9]{1,3}){3}$' then
      if not exists (select 1 from unnest(string_to_array(v_ipraw, '.')) o where o::integer > 255) then v_ip := v_ipraw; end if;
    end if;
    v_auth := lower(coalesce(v_parts[3], '')) = 'a';
    -- Aparelho EXCLUÍDO e oculto: volta como aparelho novo só se o roteador deixou de vê-lo por mais de 2 min (nova
    -- conexão comprovada pelo próprio feed). Enquanto continua conectado, segue oculto.
    update public.hotspot_device_resets r set hidden = false
     where r.device_mac = v_mac and r.hidden
       and coalesce((select k.seen_at from public.hotspot_known_hosts k where k.device_mac = v_mac), '-infinity') < now() - interval '120 seconds';
    insert into public.hotspot_known_hosts as k (device_mac, seen_at, ip, authorized)
    values (v_mac, now(), v_ip, v_auth)
    on conflict (device_mac) do update
       set seen_at = now(), ip = coalesce(excluded.ip, k.ip), authorized = excluded.authorized;
    update public.hotspot_passengers set last_activity_at = now()
     where device_mac = v_mac and last_activity_at < now() - interval '60 seconds';
    if v_auth then
      update public.hotspot_access set authenticated_at = now(), updated_at = now()
       where device_mac = v_mac and state = 'active' and authenticated_at is null;
    end if;
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

create or replace function public.hotspot_register_passenger(p_mac text, p_name text, p_email text)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_mac text := upper(btrim(coalesce(p_mac, '')));
  v_name text := regexp_replace(btrim(coalesce(p_name, '')), '[[:space:]]+', ' ', 'g');
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_old public.hotspot_passengers%rowtype;
  v_had boolean;
  v_n integer;
begin
  if v_mac !~ '^([0-9A-F]{2}:){5}[0-9A-F]{2}$' then
    return jsonb_build_object('action', 'invalid_mac');
  end if;
  if char_length(v_name) < 3 or char_length(v_name) > 80 or v_name ~ '[[:cntrl:]<>]' or position(' ' in v_name) = 0 then
    return jsonb_build_object('action', 'invalid_name');
  end if;
  if char_length(v_email) < 6 or char_length(v_email) > 254
     or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' then
    return jsonb_build_object('action', 'invalid_email');
  end if;
  if public.hotspot_device_gate(v_mac) = 'unknown' then
    return jsonb_build_object('action', 'unknown_device');
  end if;

  perform pg_advisory_xact_lock(hashtext('hotspot_passenger:' || v_mac));
  select * into v_old from public.hotspot_passengers where device_mac = v_mac;
  v_had := found;

  if v_had then
    if v_old.full_name = v_name and v_old.email = v_email then
      return jsonb_build_object('action', 'unchanged'); -- repetir os mesmos dados não grava nada nem conta no limite
    end if;
    if v_old.reg_hit_window < now() - interval '10 minutes' then
      update public.hotspot_passengers set reg_hits = 1, reg_hit_window = now() where device_mac = v_mac;
    elsif v_old.reg_hits >= 20 then
      return jsonb_build_object('action', 'rate_limited');
    else
      update public.hotspot_passengers set reg_hits = reg_hits + 1 where device_mac = v_mac;
    end if;
  end if;

  select count(*) into v_n from public.hotspot_passenger_history where changed_at > now() - interval '10 minutes';
  if v_n >= 300 then
    return jsonb_build_object('action', 'rate_limited');
  end if;

  if v_had then
    update public.hotspot_passengers
       set full_name = v_name, email = v_email, updated_at = now(), last_activity_at = now()
     where device_mac = v_mac;
  else
    insert into public.hotspot_passengers (device_mac, full_name, email, reg_hits)
    values (v_mac, v_name, v_email, 1);
  end if;
  insert into public.hotspot_passenger_history (device_mac, full_name, email) values (v_mac, v_name, v_email);
  -- Novo cadastro depois de uma exclusão: o aparelho volta à lista como NOVO (ficha anterior não é recuperada).
  update public.hotspot_device_resets set hidden = false where device_mac = v_mac and hidden;
  delete from public.hotspot_passenger_history
   where device_mac = v_mac
     and id not in (select h.id from public.hotspot_passenger_history h where h.device_mac = v_mac
                     order by h.changed_at desc, h.id desc
                     limit greatest(1, public.hotspot_setting('passenger_history_keep', '5')::integer));
  return jsonb_build_object('action', case when v_had then 'updated' else 'created' end);
end
$$;

create or replace function public.hotspot_orders_access_trigger()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_a public.hotspot_access%rowtype;
begin
  if not (new.unlimited or new.wall_clock) then return null; end if;
  perform pg_advisory_xact_lock(hashtext('hotspot_access:' || new.device_mac));
  if new.payment_status = 'paid' and old.payment_status is distinct from 'paid' then
    -- Pedido criado ANTES de o organizador excluir o aparelho: pagamento registrado, acesso NÃO concedido.
    if exists (select 1 from public.hotspot_device_resets r where r.device_mac = new.device_mac and new.created_at <= r.reset_at) then
      insert into public.admin_audit_log (actor, actor_email, action, entity, entity_id, before_data, after_data)
      values (null, 'sistema', 'paid_not_granted', 'order', new.id::text, null,
              jsonb_build_object('mac', new.device_mac, 'motivo', 'aparelho excluido pelo organizador antes do pagamento'));
      return null;
    end if;
    select * into v_a from public.hotspot_access where device_mac = new.device_mac;
    -- Bloqueado: o direito é registrado mas nada vai ao roteador até desbloquear (hotspot_access_grant cuida disso).
    if (v_a.state = 'revoked' and v_a.revoke_reason is distinct from 'Tempo do plano acabou'
           and v_a.revoke_reason is distinct from 'Pagamento estornado') then
      insert into public.admin_audit_log (actor, actor_email, action, entity, entity_id, before_data, after_data)
      values (null, 'sistema', 'paid_not_granted', 'order', new.id::text, null,
              jsonb_build_object('mac', new.device_mac, 'motivo', 'aparelho bloqueado ou revogado pelo organizador'));
      return null;
    end if;
    perform public.hotspot_access_grant(new.device_mac, 'pix', new.id, 'mercado_pago', null);
    perform public.hotspot_access_recompute(new.device_mac);
    if not exists (select 1 from public.hotspot_router_commands where device_mac = new.device_mac
                    and kind in ('grant', 'reauth') and status in ('queued', 'sent'))
       and exists (select 1 from public.hotspot_router_commands where device_mac = new.device_mac
                    and kind in ('grant', 'reauth') and status = 'applied') then
      update public.hotspot_orders set provisioned_at = now(), updated_at = now() where id = new.id and provisioned_at is null;
    end if;
  elsif new.payment_status = 'refunded' and old.payment_status = 'paid' then
    perform public.hotspot_access_recompute(new.device_mac);
  end if;
  return null;
end
$$;

-- Fluxo antigo de horas: pedido anterior à exclusão nunca recria crédito no roteador.
create or replace function public.hotspot_router_pull(p_limit integer default 30)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_orders jsonb;
begin
  insert into public.hotspot_router_state (id, last_seen_at) values (1, now())
  on conflict (id) do update set last_seen_at = excluded.last_seen_at;
  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'mac', t.device_mac, 'grant_seconds', t.grant_seconds)
                            order by t.created_at), '[]'::jsonb)
    into v_orders
    from (select id, device_mac, grant_seconds, created_at from public.hotspot_orders
           where payment_status = 'paid' and provisioned_at is null and not unlimited and not wall_clock
             and not exists (select 1 from public.hotspot_device_resets r where r.device_mac = hotspot_orders.device_mac
                              and hotspot_orders.created_at <= r.reset_at)  -- crédito antigo de aparelho excluído não volta
           order by created_at asc limit greatest(1, least(coalesce(p_limit, 30), 100))) t;
  return jsonb_build_object('orders', v_orders);
end
$$;

do $$
declare
  f text;
begin
  foreach f in array array['hotspot_admin_device_reset(uuid,text,text)', 'hotspot_people()',
    'hotspot_router_report_hosts(text)', 'hotspot_register_passenger(text,text,text)', 'hotspot_orders_access_trigger()', 'hotspot_router_pull(integer)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end
$$;
