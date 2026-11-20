-- Acesso de viagem (revisão 10). ADITIVA: não apaga pedidos, valores, créditos de horas nem cadastros.
--
--  * hotspot_access: o DIREITO de navegar durante a viagem, um por MAC. Origem: "manual_prepaid_20" (o admin conferiu a
--    lista de quem pagou R$ 20 fora do sistema), "pix" (Pix aprovado pelo Mercado Pago) ou "transfer" (MAC trocado).
--    Sem limite de horas. Revogável individualmente e encerrável para todos no fim da viagem ("Encerrar viagem").
--  * hotspot_blocks: MACs bloqueados pelo admin. Bloqueio vence tudo (pagamento, liberação manual, reconexão).
--  * hotspot_router_commands: fila de comandos para o MikroTik (grant | revoke | kick | reauth) com id, tentativas e ACK.
--    O roteador busca de dentro para fora (wifi-poll); nada é executado como código no roteador.
--  * Planos ganham "unlimited": o novo plano "Internet para toda a viagem" (R$ 25,00) é o único ativo. Os planos de
--    horas ficam inativos (histórico preservado). Pedidos antigos de horas continuam seguindo o fluxo antigo.
--  * Estados separados: pagamento aprovado != direito registrado != comando aplicado != sessão autenticada (o roteador
--    informa o flag "authorized" de /ip hotspot host a cada ciclo).

-- ---------------------------------------------------------------------------
-- Tabelas
-- ---------------------------------------------------------------------------
create table if not exists public.hotspot_access (
  device_mac text primary key check (device_mac ~ '^([0-9A-F]{2}:){5}[0-9A-F]{2}$'),
  source text not null check (source in ('manual_prepaid_20', 'pix', 'transfer')),
  order_id uuid references public.hotspot_orders (id) on delete set null,
  state text not null check (state in ('active', 'revoked')),
  granted_at timestamptz not null default now(),
  granted_by text,
  note text check (note is null or char_length(note) <= 200),
  authenticated_at timestamptz,
  revoked_at timestamptz,
  revoked_by text,
  revoke_reason text check (revoke_reason is null or char_length(revoke_reason) <= 200),
  updated_at timestamptz not null default now()
);
alter table public.hotspot_access enable row level security;
revoke all privileges on table public.hotspot_access from public, anon, authenticated;

create table if not exists public.hotspot_blocks (
  device_mac text primary key check (device_mac ~ '^([0-9A-F]{2}:){5}[0-9A-F]{2}$'),
  blocked_at timestamptz not null default now(),
  blocked_by text,
  reason text check (reason is null or char_length(reason) <= 200)
);
alter table public.hotspot_blocks enable row level security;
revoke all privileges on table public.hotspot_blocks from public, anon, authenticated;

create table if not exists public.hotspot_router_commands (
  id uuid primary key default gen_random_uuid(),
  device_mac text not null check (device_mac ~ '^([0-9A-F]{2}:){5}[0-9A-F]{2}$'),
  kind text not null check (kind in ('grant', 'revoke', 'kick', 'reauth')),
  status text not null default 'queued' check (status in ('queued', 'sent', 'applied', 'failed', 'superseded')),
  attempts integer not null default 0,
  result text check (result is null or char_length(result) <= 20),
  created_by text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  done_at timestamptz
);
alter table public.hotspot_router_commands enable row level security;
revoke all privileges on table public.hotspot_router_commands from public, anon, authenticated;
-- No máximo um comando EM ABERTO por (MAC, tipo): clicar duas vezes não duplica.
create unique index if not exists hotspot_router_commands_open
  on public.hotspot_router_commands (device_mac, kind) where status in ('queued', 'sent');
create index if not exists hotspot_router_commands_mac on public.hotspot_router_commands (device_mac, created_at desc);
create index if not exists hotspot_router_commands_pending on public.hotspot_router_commands (created_at) where status in ('queued', 'sent');

alter table public.hotspot_plans add column if not exists unlimited boolean not null default false;
alter table public.hotspot_orders add column if not exists unlimited boolean not null default false;

insert into public.hotspot_settings (key, value) values
  ('command_retry_seconds', '60'),
  ('command_max_attempts', '5'),
  ('trip_ended_at', '')
on conflict (key) do nothing;

