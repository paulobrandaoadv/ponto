-- Adds continuous work sessions and non-blocking operational alerts.
-- Apply after the existing Supabase schema/RLS scripts. This does not rewrite
-- historical attendance records; their original timestamps remain untouched.
begin;

create table if not exists public.work_sessions (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  started_at timestamptz not null,
  ended_at timestamptz,
  status text not null default 'open' check (status in ('open', 'closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'open' and ended_at is null) or (status = 'closed' and ended_at is not null))
);

alter table public.attendance_records
  add column if not exists work_session_id uuid references public.work_sessions(id) on delete set null,
  add column if not exists work_session_error text,
  add column if not exists client_request_id uuid;

create unique index if not exists work_sessions_one_open_per_employee
  on public.work_sessions (employee_id) where status = 'open';
create index if not exists work_sessions_company_started_at
  on public.work_sessions (company_id, started_at desc);
create index if not exists attendance_records_work_session_time
  on public.attendance_records (work_session_id, recorded_at, id);
create unique index if not exists attendance_records_client_request_key
  on public.attendance_records (employee_id, client_request_id)
  where client_request_id is not null;

create table if not exists public.attendance_alert_settings (
  company_id uuid primary key references public.companies(id) on delete cascade,
  prolonged_hours numeric not null default 10 check (prolonged_hours > 0),
  exceptional_hours numeric not null default 12 check (exceptional_hours > prolonged_hours),
  open_hours numeric not null default 18 check (open_hours > 0),
  updated_at timestamptz not null default now()
);

create table if not exists public.attendance_alerts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  work_session_id uuid references public.work_sessions(id) on delete set null,
  attendance_record_id uuid references public.attendance_records(id) on delete set null,
  alert_type text not null,
  severity text not null check (severity in ('info', 'warning', 'critical')),
  description text not null,
  status text not null default 'pending'
    check (status in ('pending', 'viewed', 'in_review', 'resolved')),
  resolution_notes text,
  resolved_by uuid references auth.users(id),
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists attendance_alerts_session_type_key
  on public.attendance_alerts (work_session_id, alert_type)
  where work_session_id is not null and attendance_record_id is null;
create unique index if not exists attendance_alerts_record_type_key
  on public.attendance_alerts (attendance_record_id, alert_type)
  where attendance_record_id is not null;
create index if not exists attendance_alerts_company_status_created
  on public.attendance_alerts (company_id, status, created_at desc);

alter table public.work_sessions enable row level security;
alter table public.attendance_alert_settings enable row level security;
alter table public.attendance_alerts enable row level security;

revoke all on public.work_sessions, public.attendance_alert_settings, public.attendance_alerts
  from public, anon, authenticated;
grant select on public.work_sessions, public.attendance_alert_settings, public.attendance_alerts
  to authenticated;

drop policy if exists work_sessions_read_company on public.work_sessions;
create policy work_sessions_read_company on public.work_sessions
  for select to authenticated using (
    company_id = (select public.app_current_company_id())
    and (
      (select public.app_is_company_manager())
      or exists (
        select 1 from public.employees e
        where e.id = employee_id and e.user_id = (select auth.uid())
      )
    )
  );

drop policy if exists attendance_alert_settings_read_manager on public.attendance_alert_settings;
create policy attendance_alert_settings_read_manager on public.attendance_alert_settings
  for select to authenticated using (
    company_id = (select public.app_current_company_id())
    and (select public.app_is_company_manager())
  );

drop policy if exists attendance_alerts_read_company on public.attendance_alerts;
create policy attendance_alerts_read_company on public.attendance_alerts
  for select to authenticated using (
    company_id = (select public.app_current_company_id())
    and (
      (select public.app_is_company_manager())
      or exists (
        select 1 from public.employees e
        where e.id = employee_id and e.user_id = (select auth.uid())
      )
    )
  );

create or replace function public.evaluate_work_session_alerts(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  session_row public.work_sessions%rowtype;
  settings public.attendance_alert_settings%rowtype;
  worked_hours numeric;
  punch_row record;
  last_punch record;
  schedule_times time[];
  expected_local_time time;
  recorded_local_time time;
  expected_break_minutes numeric;
  actual_break_minutes numeric;
  break_started_at timestamptz;
begin
  select * into session_row from public.work_sessions where id = p_session_id;
  if not found then return; end if;

  select * into settings
  from public.attendance_alert_settings
  where company_id = session_row.company_id;
  if not found then
    settings.prolonged_hours := 10;
    settings.exceptional_hours := 12;
    settings.open_hours := 18;
  end if;

  select coalesce(sum(extract(epoch from (next_at - recorded_at))), 0) / 3600
  into worked_hours
  from (
    select event_type, recorded_at,
      lead(event_type) over (order by recorded_at, id) as next_type,
      lead(recorded_at) over (order by recorded_at, id) as next_at
    from public.attendance_records
    where work_session_id = p_session_id and status <> 'rejected'
  ) events
  where (event_type in ('entrada', 'retorno_almoco')
    and next_type in ('saida_almoco', 'saida'));

  if session_row.status = 'open' then
    select event_type, recorded_at into last_punch
    from public.attendance_records
    where work_session_id = p_session_id and status <> 'rejected'
    order by recorded_at desc, id desc
    limit 1;
    if found and last_punch.event_type in ('entrada', 'retorno_almoco') then
      worked_hours := worked_hours
        + greatest(extract(epoch from (now() - last_punch.recorded_at)), 0) / 3600;
    end if;
  end if;

  if worked_hours > settings.prolonged_hours then
    insert into public.attendance_alerts (
      company_id, employee_id, work_session_id, alert_type, severity, description
    ) values (
      session_row.company_id, session_row.employee_id, session_row.id, 'prolonged_work',
      case when worked_hours > settings.exceptional_hours then 'critical' else 'warning' end,
      format('A jornada acumula %.2f horas trabalhadas.', worked_hours)
    ) on conflict do nothing;
  end if;

  if worked_hours > settings.exceptional_hours then
    insert into public.attendance_alerts (
      company_id, employee_id, work_session_id, alert_type, severity, description
    ) values (
      session_row.company_id, session_row.employee_id, session_row.id, 'exceptional_work',
      'critical', format('A jornada ultrapassou %.0f horas trabalhadas.', settings.exceptional_hours)
    ) on conflict do nothing;
  end if;

  if session_row.status = 'open'
    and now() - session_row.started_at >
      make_interval(secs => settings.open_hours::double precision * 3600) then
    insert into public.attendance_alerts (
      company_id, employee_id, work_session_id, alert_type, severity, description
    ) values (
      session_row.company_id, session_row.employee_id, session_row.id, 'open_too_long',
      'warning', format('A jornada permanece aberta há mais de %.0f horas.', settings.open_hours)
    ) on conflict do nothing;
  end if;

  for punch_row in
    select id, event_type, recorded_at, employee_id
    from public.attendance_records
    where work_session_id = p_session_id and status <> 'rejected'
    order by recorded_at, id
  loop
    select array_agg(value[1]::time order by ordinal)
    into schedule_times
    from public.employees e
    cross join lateral regexp_matches(e.jornada, '((?:[01][0-9]|2[0-3]):[0-5][0-9])', 'g')
      with ordinality as matches(value, ordinal)
    where e.id = punch_row.employee_id;

    if array_length(schedule_times, 1) >= 4 then
      expected_local_time := case punch_row.event_type
        when 'entrada' then schedule_times[1]
        when 'saida_almoco' then schedule_times[2]
        when 'retorno_almoco' then schedule_times[3]
        when 'saida' then schedule_times[4]
      end;
      recorded_local_time := (punch_row.recorded_at at time zone 'America/Campo_Grande')::time;
      if expected_local_time is not null and recorded_local_time <> expected_local_time then
        insert into public.attendance_alerts (
          company_id, employee_id, work_session_id, attendance_record_id,
          alert_type, severity, description
        ) values (
          session_row.company_id, session_row.employee_id, session_row.id, punch_row.id,
          'outside_schedule', 'info',
          format('Horário registrado (%s) diferente do horário cadastrado (%s).',
            to_char(recorded_local_time, 'HH24:MI'), to_char(expected_local_time, 'HH24:MI'))
        ) on conflict do nothing;
      end if;

      if punch_row.event_type = 'retorno_almoco' then
        expected_break_minutes := extract(epoch from (schedule_times[3] - schedule_times[2])) / 60;
        select max(recorded_at) into break_started_at
        from public.attendance_records
        where work_session_id = p_session_id and event_type = 'saida_almoco'
          and status <> 'rejected' and recorded_at < punch_row.recorded_at;
        if break_started_at is not null then
          actual_break_minutes := extract(epoch from (punch_row.recorded_at - break_started_at)) / 60;
          if expected_break_minutes > 0 and actual_break_minutes < expected_break_minutes then
            insert into public.attendance_alerts (
              company_id, employee_id, work_session_id, attendance_record_id,
              alert_type, severity, description
            ) values (
              session_row.company_id, session_row.employee_id, session_row.id, punch_row.id,
              'short_break', 'warning',
              format('O intervalo foi menor que o intervalo cadastrado na jornada (%s minutos).',
                round(expected_break_minutes)::integer)
            ) on conflict do nothing;
          end if;
        end if;
      end if;
    end if;
  end loop;
end;
$$;

revoke all on function public.evaluate_work_session_alerts(uuid) from public, anon, authenticated;

create or replace function public.link_attendance_record_to_session()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  session_row public.work_sessions%rowtype;
  last_event text;
  last_event_at timestamptz;
begin
  begin
    if new.status = 'rejected' then
      insert into public.attendance_alerts (
        company_id, employee_id, attendance_record_id, alert_type, severity, description
      ) values (
        new.company_id, new.employee_id, new.id, 'rejected_punch', 'warning',
        'Marcação rejeitada; ela não foi usada no cálculo da jornada.'
      ) on conflict do nothing;
      if tg_op = 'UPDATE' and new.work_session_id is not null then
        select * into session_row
        from public.work_sessions
        where id = new.work_session_id
        for update;
        select event_type, recorded_at into last_event, last_event_at
        from public.attendance_records
        where work_session_id = session_row.id and status <> 'rejected'
        order by recorded_at desc, id desc
        limit 1;
        if not found then
          update public.work_sessions
          set status = 'closed', ended_at = session_row.started_at, updated_at = now()
          where id = session_row.id;
        elsif last_event = 'saida' then
          update public.work_sessions
          set status = 'closed', ended_at = last_event_at, updated_at = now()
          where id = session_row.id;
        elsif not exists (
          select 1 from public.work_sessions
          where employee_id = new.employee_id and status = 'open' and id <> session_row.id
        ) then
          update public.work_sessions
          set status = 'open', ended_at = null, updated_at = now()
          where id = session_row.id;
        else
          insert into public.attendance_alerts (
            company_id, employee_id, work_session_id, attendance_record_id,
            alert_type, severity, description
          ) values (
            new.company_id, new.employee_id, session_row.id, new.id,
            'inconsistent_sequence', 'critical',
            'A rejeição desta marcação afeta uma jornada já seguida por outra jornada aberta.'
          ) on conflict do nothing;
        end if;
      end if;
      return new;
    end if;

    perform pg_advisory_xact_lock(hashtextextended(new.employee_id::text, 0));
    if new.work_session_id is not null then return new; end if;

    select * into session_row
    from public.work_sessions
    where employee_id = new.employee_id and status = 'open'
    order by started_at desc
    limit 1
    for update;

    if new.event_type = 'entrada' then
      if found then
        insert into public.attendance_alerts (
          company_id, employee_id, work_session_id, attendance_record_id,
          alert_type, severity, description
        ) values (
          new.company_id, new.employee_id, session_row.id, new.id,
          'inconsistent_sequence', 'critical',
          'Foi registrada uma nova entrada enquanto outra jornada ainda estava aberta.'
        ) on conflict do nothing;
        return new;
      end if;
      insert into public.work_sessions (employee_id, company_id, started_at)
      values (new.employee_id, new.company_id, new.recorded_at)
      returning * into session_row;
      update public.attendance_records set work_session_id = session_row.id where id = new.id;
      perform public.evaluate_work_session_alerts(session_row.id);
    else
      if not found then
        insert into public.attendance_alerts (
          company_id, employee_id, attendance_record_id, alert_type, severity, description
        ) values (
          new.company_id, new.employee_id, new.id, 'inconsistent_sequence', 'critical',
          'A marcação não corresponde a uma jornada aberta.'
        ) on conflict do nothing;
        return new;
      end if;
      select event_type into last_event
      from public.attendance_records
      where work_session_id = session_row.id and status <> 'rejected' and id <> new.id
      order by recorded_at desc, id desc
      limit 1;

      if not (
        (last_event in ('entrada', 'retorno_almoco') and new.event_type in ('saida_almoco', 'saida'))
        or (last_event = 'saida_almoco' and new.event_type = 'retorno_almoco')
      ) then
        insert into public.attendance_alerts (
          company_id, employee_id, work_session_id, attendance_record_id,
          alert_type, severity, description
        ) values (
          new.company_id, new.employee_id, session_row.id, new.id,
          'inconsistent_sequence', 'critical',
          'A marcação não segue a sequência da jornada. O registro original foi preservado.'
        ) on conflict do nothing;
        return new;
      end if;

      update public.attendance_records set work_session_id = session_row.id where id = new.id;
      if new.event_type = 'saida' then
        update public.work_sessions
        set status = 'closed', ended_at = new.recorded_at, updated_at = now()
        where id = session_row.id;
      end if;
      perform public.evaluate_work_session_alerts(session_row.id);
    end if;

  exception when others then
    update public.attendance_records
    set work_session_error = sqlerrm
    where id = new.id;
  end;
  return new;
end;
$$;

do $$
declare
  item record;
  current_employee_id uuid;
  current_session_id uuid;
  last_event text;
  is_valid boolean;
begin
  if not exists (select 1 from public.work_sessions) then

  for item in
    select id, employee_id, company_id, event_type, recorded_at, status
    from public.attendance_records
    order by employee_id, recorded_at, id
  loop
    if current_employee_id is distinct from item.employee_id then
      current_employee_id := item.employee_id;
      current_session_id := null;
      last_event := null;
    end if;

    if item.status = 'rejected' then
      insert into public.attendance_alerts (
        company_id, employee_id, attendance_record_id, alert_type, severity, description
      ) values (
        item.company_id, item.employee_id, item.id, 'rejected_punch', 'warning',
        'Marcação rejeitada; ela não foi usada no cálculo da jornada.'
      ) on conflict do nothing;
      continue;
    end if;

    if item.event_type = 'entrada' then
      if current_session_id is not null then
        insert into public.attendance_alerts (
          company_id, employee_id, work_session_id, attendance_record_id,
          alert_type, severity, description
        ) values (
          item.company_id, item.employee_id, current_session_id, item.id,
          'inconsistent_sequence', 'critical',
          'Foi registrada uma nova entrada enquanto outra jornada ainda estava aberta.'
        ) on conflict do nothing;
        continue;
      end if;

      insert into public.work_sessions (employee_id, company_id, started_at)
      values (item.employee_id, item.company_id, item.recorded_at)
      returning id into current_session_id;
      update public.attendance_records set work_session_id = current_session_id where id = item.id;
      last_event := item.event_type;
      continue;
    end if;

    if current_session_id is null then
      insert into public.attendance_alerts (
        company_id, employee_id, attendance_record_id, alert_type, severity, description
      ) values (
        item.company_id, item.employee_id, item.id, 'inconsistent_sequence', 'critical',
        'A marcação não corresponde a uma jornada iniciada.'
      ) on conflict do nothing;
      continue;
    end if;

    is_valid := (last_event in ('entrada', 'retorno_almoco')
      and item.event_type in ('saida_almoco', 'saida'))
      or (last_event = 'saida_almoco' and item.event_type = 'retorno_almoco');
    if not is_valid then
      insert into public.attendance_alerts (
        company_id, employee_id, work_session_id, attendance_record_id,
        alert_type, severity, description
      ) values (
        item.company_id, item.employee_id, current_session_id, item.id,
        'inconsistent_sequence', 'critical',
        'A marcação não segue a sequência da jornada. O registro original foi preservado.'
      ) on conflict do nothing;
      continue;
    end if;

    update public.attendance_records set work_session_id = current_session_id where id = item.id;
    last_event := item.event_type;
    if item.event_type = 'saida' then
      update public.work_sessions
      set status = 'closed', ended_at = item.recorded_at, updated_at = now()
      where id = current_session_id;
      perform public.evaluate_work_session_alerts(current_session_id);
      current_session_id := null;
      last_event := null;
    end if;
  end loop;

  for current_session_id in
    select id from public.work_sessions
  loop
    perform public.evaluate_work_session_alerts(current_session_id);
  end loop;
  end if;
end;
$$;

drop trigger if exists attendance_record_session_link on public.attendance_records;
create trigger attendance_record_session_link
  after insert or update of status on public.attendance_records
  for each row execute function public.link_attendance_record_to_session();

create or replace function public.refresh_attendance_alerts()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  session_id uuid;
begin
  if auth.uid() is null or not (select public.app_is_company_manager()) then
    raise exception 'Você não tem permissão para atualizar os alertas.';
  end if;
  for session_id in
    select id from public.work_sessions
    where company_id = (select public.app_current_company_id()) and status = 'open'
  loop
    perform public.evaluate_work_session_alerts(session_id);
  end loop;
end;
$$;

revoke all on function public.refresh_attendance_alerts() from public, anon;
grant execute on function public.refresh_attendance_alerts() to authenticated;

create or replace function public.review_attendance_alert(
  p_alert_id uuid,
  p_status text,
  p_resolution_notes text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  alert_row public.attendance_alerts%rowtype;
begin
  if auth.uid() is null or not (select public.app_is_company_manager())
    or p_status is null or p_status not in ('viewed', 'in_review', 'resolved') then
    raise exception 'Você não tem permissão para revisar este alerta.';
  end if;
  if p_status = 'resolved' and coalesce(trim(p_resolution_notes), '') = '' then
    raise exception 'Informe a justificativa/providência antes de resolver o alerta.';
  end if;
  select * into alert_row from public.attendance_alerts
  where id = p_alert_id and company_id = (select public.app_current_company_id())
  for update;
  if not found then raise exception 'Alerta não encontrado para esta empresa.'; end if;

  update public.attendance_alerts
  set status = p_status,
      resolution_notes = case when p_resolution_notes is null then resolution_notes else trim(p_resolution_notes) end,
      resolved_by = case when p_status = 'resolved' then auth.uid() else resolved_by end,
      resolved_at = case when p_status = 'resolved' then now() else resolved_at end,
      updated_at = now()
  where id = p_alert_id;

  insert into public.audit_logs (table_name, record_id, user_id, action, old_values, new_values)
  values ('attendance_alerts', p_alert_id, auth.uid(), 'attendance_alert_reviewed',
    jsonb_build_object('status', alert_row.status, 'resolution_notes', alert_row.resolution_notes),
    jsonb_build_object('status', p_status, 'resolution_notes', p_resolution_notes));
end;
$$;

revoke all on function public.review_attendance_alert(uuid, text, text) from public, anon;
grant execute on function public.review_attendance_alert(uuid, text, text) to authenticated;

create or replace function public.record_own_attendance(
  p_location text,
  p_notes text,
  p_latitude double precision,
  p_longitude double precision,
  p_accuracy double precision,
  p_request_id uuid,
  p_event_type text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_employee public.employees%rowtype;
  last_event text;
  next_event text;
  new_record_id uuid;
  existing_record_id uuid;
  local_now timestamptz := now();
  last_exit_at timestamptz;
  last_exit_id uuid;
  open_events text[];
  event_index integer;
  sequence_valid boolean := true;
begin
  if auth.uid() is null or (select public.app_current_role()) <> 'funcionario' then
    raise exception 'Somente funcionário autenticado pode registrar o próprio ponto.';
  end if;
  if p_latitude is null or p_longitude is null or p_accuracy is null
    or p_latitude < -90 or p_latitude > 90 or p_longitude < -180 or p_longitude > 180
    or p_accuracy < 0 then
    raise exception 'Não foi possível validar a localização GPS desta marcação.';
  end if;
  select * into current_employee from public.employees
  where user_id = auth.uid()
    and company_id = (select public.app_current_company_id())
    and lower(status) = 'ativo'
  limit 1;
  if not found then
    raise exception 'Não há cadastro ativo de funcionário vinculado a esta conta.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(current_employee.id::text, 0));

  if p_request_id is not null then
    select id into existing_record_id
    from public.attendance_records
    where employee_id = current_employee.id and client_request_id = p_request_id;
    if found then return existing_record_id; end if;
  end if;

  select recorded_at, id into last_exit_at, last_exit_id
  from public.attendance_records
  where employee_id = current_employee.id and status <> 'rejected' and event_type = 'saida'
  order by recorded_at desc, id desc
  limit 1;

  select array_agg(event_type order by recorded_at, id)
  into open_events
  from public.attendance_records
  where employee_id = current_employee.id and status <> 'rejected'
    and (
      last_exit_at is null
      or (recorded_at, id) > (last_exit_at, last_exit_id)
    );

  if coalesce(array_length(open_events, 1), 0) > 0 then
    if open_events[1] <> 'entrada' then
      sequence_valid := false;
    else
      for event_index in 2..array_length(open_events, 1) loop
        if not (
          (open_events[event_index - 1] in ('entrada', 'retorno_almoco')
            and open_events[event_index] in ('saida_almoco', 'saida'))
          or (open_events[event_index - 1] = 'saida_almoco'
            and open_events[event_index] = 'retorno_almoco')
        ) then
          sequence_valid := false;
          exit;
        end if;
      end loop;
    end if;
    if sequence_valid then
      last_event := open_events[array_length(open_events, 1)];
    else
      last_event := null;
    end if;
  else
    last_event := null;
  end if;

  if p_event_type is not null then
    if p_event_type not in ('entrada', 'saida_almoco', 'retorno_almoco', 'saida') then
      raise exception 'Tipo de marcação inválido.';
    end if;
    next_event := p_event_type;
  else
    if not sequence_valid then
      raise exception 'A sequência está inconsistente. Escolha explicitamente a marcação; o sistema não presumirá o tipo.';
    end if;

    if last_event is null then
      next_event := 'entrada';
    elsif last_event in ('entrada', 'retorno_almoco') then
      next_event := 'saida_almoco';
    elsif last_event = 'saida_almoco' then
      next_event := 'retorno_almoco';
    else
      raise exception 'A jornada está inconsistente e precisa de revisão.';
    end if;
  end if;

  insert into public.attendance_records (
    employee_id, company_id, source, event_type, recorded_at, timezone, status,
    location, notes, recorded_by, latitude, longitude, accuracy, client_request_id
  ) values (
    current_employee.id, current_employee.company_id, 'web', next_event, local_now,
    'America/Campo_Grande', 'pending', nullif(trim(p_location), ''), nullif(trim(p_notes), ''),
    auth.uid(), p_latitude, p_longitude, p_accuracy, p_request_id
  ) returning id into new_record_id;
  return new_record_id;
end;
$$;

revoke all on function public.record_own_attendance(text, text, double precision, double precision, double precision, uuid, text)
  from public, anon;
grant execute on function public.record_own_attendance(text, text, double precision, double precision, double precision, uuid, text)
  to authenticated;

create or replace function public.record_own_attendance(
  p_location text,
  p_notes text,
  p_latitude double precision,
  p_longitude double precision,
  p_accuracy double precision
)
returns uuid
language sql
security definer
set search_path = public, pg_temp
as $$
  select public.record_own_attendance(
    p_location, p_notes, p_latitude, p_longitude, p_accuracy, null::uuid, null::text
  );
$$;

revoke all on function public.record_own_attendance(text, text, double precision, double precision, double precision)
  from public, anon;
grant execute on function public.record_own_attendance(text, text, double precision, double precision, double precision)
  to authenticated;

create or replace function public.record_own_attendance_with_face(
  p_location text,
  p_notes text,
  p_latitude double precision,
  p_longitude double precision,
  p_accuracy double precision,
  p_challenge_id uuid,
  p_request_id uuid,
  p_event_type text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  verified_challenge public.face_auth_challenges%rowtype;
  new_record_id uuid;
begin
  if auth.uid() is null or (select public.app_current_role()) <> 'funcionario' then
    raise exception 'Somente funcionário autenticado pode registrar o próprio ponto.';
  end if;

  select * into verified_challenge
  from public.face_auth_challenges
  where id = p_challenge_id
    and user_id = auth.uid()
    and company_id = (select public.app_current_company_id())
    and used_at is null
    and expires_at > now()
  for update;
  if not found then
    raise exception 'A verificação facial é inválida, expirou ou já foi usada.';
  end if;

  update public.face_auth_challenges set used_at = now()
  where id = verified_challenge.id;

  new_record_id := public.record_own_attendance(
    p_location, p_notes, p_latitude, p_longitude, p_accuracy, p_request_id, p_event_type
  );
  update public.attendance_records
  set source = 'web_face'
  where id = new_record_id and recorded_by = auth.uid();
  return new_record_id;
end;
$$;

revoke all on function public.record_own_attendance_with_face(
  text, text, double precision, double precision, double precision, uuid, uuid, text
) from public, anon;
grant execute on function public.record_own_attendance_with_face(
  text, text, double precision, double precision, double precision, uuid, uuid, text
) to authenticated;

commit;
