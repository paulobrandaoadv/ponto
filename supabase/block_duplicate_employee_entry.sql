-- Apply after continuous_work_sessions.sql. Existing records are not changed.
-- This also updates the earlier version that blocked duplicate entries only.
begin;

create or replace function public.block_duplicate_employee_entry()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  last_event text;
begin
  if auth.uid() is null or (select public.app_current_role()) is distinct from 'funcionario' then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(new.employee_id::text, 0));

  if new.event_type = 'entrada' and (exists (
    select 1 from public.work_sessions
    where employee_id = new.employee_id and status = 'open'
  ) or exists (
    select 1 from public.attendance_records entry
    where entry.employee_id = new.employee_id
      and entry.event_type = 'entrada'
      and entry.status <> 'rejected'
      and not exists (
        select 1 from public.attendance_records exit_record
        where exit_record.employee_id = entry.employee_id
          and exit_record.event_type = 'saida'
          and exit_record.status <> 'rejected'
          and (exit_record.recorded_at, exit_record.id) > (entry.recorded_at, entry.id)
      )
  )) then
    raise exception 'Já existe uma jornada aberta. Não é possível registrar outra entrada. Se necessário, solicite a revisão ao administrador.';
  end if;

  select event_type into last_event
  from public.attendance_records
  where employee_id = new.employee_id and status <> 'rejected'
  order by recorded_at desc, id desc
  limit 1;

  if last_event = new.event_type then
    raise exception 'A última marcação já é deste tipo. Não é possível registrá-la novamente em sequência. Se necessário, solicite a revisão ao administrador.';
  end if;

  return new;
end;
$$;

revoke all on function public.block_duplicate_employee_entry() from public, anon, authenticated;

drop trigger if exists attendance_block_duplicate_employee_entry on public.attendance_records;
create trigger attendance_block_duplicate_employee_entry
  before insert on public.attendance_records
  for each row
  when (new.status <> 'rejected')
  execute function public.block_duplicate_employee_entry();

commit;
