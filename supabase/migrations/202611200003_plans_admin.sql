-- Planos e preços, painel administrativo, telemetria do roteador (revisão 6). ADITIVA:
-- não apaga pedidos, não altera o valor/duração (snapshot) de nenhum pedido existente.
--
-- * hotspot_plans: planos editáveis pelo painel. Cada pedido congela preço e duração no momento da criação
--   (hotspot_orders.amount_cents / grant_seconds + plan_id / plan_name). Mudar o plano só vale para novas compras.
-- * admin_users / admin_audit_log: quem pode usar o painel (allowlist; estar autenticado NÃO basta) e o histórico de alterações.
-- * hotspot_device_state: último relatório de sessões enviado pelo MikroTik (telemetria agregada).
-- * Funções hotspot_admin_*: somente service_role; a Edge Function admin-api autoriza ANTES de chamá-las.

-- ---------------------------------------------------------------------------
-- Configurações operacionais (limites configuráveis)
-- ---------------------------------------------------------------------------
create table if not exists public.hotspot_settings (
  key text primary key check (key ~ '^[a-z_]{1,40}$'),
  value text not null check (char_length(value) <= 100),
  updated_at timestamptz not null default now()
);
alter table public.hotspot_settings enable row level security;
revoke all privileges on table public.hotspot_settings from public, anon, authenticated;
insert into public.hotspot_settings (key, value) values
  ('timezone', 'America/Fortaleza'),
  ('router_offline_seconds', '180'),
  ('telemetry_stale_seconds', '180'),
  ('paid_wait_alert_seconds', '300'),
  ('router_name', 'MikroTik hEX lite'),
  ('site_name', 'Ônibus')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- Planos
-- ---------------------------------------------------------------------------
create table if not exists public.hotspot_plans (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 60),
  description text check (description is null or char_length(description) <= 200),
  price_cents integer not null check (price_cents between 100 and 50000),
  grant_seconds integer not null check (grant_seconds between 60 and 172800),
  active boolean not null default false,
  highlight boolean not null default false,
  is_default boolean not null default false,
  sort_order integer not null default 0 check (sort_order between -1000 and 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.hotspot_plans enable row level security;
revoke all privileges on table public.hotspot_plans from public, anon, authenticated;
create unique index if not exists hotspot_plans_one_default on public.hotspot_plans (is_default) where is_default;
create unique index if not exists hotspot_plans_one_highlight on public.hotspot_plans (highlight) where highlight;

-- Plano atual (R$ 5,00 / 5 horas) como único plano ativo e padrão. Só é criado se ainda não existir nenhum plano.
insert into public.hotspot_plans (name, price_cents, grant_seconds, active, is_default, sort_order)
select '5 horas', 500, 18000, true, true, 0
 where not exists (select 1 from public.hotspot_plans);

-- Pedidos: vínculo com o plano (snapshot), marca de teste e taxas do Mercado Pago (quando informadas).
alter table public.hotspot_orders add column if not exists plan_id uuid references public.hotspot_plans (id) on delete restrict;
alter table public.hotspot_orders add column if not exists plan_name text;
alter table public.hotspot_orders add column if not exists is_test boolean not null default false;
alter table public.hotspot_orders add column if not exists mp_fee_cents integer check (mp_fee_cents is null or mp_fee_cents >= 0);
alter table public.hotspot_orders add column if not exists mp_net_cents integer check (mp_net_cents is null or mp_net_cents >= 0);
create index if not exists hotspot_orders_paid_at on public.hotspot_orders (paid_at) where paid_at is not null;

-- Pedidos já encerrados com exatamente R$ 5,00 / 5 h recebem o rótulo do plano (não mexe em Pix pendente).
update public.hotspot_orders o
   set plan_id = (select p.id from public.hotspot_plans p where p.is_default limit 1), plan_name = '5 horas'
 where o.plan_id is null and o.plan_name is null and o.payment_status <> 'pending'
   and o.amount_cents = 500 and o.grant_seconds = 18000 and not o.is_test
   and exists (select 1 from public.hotspot_plans p where p.is_default);

-- ---------------------------------------------------------------------------
-- Administradores e auditoria
-- ---------------------------------------------------------------------------
create table if not exists public.admin_users (
  user_id uuid primary key references auth.users (id) on delete cascade,
  role text not null check (role in ('admin', 'operator')),
  created_at timestamptz not null default now()
);
alter table public.admin_users enable row level security;
revoke all privileges on table public.admin_users from public, anon, authenticated;

create table if not exists public.admin_audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor uuid,
  actor_email text,
  action text not null,
  entity text not null,
  entity_id text,
  before_data jsonb,
  after_data jsonb
);
alter table public.admin_audit_log enable row level security;
revoke all privileges on table public.admin_audit_log from public, anon, authenticated;
create index if not exists admin_audit_log_at on public.admin_audit_log (at desc);

