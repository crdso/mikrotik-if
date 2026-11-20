-- Passageiros (revisão 9): cadastro obrigatório (nome + e-mail, AUTODECLARADOS) e visão de TODOS os aparelhos
-- presentes na rede, com ou sem pagamento. ADITIVA: não altera pedidos, valores, créditos nem planos existentes.
--
--  * hotspot_passengers: um cadastro por MAC (o MAC NÃO é identidade verificada; o aparelho pode ser reutilizado).
--  * hotspot_passenger_history: quem já se declarou naquele MAC (preserva a história se outra pessoa usar o aparelho).
--  * hotspot_orders.payer_name/payer_email: cópia (snapshot) dos dados NO MOMENTO da compra.
--  * hotspot_known_hosts ganha IP e "autenticado": é a lista de presença enviada pelo MikroTik (/ip hotspot host).
--  * Privacidade: só service_role lê estas tabelas; retenção automática; exclusão individual pelo painel.
--  * Cadastro NÃO libera internet. A liberação continua dependendo só do Pix aprovado.

-- ---------------------------------------------------------------------------
-- Tabelas
-- ---------------------------------------------------------------------------
create table if not exists public.hotspot_passengers (
  device_mac text primary key check (device_mac ~ '^([0-9A-F]{2}:){5}[0-9A-F]{2}$'),
  full_name text not null check (char_length(full_name) between 3 and 80 and full_name !~ '[[:cntrl:]<>]'),
  email text not null check (char_length(email) between 6 and 254
                              and email ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'),
  registered_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_activity_at timestamptz not null default now(),
  reg_hits integer not null default 0,
  reg_hit_window timestamptz not null default now()
);
alter table public.hotspot_passengers enable row level security;
revoke all privileges on table public.hotspot_passengers from public, anon, authenticated;

create table if not exists public.hotspot_passenger_history (
  id bigint generated always as identity primary key,
  device_mac text not null check (device_mac ~ '^([0-9A-F]{2}:){5}[0-9A-F]{2}$'),
  full_name text not null,
  email text not null,
  changed_at timestamptz not null default now()
);
create index if not exists hotspot_passenger_history_mac on public.hotspot_passenger_history (device_mac, changed_at desc);
create index if not exists hotspot_passenger_history_at on public.hotspot_passenger_history (changed_at);
alter table public.hotspot_passenger_history enable row level security;
revoke all privileges on table public.hotspot_passenger_history from public, anon, authenticated;

alter table public.hotspot_orders add column if not exists payer_name text;
alter table public.hotspot_orders add column if not exists payer_email text;

alter table public.hotspot_known_hosts add column if not exists ip text;
alter table public.hotspot_known_hosts add column if not exists authorized boolean not null default false;
alter table public.hotspot_known_hosts add column if not exists first_seen_at timestamptz not null default now();

insert into public.hotspot_settings (key, value) values
  ('presence_seconds', '90'),
  ('lan_prefix', '192.168.88.'),
  ('personal_data_retention_days', '30'),
  ('passenger_history_keep', '5')
on conflict (key) do nothing;

-- Snapshot do cadastro no pedido (no momento da compra). Não bloqueia nada: sem cadastro, fica nulo.
create or replace function public.hotspot_order_snapshot()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.payer_name is null and new.payer_email is null then
    select p.full_name, p.email into new.payer_name, new.payer_email
      from public.hotspot_passengers p where p.device_mac = new.device_mac;
  end if;
  return new;
end
$$;
drop trigger if exists hotspot_orders_snapshot on public.hotspot_orders;
create trigger hotspot_orders_snapshot before insert on public.hotspot_orders
  for each row execute function public.hotspot_order_snapshot();

-- ---------------------------------------------------------------------------
-- Presença: lista do MikroTik "MAC|IP|a;MAC|IP|n;..." (MAC com hífens). IP pode vir só com o último octeto.
-- Também aceita o formato antigo "MAC;MAC;". Até 150 aparelhos, 4000 caracteres.
-- ---------------------------------------------------------------------------
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
-- Cadastro (nome + e-mail). Só aparelhos presentes na rede (mesmo portão do checkout). Limites contra spam.
-- Resultado: created | updated | unchanged | unknown_device | invalid_mac | invalid_name | invalid_email | rate_limited
-- ---------------------------------------------------------------------------
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
  delete from public.hotspot_passenger_history
   where device_mac = v_mac
     and id not in (select h.id from public.hotspot_passenger_history h where h.device_mac = v_mac
                     order by h.changed_at desc, h.id desc
                     limit greatest(1, public.hotspot_setting('passenger_history_keep', '5')::integer));
  return jsonb_build_object('action', case when v_had then 'updated' else 'created' end);
end
$$;

-- Dica para o portal: o aparelho já tem cadastro? Devolve só dados MASCARADOS (o MAC trafega pelo ar e não é segredo).
create or replace function public.hotspot_passenger_hint(p_mac text)
returns jsonb
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_mac text := upper(btrim(coalesce(p_mac, '')));
  p public.hotspot_passengers%rowtype;
  v_words text[];
  v_user text;
begin
  if v_mac !~ '^([0-9A-F]{2}:){5}[0-9A-F]{2}$' or public.hotspot_device_gate(v_mac) = 'unknown' then
    return jsonb_build_object('registered', false);
  end if;
  select * into p from public.hotspot_passengers where device_mac = v_mac;
  if not found then
    return jsonb_build_object('registered', false);
  end if;
  v_words := string_to_array(p.full_name, ' ');
  v_user := split_part(p.email, '@', 1);
  return jsonb_build_object('registered', true,
    'name_hint', v_words[1] || case when array_length(v_words, 1) > 1 then ' ' || upper(left(v_words[array_length(v_words, 1)], 1)) || '.' else '' end,
    'email_hint', left(v_user, 1) || '***@' || split_part(p.email, '@', 2));
end
$$;

-- E-mail do cadastro (para o Mercado Pago). Só o servidor lê.
create or replace function public.hotspot_passenger_email(p_mac text)
returns text
language sql
stable
set search_path = public, pg_temp
as $$
  select email from public.hotspot_passengers where device_mac = upper(btrim(coalesce(p_mac, '')));
$$;

-- Checkout: exige cadastro (a menos que já exista Pix pendente / pagamento aguardando liberação desse aparelho,
-- que continuam sendo atendidos como antes).
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
begin
  if v_mac !~ '^([0-9A-F]{2}:){5}[0-9A-F]{2}$' then
    return jsonb_build_object('action', 'invalid_mac');
  end if;
  if public.hotspot_device_gate(v_mac) = 'unknown' then
    return jsonb_build_object('action', 'unknown_device');
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
  return v_r || jsonb_build_object('plan_name', v_p.name, 'amount_cents', v_p.price_cents, 'grant_seconds', v_p.grant_seconds);
end
$$;

-- ---------------------------------------------------------------------------
-- Visão consolidada de TODOS os aparelhos (presentes, cadastrados ou com pedidos)
-- ---------------------------------------------------------------------------
-- (reexecução segura: a revisão seguinte muda o formato de retorno destas funções)
drop function if exists public.hotspot_admin_passengers(text, text, integer, integer);
drop function if exists public.hotspot_admin_passenger(text);
drop function if exists public.hotspot_admin_people_summary();
drop function if exists public.hotspot_people();
create or replace function public.hotspot_people()
returns table (
  mac text, ip text, full_name text, email text, identified boolean, registered_at timestamptz,
  online boolean, browsing boolean, last_contact timestamptz,
  paid_count integer, total_paid_cents bigint, granted_seconds bigint, plan_name text,
  credit_state text, pix_pending boolean, paid_waiting boolean, remaining_seconds integer, used_seconds integer,
  status text
)
language sql
stable
set search_path = public, pg_temp
as $$
  with cfg as (
    select public.hotspot_setting('presence_seconds', '90')::integer as pres,
           public.hotspot_setting('telemetry_stale_seconds', '180')::integer as stale
  ), macs as (
    select device_mac from public.hotspot_known_hosts
    union select device_mac from public.hotspot_passengers
    union select device_mac from public.hotspot_orders
  ), ord as (
    select o.device_mac,
           (count(*) filter (where o.payment_status = 'paid' and not o.is_test))::integer as pc,
           coalesce(sum(o.amount_cents) filter (where o.payment_status = 'paid' and not o.is_test), 0)::bigint as tp,
           coalesce(sum(o.grant_seconds) filter (where o.provisioned_at is not null and o.payment_status in ('paid', 'refunded')), 0)::bigint as gs,
           coalesce(bool_or(o.payment_status = 'pending' and (o.expires_at is null or o.expires_at > now())), false) as pp,
           coalesce(bool_or(o.payment_status = 'paid' and o.provisioned_at is null), false) as pw,
           (array_agg(o.plan_name order by o.paid_at desc) filter (where o.payment_status = 'paid'))[1] as lp
      from public.hotspot_orders o group by o.device_mac
  ), x as (
    select m.device_mac as mac,
           p.full_name, p.email, (p.device_mac is not null) as identified, p.registered_at,
           coalesce(o.pc, 0) as pc, coalesce(o.tp, 0) as tp, coalesce(o.gs, 0) as gs,
           coalesce(o.pp, false) as pp, coalesce(o.pw, false) as pw, o.lp,
           coalesce(k.seen_at > now() - make_interval(secs => cfg.pres), false) as host_fresh,
           coalesce(s.session_active and s.reported_at > now() - make_interval(secs => cfg.stale), false) as browse,
           coalesce(s.reported_at > now() - make_interval(secs => cfg.stale), false) as tel_fresh,
           k.seen_at, k.ip as kip, s.ip as sip, s.limit_seconds, s.uptime_seconds, s.last_active_at,
           public.hotspot_device_credit_state(m.device_mac) as cs
      from macs m cross join cfg
      left join public.hotspot_passengers p on p.device_mac = m.device_mac
      left join public.hotspot_known_hosts k on k.device_mac = m.device_mac
      left join public.hotspot_device_state s on s.device_mac = m.device_mac
      left join ord o on o.device_mac = m.device_mac
  )
  select x.mac,
         case when x.host_fresh then coalesce(x.kip, x.sip) else coalesce(x.sip, x.kip) end,
         x.full_name, x.email, x.identified, x.registered_at,
         (x.host_fresh or x.browse), x.browse,
         greatest(x.seen_at, case when x.tel_fresh then x.last_active_at end),
         x.pc, x.tp, x.gs, x.lp, x.cs, x.pp, x.pw,
         case when x.tel_fresh and x.limit_seconds is not null and x.uptime_seconds is not null
              then greatest(x.limit_seconds - x.uptime_seconds, 0) end,
         case when x.tel_fresh then x.uptime_seconds end,
         case
           when x.pw then 'paid_waiting'
           when x.cs = 'active' and not (x.tel_fresh and x.limit_seconds is not null and x.uptime_seconds is not null
                                          and x.uptime_seconds >= x.limit_seconds) then 'active'
           when x.pp then 'pix_pending'
           when x.cs in ('active', 'exhausted') then 'exhausted'
           when x.identified then 'identified_unpaid'
           else 'not_identified'
         end
    from x;
$$;

-- Lista com filtros: all | online | offline | identified | unidentified | paid | unpaid | pix_pending | exhausted
create or replace function public.hotspot_admin_passengers(p_filter text, p_q text, p_limit integer, p_offset integer)
returns jsonb
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_f text := coalesce(nullif(btrim(p_filter), ''), 'all');
  v_q text := lower(btrim(coalesce(p_q, '')));
  v_lim integer := greatest(1, least(coalesce(p_limit, 50), 100));
  v_off integer := greatest(0, coalesce(p_offset, 0));
  v_total integer;
  v_rows jsonb;
begin
  if v_f not in ('all', 'online', 'offline', 'identified', 'unidentified', 'paid', 'unpaid', 'pix_pending', 'exhausted') then
    raise exception 'filtro invalido';
  end if;
  with f as (
    select * from public.hotspot_people() p
     where (v_f = 'all'
            or (v_f = 'online' and p.online) or (v_f = 'offline' and not p.online)
            or (v_f = 'identified' and p.identified) or (v_f = 'unidentified' and not p.identified)
            or (v_f = 'paid' and p.paid_count > 0) or (v_f = 'unpaid' and p.paid_count = 0)
            or (v_f = 'pix_pending' and p.pix_pending) or (v_f = 'exhausted' and p.credit_state = 'exhausted'))
       and (v_q = '' or position(v_q in lower(p.mac)) > 0 or position(v_q in lower(coalesce(p.full_name, ''))) > 0
            or position(v_q in lower(coalesce(p.email, ''))) > 0 or position(v_q in coalesce(p.ip, '')) > 0)
  )
  select (select count(*) from f),
         coalesce(jsonb_agg(to_jsonb(t) order by t.online desc, t.last_contact desc nulls last, t.mac), '[]'::jsonb)
    into v_total, v_rows
    from (select * from f order by online desc, last_contact desc nulls last, mac limit v_lim offset v_off) t;
  return jsonb_build_object('total', v_total, 'limit', v_lim, 'offset', v_off, 'rows', v_rows);
end
$$;

-- Cartões do Dashboard (cada MAC conta uma vez; "presentes" = online agora).
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
  r record;
begin
  begin
    v_feed := nullif(public.hotspot_setting('hosts_feed_at', ''), '')::timestamptz;
  exception when others then v_feed := null;
  end;
  select coalesce(sum(amount_cents), 0) into v_rev from public.hotspot_orders where payment_status = 'paid' and not is_test;
  select count(*) filter (where online) as present,
         count(*) filter (where online and identified) as present_identified,
         count(*) filter (where online and not identified) as present_unidentified,
         count(*) filter (where online and paid_count > 0) as present_paid,
         count(*) filter (where online and paid_count = 0) as present_unpaid,
         count(*) filter (where browsing) as browsing,
         count(*) as known_total,
         count(*) filter (where identified) as identified_total
    into r from public.hotspot_people();
  return jsonb_build_object(
    'present', r.present, 'present_identified', r.present_identified, 'present_unidentified', r.present_unidentified,
    'present_paid', r.present_paid, 'present_unpaid', r.present_unpaid, 'browsing', r.browsing,
    'known_total', r.known_total, 'identified_total', r.identified_total, 'revenue_total_cents', v_rev,
    'feed_at', v_feed, 'feed_fresh', (v_feed is not null and v_feed > now() - make_interval(secs => v_win)));
end
$$;

-- Detalhe de um passageiro: situação atual, compras (com o cadastro daquela época) e quem já usou o MAC.
create or replace function public.hotspot_admin_passenger(p_mac text)
returns jsonb
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_mac text := upper(btrim(coalesce(p_mac, '')));
  v_row jsonb;
  v_orders jsonb;
  v_hist jsonb;
begin
  if v_mac !~ '^([0-9A-F]{2}:){5}[0-9A-F]{2}$' then raise exception 'mac invalido'; end if;
  select to_jsonb(p) into v_row from public.hotspot_people() p where p.mac = v_mac;
  select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at desc), '[]'::jsonb) into v_orders from (
    select o.id, o.created_at, o.paid_at, o.provisioned_at, o.amount_cents, o.grant_seconds, o.is_test,
           coalesce(o.plan_name, 'Sem plano') as plan_name, o.payer_name, o.payer_email,
           public.hotspot_display_state(o.payment_status, o.mp_status, o.expires_at, o.provisioned_at) as state
      from public.hotspot_orders o where o.device_mac = v_mac order by o.created_at desc limit 50) t;
  select coalesce(jsonb_agg(to_jsonb(t) order by t.changed_at desc), '[]'::jsonb) into v_hist from (
    select h.full_name, h.email, h.changed_at from public.hotspot_passenger_history h
     where h.device_mac = v_mac order by h.changed_at desc limit 20) t;
  return jsonb_build_object('mac', v_mac, 'person', v_row, 'orders', v_orders, 'history', v_hist);