-- Novo produto: único plano ativo e padrão. Os de horas ficam inativos (não são apagados).
do $$
begin
  if not exists (select 1 from public.hotspot_plans where unlimited) then
    update public.hotspot_plans set is_default = false, highlight = false, active = false, updated_at = now();
    insert into public.hotspot_plans (name, description, price_cents, grant_seconds, active, is_default, highlight, sort_order, unlimited)
    values ('Internet para toda a viagem', 'Acesso ilimitado durante toda a viagem', 2500, 172800, true, true, true, 0, true);
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Comandos para o roteador
-- ---------------------------------------------------------------------------
-- Enfileira um comando. Um comando novo cancela ("superseded") os comandos em aberto que ele contradiz:
-- grant/reauth x revoke. kick não contradiz nada. Idempotente: se o mesmo tipo já está em aberto, reaproveita.
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
     where device_mac = p_mac and kind = 'revoke' and status in ('queued', 'sent');
  elsif p_kind = 'revoke' then
    update public.hotspot_router_commands set status = 'superseded', done_at = now()
     where device_mac = p_mac and kind in ('grant', 'reauth') and status in ('queued', 'sent');
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

-- Roteador: comandos a aplicar (no máximo p_limit). "sent" sem ACK volta após command_retry_seconds;
-- depois de command_max_attempts envios vira "failed" (o painel mostra "Erro ao aplicar" e permite tentar de novo).
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

-- Roteador: resultado de um comando. p_result: ok | auth (sessão autenticada) | login (login disparado) |
-- nohost (aparelho fora da rede agora; vale quando voltar) | err (falhou: volta para a fila até o limite).
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
     where device_mac = v_mac and unlimited and payment_status = 'paid' and provisioned_at is null;
  end if;
  if p_result = 'auth' then
    update public.hotspot_access set authenticated_at = coalesce(authenticated_at, now()), updated_at = now()
     where device_mac = v_mac and state = 'active';
  end if;
  update public.hotspot_router_state set last_ack_at = now() where id = 1;
  return jsonb_build_object('ok', true, 'already', false);
end
$$;

-- ---------------------------------------------------------------------------
-- Direito de acesso
-- ---------------------------------------------------------------------------
-- Concede (ou mantém) o direito do MAC. Nunca duplica: se já está ativo, devolve "already".
-- Bloqueado: o direito é registrado (se veio de Pix aprovado, o dinheiro não some), mas NADA vai ao roteador
-- até o desbloqueio.
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
         revoked_at = null, revoked_by = null, revoke_reason = null, updated_at = now();
  if v_blocked then
    return jsonb_build_object('result', 'granted_blocked');
  end if;
  perform public.hotspot_queue_command(v_mac, 'grant', p_by);
  return jsonb_build_object('result', 'granted');
end
$$;

create or replace function public.hotspot_access_revoke(p_mac text, p_by text, p_reason text)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_mac text := upper(btrim(coalesce(p_mac, '')));
begin
  perform pg_advisory_xact_lock(hashtext('hotspot_access:' || v_mac));
  update public.hotspot_access
     set state = 'revoked', revoked_at = now(), revoked_by = left(p_by, 120), revoke_reason = left(p_reason, 200), updated_at = now()
   where device_mac = v_mac and state = 'active';
  if not found then
    return jsonb_build_object('result', 'not_active');
  end if;
  perform public.hotspot_queue_command(v_mac, 'revoke', p_by);
  return jsonb_build_object('result', 'revoked');
end
$$;

-- Pix: pedido ilimitado aprovado => direito "pix" + comando. Reembolso/estorno => revoga se o direito veio dele.
create or replace function public.hotspot_orders_access_trigger()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.unlimited and new.payment_status = 'paid' and old.payment_status is distinct from 'paid' then
    perform public.hotspot_access_grant(new.device_mac, 'pix', new.id, 'mercado_pago', null);
  elsif new.unlimited and new.payment_status = 'refunded' and old.payment_status = 'paid' then
    if exists (select 1 from public.hotspot_access where device_mac = new.device_mac and state = 'active'
                and source = 'pix' and order_id = new.id) then
      perform public.hotspot_access_revoke(new.device_mac, 'mercado_pago', 'Pagamento estornado');
    end if;
  end if;
  return null;