-- ---------------------------------------------------------------------------
-- Telemetria do roteador (relatório agregado de sessões)
-- ---------------------------------------------------------------------------
alter table public.hotspot_router_state add column if not exists last_telemetry_at timestamptz;
alter table public.hotspot_router_state add column if not exists sessions_online integer;

create table if not exists public.hotspot_device_state (
  device_mac text primary key check (device_mac ~ '^([0-9A-F]{2}:){5}[0-9A-F]{2}$'),
  ip text,
  uptime_seconds integer check (uptime_seconds is null or uptime_seconds >= 0),
  limit_seconds integer check (limit_seconds is null or limit_seconds >= 0),
  session_active boolean not null default false,
  last_active_at timestamptz,
  reported_at timestamptz not null default now()
);
alter table public.hotspot_device_state enable row level security;
revoke all privileges on table public.hotspot_device_state from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Auxiliares
-- ---------------------------------------------------------------------------
create or replace function public.hotspot_setting(p_key text, p_default text)
returns text
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce((select value from public.hotspot_settings where key = p_key), p_default);
$$;

-- Estado de exibição do pedido (não confunde pagamento aprovado com internet liberada).
create or replace function public.hotspot_display_state(
  p_status text, p_mp_status text, p_expires timestamptz, p_provisioned timestamptz
) returns text
language sql
stable
set search_path = public, pg_temp
as $$
  select case
    when p_status = 'pending' and (p_expires is null or p_expires > now()) then 'pending'
    when p_status = 'pending' then 'expired'
    when p_status = 'paid' and p_provisioned is null then 'approved_waiting'
    when p_status = 'paid' then 'provisioned'
    when p_status = 'refunded' then 'refunded'
    when p_status = 'expired' then 'expired'
    when p_status = 'failed' and p_mp_status = 'cancelled' then 'cancelled'
    else 'failed'
  end;
$$;

-- ---------------------------------------------------------------------------
-- Checkout: reserva de pedido com snapshot do plano
-- ---------------------------------------------------------------------------
drop function if exists public.hotspot_reserve_order(text, integer, integer);
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
     or p_grant_seconds is null or p_grant_seconds < 60 or p_grant_seconds > 604800 then
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

-- Escolhe o plano NO SERVIDOR (o navegador só informa o identificador) e congela preço/duração.
-- Sem identificador: plano padrão ativo (ou o único plano ativo).
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

-- Planos ativos para o portal (somente dados públicos do plano).
create or replace function public.hotspot_public_plans()
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', id, 'name', name, 'description', description, 'price_cents', price_cents,
           'grant_seconds', grant_seconds, 'highlight', highlight, 'is_default', is_default)
         order by sort_order, price_cents, created_at), '[]'::jsonb)
    from public.hotspot_plans where active;
$$;

-- Taxas informadas pelo Mercado Pago (opcional; melhor esforço).
create or replace function public.hotspot_record_fees(p_order_id uuid, p_fee_cents integer, p_net_cents integer)
returns boolean
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if p_fee_cents is null or p_fee_cents < 0 or p_net_cents is null or p_net_cents < 0 then
    return false;
  end if;
  update public.hotspot_orders
     set mp_fee_cents = p_fee_cents, mp_net_cents = p_net_cents, updated_at = now()
   where id = p_order_id and payment_status in ('paid', 'refunded');
  return found;
end
$$;

-- ---------------------------------------------------------------------------
-- Telemetria: relatório agregado de sessões (até 20 aparelhos por chamada)
-- ---------------------------------------------------------------------------
create or replace function public.hotspot_router_report_state(p_online integer, p_rows jsonb)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  r record;
  v_mac text;
  v_ip text;
  v_ok integer := 0;
  v_skip integer := 0;