end
$$;

-- ---------------------------------------------------------------------------
-- Privacidade: exclusão individual (painel, só admin) e retenção. Valores pagos e pedidos são PRESERVADOS
-- (obrigação financeira); somente nome/e-mail são apagados.
-- ---------------------------------------------------------------------------
create or replace function public.hotspot_purge_personal(p_days integer)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_a integer; v_b integer; v_c integer;
  v_cut timestamptz;
begin
  if p_days is null or p_days < 0 then
    return jsonb_build_object('error', 'invalid_days');
  end if;
  v_cut := now() - make_interval(days => p_days);
  delete from public.hotspot_passengers p
   where p.last_activity_at < v_cut
     and not exists (select 1 from public.hotspot_orders o
                      where o.device_mac = p.device_mac
                        and (o.payment_status = 'pending' or (o.payment_status = 'paid' and o.provisioned_at is null)));
  get diagnostics v_a = row_count;
  delete from public.hotspot_passenger_history where changed_at < v_cut;
  get diagnostics v_b = row_count;
  update public.hotspot_orders set payer_name = null, payer_email = null
   where (payer_name is not null or payer_email is not null) and created_at < v_cut
     and payment_status not in ('pending');
  get diagnostics v_c = row_count;
  return jsonb_build_object('passengers_deleted', v_a, 'history_deleted', v_b, 'orders_anonymized', v_c);