end
$$;
drop trigger if exists hotspot_orders_access on public.hotspot_orders;
create trigger hotspot_orders_access after update of payment_status on public.hotspot_orders
  for each row execute function public.hotspot_orders_access_trigger();

-- ---------------------------------------------------------------------------
-- Checkout: copia "unlimited" do plano; recusa quem já tem acesso, está bloqueado ou teve o acesso revogado.
-- ---------------------------------------------------------------------------
create or replace function public.hotspot_order_unlimited()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.plan_id is not null then
    select coalesce(p.unlimited, false) into new.unlimited from public.hotspot_plans p where p.id = new.plan_id;
    new.unlimited := coalesce(new.unlimited, false);
  end if;
  return new;
end
$$;
drop trigger if exists hotspot_orders_unlimited on public.hotspot_orders;
create trigger hotspot_orders_unlimited before insert on public.hotspot_orders
  for each row execute function public.hotspot_order_unlimited();

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
  v_state text;
begin
  if v_mac !~ '^([0-9A-F]{2}:){5}[0-9A-F]{2}$' then
    return jsonb_build_object('action', 'invalid_mac');
  end if;
  if public.hotspot_device_gate(v_mac) = 'unknown' then
    return jsonb_build_object('action', 'unknown_device');
  end if;
  if exists (select 1 from public.hotspot_blocks where device_mac = v_mac) then
    return jsonb_build_object('action', 'blocked');
  end if;
  select state into v_state from public.hotspot_access where device_mac = v_mac;
  if v_state = 'active' then
    return jsonb_build_object('action', 'already_active');
  elsif v_state = 'revoked' then
    return jsonb_build_object('action', 'revoked');
  end if;
  if not exists (select 1 from public.hotspot_passengers where device_mac = v_mac)
     and not exists (select 1 from public.hotspot_orders o
                      where o.device_mac = v_mac
                        and (o.payment_status = 'pending' or (o.payment_status = 'paid' and o.provisioned_at is null))) then
    return jsonb_build_object('action', 'registration_required');
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
  v_r := public.hotspot_reserve_order(v_mac, v_p.price_cents, v_p.grant_seconds, v_p.id, v_p.name);
  return v_r || jsonb_build_object('plan_name', v_p.name, 'amount_cents', v_p.price_cents,
                                   'grant_seconds', v_p.grant_seconds, 'unlimited', v_p.unlimited);
end
$$;

create or replace function public.hotspot_public_plans()
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', id, 'name', name, 'description', description, 'price_cents', price_cents,
           'grant_seconds', grant_seconds, 'highlight', highlight, 'is_default', is_default, 'unlimited', unlimited)
         order by sort_order, price_cents, created_at), '[]'::jsonb)
    from public.hotspot_plans where active;
$$;

-- Roteador (fluxo antigo de horas): os pedidos ilimitados NÃO viram linha "G <tempo>"; eles chegam como comando.
create or replace function public.hotspot_router_pull(p_limit integer default 30)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_orders jsonb;
begin
  insert into public.hotspot_router_state (id, last_seen_at)
  values (1, now())
  on conflict (id) do update set last_seen_at = excluded.last_seen_at;

  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'mac', t.device_mac,
                                               'grant_seconds', t.grant_seconds)
                            order by t.created_at), '[]'::jsonb)
    into v_orders
    from (select id, device_mac, grant_seconds, created_at
            from public.hotspot_orders
           where payment_status = 'paid' and provisioned_at is null and not unlimited
           order by created_at asc
           limit greatest(1, least(coalesce(p_limit, 30), 100))) t;

  return jsonb_build_object('orders', v_orders);
end
$$;

-- Presença: igual à revisão anterior + marca "autenticado" no direito de acesso quando o roteador confirma.
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

