-- Auditoria (revisão 14). ADITIVA. Corrige:
--  1. Validade máxima incoerente: hotspot_reserve_order aceitava só 7 dias; planos aceitam 30 dias.
--  2. Renovação e estorno de tempo corrido: o fim do acesso passa a ser RECALCULADO a partir de TODOS os pedidos pagos
--     (não estornados) do aparelho, encadeados pela data de pagamento. Estornar uma compra tira só o tempo dela; estornar
--     a única compra encerra o acesso. Antes, o estorno de uma renovação deixava o tempo não pago ativo e o estorno da
--     primeira compra cortava também o tempo legítimo das outras.
--  3. Teto de USO no roteador para tempo corrido: o comando de liberação leva os segundos restantes; o RouterOS grava
--     limit-uptime = uso atual + restante. Mesmo sem Supabase, sem ACK da revogação ou após reboot, o aparelho não
--     navega mais do que o tempo pago (o corte pelo relógio continua sendo do servidor).
--  4. Estado REAL da cortesia de 2 min para o portal: preparing | authenticating | active | ended | failed.
--  5. Pix antigos vencidos aqui (5 min) mas ainda pagáveis no Mercado Pago (30 min): lista para cancelamento no MP.

-- (1) ---------------------------------------------------------------------------------------------------------------
create or replace function public.hotspot_reserve_order(
  p_mac text,
  p_amount_cents integer,
  p_grant_seconds integer default 18000,
  p_plan_id uuid default null,
  p_plan_name text default null
) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_mac text := upper(btrim(coalesce(p_mac, '')));
  v_o public.hotspot_orders%rowtype;
  v_n integer;
begin
  if v_mac !~ '^([0-9A-F]{2}:){5}[0-9A-F]{2}$' then
    return jsonb_build_object('action', 'invalid_mac');
  end if;
  if p_amount_cents is null or p_amount_cents <= 0
     or p_grant_seconds is null or p_grant_seconds < 60 or p_grant_seconds > 2592000 then
    return jsonb_build_object('action', 'invalid_amount');
  end if;

  perform pg_advisory_xact_lock(hashtext('hotspot_reserve:' || v_mac));
  perform public.hotspot_expire_stale();

  -- Já pagou e o roteador ainda não confirmou: não gerar outro Pix.
  select * into v_o from public.hotspot_orders
   where device_mac = v_mac and payment_status = 'paid' and provisioned_at is null
   order by created_at desc limit 1;
  if found then
    return jsonb_build_object('action', 'paid_waiting',
      'order_id', v_o.id, 'read_token', v_o.read_token);
  end if;

  -- Pix ainda válido para este aparelho.
  select * into v_o from public.hotspot_orders
   where device_mac = v_mac and payment_status = 'pending'
   order by created_at desc limit 1;
  if found then
    -- Outro plano escolhido: a função (Edge) confere o Pix antigo no Mercado Pago antes de cancelar.
    -- Pedido antigo sem plano (criado antes dos planos) com o mesmo valor/duração conta como o mesmo plano.
    if v_o.plan_id is distinct from p_plan_id
       and not (v_o.plan_id is null and v_o.amount_cents = p_amount_cents and v_o.grant_seconds = p_grant_seconds) then
      if v_o.payment_id is not null then
        return jsonb_build_object('action', 'switch_needed',
          'order_id', v_o.id, 'payment_id', v_o.payment_id);
      end if;
      return jsonb_build_object('action', 'in_progress');
    end if;
    if v_o.qr_code is not null then
      return jsonb_build_object('action', 'existing',
        'order_id', v_o.id, 'read_token', v_o.read_token,
        'qr_code', v_o.qr_code, 'qr_code_base64', v_o.qr_code_base64,
        'ticket_url', v_o.ticket_url, 'expires_at', v_o.expires_at);
    end if;
    return jsonb_build_object('action', 'in_progress');
  end if;

  select count(*) into v_n from public.hotspot_orders
   where device_mac = v_mac and created_at > now() - interval '10 minutes';
  if v_n >= 5 then
    return jsonb_build_object('action', 'rate_limited');
  end if;
  select count(*) into v_n from public.hotspot_orders
   where created_at > now() - interval '10 minutes';
  if v_n >= 200 then
    return jsonb_build_object('action', 'rate_limited');
  end if;

  insert into public.hotspot_orders (device_mac, amount_cents, grant_seconds, plan_id, plan_name)
  values (v_mac, p_amount_cents, p_grant_seconds, p_plan_id, p_plan_name)
  returning * into v_o;
  return jsonb_build_object('action', 'created',
    'order_id', v_o.id, 'read_token', v_o.read_token);
end
$$;