end
$$;

create or replace function public.hotspot_admin_passenger_delete(p_actor uuid, p_actor_email text, p_mac text)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_mac text := upper(btrim(coalesce(p_mac, '')));
  v_a integer; v_b integer; v_c integer;
begin
  if not exists (select 1 from public.admin_users where user_id = p_actor and role = 'admin') then
    raise exception 'forbidden';
  end if;
  if v_mac !~ '^([0-9A-F]{2}:){5}[0-9A-F]{2}$' then raise exception 'mac invalido'; end if;
  delete from public.hotspot_passengers where device_mac = v_mac;
  get diagnostics v_a = row_count;
  delete from public.hotspot_passenger_history where device_mac = v_mac;
  get diagnostics v_b = row_count;
  update public.hotspot_orders set payer_name = null, payer_email = null
   where device_mac = v_mac and (payer_name is not null or payer_email is not null);
  get diagnostics v_c = row_count;
  insert into public.admin_audit_log (actor, actor_email, action, entity, entity_id, before_data, after_data)
  values (p_actor, p_actor_email, 'passenger_delete', 'passenger', v_mac, null,
          jsonb_build_object('registrations_deleted', v_a, 'history_deleted', v_b, 'orders_anonymized', v_c));
  return jsonb_build_object('registrations_deleted', v_a, 'history_deleted', v_b, 'orders_anonymized', v_c);