begin
  insert into public.hotspot_router_state (id, last_seen_at, last_telemetry_at, sessions_online)
  values (1, now(), now(), case when p_online between 0 and 5000 then p_online else null end)
  on conflict (id) do update
     set last_telemetry_at = now(),
         sessions_online = case when p_online between 0 and 5000 then p_online
                                else public.hotspot_router_state.sessions_online end;

  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    return jsonb_build_object('accepted', 0, 'ignored', 0);
  end if;

  for r in
    select * from jsonb_to_recordset(p_rows)
      as x(mac text, ip text, uptime integer, lim integer, active boolean)
     limit 20
  loop
    v_mac := upper(btrim(coalesce(r.mac, '')));
    if v_mac !~ '^([0-9A-F]{2}:){5}[0-9A-F]{2}$'
       or r.uptime is null or r.uptime < 0 or r.uptime > 100000000
       or (r.lim is not null and (r.lim < 0 or r.lim > 100000000))
       or not exists (select 1 from public.hotspot_orders o where o.device_mac = v_mac) then
      v_skip := v_skip + 1;
      continue;
    end if;
    v_ip := case when r.ip ~ '^[0-9]{1,3}(\.[0-9]{1,3}){3}$' then r.ip else null end;
    insert into public.hotspot_device_state as d
      (device_mac, ip, uptime_seconds, limit_seconds, session_active, last_active_at, reported_at)
    values (v_mac, v_ip, r.uptime, nullif(r.lim, 0), coalesce(r.active, false),
            case when coalesce(r.active, false) then now() else null end, now())
    on conflict (device_mac) do update
       set ip = coalesce(excluded.ip, d.ip),
           uptime_seconds = excluded.uptime_seconds,
           limit_seconds = excluded.limit_seconds,
           session_active = excluded.session_active,
           last_active_at = case when excluded.session_active then now() else d.last_active_at end,
           reported_at = now();
    v_ok := v_ok + 1;
  end loop;
  return jsonb_build_object('accepted', v_ok, 'ignored', v_skip);
end
$$;

-- Privacidade: a limpeza também remove o estado dos aparelhos sem nenhum pedido restante.
create or replace function public.hotspot_purge(p_days integer default 30)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_n integer;
begin
  if p_days is null or p_days < 0 then
    return jsonb_build_object('deleted', 0, 'error', 'invalid_days');
  end if;
  delete from public.hotspot_orders
   where payment_status <> 'pending'
     and created_at < now() - make_interval(days => p_days);
  get diagnostics v_n = row_count;
  delete from public.hotspot_device_credit c
   where not exists (select 1 from public.hotspot_orders o where o.device_mac = c.device_mac);
  delete from public.hotspot_device_state s
   where not exists (select 1 from public.hotspot_orders o where o.device_mac = s.device_mac);
  return jsonb_build_object('deleted', v_n);
end
$$;

-- ---------------------------------------------------------------------------
-- Painel: funções de leitura/escrita (chamadas só pela Edge Function admin-api, já autorizada)
-- ---------------------------------------------------------------------------
create or replace function public.hotspot_admin_get_role(p_user uuid)
returns text
language sql
stable
set search_path = public, pg_temp
as $$
  select role from public.admin_users where user_id = p_user;
$$;

-- Período no fuso configurado. Presets: today, yesterday, last7, last30, month, custom (datas inclusivas).
create or replace function public.hotspot_admin_period(p_preset text, p_start date default null, p_end date default null)
returns jsonb
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_tz text := public.hotspot_setting('timezone', 'America/Fortaleza');
  v_today date := (now() at time zone v_tz)::date;
  v_s date;
  v_e date; -- exclusivo
begin
  case coalesce(p_preset, 'today')
    when 'today' then v_s := v_today; v_e := v_today + 1;
    when 'yesterday' then v_s := v_today - 1; v_e := v_today;
    when 'last7' then v_s := v_today - 6; v_e := v_today + 1;
    when 'last30' then v_s := v_today - 29; v_e := v_today + 1;
    when 'month' then v_s := date_trunc('month', v_today)::date; v_e := v_today + 1;
    when 'custom' then
      if p_start is null or p_end is null or p_end < p_start or p_end - p_start > 365 then
        raise exception 'periodo invalido';
      end if;
      v_s := p_start; v_e := p_end + 1;
    else raise exception 'periodo invalido';
  end case;
  return jsonb_build_object(
    'preset', coalesce(p_preset, 'today'),
    'from', (v_s::timestamp at time zone v_tz),
    'to', (v_e::timestamp at time zone v_tz),
    'start_date', v_s, 'end_date', v_e - 1,
    'bucket', case when v_e - v_s <= 1 then 'hour' else 'day' end,
    'timezone', v_tz);
end
$$;

-- Indicadores do período. Receita = pedidos 'paid' (aprovados, não estornados) e não marcados como teste, em centavos.
create or replace function public.hotspot_admin_overview(p_from timestamptz, p_to timestamptz)
returns jsonb
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_len interval := p_to - p_from;
  c_sales integer; c_rev bigint; c_secs bigint; c_dev integer; c_fee bigint; c_feen integer;
  p_sales integer; p_rev bigint;
  r_n integer; r_c bigint;
  w_n integer; w_c bigint;
  t_n integer;
  v_plans jsonb;
  v_total bigint;