-- ---------------------------------------------------------------------------
-- Visão consolidada (painel). Estados (coluna "status"), do mais forte para o mais fraco:
--   blocked | auth_error | provisioning | internet_active | authorized_not_authenticated | authorized_offline |
--   revoked | pix_pending | legacy_active | legacy_exhausted | waiting | not_identified
-- ---------------------------------------------------------------------------
drop function if exists public.hotspot_admin_passengers(text, text, integer, integer);
drop function if exists public.hotspot_admin_passenger(text);
drop function if exists public.hotspot_admin_people_summary();
drop function if exists public.hotspot_people();
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
    union select device_mac from public.hotspot_orders
    union select device_mac from public.hotspot_access
    union select device_mac from public.hotspot_blocks
  ), ord as (
    select o.device_mac,
           (count(*) filter (where o.payment_status = 'paid' and not o.is_test))::integer as pc,
           coalesce(sum(o.amount_cents) filter (where o.payment_status = 'paid' and not o.is_test), 0)::bigint as tp,
           coalesce(bool_or(o.payment_status = 'pending' and (o.expires_at is null or o.expires_at > now())), false) as pp,
           coalesce(bool_or(o.payment_status = 'paid' and o.unlimited), false) as pu,
           coalesce(bool_or(not o.unlimited and o.payment_status in ('paid', 'refunded') and o.provisioned_at is not null), false) as legacy
      from public.hotspot_orders o group by o.device_mac
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
    from y as x;
$$;

-- Filtros: all | online | offline | waiting | unidentified | active | problem | blocked | revoked | pix_pending | manual | pix
create or replace function public.hotspot_admin_passengers(p_filter text, p_q text, p_limit integer, p_offset integer)
returns jsonb
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_f text := coalesce(nullif(btrim(p_filter), ''), 'all');
  v_q text := lower(btrim(coalesce(p_q, '')));
  v_lim integer := greatest(1, least(coalesce(p_limit, 100), 200));
  v_off integer := greatest(0, coalesce(p_offset, 0));
  v_total integer;
  v_rows jsonb;
begin
  if v_f not in ('all', 'online', 'offline', 'waiting', 'unidentified', 'active', 'problem', 'blocked', 'revoked',
                 'pix_pending', 'manual', 'pix') then
    raise exception 'filtro invalido';
  end if;
  with f as (
    select * from public.hotspot_people() p
     where (v_f = 'all'
            or (v_f = 'online' and p.online) or (v_f = 'offline' and not p.online)
            or (v_f = 'waiting' and p.status in ('waiting', 'pix_pending'))
            or (v_f = 'unidentified' and not p.identified)
            or (v_f = 'active' and p.access_state = 'active')
            or (v_f = 'problem' and p.status in ('auth_error', 'authorized_not_authenticated'))
            or (v_f = 'blocked' and p.blocked) or (v_f = 'revoked' and p.status = 'revoked')
            or (v_f = 'pix_pending' and p.pix_pending)
            or (v_f = 'manual' and p.access_state = 'active' and p.access_source = 'manual_prepaid_20')
            or (v_f = 'pix' and p.access_state = 'active' and p.access_source = 'pix'))
       and (v_q = '' or position(v_q in lower(p.mac)) > 0 or position(v_q in lower(coalesce(p.full_name, ''))) > 0
            or position(v_q in lower(coalesce(p.email, ''))) > 0 or position(v_q in coalesce(p.ip, '')) > 0)
  )
  select (select count(*) from f),
         coalesce(jsonb_agg(to_jsonb(t) order by t.online desc, t.identified desc, t.last_contact desc nulls last, t.mac), '[]'::jsonb)
    into v_total, v_rows
    from (select * from f order by online desc, identified desc, last_contact desc nulls last, mac limit v_lim offset v_off) t;
  return jsonb_build_object('total', v_total, 'limit', v_lim, 'offset', v_off, 'rows', v_rows, 'at', now());
end
$$;

create or replace function public.hotspot_admin_people_summary()
returns jsonb
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_feed timestamptz;
  v_win integer := public.hotspot_setting('hosts_feed_window_seconds', '120')::integer;
  v_rev bigint;
  v_router timestamptz;
  v_open integer;
  r record;
begin
  begin
    v_feed := nullif(public.hotspot_setting('hosts_feed_at', ''), '')::timestamptz;
  exception when others then v_feed := null;
  end;
  select last_seen_at into v_router from public.hotspot_router_state where id = 1;
  select coalesce(sum(amount_cents), 0) into v_rev from public.hotspot_orders where payment_status = 'paid' and not is_test;
  select count(*) into v_open from public.hotspot_router_commands where status in ('queued', 'sent');
  select count(*) filter (where online) as present,
         count(*) filter (where identified) as registered,
         count(*) filter (where online and not identified) as present_unidentified,
         count(*) filter (where status in ('waiting', 'pix_pending')) as waiting,
         count(*) filter (where access_state = 'active' and access_source = 'manual_prepaid_20') as manual,
         count(*) filter (where access_state = 'active' and access_source = 'pix') as pix,
         count(*) filter (where access_state = 'active' and access_source = 'transfer') as transferred,
         count(*) filter (where status = 'internet_active') as internet,
         count(*) filter (where status in ('auth_error', 'authorized_not_authenticated')) as problems,
         count(*) filter (where blocked) as blocked,
         count(*) filter (where pix_pending) as pix_pending
    into r from public.hotspot_people();
  return jsonb_build_object(
    'present', r.present, 'registered', r.registered, 'present_unidentified', r.present_unidentified,
    'waiting', r.waiting, 'manual', r.manual, 'pix', r.pix, 'transferred', r.transferred, 'internet', r.internet,
    'problems', r.problems, 'blocked', r.blocked, 'pix_pending', r.pix_pending, 'revenue_total_cents', v_rev,
    'commands_open', v_open, 'router_seen_at', v_router,
    'router_online', (v_router is not null and v_router > now() - interval '60 seconds'),
    'feed_at', v_feed, 'feed_fresh', (v_feed is not null and v_feed > now() - make_interval(secs => v_win)),
    'trip_ended_at', nullif(public.hotspot_setting('trip_ended_at', ''), ''),
    'at', now());
end
$$;

create or replace function public.hotspot_admin_passenger(p_mac text)
returns jsonb
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_mac text := upper(btrim(coalesce(p_mac, '')));
  v_row jsonb; v_orders jsonb; v_hist jsonb; v_cmds jsonb; v_acc jsonb;
begin
  if v_mac !~ '^([0-9A-F]{2}:){5}[0-9A-F]{2}$' then raise exception 'mac invalido'; end if;
  select to_jsonb(p) into v_row from public.hotspot_people() p where p.mac = v_mac;
  select to_jsonb(a) into v_acc from public.hotspot_access a where a.device_mac = v_mac;
  select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at desc), '[]'::jsonb) into v_orders from (
    select o.id, o.created_at, o.paid_at, o.provisioned_at, o.amount_cents, o.grant_seconds, o.is_test, o.unlimited,
           coalesce(o.plan_name, 'Sem plano') as plan_name, o.payer_name, o.payer_email,
           public.hotspot_display_state(o.payment_status, o.mp_status, o.expires_at, o.provisioned_at) as state
      from public.hotspot_orders o where o.device_mac = v_mac order by o.created_at desc limit 50) t;
  select coalesce(jsonb_agg(to_jsonb(t) order by t.changed_at desc), '[]'::jsonb) into v_hist from (
    select h.full_name, h.email, h.changed_at from public.hotspot_passenger_history h
     where h.device_mac = v_mac order by h.changed_at desc limit 20) t;
  select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at desc), '[]'::jsonb) into v_cmds from (
    select c.id, c.kind, c.status, c.result, c.attempts, c.created_by, c.created_at, c.done_at
      from public.hotspot_router_commands c where c.device_mac = v_mac order by c.created_at desc limit 20) t;
  return jsonb_build_object('mac', v_mac, 'person', v_row, 'access', v_acc, 'orders', v_orders,
                            'history', v_hist, 'commands', v_cmds);
