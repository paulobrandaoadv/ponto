create extension if not exists pgcrypto;

create table if not exists companies (
  id uuid primary key default gen_random_uuid(),
  razao_social text not null,
  cnpj text,
  nome_fantasia text,
  created_at timestamptz not null default now()
);

create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  nome text not null,
  role text not null check (role in ('admin','gestor','funcionario')),
  company_id uuid references companies(id),
  status text not null default 'ativo',
  created_at timestamptz not null default now()
);

create table if not exists establishments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  nome text not null,
  tipo text not null check (tipo in ('matriz','filial','obra','atendimento')),
  ativo boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists departments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  nome text not null,
  created_at timestamptz not null default now()
);

create table if not exists employees (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id),
  company_id uuid not null references companies(id) on delete cascade,
  nome text not null,
  cpf text not null,
  codigo_registro text,
  matricula text,
  departamento_id uuid references departments(id),
  cargo text,
  situacao text not null default 'ativo',
  data_admissao date,
  jornada text,
  gestor_id uuid references auth.users(id),
  local_trabalho_id uuid references establishments(id),
  modalidade text,
  status text not null default 'ativo',
  created_at timestamptz not null default now()
);

create table if not exists attendance_records (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references employees(id) on delete cascade,
  company_id uuid not null references companies(id) on delete cascade,
  establishment_id uuid references establishments(id),
  source text not null check (source in ('web','mobile','offline')),
  event_type text not null check (event_type in ('entrada','saida_almoco','retorno_almoco','saida')),
  recorded_at timestamptz not null,
  timezone text not null default 'UTC',
  latitude double precision,
  longitude double precision,
  accuracy double precision,
  status text not null default 'pending' check (status in ('pending','confirmed','rejected')),
  device_id text,
  location text,
  notes text,
  recorded_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists audit_logs (
  id uuid primary key default gen_random_uuid(),
  table_name text not null,
  record_id uuid,
  user_id uuid references auth.users(id),
  action text not null,
  old_values jsonb,
  new_values jsonb,
  created_at timestamptz not null default now()
);

alter table companies enable row level security;
alter table profiles enable row level security;
alter table establishments enable row level security;
alter table departments enable row level security;
alter table employees enable row level security;
alter table attendance_records enable row level security;
alter table audit_logs enable row level security;

-- Run supabase/secure_rls.sql after this schema to install company-scoped policies.