begin
  if p_from is null or p_to is null or p_to <= p_from then raise exception 'periodo invalido'; end if;

  select count(*), coalesce(sum(amount_cents), 0), coalesce(sum(grant_seconds), 0), count(distinct device_mac),
         coalesce(sum(mp_fee_cents), 0), count(mp_fee_cents)
    into c_sales, c_rev, c_secs, c_dev, c_fee, c_feen
    from public.hotspot_orders
   where payment_status = 'paid' and not is_test and paid_at >= p_from and paid_at < p_to;

  select count(*), coalesce(sum(amount_cents), 0) into p_sales, p_rev
    from public.hotspot_orders
   where payment_status = 'paid' and not is_test and paid_at >= p_from - v_len and paid_at < p_from;

  select count(*), coalesce(sum(amount_cents), 0) into r_n, r_c
    from public.hotspot_orders
   where payment_status = 'refunded' and not is_test and refunded_at >= p_from and refunded_at < p_to;

  select count(*), coalesce(sum(amount_cents), 0) into w_n, w_c
    from public.hotspot_orders
   where payment_status = 'pending' and not is_test and (expires_at is null or expires_at > now());

  select count(*) into t_n from public.hotspot_orders
   where is_test and (paid_at >= p_from and paid_at < p_to or created_at >= p_from and created_at < p_to);

  v_total := c_rev;
  select coalesce(jsonb_agg(x order by (x->>'revenue_cents')::bigint desc, x->>'name'), '[]'::jsonb) into v_plans
    from (
      select jsonb_build_object(
               'name', coalesce(plan_name, 'Sem plano (' || (grant_seconds / 60) || ' min)'),
               'sales', count(*), 'revenue_cents', sum(amount_cents), 'seconds_sold', sum(grant_seconds),
               'share_pct', case when v_total > 0 then round(sum(amount_cents) * 100.0 / v_total, 1) else 0 end) as x
        from public.hotspot_orders
       where payment_status = 'paid' and not is_test and paid_at >= p_from and paid_at < p_to
       group by coalesce(plan_name, 'Sem plano (' || (grant_seconds / 60) || ' min)')
    ) q;

  return jsonb_build_object(
    'sales_count', c_sales, 'revenue_cents', c_rev,
    'prev_sales_count', p_sales, 'prev_revenue_cents', p_rev,
    'revenue_change_pct', case when p_rev > 0 then round((c_rev - p_rev) * 100.0 / p_rev, 1) else null end,
    'sales_change_pct', case when p_sales > 0 then round((c_sales - p_sales) * 100.0 / p_sales, 1) else null end,
    'avg_ticket_cents', case when c_sales > 0 then round(c_rev::numeric / c_sales) else null end,
    'seconds_sold', c_secs, 'devices_served', c_dev,
    'refunds_count', r_n, 'refunds_cents', r_c,
    'pending_count', w_n, 'pending_cents', w_c,
    'test_orders_excluded', t_n,
    'fees_cents', c_fee, 'fees_known_for', c_feen,
    'net_estimated_cents', case when c_sales > 0 and c_feen = c_sales then c_rev - c_fee else null end,
    'by_plan', v_plans);
end
$$;

-- Situação atual (não depende do período): roteador, sessões, passes ativos e alertas reais.
create or replace function public.hotspot_admin_live()
returns jsonb
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  s public.hotspot_router_state%rowtype;
  v_off integer := public.hotspot_setting('router_offline_seconds', '180')::integer;
  v_stale integer := public.hotspot_setting('telemetry_stale_seconds', '180')::integer;
  v_wait integer := public.hotspot_setting('paid_wait_alert_seconds', '300')::integer;
  v_since numeric;
  v_tel_age numeric;
  v_online boolean;
  v_fresh boolean;
  v_alerts jsonb := '[]'::jsonb;
  v_n integer;
  v_old timestamptz;
  v_passes integer;