end
$$;

-- ---------------------------------------------------------------------------
-- Ações do admin (somente perfil "admin"; tudo auditado). p_action:
--   grant   = Liberar acesso (pré-pago R$ 20 conferido pelo admin; sem Pix, sem horas)
--   kick    = Desconectar sessão agora (temporário: com direito válido o login por MAC volta sozinho)
--   revoke  = Revogar acesso (direito invalidado; o roteador desativa o usuário e derruba a sessão)
--   block   = Bloquear MAC (vence pagamento e liberação; não gera Pix)
--   unblock = Desbloquear (só reativa a internet se ainda houver direito ativo)
--   reauth  = Reautenticar (recuperação: reaplica o usuário e força nova tentativa de login; não cria nem muda direito)
-- ---------------------------------------------------------------------------
create or replace function public.hotspot_admin_device_action(p_actor uuid, p_actor_email text, p_mac text, p_action text, p_note text)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_mac text := upper(btrim(coalesce(p_mac, '')));
  v_by text := coalesce(nullif(p_actor_email, ''), 'admin');
  v_note text := nullif(left(btrim(coalesce(p_note, '')), 200), '');
  v_r jsonb;
  v_a public.hotspot_access%rowtype;
  v_cmd uuid;
begin
  if not exists (select 1 from public.admin_users where user_id = p_actor and role = 'admin') then
    raise exception 'forbidden';
  end if;
  if v_mac !~ '^([0-9A-F]{2}:){5}[0-9A-F]{2}$' then raise exception 'mac invalido'; end if;
  if p_action not in ('grant', 'kick', 'revoke', 'block', 'unblock', 'reauth') then raise exception 'acao invalida'; end if;
  select * into v_a from public.hotspot_access where device_mac = v_mac;

  if p_action = 'grant' then
    if not exists (select 1 from public.hotspot_known_hosts where device_mac = v_mac)
       and not exists (select 1 from public.hotspot_passengers where device_mac = v_mac) then
      raise exception 'aparelho nao visto pelo roteador';
    end if;
    if exists (select 1 from public.hotspot_blocks where device_mac = v_mac) then
      raise exception 'aparelho bloqueado: desbloqueie antes de liberar';
    end if;
    v_r := public.hotspot_access_grant(v_mac, 'manual_prepaid_20', null, v_by, v_note);
  elsif p_action = 'kick' then
    v_cmd := public.hotspot_queue_command(v_mac, 'kick', v_by);
    v_r := jsonb_build_object('result', 'queued', 'command_id', v_cmd);
  elsif p_action = 'revoke' then
    v_r := public.hotspot_access_revoke(v_mac, v_by, coalesce(v_note, 'Revogado pelo administrador'));
    if v_r->>'result' = 'not_active' then
      -- sem direito ativo: garante mesmo assim que o roteador não deixe sessão aberta
      v_cmd := public.hotspot_queue_command(v_mac, 'revoke', v_by);
      v_r := jsonb_build_object('result', 'queued', 'command_id', v_cmd);
    end if;
  elsif p_action = 'block' then
    insert into public.hotspot_blocks (device_mac, blocked_by, reason) values (v_mac, v_by, v_note)
    on conflict (device_mac) do nothing;
    v_cmd := public.hotspot_queue_command(v_mac, 'revoke', v_by);
    v_r := jsonb_build_object('result', 'blocked', 'command_id', v_cmd);
  elsif p_action = 'unblock' then
    delete from public.hotspot_blocks where device_mac = v_mac;
    if v_a.state = 'active' then
      v_cmd := public.hotspot_queue_command(v_mac, 'grant', v_by);
      v_r := jsonb_build_object('result', 'unblocked_restored', 'command_id', v_cmd);
    else
      v_r := jsonb_build_object('result', 'unblocked_no_access');
    end if;
  elsif p_action = 'reauth' then
    if v_a.state is distinct from 'active' then raise exception 'aparelho sem acesso ativo'; end if;
    if exists (select 1 from public.hotspot_blocks where device_mac = v_mac) then raise exception 'aparelho bloqueado'; end if;
    v_cmd := public.hotspot_queue_command(v_mac, 'reauth', v_by);
    v_r := jsonb_build_object('result', 'queued', 'command_id', v_cmd);
  end if;

  insert into public.admin_audit_log (actor, actor_email, action, entity, entity_id, before_data, after_data)
  values (p_actor, p_actor_email, 'device_' || p_action, 'device', v_mac,
          case when v_a.device_mac is not null then jsonb_build_object('state', v_a.state, 'source', v_a.source) end,
          v_r || case when v_note is not null then jsonb_build_object('note', v_note) else '{}'::jsonb end);
  return v_r;