end
$$;

create or replace function public.hotspot_admin_personal_purge(p_actor uuid, p_actor_email text, p_days integer)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_r jsonb;
begin
  if not exists (select 1 from public.admin_users where user_id = p_actor and role = 'admin') then
    raise exception 'forbidden';
  end if;
  if p_days is null or p_days < 0 or p_days > 3650 then raise exception 'dias invalidos'; end if;
  v_r := public.hotspot_purge_personal(p_days);
  insert into public.admin_audit_log (actor, actor_email, action, entity, entity_id, before_data, after_data)
  values (p_actor, p_actor_email, 'personal_purge', 'passenger', p_days::text, null, v_r);
  return v_r;
end
$$;

-- Limpeza diária (mesma da revisão anterior + retenção de dados pessoais).
create or replace function public.hotspot_maintenance()
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_last timestamptz;
  v_fail integer := public.hotspot_setting('failed_orders_retention_days', '30')::integer;
  v_pend integer := public.hotspot_setting('pending_orders_retention_days', '7')::integer;
  v_keep integer := public.hotspot_setting('personal_data_retention_days', '30')::integer;
  v_a integer; v_b integer; v_p jsonb;
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
  v_p := public.hotspot_purge_personal(greatest(v_keep, 1));
  return jsonb_build_object('ran', true, 'failed_expired_deleted', v_a, 'pending_deleted', v_b, 'personal', v_p);
end
$$;

-- ---------------------------------------------------------------------------
-- Permissões: somente service_role (nunca anon/authenticated).
-- ---------------------------------------------------------------------------
do $$
declare
  f text;
begin
  foreach f in array array[
    'hotspot_order_snapshot()',
    'hotspot_router_report_hosts(text)',
    'hotspot_register_passenger(text,text,text)',
    'hotspot_passenger_hint(text)',
    'hotspot_passenger_email(text)',
    'hotspot_reserve_plan_order(text,uuid)',
    'hotspot_people()',
    'hotspot_admin_passengers(text,text,integer,integer)',
    'hotspot_admin_people_summary()',
    'hotspot_admin_passenger(text)',
    'hotspot_purge_personal(integer)',
    'hotspot_admin_passenger_delete(uuid,text,text)',
    'hotspot_admin_personal_purge(uuid,text,integer)',
    'hotspot_maintenance()'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end
$$;