-- (2) ---------------------------------------------------------------------------------------------------------------
create or replace function public.hotspot_access_recompute(p_mac text)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_mac text := upper(btrim(coalesce(p_mac, '')));
  v_a public.hotspot_access%rowtype;
  v_unl boolean;
  v_end timestamptz;
  r record;
begin
  select * into v_a from public.hotspot_access where device_mac = v_mac for update;
  if not found or v_a.source <> 'pix' then
    return jsonb_build_object('result', 'not_pix');                 -- liberação manual/transferência: não mexe
  end if;
  v_unl := exists (select 1 from public.hotspot_orders where device_mac = v_mac and unlimited and payment_status = 'paid');
  for r in select paid_at, grant_seconds from public.hotspot_orders
            where device_mac = v_mac and wall_clock and payment_status = 'paid' and paid_at is not null
            order by paid_at, created_at loop
    v_end := greatest(coalesce(v_end, r.paid_at), r.paid_at) + make_interval(secs => r.grant_seconds);
  end loop;
  if v_unl then
    update public.hotspot_access set expires_at = null, updated_at = now() where device_mac = v_mac and state = 'active';
    return jsonb_build_object('result', 'unlimited');
  end if;
  if v_end is null or v_end <= now() then
    if v_a.state = 'active' then
      perform public.hotspot_access_revoke(v_mac, 'pagamento',
        case when v_end is null then 'Pagamento estornado' else 'Tempo do plano acabou' end);
    end if;
    return jsonb_build_object('result', 'ended');
  end if;
  if v_a.state = 'active' then
    update public.hotspot_access set expires_at = v_end, updated_at = now() where device_mac = v_mac;
    if not exists (select 1 from public.hotspot_blocks where device_mac = v_mac) then
      perform public.hotspot_queue_command(v_mac, 'grant', 'renovacao');   -- atualiza o teto de uso no roteador
    end if;
  end if;
  return jsonb_build_object('result', 'timed', 'expires_at', v_end);
end
$$;

-- (gatilho de pagamento: definido na seção 6, abaixo)

-- (3) ---------------------------------------------------------------------------------------------------------------
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
  perform public.hotspot_reconcile_authorized();
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
  select coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'mac', u.device_mac, 'kind', u.kind,
           'secs', case when u.kind in ('grant', 'reauth') and a.state = 'active' and a.expires_at is not null
                        then greatest(60, ceil(extract(epoch from (a.expires_at - now())))::integer) end)
           order by u.created_at), '[]'::jsonb)
    into v_rows
    from upd u left join public.hotspot_access a on a.device_mac = u.device_mac;
  return jsonb_build_object('commands', v_rows);
end
$$;

-- (4) ---------------------------------------------------------------------------------------------------------------
create or replace function public.hotspot_trial_state(p_mac text)
returns text
language sql
stable
set search_path = public, pg_temp
as $$
  select case
    when c.id is null then 'none'
    when c.status in ('queued', 'sent') then 'preparing'
    when c.status = 'superseded' then 'none'
    when coalesce(c.done_at, c.created_at) < now() - interval '10 minutes' then 'none'
    when c.status = 'failed' or c.result in ('err', 'nohost') then 'failed'
    when c.done_at <= now() - interval '150 seconds' then 'ended'
    when c.result = 'auth' or (k.authorized and k.seen_at > now() - interval '90 seconds' and k.seen_at >= c.done_at) then 'active'
    when c.done_at > now() - interval '40 seconds' then 'authenticating'
    else 'failed' end
  from (select 1) one
  left join lateral (select * from public.hotspot_router_commands t
                      where t.device_mac = upper(btrim(p_mac)) and t.kind = 'trial'
                      order by t.created_at desc limit 1) c on true
  left join public.hotspot_known_hosts k on k.device_mac = upper(btrim(p_mac));
$$;

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
    when v_p.access_state = 'active' and v_a.expires_at is not null and v_a.expires_at <= now() then 'none'
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
    'trial', case when v_access = 'none' then public.hotspot_trial_state(v_mac) else 'none' end,
    'router_online', (v_router is not null and v_router > now() - interval '60 seconds'));
end
$$;

-- (5) ---------------------------------------------------------------------------------------------------------------
create or replace function public.hotspot_stale_payments(p_mac text)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(jsonb_build_object('order_id', o.id, 'payment_id', o.payment_id)), '[]'::jsonb)
    from public.hotspot_orders o
   where o.device_mac = upper(btrim(p_mac)) and o.payment_status in ('expired', 'failed') and o.payment_id is not null
     and coalesce(o.mp_status, 'pending') in ('pending', 'in_process') and o.created_at > now() - interval '40 minutes';
$$;

do $$
declare
  f text;