end
$$;

-- Transferência (MAC privado do iPhone mudou): o direito passa do MAC antigo para o novo, nunca fica nos dois.
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
  perform public.hotspot_queue_command(v_to, 'grant', v_by);
  insert into public.admin_audit_log (actor, actor_email, action, entity, entity_id, before_data, after_data)
  values (p_actor, p_actor_email, 'device_transfer', 'device', v_to,
          jsonb_build_object('from', v_from, 'source', v_a.source), jsonb_build_object('to', v_to));
  return jsonb_build_object('result', 'transferred', 'from', v_from, 'to', v_to);
end
$$;

-- Fim da viagem: revoga TODOS os direitos ativos (histórico preservado). Exige digitar ENCERRAR.
create or replace function public.hotspot_admin_end_trip(p_actor uuid, p_actor_email text, p_confirm text)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_by text := coalesce(nullif(p_actor_email, ''), 'admin');
  v_mac text;
  v_n integer := 0;
begin
  if not exists (select 1 from public.admin_users where user_id = p_actor and role = 'admin') then
    raise exception 'forbidden';
  end if;
  if coalesce(p_confirm, '') <> 'ENCERRAR' then raise exception 'digite ENCERRAR para confirmar'; end if;
  for v_mac in select device_mac from public.hotspot_access where state = 'active' loop
    perform public.hotspot_access_revoke(v_mac, v_by, 'Fim da viagem');
    v_n := v_n + 1;
  end loop;
  insert into public.hotspot_settings (key, value) values ('trip_ended_at', now()::text)
  on conflict (key) do update set value = excluded.value, updated_at = now();
  insert into public.admin_audit_log (actor, actor_email, action, entity, entity_id, before_data, after_data)
  values (p_actor, p_actor_email, 'trip_end', 'trip', 'all', null, jsonb_build_object('revoked', v_n));
  return jsonb_build_object('result', 'ended', 'revoked', v_n);
