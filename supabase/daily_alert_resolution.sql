-- Apply after continuous_work_sessions.sql. Disabled by default for each company.
begin;

create extension if not exists pg_cron with schema pg_catalog;

alter table public.attendance_alert_settings
  add column if not exists auto_resolve_daily boolean not null default false;

create or replace function public.set_daily_alert_auto_resolution(p_enabled boolean)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  company uuid;
  previous_enabled boolean;
begin
  if auth.uid() is null or not (select public.app_is_company_manager()) then
    raise exception 'Você não tem permissão para alterar esta configuração.';
  end if;
  if p_enabled is null then
    raise exception 'Informe se o encerramento automático deve estar ativado.';
  end if;

  company := (select public.app_current_company_id());
  if company is null then
    raise exception 'Não foi possível identificar a empresa.';
  end if;

  insert into public.attendance_alert_settings (company_id)
  values (company)
  on conflict (company_id) do nothing;

  select auto_resolve_daily into previous_enabled
  from public.attendance_alert_settings
  where company_id = company
  for update;

  update public.attendance_alert_settings
  set auto_resolve_daily = p_enabled, updated_at = now()
  where company_id = company;

  insert into public.audit_logs (table_name, record_id, user_id, action, old_values, new_values)
  values (
    'attendance_alert_settings', company, auth.uid(), 'attendance_alert_auto_resolution_changed',
    jsonb_build_object('auto_resolve_daily', previous_enabled),
    jsonb_build_object('auto_resolve_daily', p_enabled)
  );
end;
$$;

revoke all on function public.set_daily_alert_auto_resolution(boolean) from public, anon;
grant execute on function public.set_daily_alert_auto_resolution(boolean) to authenticated;

create or replace function public.auto_resolve_past_attendance_alerts()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  with candidates as (
    select alert.id, alert.status, alert.resolution_notes
    from public.attendance_alerts alert
    join public.attendance_alert_settings settings on settings.company_id = alert.company_id
    where settings.auto_resolve_daily
      and alert.status in ('pending', 'viewed', 'in_review')
      and alert.created_at < (date_trunc('day', now() at time zone 'America/Campo_Grande')
        at time zone 'America/Campo_Grande')
    for update of alert
  ), resolved as (
    update public.attendance_alerts alert
    set status = 'resolved',
        resolution_notes = concat_ws(E'\n', nullif(candidates.resolution_notes, ''),
          'Encerrado automaticamente ao virar o dia; não indica revisão nem correção da situação.'),
        resolved_by = null,
        resolved_at = now(),
        updated_at = now()
    from candidates
    where alert.id = candidates.id
    returning alert.id, candidates.status as previous_status,
      candidates.resolution_notes as previous_notes, alert.resolution_notes
  )
  insert into public.audit_logs (table_name, record_id, user_id, action, old_values, new_values)
  select 'attendance_alerts', id, null, 'attendance_alert_auto_resolved',
    jsonb_build_object('status', previous_status, 'resolution_notes', previous_notes),
    jsonb_build_object('status', 'resolved', 'resolution_notes', resolution_notes)
  from resolved;
end;
$$;

revoke all on function public.auto_resolve_past_attendance_alerts() from public, anon, authenticated;

select cron.schedule(
  'ponto-auto-resolve-past-attendance-alerts',
  '0 * * * *',
  'select public.auto_resolve_past_attendance_alerts()'
);

commit;