begin
  select * into s from public.hotspot_router_state where id = 1;
  v_since := case when s.last_seen_at is null then null else extract(epoch from (now() - s.last_seen_at)) end;
  v_tel_age := case when s.last_telemetry_at is null then null else extract(epoch from (now() - s.last_telemetry_at)) end;
  v_online := v_since is not null and v_since <= v_off;
  v_fresh := v_online and v_tel_age is not null and v_tel_age <= v_stale;

  if not v_online then
    v_alerts := v_alerts || jsonb_build_array(jsonb_build_object(
      'code', 'router_offline', 'severity', 'error', 'since', s.last_seen_at, 'count', 1,
      'message', case when s.last_seen_at is null then 'O MikroTik ainda não entrou em contato.'
                      else 'O MikroTik está sem comunicação além do limite configurado.' end));
  elsif s.last_telemetry_at is not null and not v_fresh then
    v_alerts := v_alerts || jsonb_build_array(jsonb_build_object(
      'code', 'telemetry_stale', 'severity', 'warning', 'since', s.last_telemetry_at, 'count', 1,
      'message', 'Os dados de sessões estão desatualizados.'));
  end if;

  select count(*), min(paid_at) into v_n, v_old from public.hotspot_orders
   where payment_status = 'paid' and provisioned_at is null and not is_test
     and paid_at < now() - make_interval(secs => v_wait);
  if v_n > 0 then
    v_alerts := v_alerts || jsonb_build_array(jsonb_build_object(
      'code', 'paid_waiting', 'severity', 'error', 'since', v_old, 'count', v_n,
      'message', 'Pagamento aprovado aguardando liberação além do tempo esperado.'));
  end if;

  select count(*), min(created_at) into v_n, v_old from public.hotspot_orders
   where payment_status = 'failed' and not is_test and created_at > now() - interval '1 hour';
  if v_n >= 3 then
    v_alerts := v_alerts || jsonb_build_array(jsonb_build_object(
      'code', 'payment_failures', 'severity', 'warning', 'since', v_old, 'count', v_n,
      'message', 'Várias cobranças Pix falharam na última hora.'));
  end if;

  select count(*) into v_passes from (
    select distinct device_mac from public.hotspot_orders
     where payment_status in ('paid', 'refunded') and provisioned_at is not null) d
   where public.hotspot_device_credit_state(d.device_mac) = 'active';

  return jsonb_build_object(
    'router', jsonb_build_object(
      'name', public.hotspot_setting('router_name', 'MikroTik'),
      'site', public.hotspot_setting('site_name', ''),
      'online', v_online, 'last_seen_at', s.last_seen_at, 'seconds_since_contact', round(v_since),
      'last_telemetry_at', s.last_telemetry_at, 'telemetry_age_seconds', round(v_tel_age),
      'telemetry_fresh', v_fresh,
      'integration', case when s.last_seen_at is null then 'never'
                          when not v_online then 'offline'
                          when s.last_telemetry_at is null then 'no_telemetry'
                          when not v_fresh then 'telemetry_stale' else 'ok' end),
    'routers_total', 1, 'routers_online', case when v_online then 1 else 0 end,
    'sessions_online', case when v_fresh then s.sessions_online else null end,
    'sessions_last_known', s.sessions_online,
    'offline_after_seconds', v_off, 'stale_after_seconds', v_stale,
    'active_passes', v_passes,
    'alerts', v_alerts, 'server_time', now());
end
$$;

-- Série para o gráfico (hora ou dia no fuso configurado), com zeros nos intervalos sem venda.
create or replace function public.hotspot_admin_series(p_from timestamptz, p_to timestamptz, p_bucket text)
returns jsonb
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_tz text := public.hotspot_setting('timezone', 'America/Fortaleza');
  v_out jsonb;
begin
  if p_bucket not in ('hour', 'day') or p_to <= p_from then raise exception 'parametros invalidos'; end if;
  if (p_bucket = 'hour' and p_to - p_from > interval '49 hours') or (p_bucket = 'day' and p_to - p_from > interval '367 days') then
    raise exception 'periodo grande demais';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'label', to_char(g.b, 'YYYY-MM-DD"T"HH24:MI'),
           'sales', coalesce(a.n, 0), 'revenue_cents', coalesce(a.rev, 0)) order by g.b), '[]'::jsonb)
    into v_out
    from generate_series(
           date_trunc(p_bucket, p_from at time zone v_tz),
           date_trunc(p_bucket, (p_to - interval '1 second') at time zone v_tz),
           ('1 ' || p_bucket)::interval) as g(b)
    left join (
      select date_trunc(p_bucket, paid_at at time zone v_tz) as b, count(*) as n, sum(amount_cents) as rev
        from public.hotspot_orders
       where payment_status = 'paid' and not is_test and paid_at >= p_from and paid_at < p_to
       group by 1) a on a.b = g.b;
  return jsonb_build_object('bucket', p_bucket, 'timezone', v_tz, 'points', v_out);
end
$$;

-- Lista paginada de pagamentos. Status: pending, approved_waiting, provisioned, expired, failed, cancelled, refunded.
create or replace function public.hotspot_admin_orders(
  p_limit integer, p_offset integer, p_status text, p_from timestamptz, p_to timestamptz, p_q text
) returns jsonb
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_lim integer := greatest(1, least(coalesce(p_limit, 20), 100));
  v_off integer := greatest(0, coalesce(p_offset, 0));
  v_q text := lower(btrim(coalesce(p_q, '')));
  v_total integer;
  v_rows jsonb;