end
$$;

-- ---------------------------------------------------------------------------
-- Portal: estado do PRÓPRIO aparelho (sem dados pessoais além das dicas mascaradas). Só para aparelho presente.
--   access: none | provisioning | active | revoked | blocked ; internet: o roteador confirmou sessão autenticada
-- ---------------------------------------------------------------------------
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
begin
  if v_mac !~ '^([0-9A-F]{2}:){5}[0-9A-F]{2}$' or public.hotspot_device_gate(v_mac) = 'unknown' then
    return jsonb_build_object('known', false, 'registered', false);
  end if;
  v_hint := public.hotspot_passenger_hint(v_mac);
  select * into v_p from public.hotspot_people() p where p.mac = v_mac;
  select last_seen_at into v_router from public.hotspot_router_state where id = 1;
  v_access := case
    when coalesce(v_p.blocked, false) then 'blocked'
    when v_p.access_state = 'active' and v_p.status in ('provisioning', 'auth_error') then 'provisioning'
    when v_p.access_state = 'active' then 'active'
    when v_p.access_state = 'revoked' then 'revoked'
    when coalesce(v_p.pix_paid, false) then 'provisioning'
    else 'none' end;
  return v_hint || jsonb_build_object(
    'known', true,
    'access', v_access,
    'internet', coalesce(v_p.host_authorized, false) and v_access = 'active',
    'stuck', coalesce(v_p.status = 'authorized_not_authenticated', false),
    'pix_pending', coalesce(v_p.pix_pending, false),
    'legacy_credit', v_p.legacy_credit,
    'router_online', (v_router is not null and v_router > now() - interval '60 seconds'));
end
$$;

-- ---------------------------------------------------------------------------
-- Permissões: somente service_role.
-- ---------------------------------------------------------------------------
do $$
declare
  f text;
begin
  foreach f in array array[
    'hotspot_queue_command(text,text,text)',
    'hotspot_router_commands_pull(integer)',
    'hotspot_router_command_ack(uuid,text,text)',
    'hotspot_access_grant(text,text,uuid,text,text)',
    'hotspot_access_revoke(text,text,text)',
    'hotspot_orders_access_trigger()',
    'hotspot_order_unlimited()',
    'hotspot_reserve_plan_order(text,uuid)',
    'hotspot_public_plans()',
    'hotspot_router_pull(integer)',
    'hotspot_router_report_hosts(text)',
    'hotspot_people()',
    'hotspot_admin_passengers(text,text,integer,integer)',
    'hotspot_admin_people_summary()',
    'hotspot_admin_passenger(text)',
    'hotspot_admin_device_action(uuid,text,text,text,text)',
    'hotspot_admin_transfer(uuid,text,text,text)',
    'hotspot_admin_end_trip(uuid,text,text)',
    'hotspot_portal_state(text)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end
$$;
