-- Tempo corrido e plano ilimitado editável (revisão 12). ADITIVA.
--  * Planos: "unlimited" (toda a viagem) e "wall_clock" (tempo corrido: pagou às 20:00 um plano de 4 h -> acaba à
--    00:00, usando ou não). Duração de 1 minuto a 30 dias.
--  * Pedido pago de plano ilimitado ou de tempo corrido vira DIREITO de acesso (hotspot_access) com expires_at
--    (nulo = sem fim). O servidor vence o direito no horário e manda o roteador desativar (comando R).
--  * Comprar de novo antes de vencer SOMA ao horário final; depois de vencido, o aparelho volta a poder comprar.
--  * Planos antigos de horas por USO (wall_clock = false, unlimited = false) seguem o fluxo antigo, inalterados.
alter table public.hotspot_plans add column if not exists wall_clock boolean not null default false;
alter table public.hotspot_orders add column if not exists wall_clock boolean not null default false;
alter table public.hotspot_access add column if not exists expires_at timestamptz;

alter table public.hotspot_plans drop constraint if exists hotspot_plans_grant_seconds_check;
alter table public.hotspot_plans add constraint hotspot_plans_grant_seconds_check check (grant_seconds between 60 and 2592000);
alter table public.hotspot_orders drop constraint if exists hotspot_orders_grant_range;
alter table public.hotspot_orders add constraint hotspot_orders_grant_range check (grant_seconds between 60 and 2592000);

-- O pedido copia do plano: ilimitado e tempo corrido.
create or replace function public.hotspot_order_unlimited()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.plan_id is not null then
    select coalesce(p.unlimited, false), coalesce(p.wall_clock, false) into new.unlimited, new.wall_clock
      from public.hotspot_plans p where p.id = new.plan_id;
    new.unlimited := coalesce(new.unlimited, false);
    new.wall_clock := coalesce(new.wall_clock, false);
  end if;
  return new;
end
$$;

-- Pago => direito. Ilimitado: sem fim. Tempo corrido: fim = max(fim atual, agora) + duração (soma se ainda valia).
create or replace function public.hotspot_orders_access_trigger()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_prev public.hotspot_access%rowtype;
  v_had boolean;
begin
  if (new.unlimited or new.wall_clock) and new.payment_status = 'paid' and old.payment_status is distinct from 'paid' then
    select * into v_prev from public.hotspot_access where device_mac = new.device_mac;
    v_had := found and v_prev.state = 'active';
    perform public.hotspot_access_grant(new.device_mac, 'pix', new.id, 'mercado_pago', null);
    update public.hotspot_access
       set expires_at = case
             when new.unlimited then null
             when v_had and v_prev.expires_at is null then null              -- já era ilimitado: continua
             else greatest(coalesce(case when v_had then v_prev.expires_at end, now()), now())
                  + make_interval(secs => new.grant_seconds) end,
           updated_at = now()
     where device_mac = new.device_mac and state = 'active';
  elsif (new.unlimited or new.wall_clock) and new.payment_status = 'refunded' and old.payment_status = 'paid' then
    if exists (select 1 from public.hotspot_access where device_mac = new.device_mac and state = 'active'
                and source = 'pix' and order_id = new.id) then
      perform public.hotspot_access_revoke(new.device_mac, 'mercado_pago', 'Pagamento estornado');
    end if;
  end if;
  return null;
end
$$;

-- Vence os direitos cujo horário final passou (chamado a cada consulta do roteador).
create or replace function public.hotspot_access_expire()
returns integer
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_mac text;
  v_n integer := 0;
begin
  for v_mac in select device_mac from public.hotspot_access where state = 'active' and expires_at is not null and expires_at <= now() loop
    perform public.hotspot_access_revoke(v_mac, 'tempo', 'Tempo do plano acabou');
    v_n := v_n + 1;
  end loop;
  return v_n;
end
$$;

create or replace function public.hotspot_router_commands_pull(p_limit integer default 10)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_retry integer := public.hotspot_setting('command_retry_seconds', '60')::integer;
  v_max integer := public.hotspot_setting('command_max_attempts', '5')::integer;
  v_rows jsonb;