begin
  select count(*) into v_total from public.hotspot_orders o
   where (p_from is null or o.created_at >= p_from) and (p_to is null or o.created_at < p_to)
     and (p_status is null or p_status = ''
          or public.hotspot_display_state(o.payment_status, o.mp_status, o.expires_at, o.provisioned_at) = p_status)
     and (v_q = '' or position(v_q in lower(coalesce(o.payment_id, ''))) > 0
          or position(v_q in lower(o.device_mac)) > 0 or position(v_q in o.id::text) > 0);
  select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at desc), '[]'::jsonb) into v_rows from (
    select o.id, o.created_at, o.paid_at, o.provisioned_at, o.device_mac, o.payment_id,
           o.amount_cents, o.grant_seconds, o.is_test, o.mp_fee_cents, o.mp_net_cents,
           coalesce(o.plan_name, 'Sem plano') as plan_name,
           public.hotspot_display_state(o.payment_status, o.mp_status, o.expires_at, o.provisioned_at) as state
      from public.hotspot_orders o
     where (p_from is null or o.created_at >= p_from) and (p_to is null or o.created_at < p_to)
       and (p_status is null or p_status = ''
            or public.hotspot_display_state(o.payment_status, o.mp_status, o.expires_at, o.provisioned_at) = p_status)
       and (v_q = '' or position(v_q in lower(coalesce(o.payment_id, ''))) > 0
            or position(v_q in lower(o.device_mac)) > 0 or position(v_q in o.id::text) > 0)
     order by o.created_at desc limit v_lim offset v_off) t;
  return jsonb_build_object('total', v_total, 'limit', v_lim, 'offset', v_off, 'rows', v_rows);
end
$$;

-- Aparelhos: crédito (backend) + sessão/uso/limite (telemetria do MikroTik).
create or replace function public.hotspot_admin_devices(p_limit integer, p_offset integer, p_q text)
returns jsonb
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_lim integer := greatest(1, least(coalesce(p_limit, 25), 100));
  v_off integer := greatest(0, coalesce(p_offset, 0));
  v_q text := lower(btrim(coalesce(p_q, '')));
  v_stale integer := public.hotspot_setting('telemetry_stale_seconds', '180')::integer;
  v_total integer;
  v_rows jsonb;
begin
  with base as (
    select o.device_mac,
           count(*) filter (where o.payment_status = 'paid' and not o.is_test) as purchases,
           coalesce(sum(o.amount_cents) filter (where o.payment_status = 'paid' and not o.is_test), 0) as total_paid_cents,
           coalesce(sum(o.grant_seconds) filter (where o.provisioned_at is not null), 0) as granted_seconds,
           max(o.provisioned_at) as last_provisioned_at
      from public.hotspot_orders o
     where o.payment_status in ('paid', 'refunded') or o.provisioned_at is not null
     group by o.device_mac
  ), f as (
    select * from base where v_q = '' or position(v_q in lower(device_mac)) > 0
  )
  select (select count(*) from f),
         coalesce(jsonb_agg(to_jsonb(t) order by t.last_seen desc nulls last, t.mac), '[]'::jsonb)
    into v_total, v_rows
  from (
    select f.device_mac as mac, s.ip, f.purchases, f.total_paid_cents, f.granted_seconds,
           public.hotspot_device_credit_state(f.device_mac) as credit_state,
           s.reported_at, s.last_active_at,
           (s.reported_at is not null and s.reported_at > now() - make_interval(secs => v_stale)) as telemetry_fresh,
           s.uptime_seconds as used_seconds, s.limit_seconds,
           case when s.limit_seconds is not null and s.uptime_seconds is not null
                then greatest(s.limit_seconds - s.uptime_seconds, 0) else null end as remaining_seconds,
           (coalesce(s.session_active, false) and s.reported_at > now() - make_interval(secs => v_stale)) as online,
           s.session_active as session_active_last_known,
           coalesce(s.last_active_at, f.last_provisioned_at) as last_seen
      from f left join public.hotspot_device_state s on s.device_mac = f.device_mac
     order by coalesce(s.last_active_at, f.last_provisioned_at) desc nulls last, f.device_mac
     limit v_lim offset v_off) t;
  return jsonb_build_object('total', v_total, 'limit', v_lim, 'offset', v_off, 'rows', v_rows);
end
$$;

create or replace function public.hotspot_admin_device(p_mac text)
returns jsonb
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_mac text := upper(btrim(coalesce(p_mac, '')));
  v_dev jsonb;
  v_orders jsonb;
