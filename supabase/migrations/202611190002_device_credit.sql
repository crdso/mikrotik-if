-- Estado do crédito por aparelho (revisão 5). ADITIVA: não altera nem apaga pedidos.
--
-- O backend sabe o que CONCEDEU (hotspot_orders); quem sabe quanto foi CONSUMIDO é o MikroTik.
-- Por isso o roteador informa, a cada consulta, os aparelhos cujo limit-uptime esgotou
-- (hotspot_router_report_exhausted). O portal consulta esse estado SOMENTE com o id + read_token
-- do pedido do próprio aparelho (payment-status): não existe consulta por MAC, então não há
-- como enumerar aparelhos de terceiros nem ver histórico de pagamento.
--
-- Estados (hotspot_device_credit_state):
--   none      nenhum crédito foi concedido a este MAC por este sistema
--   active    há crédito concedido e o roteador não reportou esgotamento depois da última concessão
--   exhausted o roteador reportou esgotamento DEPOIS da última concessão (nova compra => volta a active)

create table if not exists public.hotspot_device_credit (
  device_mac text primary key check (device_mac ~ '^([0-9A-F]{2}:){5}[0-9A-F]{2}$'),
  exhausted_at timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.hotspot_device_credit enable row level security;
revoke all privileges on table public.hotspot_device_credit from public, anon, authenticated;

create or replace function public.hotspot_device_credit_state(p_mac text)
returns text
language sql
stable
set search_path = public, pg_temp
as $$
  select case
    when (select max(o.provisioned_at) from public.hotspot_orders o
           where o.device_mac = upper(btrim(p_mac))
             and o.payment_status in ('paid', 'refunded')
             and o.provisioned_at is not null) is null then 'none'
    when coalesce((select c.exhausted_at from public.hotspot_device_credit c
                    where c.device_mac = upper(btrim(p_mac))), '-infinity'::timestamptz)
         >= (select max(o.provisioned_at) from public.hotspot_orders o
              where o.device_mac = upper(btrim(p_mac))
                and o.payment_status in ('paid', 'refunded')
                and o.provisioned_at is not null) then 'exhausted'
    else 'active'
  end;
$$;

-- Roteador: lista (separada por vírgulas, até 20) de MACs cujo crédito esgotou. Idempotente:
-- repetir o aviso não muda nada; MACs inválidos ou sem crédito concedido por aqui são ignorados.
create or replace function public.hotspot_router_report_exhausted(p_macs text)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_mac text;
  v_last timestamptz;
  v_received integer := 0;
  v_updated integer := 0;
begin
  for v_mac in
    select upper(btrim(x)) from unnest(string_to_array(coalesce(p_macs, ''), ',')) as x
     where length(btrim(x)) > 0 limit 20
  loop
    v_received := v_received + 1;
    if v_mac !~ '^([0-9A-F]{2}:){5}[0-9A-F]{2}$' then continue; end if;

    select max(provisioned_at) into v_last from public.hotspot_orders
     where device_mac = v_mac and payment_status in ('paid', 'refunded') and provisioned_at is not null;
    if v_last is null then continue; end if;

    insert into public.hotspot_device_credit as c (device_mac, exhausted_at)
    values (v_mac, now())
    on conflict (device_mac) do update
       set exhausted_at = now(), updated_at = now()
     where c.exhausted_at is null or c.exhausted_at < v_last;
    if found then v_updated := v_updated + 1; end if;
  end loop;
  return jsonb_build_object('received', v_received, 'updated', v_updated);
end
$$;

-- Estado do pedido para o portal (mesmo contrato anterior + device_credit).
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
    'device_credit', case when v_o.provisioned_at is not null
                          then public.hotspot_device_credit_state(v_o.device_mac) else null end,
    'seconds_left', case when v_o.expires_at is null then null
                         else greatest(0, floor(extract(epoch from (v_o.expires_at - now())))) end,
    'router_online', coalesce(v_online, false),
    'reconcile_payment_id', v_reconcile
  );
end
$$;

-- Privacidade: a limpeza também remove o estado de aparelhos sem nenhum pedido restante.
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
  return jsonb_build_object('deleted', v_n);
end
$$;

-- Permissões: somente service_role (nunca anon/authenticated).
do $$
declare
  f text;
begin
  foreach f in array array[
    'hotspot_device_credit_state(text)',
    'hotspot_router_report_exhausted(text)',
    'hotspot_order_status(uuid,uuid,integer)',
    'hotspot_purge(integer)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end
$$;