begin
  perform public.hotspot_access_expire();
  update public.hotspot_router_commands
     set status = 'failed', done_at = now(), result = coalesce(result, 'no_ack')
   where status = 'sent' and attempts >= v_max and sent_at < now() - make_interval(secs => v_retry);
  with pick as (
    select id from public.hotspot_router_commands
     where status = 'queued' or (status = 'sent' and sent_at < now() - make_interval(secs => v_retry))
     order by created_at
     limit greatest(1, least(coalesce(p_limit, 10), 20))
     for update skip locked
  ), upd as (
    update public.hotspot_router_commands c
       set status = 'sent', sent_at = now(), attempts = c.attempts + 1
      from pick where c.id = pick.id
    returning c.id, c.device_mac, c.kind, c.created_at
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'mac', device_mac, 'kind', kind) order by created_at), '[]'::jsonb)
    into v_rows from upd;
  return jsonb_build_object('commands', v_rows);
end
$$;

-- Fluxo antigo (linhas "G <tempo>"): só pedidos de horas por USO.
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
           order by created_at asc limit greatest(1, least(coalesce(p_limit, 30), 100))) t;
  return jsonb_build_object('orders', v_orders);
end
$$;

-- Checkout: com tempo corrido ainda valendo pode comprar mais (soma); tempo vencido pode comprar de novo.
create or replace function public.hotspot_reserve_plan_order(p_mac text, p_plan_id uuid default null)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_p public.hotspot_plans%rowtype;
  v_n integer;
  v_r jsonb;
  v_mac text := upper(btrim(coalesce(p_mac, '')));
  v_a public.hotspot_access%rowtype;
begin
  if v_mac !~ '^([0-9A-F]{2}:){5}[0-9A-F]{2}$' then return jsonb_build_object('action', 'invalid_mac'); end if;
  if public.hotspot_device_gate(v_mac) = 'unknown' then return jsonb_build_object('action', 'unknown_device'); end if;
  if exists (select 1 from public.hotspot_blocks where device_mac = v_mac) then return jsonb_build_object('action', 'blocked'); end if;
  select * into v_a from public.hotspot_access where device_mac = v_mac;
  if v_a.state = 'active' and v_a.expires_at is null then
    return jsonb_build_object('action', 'already_active');
  elsif v_a.state = 'revoked' and v_a.revoke_reason is distinct from 'Tempo do plano acabou' then
    return jsonb_build_object('action', 'revoked');
  end if;
  if not exists (select 1 from public.hotspot_passengers where device_mac = v_mac)
     and not exists (select 1 from public.hotspot_orders o where o.device_mac = v_mac
                        and (o.payment_status = 'pending' or (o.payment_status = 'paid' and o.provisioned_at is null))) then
    return jsonb_build_object('action', 'registration_required');
  end if;
  if p_plan_id is not null then
    select * into v_p from public.hotspot_plans where id = p_plan_id for share;
  else
    select * into v_p from public.hotspot_plans where active and is_default limit 1 for share;
    if not found then
      select count(*) into v_n from public.hotspot_plans where active;
      if v_n = 1 then select * into v_p from public.hotspot_plans where active limit 1 for share; end if;
    end if;
  end if;
  if v_p.id is null or not v_p.active then return jsonb_build_object('action', 'plan_unavailable'); end if;
  v_r := public.hotspot_reserve_order(v_mac, v_p.price_cents, v_p.grant_seconds, v_p.id, v_p.name);
  return v_r || jsonb_build_object('plan_name', v_p.name, 'amount_cents', v_p.price_cents,
                                   'grant_seconds', v_p.grant_seconds, 'unlimited', v_p.unlimited);
end
$$;

-- Portal: tempo vencido não é "acesso encerrado pelo organizador": volta à tela de compra.
create or replace function public.hotspot_portal_state(p_mac text)
returns jsonb
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_mac text := upper(btrim(coalesce(p_mac, '')));
  v_hint jsonb;
  v_p record;
  v_access text;
  v_router timestamptz;
  v_a public.hotspot_access%rowtype;
begin
  if v_mac !~ '^([0-9A-F]{2}:){5}[0-9A-F]{2}$' or public.hotspot_device_gate(v_mac) = 'unknown' then
    return jsonb_build_object('known', false, 'registered', false);
  end if;
  v_hint := public.hotspot_passenger_hint(v_mac);
  select * into v_p from public.hotspot_people() p where p.mac = v_mac;
  select * into v_a from public.hotspot_access where device_mac = v_mac;
  select last_seen_at into v_router from public.hotspot_router_state where id = 1;
  v_access := case
    when coalesce(v_p.blocked, false) then 'blocked'
    when v_p.access_state = 'active' and v_p.status in ('provisioning', 'auth_error') then 'provisioning'
    when v_p.access_state = 'active' then 'active'
    when v_p.access_state = 'revoked' and v_a.revoke_reason = 'Tempo do plano acabou' then 'none'
    when v_p.access_state = 'revoked' then 'revoked'
    when coalesce(v_p.pix_paid, false) and v_a.device_mac is null then 'provisioning'
    else 'none' end;
  return v_hint || jsonb_build_object(
    'known', true, 'access', v_access,
    'internet', coalesce(v_p.host_authorized, false) and v_access = 'active',
    'stuck', coalesce(v_p.status = 'authorized_not_authenticated', false),
    'pix_pending', coalesce(v_p.pix_pending, false),
    'expires_at', case when v_access = 'active' then v_a.expires_at end,
    'expired', v_a.revoke_reason = 'Tempo do plano acabou' and v_a.state = 'revoked',
    'router_online', (v_router is not null and v_router > now() - interval '60 seconds'));
