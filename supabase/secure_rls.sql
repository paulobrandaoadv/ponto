alter table public.attendance_records
  add column if not exists location text,
  add column if not exists notes text,
  add column if not exists recorded_by uuid references auth.users(id);

alter table public.attendance_records
  drop constraint if exists attendance_records_source_check;

alter table public.attendance_records
  add constraint attendance_records_source_check
  check (source in ('web', 'web_passkey', 'web_face', 'mobile', 'offline'));

alter table public.employees
  add column if not exists codigo_registro text;

create sequence if not exists public.employee_registration_code_seq;

create or replace function public.next_employee_registration_code()
returns text
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  registration_number bigint;
begin
  registration_number := nextval('public.employee_registration_code_seq');
  return 'ANB-' || case
    when registration_number < 1000 then lpad(registration_number::text, 3, '0')
    else registration_number::text
  end;
end;
$$;

revoke all on function public.next_employee_registration_code() from public, anon, authenticated;

create or replace function public.assign_employee_registration_code()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.codigo_registro is null or trim(new.codigo_registro) = '' then
    new.codigo_registro := public.next_employee_registration_code();
  end if;
  return new;
end;
$$;

revoke all on function public.assign_employee_registration_code() from public, anon, authenticated;

drop trigger if exists assign_employee_registration_code on public.employees;
create trigger assign_employee_registration_code
  before insert on public.employees
  for each row
  execute function public.assign_employee_registration_code();

update public.employees
set codigo_registro = public.next_employee_registration_code()
where codigo_registro is null or trim(codigo_registro) = '';

update public.employees
set codigo_registro = 'ANB-' || case
  when substring(codigo_registro from 5)::bigint < 1000
    then lpad(substring(codigo_registro from 5)::bigint::text, 3, '0')
  else substring(codigo_registro from 5)::bigint::text
end
where codigo_registro ~ '^ANB-[0-9]+$';

alter table public.employees
  alter column codigo_registro set not null;

create unique index if not exists employees_codigo_registro_key
  on public.employees (codigo_registro);

