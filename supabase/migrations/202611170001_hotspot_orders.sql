-- Wi-Fi a Bordo — esquema do banco (revisão 2, pós-auditoria).
--
-- Rodar UMA vez no SQL Editor de um projeto Supabase DEDICADO a este sistema.
-- É idempotente: se a revisão 1 já tiver sido aplicada, as colunas novas são
-- acrescentadas e as funções são recriadas (não apaga pedidos).
--
-- Princípios:
--  * Toda a lógica de transição de pedidos vive aqui, em funções atômicas,
--    chamadas somente pelas Edge Functions com a chave service_role.
--  * RLS ligado e nenhum privilégio para anon/authenticated: a chave pública
--    do Supabase não consegue ler a tabela nem executar as funções.
--  * Um pedido só vira 'paid' por hotspot_apply_payment, que confere valor,
--    moeda, meio de pagamento e vínculo pedido<->pagamento.
--  * O roteador só enxerga pedidos 'paid' ainda sem confirmação (ACK).

-- ---------------------------------------------------------------------------
-- Tabelas
-- ---------------------------------------------------------------------------
create table if not exists public.hotspot_orders (
  id uuid primary key default gen_random_uuid(),
  read_token uuid not null default gen_random_uuid(),
  device_mac text not null check (device_mac ~* '^([0-9a-f]{2}:){5}[0-9a-f]{2}$'),
  payment_id text unique,
  payment_status text not null default 'pending',
  paid_at timestamptz,
  provisioned_at timestamptz,
  created_at timestamptz not null default now()
);

-- Colunas acrescentadas na revisão 2 (seguro reexecutar).
alter table public.hotspot_orders add column if not exists amount_cents integer not null default 500;
alter table public.hotspot_orders add column if not exists mp_status text;
alter table public.hotspot_orders add column if not exists mp_status_detail text;
alter table public.hotspot_orders add column if not exists qr_code text;
alter table public.hotspot_orders add column if not exists qr_code_base64 text;
alter table public.hotspot_orders add column if not exists ticket_url text;
alter table public.hotspot_orders add column if not exists expires_at timestamptz;
alter table public.hotspot_orders add column if not exists refunded_at timestamptz;
alter table public.hotspot_orders add column if not exists last_mp_check_at timestamptz;
alter table public.hotspot_orders add column if not exists updated_at timestamptz not null default now();

-- Duração do crédito deste pedido (decidida no servidor; o roteador só obedece).
alter table public.hotspot_orders add column if not exists grant_seconds integer not null default 18000;
alter table public.hotspot_orders drop constraint if exists hotspot_orders_grant_range;
alter table public.hotspot_orders add constraint hotspot_orders_grant_range
  check (grant_seconds between 60 and 604800);

alter table public.hotspot_orders drop constraint if exists hotspot_orders_payment_status_check;
alter table public.hotspot_orders add constraint hotspot_orders_payment_status_check
  check (payment_status in ('pending', 'paid', 'failed', 'expired', 'refunded'));

alter table public.hotspot_orders drop constraint if exists hotspot_orders_amount_positive;
alter table public.hotspot_orders add constraint hotspot_orders_amount_positive check (amount_cents > 0);

-- Integridade: pago exige data de pagamento; liberação exige pagamento.
alter table public.hotspot_orders drop constraint if exists hotspot_orders_paid_has_timestamp;
alter table public.hotspot_orders add constraint hotspot_orders_paid_has_timestamp
  check (payment_status not in ('paid', 'refunded') or paid_at is not null);

alter table public.hotspot_orders drop constraint if exists hotspot_orders_provisioned_requires_paid;
alter table public.hotspot_orders add constraint hotspot_orders_provisioned_requires_paid
  check (provisioned_at is null or paid_at is not null);

create index if not exists hotspot_orders_unprovisioned
  on public.hotspot_orders (created_at)
  where payment_status = 'paid' and provisioned_at is null;
create unique index if not exists hotspot_orders_read_token
  on public.hotspot_orders (read_token);
create index if not exists hotspot_orders_mac_created
  on public.hotspot_orders (device_mac, created_at desc);
