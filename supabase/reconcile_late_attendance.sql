-- Apply after continuous_work_sessions.sql and block_duplicate_employee_entry.sql.
-- Reconciles only unambiguous sequences after a manager's manual insertion.
begin;

create or replace function public.reconcile_late_attendance()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  session_row public.work_sessions%rowtype;
  punch record;
  previous_type text;
  previous_time timestamptz;
  last_id uuid;
  last_time timestamptz;
  current_link uuid;
  current_error text;
  valid_sequence boolean := true;
  has_unlinked boolean := false;
  has_candidate boolean := false;
  last_before text;
  linked_ids uuid[] := '{}';
begin
  if auth.uid() is null or not (select public.app_is_company_manager()) then
    return new;
  end if;

  begin
    perform pg_advisory_xact_lock(hashtextextended(new.employee_id::text, 0));
    select * into session_row from public.work_sessions
    where employee_id = new.employee_id and company_id = new.company_id
      and started_at <= new.recorded_at and (ended_at is null or ended_at >= new.recorded_at)
    order by started_at desc, id desc limit 1
    for update;

    if found then
      has_candidate := true;
      select event_type into last_before from public.attendance_records
      where employee_id = new.employee_id and status <> 'rejected'
        and recorded_at < session_row.started_at
      order by recorded_at desc, id desc limit 1;
      if found and last_before <> 'saida' then valid_sequence := false; end if;

      for punch in
        select id, event_type, recorded_at, work_session_id, company_id
        from public.attendance_records
        where employee_id = new.employee_id and status <> 'rejected'
          and recorded_at >= session_row.started_at
          and (session_row.ended_at is null or recorded_at <= session_row.ended_at)
        order by recorded_at, id
      loop
        if punch.company_id <> new.company_id or
           (punch.work_session_id is not null and punch.work_session_id <> session_row.id) or
           (previous_time is not null and punch.recorded_at <= previous_time) then
          valid_sequence := false;
        end if;
        if previous_type is null then
          if punch.event_type <> 'entrada' or punch.recorded_at <> session_row.started_at
            or punch.work_session_id is distinct from session_row.id then
            valid_sequence := false;
          end if;
        elsif not (
          (previous_type in ('entrada', 'retorno_almoco') and punch.event_type in ('saida_almoco', 'saida'))
          or (previous_type = 'saida_almoco' and punch.event_type = 'retorno_almoco')
        ) then
          valid_sequence := false;
        end if;
        if punch.work_session_id is null then
          has_unlinked := true;
          linked_ids := array_append(linked_ids, punch.id);
        end if;
        previous_type := punch.event_type;
        previous_time := punch.recorded_at;
        last_id := punch.id;
        last_time := punch.recorded_at;
      end loop;

      if valid_sequence and has_unlinked and previous_type = 'saida'
        and (session_row.ended_at is null or session_row.ended_at = last_time)
        and not exists (
        select 1 from public.work_sessions s
        where s.employee_id = new.employee_id and s.id <> session_row.id
          and s.started_at <= last_time
          and (s.ended_at is null or s.ended_at >= session_row.started_at)
      ) and not exists (
        select 1 from public.attendance_records r
        where r.work_session_id = session_row.id and r.status <> 'rejected'
          and (r.recorded_at < session_row.started_at or r.recorded_at > last_time)
      ) then
        update public.attendance_records set work_session_id = session_row.id
        where id = any(linked_ids) and work_session_id is null;
        if session_row.status = 'open' then
          update public.work_sessions set status = 'closed', ended_at = last_time, updated_at = now()
          where id = session_row.id;
        end if;
        insert into public.audit_logs (table_name, record_id, user_id, action, old_values, new_values)
        select 'attendance_records', id, auth.uid(), 'attendance_session_reconciled',
          jsonb_build_object('work_session_id', null),
          jsonb_build_object('work_session_id', session_row.id, 'reason', 'Reconciliação automática de marcações lançadas fora de ordem.')
        from unnest(linked_ids) as id;
        if session_row.status = 'open' then
          insert into public.audit_logs (table_name, record_id, user_id, action, old_values, new_values)
          values ('work_sessions', session_row.id, auth.uid(), 'attendance_session_reconciled',
            jsonb_build_object('status', 'open', 'ended_at', null),
            jsonb_build_object('status', 'closed', 'ended_at', last_time, 'exit_record_id', last_id));
        end if;
        perform public.evaluate_work_session_alerts(session_row.id);
        has_unlinked := false;
      end if;
    end if;

    select work_session_id, work_session_error into current_link, current_error
    from public.attendance_records where id = new.id;
    if current_link is null or has_unlinked or current_error is not null
      or (has_candidate and not valid_sequence) or exists (
      select 1 from public.attendance_records r
      where r.employee_id = new.employee_id and r.status <> 'rejected'
        and r.work_session_id is null
    ) or exists (
      select 1 from public.work_sessions s
      join public.attendance_records r on r.work_session_id = s.id and r.status <> 'rejected'
      where s.employee_id = new.employee_id and s.status = 'closed'
        and (r.recorded_at < s.started_at or r.recorded_at > s.ended_at)
    ) then
      insert into public.attendance_alerts (
        company_id, employee_id, attendance_record_id, alert_type, severity, description
      ) values (
        new.company_id, new.employee_id, new.id, 'inconsistent_sequence', 'critical',
        'Há marcações que não puderam ser vinculadas com segurança. Revise a jornada e os horários.'
      ) on conflict do nothing;
    end if;
  exception when others then
    update public.attendance_records
    set work_session_error = concat_ws('; ', work_session_error, 'Reconciliação automática: ' || sqlerrm)
    where id = new.id;
  end;
  return new;
end;
$$;

revoke all on function public.reconcile_late_attendance() from public, anon, authenticated;
drop trigger if exists attendance_zz_reconcile_late on public.attendance_records;
create trigger attendance_zz_reconcile_late
  after insert on public.attendance_records
  for each row when (new.status <> 'rejected')
  execute function public.reconcile_late_attendance();

commit;