create table if not exists public.employee_passkeys (
  credential_id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  public_key text not null,
  counter bigint not null default 0,
  transports text[] not null default '{}',
  device_type text not null,
  backed_up boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists employee_passkeys_user_id_idx
  on public.employee_passkeys (user_id);

create table if not exists public.passkey_challenges (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  challenge text not null,
  purpose text not null check (purpose in ('register', 'authenticate')),
  expires_at timestamptz not null,
  verified_at timestamptz,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.employee_face_templates (
  employee_id uuid primary key references public.employees(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  template_ciphertext text not null,
  template_iv text not null,
  template_auth_tag text not null,
  key_version smallint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.face_auth_challenges (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.passkey_challenges
  add column if not exists used_at timestamptz;

create index if not exists passkey_challenges_user_id_idx
  on public.passkey_challenges (user_id, purpose, expires_at);

alter table public.employee_passkeys enable row level security;
alter table public.passkey_challenges enable row level security;
alter table public.employee_face_templates enable row level security;
alter table public.face_auth_challenges enable row level security;
revoke all on public.employee_passkeys, public.passkey_challenges from public, anon, authenticated;
grant all on public.employee_passkeys, public.passkey_challenges to service_role;
revoke all on public.employee_face_templates, public.face_auth_challenges from public, anon, authenticated;
grant all on public.employee_face_templates, public.face_auth_challenges to service_role;

create or replace function public.app_current_company_id()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select company_id
  from public.profiles
  where id = (select auth.uid())
    and status = 'ativo'
  limit 1
$$;

create or replace function public.app_current_role()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select role
  from public.profiles
  where id = (select auth.uid())
    and status = 'ativo'
  limit 1
$$;

create or replace function public.app_is_company_manager()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(public.app_current_role() in ('admin', 'gestor'), false)
$$;

revoke all on function public.app_current_company_id() from public, anon;
revoke all on function public.app_current_role() from public, anon;
revoke all on function public.app_is_company_manager() from public, anon;
grant execute on function public.app_current_company_id() to authenticated;
grant execute on function public.app_current_role() to authenticated;
grant execute on function public.app_is_company_manager() to authenticated;

drop policy if exists "Allow view own company company" on public.companies;
drop policy if exists "Allow update own company company" on public.companies;
drop policy if exists "Allow insert profiles" on public.profiles;
drop policy if exists "Allow employees to read own profile" on public.profiles;
drop policy if exists "Allow managers to read team profiles" on public.profiles;
drop policy if exists "Allow any authenticated user to read establishments" on public.establishments;
drop policy if exists "Allow any authenticated user to read departments" on public.departments;
drop policy if exists "Allow any authenticated user to read employees" on public.employees;
drop policy if exists "Allow insert attendance" on public.attendance_records;
drop policy if exists "Allow read attendance" on public.attendance_records;
drop policy if exists "Allow audit log insert" on public.audit_logs;

drop policy if exists companies_read_own_company on public.companies;
drop policy if exists companies_update_admin on public.companies;
drop policy if exists profiles_read_company on public.profiles;
drop policy if exists establishments_read_company on public.establishments;
drop policy if exists establishments_manage_company on public.establishments;
drop policy if exists departments_read_company on public.departments;
drop policy if exists departments_manage_company on public.departments;
drop policy if exists employees_read_company on public.employees;
drop policy if exists employees_insert_company on public.employees;
drop policy if exists employees_update_company on public.employees;
drop policy if exists attendance_read_company on public.attendance_records;
drop policy if exists attendance_insert_company on public.attendance_records;
drop policy if exists audit_logs_read_admin on public.audit_logs;

create policy companies_read_own_company
  on public.companies for select
  to authenticated
  using (id = (select public.app_current_company_id()));

create policy companies_update_admin
  on public.companies for update
  to authenticated
  using (
    id = (select public.app_current_company_id())
    and (select public.app_current_role()) = 'admin'
  )
  with check (
    id = (select public.app_current_company_id())
    and (select public.app_current_role()) = 'admin'
  );

create policy profiles_read_company
  on public.profiles for select
  to authenticated
  using (
    id = (select auth.uid())
    or (
      company_id = (select public.app_current_company_id())
      and (select public.app_is_company_manager())
    )
  );

create policy establishments_read_company
  on public.establishments for select
  to authenticated
  using (company_id = (select public.app_current_company_id()));

create policy establishments_manage_company
  on public.establishments for all
  to authenticated
  using (
    company_id = (select public.app_current_company_id())
    and (select public.app_is_company_manager())
  )
  with check (
    company_id = (select public.app_current_company_id())
    and (select public.app_is_company_manager())
  );

create policy departments_read_company
  on public.departments for select
  to authenticated
  using (company_id = (select public.app_current_company_id()));

create policy departments_manage_company
  on public.departments for all
  to authenticated
  using (
    company_id = (select public.app_current_company_id())
    and (select public.app_is_company_manager())
  )
  with check (
    company_id = (select public.app_current_company_id())
    and (select public.app_is_company_manager())
  );

create policy employees_read_company
  on public.employees for select
  to authenticated
  using (
    company_id = (select public.app_current_company_id())
    and (
      (select public.app_is_company_manager())
      or user_id = (select auth.uid())
    )
  );

create policy employees_insert_company
  on public.employees for insert
  to authenticated
  with check (
    company_id = (select public.app_current_company_id())
    and (select public.app_is_company_manager())
  );

create policy employees_update_company
  on public.employees for update
  to authenticated
  using (
    company_id = (select public.app_current_company_id())
    and (select public.app_is_company_manager())
  )
  with check (
    company_id = (select public.app_current_company_id())
    and (select public.app_is_company_manager())
  );

create policy attendance_read_company
  on public.attendance_records for select
  to authenticated
  using (
    company_id = (select public.app_current_company_id())
    and (
      (select public.app_is_company_manager())
      or exists (
        select 1
        from public.employees e
        where e.id = employee_id
          and e.user_id = (select auth.uid())
      )
    )
  );

create policy attendance_insert_company
  on public.attendance_records for insert
  to authenticated
  with check (
    company_id = (select public.app_current_company_id())
    and recorded_by = (select auth.uid())
    and (select public.app_is_company_manager())
    and exists (
      select 1
      from public.employees e
      where e.id = employee_id
        and e.company_id = attendance_records.company_id
    )
  );

create policy audit_logs_read_admin
  on public.audit_logs for select
  to authenticated
  using (
    (select public.app_current_role()) = 'admin'
    and user_id = (select auth.uid())
  );

create or replace function public.review_attendance_record(
  p_record_id uuid,
  p_status text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  record_to_review public.attendance_records%rowtype;
begin
  if auth.uid() is null
    or not (select public.app_is_company_manager())
    or p_status is null
    or p_status not in ('confirmed', 'rejected') then
    raise exception 'Você não tem permissão para revisar esta marcação.';
  end if;

  select *
  into record_to_review
  from public.attendance_records
  where id = p_record_id
    and company_id = (select public.app_current_company_id())
  for update;

  if not found then
    raise exception 'Marcação não encontrada para esta empresa.';
  end if;

  if record_to_review.status <> 'pending' then
    raise exception 'Esta marcação já foi revisada.';
  end if;

  update public.attendance_records
  set status = p_status
  where id = p_record_id;

  insert into public.audit_logs (
    table_name,
    record_id,
    user_id,
    action,
    old_values,
    new_values
  )
  values (
    'attendance_records',
    p_record_id,
    auth.uid(),
    case when p_status = 'confirmed' then 'attendance_confirmed' else 'attendance_rejected' end,
    jsonb_build_object('status', record_to_review.status),
    jsonb_build_object('status', p_status)
  );
end;
$$;

revoke all on function public.review_attendance_record(uuid, text) from public, anon;
grant execute on function public.review_attendance_record(uuid, text) to authenticated;

drop function if exists public.record_own_attendance(text, text);

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
begin
  if auth.uid() is null or (select public.app_current_role()) <> 'funcionario' then
    raise exception 'Somente funcionário autenticado pode registrar o próprio ponto.';
  end if;

  if p_latitude is null
    or p_longitude is null
    or p_accuracy is null
    or p_latitude < -90 or p_latitude > 90
    or p_longitude < -180 or p_longitude > 180
    or p_accuracy < 0 then
    raise exception 'Não foi possível validar a localização GPS desta marcação.';
  end if;

  select *
  into current_employee
  from public.employees
  where user_id = auth.uid()
    and company_id = (select public.app_current_company_id())
    and lower(status) = 'ativo'
  limit 1;

  if not found then
    raise exception 'Não há cadastro ativo de funcionário vinculado a esta conta.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(current_employee.id::text, 0));

  select event_type
  into last_event
  from public.attendance_records
  where employee_id = current_employee.id
    and (recorded_at at time zone 'America/Campo_Grande')::date =
        (local_now at time zone 'America/Campo_Grande')::date
    and status <> 'rejected'
  order by recorded_at desc
  limit 1;

  next_event := case
    when last_event is null then 'entrada'
    when last_event = 'entrada' then 'saida_almoco'
    when last_event = 'saida_almoco' then 'retorno_almoco'
    when last_event = 'retorno_almoco' then 'saida'
    else null
  end;

  if next_event is null then
    raise exception 'Os quatro registros do dia já foram realizados.';
  end if;

  insert into public.attendance_records (
    employee_id,
    company_id,
    source,
    event_type,
    recorded_at,
    timezone,
    status,
    location,
    notes,
    recorded_by,
    latitude,
    longitude,
    accuracy
  )
  values (
    current_employee.id,
    current_employee.company_id,
    'web',
    next_event,
    local_now,
    'America/Campo_Grande',
    'pending',
    nullif(trim(p_location), ''),
    nullif(trim(p_notes), ''),
    auth.uid(),
    p_latitude,
    p_longitude,
    p_accuracy
  )
  returning id into new_record_id;

  return new_record_id;
end;
$$;

revoke all on function public.record_own_attendance(text, text, double precision, double precision, double precision) from public, anon;
grant execute on function public.record_own_attendance(text, text, double precision, double precision, double precision) to authenticated;

create or replace function public.record_own_attendance_with_passkey(
  p_location text,
  p_notes text,
  p_latitude double precision,
  p_longitude double precision,
  p_accuracy double precision,
  p_challenge_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  verified_challenge public.passkey_challenges%rowtype;
  new_record_id uuid;
begin
  if auth.uid() is null or (select public.app_current_role()) <> 'funcionario' then
    raise exception 'Somente funcionário autenticado pode registrar o próprio ponto.';
  end if;

  select *
  into verified_challenge
  from public.passkey_challenges
  where id = p_challenge_id
    and user_id = auth.uid()
    and company_id = (select public.app_current_company_id())
    and purpose = 'authenticate'
    and verified_at is not null
    and used_at is null
    and expires_at > now()
  for update;

  if not found then
    raise exception 'A verificação do aparelho é inválida, expirou ou já foi usada.';
  end if;

  update public.passkey_challenges
  set used_at = now()
  where id = verified_challenge.id;

  new_record_id := public.record_own_attendance(
    p_location,
    p_notes,
    p_latitude,
    p_longitude,
    p_accuracy
  );

  update public.attendance_records
  set source = 'web_passkey'
  where id = new_record_id
    and recorded_by = auth.uid();

  return new_record_id;
end;
$$;

revoke all on function public.record_own_attendance_with_passkey(text, text, double precision, double precision, double precision, uuid) from public, anon;
grant execute on function public.record_own_attendance_with_passkey(text, text, double precision, double precision, double precision, uuid) to authenticated;

create or replace function public.record_own_attendance_with_face(
  p_location text,
  p_notes text,
  p_latitude double precision,
  p_longitude double precision,
  p_accuracy double precision,
  p_challenge_id uuid
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

  select *
  into verified_challenge
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

  update public.face_auth_challenges
  set used_at = now()
  where id = verified_challenge.id;

  new_record_id := public.record_own_attendance(
    p_location,
    p_notes,
    p_latitude,
    p_longitude,
    p_accuracy
  );

  update public.attendance_records
  set source = 'web_face'
  where id = new_record_id
    and recorded_by = auth.uid();

  return new_record_id;
end;
$$;

revoke all on function public.record_own_attendance_with_face(text, text, double precision, double precision, double precision, uuid) from public, anon;
grant execute on function public.record_own_attendance_with_face(text, text, double precision, double precision, double precision, uuid) to authenticated;

create or replace function public.link_employee_auth_account(
  p_employee_id uuid,
  p_email text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  employee_to_link public.employees%rowtype;
  target_user_id uuid;
  target_email text;
  target_profile public.profiles%rowtype;
begin
  if auth.uid() is null or not (select public.app_is_company_manager()) then
    raise exception 'Somente administradores e gestores podem vincular contas.';
  end if;

  if p_email is null or length(trim(p_email)) = 0 then
    raise exception 'Informe o e-mail da conta criada em Authentication.';
  end if;

  select *
  into employee_to_link
  from public.employees
  where id = p_employee_id
    and company_id = (select public.app_current_company_id())
  for update;

  if not found then
    raise exception 'Funcionário não encontrado nesta empresa.';
  end if;

  select id, email
  into target_user_id, target_email
  from auth.users
  where lower(email) = lower(trim(p_email))
  limit 1;

  if target_user_id is null then
    raise exception 'Não existe usuário com esse e-mail em Authentication → Users.';
  end if;

  select *
  into target_profile
  from public.profiles
  where id = target_user_id;

  if found and target_profile.company_id is not null
    and target_profile.company_id <> employee_to_link.company_id then
    raise exception 'A conta já está vinculada a outra empresa.';
  end if;

  if found and target_profile.role not in ('funcionario') then
    raise exception 'Essa conta já tem perfil de administrador ou gestor e não pode ser vinculada como funcionário.';
  end if;

  if exists (
    select 1
    from public.profiles
    where id <> target_user_id
      and status = 'ativo'
      and lower(regexp_replace(trim(nome), '\s+', ' ', 'g'))
        = lower(regexp_replace(trim(employee_to_link.nome), '\s+', ' ', 'g'))
  ) then
    raise exception 'Já existe um perfil ativo com esse nome. Use um nome diferente para permitir o login.';
  end if;

  if exists (
    select 1
    from public.employees
    where user_id = target_user_id
      and id <> employee_to_link.id
  ) then
    raise exception 'Essa conta já está vinculada a outro cadastro de funcionário.';
  end if;

  if employee_to_link.user_id is not null
    and employee_to_link.user_id <> target_user_id then
    raise exception 'Este funcionário já está vinculado a outra conta.';
  end if;

  update public.employees
  set user_id = target_user_id
  where id = employee_to_link.id;

  insert into public.profiles (id, email, nome, role, company_id, status)
  values (
    target_user_id,
    target_email,
    employee_to_link.nome,
    'funcionario',
    employee_to_link.company_id,
    'ativo'
  )
  on conflict (id) do update
  set email = excluded.email,
      nome = excluded.nome,
      company_id = excluded.company_id,
      status = 'ativo';

  insert into public.audit_logs (
    table_name,
    record_id,
    user_id,
    action,
    old_values,
    new_values
  )
  values (
    'employees',
    employee_to_link.id,
    auth.uid(),
    'employee_account_linked',
    jsonb_build_object('user_id', employee_to_link.user_id),
    jsonb_build_object('user_id', target_user_id, 'email', target_email)
  );
end;
$$;

revoke all on function public.link_employee_auth_account(uuid, text) from public, anon;
grant execute on function public.link_employee_auth_account(uuid, text) to authenticated;

create or replace function public.create_employee_with_auth_account(
  p_auth_user_id uuid,
  p_email text,
  p_name text,
  p_cpf text,
  p_department_name text,
  p_job_title text,
  p_shift text,
  p_status text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target_company_id uuid;
  target_department_id uuid;
  new_employee_id uuid;
  target_email text := lower(trim(p_email));
  target_name text := regexp_replace(trim(p_name), '\s+', ' ', 'g');
begin
  if auth.uid() is null or not (select public.app_is_company_manager()) then
    raise exception 'Somente administradores e gestores podem cadastrar funcionários.';
  end if;

  target_company_id := (select public.app_current_company_id());
  if target_company_id is null then
    raise exception 'Seu perfil não está vinculado a uma empresa.';
  end if;

  if p_auth_user_id is null
    or p_email is null
    or p_name is null
    or p_cpf is null
    or p_department_name is null
    or p_job_title is null
    or p_shift is null
    or p_status is null
    or target_email = ''
    or target_name = ''
    or trim(p_cpf) = ''
    or trim(p_department_name) = ''
    or trim(p_job_title) = ''
    or trim(p_shift) = ''
    or p_status not in ('Ativo', 'Férias', 'Licença') then
    raise exception 'Preencha todos os dados do funcionário e da conta.';
  end if;

  if not exists (
    select 1
    from auth.users
    where id = p_auth_user_id
      and lower(email) = target_email
  ) then
    raise exception 'A conta de autenticação não foi encontrada.';
  end if;

  if exists (
    select 1
    from public.employees
    where company_id = target_company_id
      and cpf = trim(p_cpf)
  ) then
    raise exception 'Já existe um funcionário cadastrado com esse CPF nesta empresa.';
  end if;

  if exists (
    select 1
    from public.profiles
    where status = 'ativo'
      and lower(regexp_replace(trim(nome), '\s+', ' ', 'g')) = lower(target_name)
  ) then
    raise exception 'Já existe um perfil ativo com esse nome. Use um nome diferente para permitir o login.';
  end if;

  select id
  into target_department_id
  from public.departments
  where company_id = target_company_id
    and lower(nome) = lower(trim(p_department_name))
  limit 1;

  if target_department_id is null then
    insert into public.departments (company_id, nome)
    values (target_company_id, trim(p_department_name))
    returning id into target_department_id;
  end if;

  insert into public.employees (
    user_id,
    company_id,
    nome,
    cpf,
    departamento_id,
    cargo,
    jornada,
    situacao,
    status
  )
  values (
    p_auth_user_id,
    target_company_id,
    target_name,
    trim(p_cpf),
    target_department_id,
    trim(p_job_title),
    trim(p_shift),
    lower(p_status),
    p_status
  )
  returning id into new_employee_id;

  insert into public.profiles (id, email, nome, role, company_id, status)
  values (p_auth_user_id, target_email, target_name, 'funcionario', target_company_id, 'ativo');

  insert into public.audit_logs (
    table_name,
    record_id,
    user_id,
    action,
    new_values
  )
  values (
    'employees',
    new_employee_id,
    auth.uid(),
    'employee_account_created',
    jsonb_build_object('user_id', p_auth_user_id, 'email', target_email)
  );

  return new_employee_id;
end;
$$;

revoke all on function public.create_employee_with_auth_account(uuid, text, text, text, text, text, text, text) from public, anon;
grant execute on function public.create_employee_with_auth_account(uuid, text, text, text, text, text, text, text) to authenticated;

create or replace function public.sync_linked_employee_profile_name()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.user_id is not null and new.nome is distinct from old.nome then
    if exists (
      select 1
      from public.profiles
      where id <> new.user_id
        and status = 'ativo'
        and lower(regexp_replace(trim(nome), '\s+', ' ', 'g'))
          = lower(regexp_replace(trim(new.nome), '\s+', ' ', 'g'))
    ) then
      raise exception 'Já existe um perfil ativo com esse nome. Use um nome diferente para permitir o login.';
    end if;

    update public.profiles
    set nome = new.nome
    where id = new.user_id
      and role = 'funcionario';
  end if;

  return new;
end;
$$;

revoke all on function public.sync_linked_employee_profile_name() from public, anon, authenticated;

drop trigger if exists sync_linked_employee_profile_name on public.employees;
create trigger sync_linked_employee_profile_name
  after update of nome, user_id on public.employees
  for each row
  execute function public.sync_linked_employee_profile_name();

create or replace function public.archive_employee(p_employee_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  employee_to_archive public.employees%rowtype;
  linked_profile public.profiles%rowtype;
begin
  if auth.uid() is null or not (select public.app_is_company_manager()) then
    raise exception 'Somente administradores e gestores podem arquivar funcionários.';
  end if;

  select *
  into employee_to_archive
  from public.employees
  where id = p_employee_id
    and company_id = (select public.app_current_company_id())
  for update;

  if not found then
    raise exception 'Funcionário não encontrado nesta empresa.';
  end if;

  if employee_to_archive.user_id is not null then
    select *
    into linked_profile
    from public.profiles
    where id = employee_to_archive.user_id
    for update;

    if not found or linked_profile.role <> 'funcionario'
      or linked_profile.company_id <> employee_to_archive.company_id then
      raise exception 'A conta vinculada não é um perfil de funcionário desta empresa.';
    end if;

    update public.profiles
    set status = 'inativo'
    where id = employee_to_archive.user_id;

    delete from public.employee_passkeys
    where user_id = employee_to_archive.user_id;

    delete from public.passkey_challenges
    where user_id = employee_to_archive.user_id;

    delete from public.face_auth_challenges
    where user_id = employee_to_archive.user_id;
  end if;

  delete from public.employee_face_templates
  where employee_id = employee_to_archive.id;

  update public.employees
  set status = 'Inativo',
      situacao = 'inativo'
  where id = employee_to_archive.id;

  insert into public.audit_logs (
    table_name,
    record_id,
    user_id,
    action,
    old_values,
    new_values
  )
  values (
    'employees',
    employee_to_archive.id,
    auth.uid(),
    'employee_archived',
    jsonb_build_object('status', employee_to_archive.status),
    jsonb_build_object('status', 'Inativo', 'attendance_records_preserved', true)
  );
end;
$$;

revoke all on function public.archive_employee(uuid) from public, anon;
grant execute on function public.archive_employee(uuid) to authenticated;

create or replace function public.restore_employee(p_employee_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  employee_to_restore public.employees%rowtype;
  linked_profile public.profiles%rowtype;
begin
  if auth.uid() is null or not (select public.app_is_company_manager()) then
    raise exception 'Somente administradores e gestores podem restaurar funcionários.';
  end if;

  select *
  into employee_to_restore
  from public.employees
  where id = p_employee_id
    and company_id = (select public.app_current_company_id())
  for update;

  if not found then
    raise exception 'Funcionário não encontrado nesta empresa.';
  end if;

  if employee_to_restore.status <> 'Inativo' then
    raise exception 'Este funcionário não está arquivado.';
  end if;

  if employee_to_restore.user_id is not null then
    select *
    into linked_profile
    from public.profiles
    where id = employee_to_restore.user_id
    for update;

    if not found or linked_profile.role <> 'funcionario'
      or linked_profile.company_id <> employee_to_restore.company_id then
      raise exception 'A conta vinculada não é um perfil de funcionário desta empresa.';
    end if;

    if exists (
      select 1
      from public.profiles
      where id <> employee_to_restore.user_id
        and status = 'ativo'
        and lower(regexp_replace(trim(nome), '\s+', ' ', 'g'))
          = lower(regexp_replace(trim(employee_to_restore.nome), '\s+', ' ', 'g'))
    ) then
      raise exception 'Outro perfil ativo já usa esse nome. Altere o nome antes de restaurar o acesso.';
    end if;

    update public.profiles
    set status = 'ativo'
    where id = employee_to_restore.user_id;
  end if;

  update public.employees
  set status = 'Ativo',
      situacao = 'ativo'
  where id = employee_to_restore.id;

  insert into public.audit_logs (
    table_name,
    record_id,
    user_id,
    action,
    old_values,
    new_values
  )
  values (
    'employees',
    employee_to_restore.id,
    auth.uid(),
    'employee_restored',
    jsonb_build_object('status', employee_to_restore.status),
    jsonb_build_object('status', 'Ativo')
  );
end;
$$;

revoke all on function public.restore_employee(uuid) from public, anon;
grant execute on function public.restore_employee(uuid) to authenticated;