create index if not exists hotspot_orders_created
  on public.hotspot_orders (created_at desc);

-- Última vez que o roteador consultou o Supabase (permite avisar o passageiro
-- quando o MikroTik está offline).
create table if not exists public.hotspot_router_state (
  id smallint primary key default 1 check (id = 1),
  last_seen_at timestamptz,
  last_ack_at timestamptz
);
insert into public.hotspot_router_state (id) values (1) on conflict (id) do nothing;

alter table public.hotspot_orders enable row level security;
alter table public.hotspot_router_state enable row level security;
-- Nenhuma policy: acesso somente via service_role (que ignora RLS).
revoke all privileges on table public.hotspot_orders from public, anon, authenticated;
revoke all privileges on table public.hotspot_router_state from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Funções
-- ---------------------------------------------------------------------------

-- Expira pedidos antigos. Pix vencido há mais de 2 min -> 'expired'.
-- Pedido sem Pix criado após 45 s (falha no meio da criação) -> 'failed'.
-- Um pagamento aprovado depois disso ainda pode reativar o pedido
-- (ver hotspot_apply_payment): o Mercado Pago é a fonte da verdade.
create or replace function public.hotspot_expire_stale(
  p_grace_seconds integer default 120,
  p_inflight_seconds integer default 45
) returns void
language plpgsql
set search_path = public, pg_temp
as $$
begin
  update public.hotspot_orders
     set payment_status = 'expired', updated_at = now()
   where payment_status = 'pending'
     and expires_at is not null
     and expires_at < now() - make_interval(secs => p_grace_seconds);

  update public.hotspot_orders
     set payment_status = 'failed', updated_at = now()
   where payment_status = 'pending'
     and expires_at is null
     and payment_id is null
     and created_at < now() - make_interval(secs => p_inflight_seconds);
end
$$;

