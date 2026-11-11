-- Atualiza a sequência de marcações para jornadas de até 48 horas.
-- Execute antes de publicar a versão que calcula horas extras por jornada.
begin;

create or replace function public.record_own_attendance(
  p_location text,
  p_notes text,
  p_latitude double precision,
  p_longitude double precision,
  p_accuracy double precision
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
  local_now timestamptz := now();
  jornada_inicio timestamptz;
  jornada_entrada_id uuid;
  jornada_eventos text[];
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

  select event_type into last_event
  from public.attendance_records
  where employee_id = current_employee.id and status <> 'rejected'
  order by recorded_at desc, id desc
  limit 1;
  if last_event is not null and last_event <> 'saida' then
    select recorded_at, id into jornada_inicio, jornada_entrada_id
    from public.attendance_records
    where employee_id = current_employee.id and status <> 'rejected' and event_type = 'entrada'
    order by recorded_at desc, id desc
    limit 1;
    if jornada_inicio is null or jornada_inicio > local_now or local_now - jornada_inicio > interval '48 hours' then
      raise exception 'A jornada está incompleta ou ultrapassou 48 horas. Solicite a revisão ao administrador.';
    end if;
    select array_agg(event_type order by recorded_at, id) into jornada_eventos
    from public.attendance_records
    where employee_id = current_employee.id and status <> 'rejected'
      and (recorded_at, id) >= (jornada_inicio, jornada_entrada_id);
    if jornada_eventos not in (
      array['entrada']::text[],
      array['entrada', 'saida_almoco']::text[],
      array['entrada', 'saida_almoco', 'retorno_almoco']::text[]
    ) then
      raise exception 'As marcações da jornada estão inconsistentes. Solicite a revisão ao administrador.';
    end if;
  else
    last_event := null;
  end if;

  next_event := case
    when last_event is null then 'entrada'
    when last_event = 'entrada' then 'saida_almoco'
    when last_event = 'saida_almoco' then 'retorno_almoco'
    when last_event = 'retorno_almoco' then 'saida'
    else null
  end;
  if next_event is null then
    raise exception 'A jornada precisa de revisão pelo administrador.';
  end if;
  insert into public.attendance_records (
    employee_id, company_id, source, event_type, recorded_at, timezone, status,
    location, notes, recorded_by, latitude, longitude, accuracy
  ) values (
    current_employee.id, current_employee.company_id, 'web', next_event, local_now,
    'America/Campo_Grande', 'pending', nullif(trim(p_location), ''), nullif(trim(p_notes), ''),
    auth.uid(), p_latitude, p_longitude, p_accuracy
  ) returning id into new_record_id;
  return new_record_id;
end;
$$;

revoke all on function public.record_own_attendance(text, text, double precision, double precision, double precision) from public, anon;
grant execute on function public.record_own_attendance(text, text, double precision, double precision, double precision) to authenticated;

commit;