begin
  foreach f in array array['hotspot_reserve_order(text,integer,integer,uuid,text)', 'hotspot_access_recompute(text)',
    'hotspot_orders_access_trigger()', 'hotspot_router_commands_pull(integer)', 'hotspot_trial_state(text)',
    'hotspot_portal_state(text)', 'hotspot_stale_payments(text)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- (6) Achados da revisão independente. Concessão manual zera expires_at; transferência copia o fim do tempo corrido
-- (antes, transferir tempo corrido o tornava ilimitado).
create or replace function public.hotspot_access_grant(p_mac text, p_source text, p_order uuid, p_by text, p_note text)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_mac text := upper(btrim(coalesce(p_mac, '')));
  v_a public.hotspot_access%rowtype;
  v_blocked boolean;
begin
  if v_mac !~ '^([0-9A-F]{2}:){5}[0-9A-F]{2}$' then
    return jsonb_build_object('result', 'invalid_mac');
  end if;
  perform pg_advisory_xact_lock(hashtext('hotspot_access:' || v_mac));
  v_blocked := exists (select 1 from public.hotspot_blocks where device_mac = v_mac);
  select * into v_a from public.hotspot_access where device_mac = v_mac for update;
  if found and v_a.state = 'active' then
    if v_a.order_id is null and p_order is not null then
      update public.hotspot_access set order_id = p_order, updated_at = now() where device_mac = v_mac;
    end if;
    if not v_blocked and not exists (select 1 from public.hotspot_router_commands
                                      where device_mac = v_mac and kind = 'grant' and status = 'applied') then
      perform public.hotspot_queue_command(v_mac, 'grant', p_by);
    end if;
    return jsonb_build_object('result', 'already', 'source', v_a.source);
  end if;
  insert into public.hotspot_access as a (device_mac, source, order_id, state, granted_at, granted_by, note)
  values (v_mac, p_source, p_order, 'active', now(), left(p_by, 120), left(p_note, 200))
  on conflict (device_mac) do update
     set source = excluded.source, order_id = excluded.order_id, state = 'active', granted_at = now(),
         granted_by = excluded.granted_by, note = excluded.note, authenticated_at = null,
         revoked_at = null, revoked_by = null, revoke_reason = null, expires_at = null, updated_at = now();
  if v_blocked then
    return jsonb_build_object('result', 'granted_blocked');
  end if;
  perform public.hotspot_queue_command(v_mac, 'grant', p_by);
  return jsonb_build_object('result', 'granted');
end
$$;

create or replace function public.hotspot_admin_transfer(p_actor uuid, p_actor_email text, p_from text, p_to text)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_from text := upper(btrim(coalesce(p_from, '')));
  v_to text := upper(btrim(coalesce(p_to, '')));
  v_by text := coalesce(nullif(p_actor_email, ''), 'admin');
  v_a public.hotspot_access%rowtype;
begin
  if not exists (select 1 from public.admin_users where user_id = p_actor and role = 'admin') then
    raise exception 'forbidden';
  end if;
  if v_from !~ '^([0-9A-F]{2}:){5}[0-9A-F]{2}$' or v_to !~ '^([0-9A-F]{2}:){5}[0-9A-F]{2}$' or v_from = v_to then
    raise exception 'mac invalido';
  end if;
  perform pg_advisory_xact_lock(hashtext('hotspot_transfer'));
  select * into v_a from public.hotspot_access where device_mac = v_from and state = 'active' for update;
  if not found then raise exception 'o aparelho de origem nao tem acesso ativo'; end if;
  if not exists (select 1 from public.hotspot_known_hosts where device_mac = v_to) then
    raise exception 'o novo aparelho ainda nao foi visto pelo roteador';
  end if;
  if exists (select 1 from public.hotspot_blocks where device_mac = v_to) then raise exception 'o novo aparelho esta bloqueado'; end if;
  if exists (select 1 from public.hotspot_access where device_mac = v_to and state = 'active') then
    raise exception 'o novo aparelho ja tem acesso ativo';
  end if;
  perform public.hotspot_access_revoke(v_from, v_by, 'Transferido para ' || v_to);
  insert into public.hotspot_access as a (device_mac, source, order_id, state, granted_at, granted_by, note)
  values (v_to, 'transfer', v_a.order_id, 'active', now(), v_by, 'Transferido de ' || v_from || ' (origem: ' || v_a.source || ')')
  on conflict (device_mac) do update
     set source = excluded.source, order_id = excluded.order_id, state = 'active', granted_at = now(),
         granted_by = excluded.granted_by, note = excluded.note, authenticated_at = null,
         revoked_at = null, revoked_by = null, revoke_reason = null, updated_at = now();
  update public.hotspot_access set expires_at = v_a.expires_at where device_mac = v_to; -- tempo corrido continua igual
  perform public.hotspot_queue_command(v_to, 'grant', v_by);
  insert into public.admin_audit_log (actor, actor_email, action, entity, entity_id, before_data, after_data)
  values (p_actor, p_actor_email, 'device_transfer', 'device', v_to,
          jsonb_build_object('from', v_from, 'source', v_a.source), jsonb_build_object('to', v_to));
  return jsonb_build_object('result', 'transferred', 'from', v_from, 'to', v_to);
end
$$;

-- Expiração com nova checagem sob o mesmo lock do direito (renovação paga no mesmo instante não é revogada).
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
    perform pg_advisory_xact_lock(hashtext('hotspot_access:' || v_mac));
    if exists (select 1 from public.hotspot_access where device_mac = v_mac and state = 'active'
                and expires_at is not null and expires_at <= now()) then
      perform public.hotspot_access_revoke(v_mac, 'tempo', 'Tempo do plano acabou');
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end
$$;

-- Pagamento: lock por aparelho; Pix pago de aparelho BLOQUEADO ou REVOGADO pelo organizador não reativa o acesso
-- (o pagamento fica registrado, com auditoria, para reembolso/decisão manual). Pedido de quem já tem o usuário aplicado
-- no roteador e nenhuma liberação pendente é marcado como liberado (antes ficava "pago aguardando" e travava compras).
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

-- Reconciliação: aparelho AUTENTICADO no roteador sem direito ativo, sem cortesia recente e sem crédito antigo de horas
-- (ex.: revogação que nunca recebeu ACK) recebe nova revogação. Não depende do ACK. Só para quem já teve direito aqui.
create or replace function public.hotspot_reconcile_authorized()
returns integer
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_mac text;
  v_n integer := 0;
begin
  for v_mac in
    select k.device_mac from public.hotspot_known_hosts k
     where k.authorized and k.seen_at > now() - interval '60 seconds'
       and exists (select 1 from public.hotspot_access a where a.device_mac = k.device_mac)
       and not exists (select 1 from public.hotspot_access a where a.device_mac = k.device_mac and a.state = 'active')
       and not exists (select 1 from public.hotspot_router_commands c where c.device_mac = k.device_mac
                        and ((c.kind = 'trial' and coalesce(c.done_at, c.created_at) > now() - interval '4 minutes')
                             or (c.kind = 'revoke' and c.status in ('queued', 'sent'))
                             or (c.kind = 'revoke' and c.done_at > now() - interval '40 seconds')))
       and not (public.hotspot_device_credit_state(k.device_mac) = 'active'
                and exists (select 1 from public.hotspot_orders o where o.device_mac = k.device_mac and not o.unlimited
                             and not o.wall_clock and o.payment_status = 'paid' and o.provisioned_at is not null))
  loop
    perform public.hotspot_queue_command(v_mac, 'revoke', 'reconciliacao');
    v_n := v_n + 1;
  end loop;
  return v_n;
end
$$;

-- Cortesia: além de 1 por aparelho por hora, no máximo 40 cortesias a cada 10 minutos no total (MACs trocados em série).
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
  if (select count(*) from public.hotspot_router_commands where kind = 'trial' and created_at > now() - interval '10 minutes') >= 40 then
    return jsonb_build_object('result', 'rate_limited');
  end if;
  perform public.hotspot_queue_command(v_mac, 'trial', 'cortesia_pix');
  return jsonb_build_object('result', 'queued');
end
$$;

-- Cadastro: depois de 15 min, nome/e-mail de um aparelho só mudam pelo organizador (o MAC não prova posse: impede que
-- alguém na rede troque o cadastro de outro aparelho e engane a conferência dos pré-pagos).
create or replace function public.hotspot_registration_locked(p_mac text, p_name text, p_email text)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select exists (select 1 from public.hotspot_passengers
                  where device_mac = upper(btrim(p_mac)) and registered_at < now() - interval '15 minutes'
                    and (full_name is distinct from regexp_replace(btrim(coalesce(p_name, '')), '[[:space:]]+', ' ', 'g')
                         or email is distinct from lower(btrim(coalesce(p_email, '')))));
$$;

-- Fecha a porta para funções futuras: por padrão, novas funções não ficam executáveis por papéis públicos.
do $$
begin
  execute 'alter default privileges in schema public revoke execute on functions from public, anon, authenticated';
exception when others then
  raise notice 'default privileges nao alterados: %', sqlerrm;
end
$$;

do $$
declare
  f text;
begin
  foreach f in array array['hotspot_access_grant(text,text,uuid,text,text)', 'hotspot_admin_transfer(uuid,text,text,text)',
    'hotspot_access_expire()', 'hotspot_orders_access_trigger()', 'hotspot_reconcile_authorized()', 'hotspot_trial_grant(text)',
    'hotspot_registration_locked(text,text,text)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end
$$;
