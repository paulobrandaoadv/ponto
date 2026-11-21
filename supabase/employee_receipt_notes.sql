-- Apply after employee_receipts.sql, first in a test database.
begin;

alter table public.employee_receipts
  add column if not exists notes text;

create function public.create_employee_receipt_with_notes(
  p_id uuid, p_employee_id uuid, p_type text, p_amount_cents integer,
  p_date date, p_location text, p_notes text
) returns public.employee_receipts
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  company uuid;
  result public.employee_receipts;
  normalized_notes text := nullif(trim(p_notes), '');
begin
  if auth.uid() is null or (select public.app_current_role()) is distinct from 'admin' then
    raise exception 'Somente administradores ativos podem emitir recibos.';
  end if;
  company := (select public.app_current_company_id());
  if company is null or p_id is null or p_employee_id is null or
     p_type is null or p_type not in ('advance', 'payment') or
     p_amount_cents is null or p_amount_cents not between 1 and 999999999 or
     p_date is null or p_location is null or length(trim(p_location)) not between 1 and 200 or
     length(p_notes) > 1000 then
    raise exception 'Informe funcionário, tipo, valor, data, local e observação válidos.';
  end if;

  select * into result from public.employee_receipts where id = p_id;
  if found then
    if result.company_id = company and result.created_by = auth.uid() and
       result.employee_id = p_employee_id and result.receipt_type = p_type and
       result.amount_cents = p_amount_cents and result.receipt_date = p_date and
       result.location = trim(p_location) and result.notes is not distinct from normalized_notes then
      return result;
    end if;
    raise exception 'Identificador de recibo já utilizado.';
  end if;

  insert into public.employee_receipts
    (id, company_id, employee_id, employee_name, employee_cpf, employer_name,
     employer_cnpj, receipt_type, amount_cents, receipt_date, location, notes, created_by)
  select p_id, company, employee.id, employee.nome, employee.cpf, employer.razao_social,
         employer.cnpj, p_type, p_amount_cents, p_date, trim(p_location), normalized_notes, auth.uid()
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

revoke all on function public.create_employee_receipt_with_notes(uuid, uuid, text, integer, date, text, text) from public, anon;
grant execute on function public.create_employee_receipt_with_notes(uuid, uuid, text, integer, date, text, text) to authenticated;
commit;