begin
  if v_mac !~ '^([0-9A-F]{2}:){5}[0-9A-F]{2}$' then raise exception 'mac invalido'; end if;
  select to_jsonb(s) into v_dev from public.hotspot_device_state s where s.device_mac = v_mac;
  select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at desc), '[]'::jsonb) into v_orders from (
    select o.id, o.created_at, o.paid_at, o.provisioned_at, o.amount_cents, o.grant_seconds, o.is_test,
           coalesce(o.plan_name, 'Sem plano') as plan_name,
           public.hotspot_display_state(o.payment_status, o.mp_status, o.expires_at, o.provisioned_at) as state
      from public.hotspot_orders o where o.device_mac = v_mac
     order by o.created_at desc limit 50) t;
  return jsonb_build_object('mac', v_mac, 'credit_state', public.hotspot_device_credit_state(v_mac),
                            'telemetry', v_dev, 'orders', v_orders,
                            'stale_after_seconds', public.hotspot_setting('telemetry_stale_seconds', '180')::integer);
end
$$;

-- Planos com estatísticas (vendas válidas e receita por plano; histórico preservado pelo snapshot do pedido).
create or replace function public.hotspot_admin_plans()
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(to_jsonb(t) order by t.sort_order, t.price_cents, t.created_at), '[]'::jsonb) from (
    select p.id, p.name, p.description, p.price_cents, p.grant_seconds, p.active, p.highlight, p.is_default,
           p.sort_order, p.created_at, p.updated_at,
           (select count(*) from public.hotspot_orders o where o.plan_id = p.id and o.payment_status = 'paid' and not o.is_test) as sales,
           (select coalesce(sum(o.amount_cents), 0) from public.hotspot_orders o where o.plan_id = p.id and o.payment_status = 'paid' and not o.is_test) as revenue_cents,
           (select max(o.paid_at) from public.hotspot_orders o where o.plan_id = p.id and o.payment_status = 'paid' and not o.is_test) as last_sale_at
      from public.hotspot_plans p) t;
$$;

-- Cria/edita plano. Somente administradores (conferido aqui também). Valores só valem para compras futuras.
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
  v_secs := (p_plan->>'grant_seconds')::integer;
  if v_price < 100 or v_price > 50000 then raise exception 'preco fora dos limites (R$ 1,00 a R$ 500,00)'; end if;
  if v_secs < 60 or v_secs > 172800 then raise exception 'duracao fora dos limites (1 minuto a 48 horas)'; end if;
  if v_sort < -1000 or v_sort > 1000 then raise exception 'ordem invalida'; end if;
  if v_def and not v_active then raise exception 'o plano padrao precisa estar ativo'; end if;

  if v_id is not null then
    select * into v_old from public.hotspot_plans where id = v_id for update;
    if not found then raise exception 'plano nao encontrado'; end if;
  end if;

  -- Sempre deve restar ao menos um plano ativo.
  select count(*) into v_n from public.hotspot_plans where active and id is distinct from v_id;
  if not v_active and v_n = 0 then raise exception 'mantenha ao menos um plano ativo'; end if;

  if v_def then update public.hotspot_plans set is_default = false where is_default and id is distinct from v_id; end if;
  if v_high then update public.hotspot_plans set highlight = false where highlight and id is distinct from v_id; end if;

  if v_id is null then
    insert into public.hotspot_plans (name, description, price_cents, grant_seconds, active, highlight, is_default, sort_order)
    values (v_name, v_desc, v_price, v_secs, v_active, v_high, v_def, v_sort)
    returning * into v_new;
  else
    update public.hotspot_plans
       set name = v_name, description = v_desc, price_cents = v_price, grant_seconds = v_secs,
           active = v_active, highlight = v_high, is_default = v_def, sort_order = v_sort, updated_at = now()
     where id = v_id returning * into v_new;
  end if;

  -- Sempre há um padrão ativo: se o padrão saiu (desativado ou desmarcado), o primeiro plano ativo assume.
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

-- Relatório agrupado (day, week, month) no fuso configurado.
create or replace function public.hotspot_admin_report(p_from timestamptz, p_to timestamptz, p_group text)
returns jsonb
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_tz text := public.hotspot_setting('timezone', 'America/Fortaleza');
  v_rows jsonb;
  v_tot jsonb;