end
$$;

create or replace function public.hotspot_admin_plans()
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(to_jsonb(t) order by t.sort_order, t.price_cents, t.created_at), '[]'::jsonb) from (
    select p.id, p.name, p.description, p.price_cents, p.grant_seconds, p.active, p.highlight, p.is_default,
           p.sort_order, p.created_at, p.updated_at, p.unlimited, p.wall_clock,
           (select count(*) from public.hotspot_orders o where o.plan_id = p.id and o.payment_status = 'paid' and not o.is_test) as sales,
           (select coalesce(sum(o.amount_cents), 0) from public.hotspot_orders o where o.plan_id = p.id and o.payment_status = 'paid' and not o.is_test) as revenue_cents,
           (select max(o.paid_at) from public.hotspot_orders o where o.plan_id = p.id and o.payment_status = 'paid' and not o.is_test) as last_sale_at
      from public.hotspot_plans p) t;
$$;

create or replace function public.hotspot_admin_plan_save(p_actor uuid, p_actor_email text, p_plan jsonb)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_id uuid := nullif(p_plan->>'id', '')::uuid;
  v_old public.hotspot_plans%rowtype;
  v_new public.hotspot_plans%rowtype;
  v_name text := btrim(coalesce(p_plan->>'name', ''));
  v_desc text := nullif(btrim(coalesce(p_plan->>'description', '')), '');
  v_price integer;
  v_secs integer;
  v_active boolean := coalesce((p_plan->>'active')::boolean, false);
  v_high boolean := coalesce((p_plan->>'highlight')::boolean, false);
  v_def boolean := coalesce((p_plan->>'is_default')::boolean, false);
  v_unl boolean := coalesce((p_plan->>'unlimited')::boolean, false);
  v_wall boolean := coalesce((p_plan->>'wall_clock')::boolean, false);
  v_sort integer := coalesce((p_plan->>'sort_order')::integer, 0);
  v_n integer;
begin
  if not exists (select 1 from public.admin_users where user_id = p_actor and role = 'admin') then
    raise exception 'forbidden';
  end if;
  if char_length(v_name) < 1 or char_length(v_name) > 60 then raise exception 'nome invalido'; end if;
  if v_desc is not null and char_length(v_desc) > 200 then raise exception 'descricao longa demais'; end if;
  if (p_plan->>'price_cents') !~ '^[0-9]{1,6}$' or (p_plan->>'grant_seconds') !~ '^[0-9]{1,7}$' then
    raise exception 'valor ou duracao invalidos';
  end if;
  v_price := (p_plan->>'price_cents')::integer;
  v_secs := case when v_unl then 172800 else (p_plan->>'grant_seconds')::integer end; -- ilimitado: duração não é usada
  if v_price < 100 or v_price > 50000 then raise exception 'preco fora dos limites (R$ 1,00 a R$ 500,00)'; end if;
  if v_secs < 60 or v_secs > 2592000 then raise exception 'duracao fora dos limites (1 minuto a 30 dias)'; end if;
  if v_sort < -1000 or v_sort > 1000 then raise exception 'ordem invalida'; end if;
  if v_def and not v_active then raise exception 'o plano padrao precisa estar ativo'; end if;
  if v_id is not null then
    select * into v_old from public.hotspot_plans where id = v_id for update;
    if not found then raise exception 'plano nao encontrado'; end if;
  end if;
  select count(*) into v_n from public.hotspot_plans where active and id is distinct from v_id;
  if not v_active and v_n = 0 then raise exception 'mantenha ao menos um plano ativo'; end if;
  if v_def then update public.hotspot_plans set is_default = false where is_default and id is distinct from v_id; end if;
  if v_high then update public.hotspot_plans set highlight = false where highlight and id is distinct from v_id; end if;
  if v_id is null then
    insert into public.hotspot_plans (name, description, price_cents, grant_seconds, active, highlight, is_default, sort_order, unlimited, wall_clock)
    values (v_name, v_desc, v_price, v_secs, v_active, v_high, v_def, v_sort, v_unl, v_wall and not v_unl)
    returning * into v_new;
  else
    update public.hotspot_plans
       set name = v_name, description = v_desc, price_cents = v_price, grant_seconds = v_secs,
           active = v_active, highlight = v_high, is_default = v_def, sort_order = v_sort,
           unlimited = v_unl, wall_clock = v_wall and not v_unl, updated_at = now()
     where id = v_id returning * into v_new;
  end if;
  if not exists (select 1 from public.hotspot_plans where is_default and active) then
    update public.hotspot_plans set is_default = false where is_default;
    update public.hotspot_plans set is_default = true
     where id = (select id from public.hotspot_plans where active order by sort_order, price_cents, created_at limit 1);
  end if;
  insert into public.admin_audit_log (actor, actor_email, action, entity, entity_id, before_data, after_data)
  values (p_actor, p_actor_email, case when v_id is null then 'plan_create' else 'plan_update' end, 'plan', v_new.id::text,
          case when v_id is null then null else to_jsonb(v_old) end,
          (select to_jsonb(p) from public.hotspot_plans p where p.id = v_new.id));
  return (select to_jsonb(p) from public.hotspot_plans p where p.id = v_new.id);