-- Reserva (ou reaproveita) o pedido de um MAC. Evita cobrança duplicada,
-- limita abuso e serializa requisições concorrentes do mesmo aparelho.
drop function if exists public.hotspot_reserve_order(text, integer); -- assinatura da revisão anterior
create or replace function public.hotspot_reserve_order(
  p_mac text,
  p_amount_cents integer,
  p_grant_seconds integer default 18000
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

  -- Pix ainda válido para este aparelho: devolve o mesmo.
  select * into v_o from public.hotspot_orders
   where device_mac = v_mac and payment_status = 'pending'
   order by created_at desc limit 1;
  if found then
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

  insert into public.hotspot_orders (device_mac, amount_cents, grant_seconds)
  values (v_mac, p_amount_cents, p_grant_seconds)
  returning * into v_o;
  return jsonb_build_object('action', 'created',
    'order_id', v_o.id, 'read_token', v_o.read_token);
end
$$;

-- Grava os dados do Pix devolvidos pelo Mercado Pago.
create or replace function public.hotspot_attach_payment(
  p_order_id uuid,
  p_payment_id text,
  p_qr_code text,
  p_qr_code_base64 text,
  p_ticket_url text,
  p_expires_at timestamptz
) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  update public.hotspot_orders
     set payment_id = p_payment_id,
         qr_code = p_qr_code,
         qr_code_base64 = p_qr_code_base64,
         ticket_url = p_ticket_url,
         expires_at = p_expires_at,
         updated_at = now()
   where id = p_order_id
     and (payment_id is null or payment_id = p_payment_id)
   returning id into v_id;
  return jsonb_build_object('ok', v_id is not null);
end
$$;

-- Marca como falho um pedido cujo Pix nunca foi criado.
create or replace function public.hotspot_fail_order(p_order_id uuid)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  update public.hotspot_orders
     set payment_status = 'failed', updated_at = now()
   where id = p_order_id and payment_status = 'pending' and payment_id is null
   returning id into v_id;
  return jsonb_build_object('ok', v_id is not null);
end
$$;

-- ÚNICO caminho que pode transformar um pedido em 'paid'.
-- Recebe os dados lidos diretamente da API do Mercado Pago (nunca do corpo do
-- webhook) e confere valor, moeda, meio e vínculo com o pedido.
create or replace function public.hotspot_apply_payment(
  p_order_id uuid,
  p_payment_id text,
  p_mp_status text,
  p_mp_status_detail text,
  p_amount_cents integer,
  p_currency text,
  p_method text
) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_o public.hotspot_orders%rowtype;
begin
  select * into v_o from public.hotspot_orders where id = p_order_id for update;
  if not found then
    return jsonb_build_object('result', 'order_not_found');
  end if;

  -- O mesmo pagamento nunca pode servir a dois pedidos, nem trocar de pedido.
  if v_o.payment_id is not null and v_o.payment_id <> p_payment_id then
    return jsonb_build_object('result', 'payment_mismatch');
  end if;
  if exists (select 1 from public.hotspot_orders
              where payment_id = p_payment_id and id <> p_order_id) then
    return jsonb_build_object('result', 'payment_mismatch');
  end if;

  if p_mp_status = 'approved' then
    if p_currency is distinct from 'BRL'
       or p_method is distinct from 'pix'
       or p_amount_cents is distinct from v_o.amount_cents then
      return jsonb_build_object('result', 'invalid_payment');
    end if;
    if v_o.payment_status = 'paid' then
      return jsonb_build_object('result', 'already_paid');
    end if;
    if v_o.payment_status = 'refunded' then
      return jsonb_build_object('result', 'ignored');
    end if;
    -- pending, failed ou expired -> paid (pagamento aprovado é a verdade).
    update public.hotspot_orders
       set payment_id = p_payment_id,
           payment_status = 'paid',
           paid_at = now(),
           mp_status = p_mp_status,
           mp_status_detail = p_mp_status_detail,
           updated_at = now()
     where id = p_order_id;
    return jsonb_build_object('result', 'paid');

  elsif p_mp_status in ('refunded', 'charged_back') then
    if v_o.payment_status = 'paid' then
      update public.hotspot_orders
         set payment_status = 'refunded',
             refunded_at = now(),
             mp_status = p_mp_status,
             mp_status_detail = p_mp_status_detail,
             updated_at = now()
       where id = p_order_id;
      return jsonb_build_object('result', 'refunded',
        'was_provisioned', v_o.provisioned_at is not null);
    end if;
    return jsonb_build_object('result', 'noop');

  elsif p_mp_status = 'rejected' then
    update public.hotspot_orders
       set payment_status = case when payment_status = 'pending' then 'failed' else payment_status end,
           payment_id = coalesce(payment_id, p_payment_id),
           mp_status = p_mp_status,
           mp_status_detail = p_mp_status_detail,
           updated_at = now()
     where id = p_order_id;
    return jsonb_build_object('result', 'rejected');

  elsif p_mp_status = 'cancelled' then
    update public.hotspot_orders
       set payment_status = case
             when payment_status <> 'pending' then payment_status
             when coalesce(p_mp_status_detail, '') ~* 'expired' then 'expired'
             else 'failed' end,
           payment_id = coalesce(payment_id, p_payment_id),
           mp_status = p_mp_status,
           mp_status_detail = p_mp_status_detail,
           updated_at = now()
     where id = p_order_id;
    return jsonb_build_object('result', 'cancelled');

  else
    -- pending, in_process, authorized, in_mediation...: só registra.
    update public.hotspot_orders
       set payment_id = coalesce(payment_id, p_payment_id),
           mp_status = p_mp_status,
           mp_status_detail = p_mp_status_detail,
           updated_at = now()
     where id = p_order_id;
    return jsonb_build_object('result', 'noop');
  end if;
end
$$;

-- Estado do pedido para o portal. Também "reserva" (com intervalo mínimo) a
-- vez de consultar o Mercado Pago, para reconciliar caso o webhook falhe.
create or replace function public.hotspot_order_status(
  p_order_id uuid,
  p_token uuid,
  p_reconcile_after_seconds integer default 10
) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_o public.hotspot_orders%rowtype;
  v_reconcile text;
  v_online boolean;
begin
  perform public.hotspot_expire_stale();

  select * into v_o from public.hotspot_orders
   where id = p_order_id and read_token = p_token;
  if not found then
    return jsonb_build_object('found', false);
  end if;

  update public.hotspot_orders
     set last_mp_check_at = now()
   where id = p_order_id
     and payment_status = 'pending'
     and payment_id is not null
     and (last_mp_check_at is null
          or last_mp_check_at < now() - make_interval(secs => p_reconcile_after_seconds))
   returning payment_id into v_reconcile;

  select last_seen_at > now() - interval '60 seconds'
    into v_online from public.hotspot_router_state where id = 1;

  return jsonb_build_object(
    'found', true,
    'status', v_o.payment_status,
    'internet_ready', v_o.provisioned_at is not null,
    'seconds_left', case when v_o.expires_at is null then null
                         else greatest(0, floor(extract(epoch from (v_o.expires_at - now())))) end,
    'router_online', coalesce(v_online, false),
    'reconcile_payment_id', v_reconcile
  );
end
$$;

-- Roteador: pedidos pagos ainda não confirmados. Também registra o "visto por último".
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
           where payment_status = 'paid' and provisioned_at is null
           order by created_at asc
           limit greatest(1, least(coalesce(p_limit, 30), 100))) t;

  return jsonb_build_object('orders', v_orders);