begin
  if p_group not in ('day', 'week', 'month') or p_to <= p_from or p_to - p_from > interval '731 days' then
    raise exception 'parametros invalidos';
  end if;
  select coalesce(jsonb_agg(to_jsonb(t) order by t.period), '[]'::jsonb) into v_rows from (
    select to_char(date_trunc(p_group, paid_at at time zone v_tz), 'YYYY-MM-DD') as period,
           count(*) as sales, sum(amount_cents) as revenue_cents,
           round(sum(amount_cents)::numeric / count(*)) as avg_ticket_cents,
           sum(grant_seconds) as seconds_sold, count(distinct device_mac) as devices,
           coalesce(sum(mp_fee_cents), 0) as fees_cents, count(mp_fee_cents) as fees_known_for
      from public.hotspot_orders
     where payment_status = 'paid' and not is_test and paid_at >= p_from and paid_at < p_to
     group by 1) t;
  select jsonb_build_object(
           'sales', count(*), 'revenue_cents', coalesce(sum(amount_cents), 0),
           'avg_ticket_cents', case when count(*) > 0 then round(sum(amount_cents)::numeric / count(*)) else null end,
           'seconds_sold', coalesce(sum(grant_seconds), 0), 'devices', count(distinct device_mac))
    into v_tot
    from public.hotspot_orders
   where payment_status = 'paid' and not is_test and paid_at >= p_from and paid_at < p_to;
  return jsonb_build_object('group', p_group, 'timezone', v_tz, 'rows', v_rows, 'totals', v_tot,
    'refunds_cents', (select coalesce(sum(amount_cents), 0) from public.hotspot_orders
                       where payment_status = 'refunded' and not is_test and refunded_at >= p_from and refunded_at < p_to));
end
$$;

create or replace function public.hotspot_admin_settings()
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) from public.hotspot_settings;
$$;

create or replace function public.hotspot_admin_setting_set(p_actor uuid, p_actor_email text, p_key text, p_value text)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_old text;
begin
  if not exists (select 1 from public.admin_users where user_id = p_actor and role = 'admin') then
    raise exception 'forbidden';
  end if;
  if p_key not in ('router_offline_seconds', 'telemetry_stale_seconds', 'paid_wait_alert_seconds', 'router_name', 'site_name') then
    raise exception 'configuracao desconhecida';
  end if;
  if p_key like '%_seconds' then
    if p_value !~ '^[0-9]{2,5}$' or p_value::integer < 30 or p_value::integer > 86400 then
      raise exception 'valor invalido (30 a 86400 segundos)';
    end if;
  elsif char_length(btrim(coalesce(p_value, ''))) not between 1 and 60 then
    raise exception 'texto invalido';
  end if;
  select value into v_old from public.hotspot_settings where key = p_key;
  insert into public.hotspot_settings (key, value) values (p_key, btrim(p_value))
  on conflict (key) do update set value = excluded.value, updated_at = now();
  insert into public.admin_audit_log (actor, actor_email, action, entity, entity_id, before_data, after_data)
  values (p_actor, p_actor_email, 'setting_update', 'setting', p_key,
          jsonb_build_object('value', v_old), jsonb_build_object('value', btrim(p_value)));
  return jsonb_build_object('key', p_key, 'value', btrim(p_value));
end
$$;

create or replace function public.hotspot_admin_audit(p_limit integer)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(to_jsonb(t) order by t.at desc), '[]'::jsonb) from (
    select at, actor_email, action, entity, entity_id, before_data, after_data
      from public.admin_audit_log order by at desc limit greatest(1, least(coalesce(p_limit, 50), 200))) t;
$$;

-- ---------------------------------------------------------------------------
-- Permissões: somente service_role (nunca anon/authenticated).
-- ---------------------------------------------------------------------------
do $$
declare
  f text;
begin
  foreach f in array array[
    'hotspot_setting(text,text)',
    'hotspot_display_state(text,text,timestamptz,timestamptz)',
    'hotspot_reserve_order(text,integer,integer,uuid,text)',
    'hotspot_reserve_plan_order(text,uuid)',
    'hotspot_public_plans()',
    'hotspot_record_fees(uuid,integer,integer)',
    'hotspot_router_report_state(integer,jsonb)',
    'hotspot_purge(integer)',
    'hotspot_admin_get_role(uuid)',
    'hotspot_admin_period(text,date,date)',
    'hotspot_admin_overview(timestamptz,timestamptz)',
    'hotspot_admin_live()',
    'hotspot_admin_series(timestamptz,timestamptz,text)',
    'hotspot_admin_orders(integer,integer,text,timestamptz,timestamptz,text)',
    'hotspot_admin_devices(integer,integer,text)',
    'hotspot_admin_device(text)',
    'hotspot_admin_plans()',
    'hotspot_admin_plan_save(uuid,text,jsonb)',
    'hotspot_admin_report(timestamptz,timestamptz,text)',
    'hotspot_admin_settings()',
    'hotspot_admin_setting_set(uuid,text,text,text)',
    'hotspot_admin_audit(integer)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end
$$;