end
$$;

-- Cortesia de 2 min também para Pix de tempo corrido; quem teve o tempo vencido também pode receber.
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
     or exists (select 1 from public.hotspot_access where device_mac = v_mac
                 and (state = 'active' or revoke_reason is distinct from 'Tempo do plano acabou')) then
    return jsonb_build_object('result', 'not_eligible');
  end if;
  if not exists (select 1 from public.hotspot_orders where device_mac = v_mac and payment_status = 'pending' and (unlimited or wall_clock)) then
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

-- ACK: pedidos de tempo corrido também passam a "liberados no roteador".
create or replace function public.hotspot_router_command_ack(p_id uuid, p_mac text, p_result text)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_mac text := upper(btrim(coalesce(p_mac, '')));
  v_c public.hotspot_router_commands%rowtype;
  v_max integer := public.hotspot_setting('command_max_attempts', '5')::integer;
begin
  if p_result not in ('ok', 'auth', 'login', 'nohost', 'err') then
    return jsonb_build_object('ok', false, 'reason', 'invalid_result');
  end if;
  select * into v_c from public.hotspot_router_commands where id = p_id and device_mac = v_mac for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if v_c.status in ('applied', 'failed', 'superseded') then
    return jsonb_build_object('ok', true, 'already', true);
  end if;
  if p_result = 'err' then
    update public.hotspot_router_commands
       set status = case when attempts >= v_max then 'failed' else 'queued' end,
           result = 'err', done_at = case when attempts >= v_max then now() end
     where id = p_id;
    return jsonb_build_object('ok', true, 'retry', v_c.attempts < v_max);
  end if;
  update public.hotspot_router_commands set status = 'applied', result = p_result, done_at = now() where id = p_id;
  if v_c.kind in ('grant', 'reauth') then
    -- Pedidos Pix ilimitados deste aparelho passam a "liberados no roteador" (o usuário Hotspot existe).
    update public.hotspot_orders set provisioned_at = now(), updated_at = now()
     where device_mac = v_mac and (unlimited or wall_clock) and payment_status = 'paid' and provisioned_at is null;
  end if;
  if p_result = 'auth' then
    update public.hotspot_access set authenticated_at = coalesce(authenticated_at, now()), updated_at = now()
     where device_mac = v_mac and state = 'active';
  end if;
  update public.hotspot_router_state set last_ack_at = now() where id = 1;
  return jsonb_build_object('ok', true, 'already', false);
end
$$;

do $$
declare
  f text;
begin
  foreach f in array array['hotspot_order_unlimited()', 'hotspot_orders_access_trigger()', 'hotspot_access_expire()',
    'hotspot_router_commands_pull(integer)', 'hotspot_router_pull(integer)', 'hotspot_reserve_plan_order(text,uuid)',
    'hotspot_portal_state(text)', 'hotspot_trial_grant(text)', 'hotspot_router_command_ack(uuid,text,text)', 'hotspot_admin_plans()', 'hotspot_admin_plan_save(uuid,text,jsonb)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end
$$;
