-- Apply after secure_rls.sql, first in a test database.
begin;

create table public.employee_receipts (
  id uuid primary key,
  company_id uuid not null references public.companies(id),
  employee_id uuid not null,
  employee_name text not null,
  employee_cpf text not null,
  employer_name text not null,
  employer_cnpj text,
  receipt_type text not null check (receipt_type in ('advance', 'payment')),
  amount_cents integer not null check (amount_cents between 1 and 999999999),
  receipt_date date not null,
  location text not null,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  cancelled_at timestamptz,
  cancelled_by uuid,
  cancellation_reason text,
  check ((cancelled_at is null and cancelled_by is null and cancellation_reason is null) or
         (cancelled_at is not null and cancelled_by is not null and cancellation_reason is not null
          and length(trim(cancellation_reason)) > 0))
);

create index employee_receipts_company_employee_date_idx
  on public.employee_receipts (company_id, employee_id, receipt_date, id);
alter table public.employee_receipts enable row level security;
revoke all on public.employee_receipts from public, anon, authenticated;
grant select on public.employee_receipts to authenticated;
create policy employee_receipts_admin_read on public.employee_receipts for select to authenticated
  using (company_id = (select public.app_current_company_id()) and
         (select public.app_current_role()) = 'admin');

create function public.create_employee_receipt(
  p_id uuid, p_employee_id uuid, p_type text, p_amount_cents integer,
  p_date date, p_location text
) returns public.employee_receipts
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  company uuid;
  result public.employee_receipts;
begin
  if auth.uid() is null or (select public.app_current_role()) is distinct from 'admin' then
    raise exception 'Somente administradores ativos podem emitir recibos.';
  end if;
  company := (select public.app_current_company_id());
  if company is null or p_id is null or p_employee_id is null or
     p_type is null or p_type not in ('advance', 'payment') or
     p_amount_cents is null or p_amount_cents not between 1 and 999999999 or
     p_date is null or p_location is null or length(trim(p_location)) not between 1 and 200 then
    raise exception 'Informe funcionário, tipo, valor, data e local válidos.';
  end if;
  -- The caller can safely retry an identical request after a connection failure.
  select * into result from public.employee_receipts where id = p_id;
  if found then
    if result.company_id = company and result.created_by = auth.uid() and
       result.employee_id = p_employee_id and result.receipt_type = p_type and
       result.amount_cents = p_amount_cents and result.receipt_date = p_date and
       result.location = trim(p_location) then
      return result;
    end if;
    raise exception 'Identificador de recibo já utilizado.';
  end if;
  insert into public.employee_receipts
    (id, company_id, employee_id, employee_name, employee_cpf, employer_name,
     employer_cnpj, receipt_type, amount_cents, receipt_date, location, created_by)
  select p_id, company, employee.id, employee.nome, employee.cpf, employer.razao_social,
         employer.cnpj, p_type, p_amount_cents, p_date, trim(p_location), auth.uid()
  from public.employees employee join public.companies employer on employer.id = employee.company_id
  where employee.id = p_employee_id and employee.company_id = company
  returning * into result;
  if not found then
    raise exception 'Funcionário não encontrado na sua empresa.';
  end if;
  insert into public.audit_logs (table_name, record_id, user_id, action, new_values)
  values ('employee_receipts', result.id, auth.uid(), 'receipt_created', to_jsonb(result));
  return result;
end;
$$;

create function public.cancel_employee_receipt(p_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  previous public.employee_receipts;
  updated public.employee_receipts;
begin
  if auth.uid() is null or (select public.app_current_role()) is distinct from 'admin' then
    raise exception 'Somente administradores ativos podem cancelar recibos.';
  end if;
  if p_reason is null or length(trim(p_reason)) not between 1 and 1000 then
    raise exception 'Informe o motivo do cancelamento.';
  end if;
  select * into previous from public.employee_receipts
    where id = p_id and company_id = (select public.app_current_company_id()) for update;
  if not found then raise exception 'Recibo não encontrado.'; end if;
  if previous.cancelled_at is not null then raise exception 'Este recibo já foi cancelado.'; end if;
  update public.employee_receipts
    set cancelled_at = now(), cancelled_by = auth.uid(), cancellation_reason = trim(p_reason)
    where id = p_id returning * into updated;
  insert into public.audit_logs (table_name, record_id, user_id, action, old_values, new_values)
  values ('employee_receipts', updated.id, auth.uid(), 'receipt_cancelled',
          to_jsonb(previous), to_jsonb(updated));
end;
$$;

revoke all on function public.create_employee_receipt(uuid, uuid, text, integer, date, text) from public, anon;
revoke all on function public.cancel_employee_receipt(uuid, text) from public, anon;
grant execute on function public.create_employee_receipt(uuid, uuid, text, integer, date, text) to authenticated;
grant execute on function public.cancel_employee_receipt(uuid, text) to authenticated;
commit;