end
$$;

-- Roteador: confirma que criou/atualizou o usuário. Idempotente.
create or replace function public.hotspot_router_ack(p_order_id uuid, p_mac text)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_mac text := upper(btrim(coalesce(p_mac, '')));
  v_id uuid;
begin
  update public.hotspot_orders
     set provisioned_at = now(), updated_at = now()
   where id = p_order_id
     and device_mac = v_mac
     and payment_status = 'paid'
     and provisioned_at is null
   returning id into v_id;
  if found then
    update public.hotspot_router_state set last_ack_at = now() where id = 1;
    return jsonb_build_object('ok', true, 'already', false);
  end if;

  if exists (select 1 from public.hotspot_orders
              where id = p_order_id and device_mac = v_mac
                and payment_status in ('paid', 'refunded')
                and provisioned_at is not null) then
    return jsonb_build_object('ok', true, 'already', true);
  end if;
  return jsonb_build_object('ok', false, 'reason', 'not_eligible');
end
$$;

-- Operação/suporte: resumo dos créditos de um aparelho (somente leitura).
-- Ex.: select public.hotspot_credit_summary('AA:BB:CC:DD:EE:FF');
create or replace function public.hotspot_credit_summary(p_mac text)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'mac', upper(btrim(p_mac)),
    'orders_paid', count(*) filter (where payment_status = 'paid'),
    'granted_seconds', coalesce(sum(grant_seconds) filter (where payment_status = 'paid' and provisioned_at is not null), 0),
    'awaiting_router_seconds', coalesce(sum(grant_seconds) filter (where payment_status = 'paid' and provisioned_at is null), 0),
    'refunded_orders', count(*) filter (where payment_status = 'refunded'))
  from public.hotspot_orders
  where device_mac = upper(btrim(p_mac));
$$;

-- Privacidade: apaga pedidos encerrados com mais de N dias. Rodar à mão
-- ao encerrar a operação:  select public.hotspot_purge(1);
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
  return jsonb_build_object('deleted', v_n);
end
$$;

-- ---------------------------------------------------------------------------
-- Permissões: funções só para service_role (nunca anon/authenticated).
-- ---------------------------------------------------------------------------
do $$
declare
  f text;
begin
  foreach f in array array[
    'hotspot_expire_stale(integer,integer)',
    'hotspot_reserve_order(text,integer,integer)',
    'hotspot_credit_summary(text)',
    'hotspot_attach_payment(uuid,text,text,text,text,timestamptz)',
    'hotspot_fail_order(uuid)',
    'hotspot_apply_payment(uuid,text,text,text,integer,text,text)',
    'hotspot_order_status(uuid,uuid,integer)',
    'hotspot_router_pull(integer)',
    'hotspot_router_ack(uuid,text)',
    'hotspot_purge(integer)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end
$$;
