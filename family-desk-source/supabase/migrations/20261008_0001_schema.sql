-- HERO Family Desk: core schema, roles, audit log.
create schema if not exists app;

create type public.staff_role as enum ('owner','admin','site_lead','coach');
create type public.pay_method as enum ('esa','private','split');
create type public.enrollment_status as enum ('active','hold','dropped','waitlist');
create type public.enroll_pay as enum ('esa','card');
create type public.esa_status as enum ('draft','sent','submitted','paid','rejected','void');

create table public.sites (
  id text primary key,
  name text not null,
  gym text,
  city text,
  active boolean not null default true
);

create table public.staff (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique references auth.users(id) on delete set null,
  email text not null unique,
  name text not null,
  role public.staff_role not null,
  site_id text references public.sites(id),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index staff_user_id_idx on public.staff(user_id);

create table public.programs (
  id text primary key,
  name text not null,
  kind text not null,
  site_id text not null references public.sites(id),
  weekday smallint check (weekday between 0 and 6),
  start_time time,
  end_time time,
  monthly_price_cents integer not null,
  stripe_product_id text,
  stripe_price_id text,
  active boolean not null default true
);
create index programs_site_idx on public.programs(site_id);

create table public.families (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  site_id text not null references public.sites(id),
  pay_method public.pay_method not null default 'private',
  stripe_customer_id text unique,
  address_line1 text,
  city text,
  state text default 'AZ',
  zip text,
  text_consent boolean not null default false,
  notes text,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index families_site_idx on public.families(site_id);

create table public.guardians (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  name text not null,
  email text,
  mobile text,
  is_primary boolean not null default false,
  created_at timestamptz not null default now()
);
create index guardians_family_idx on public.guardians(family_id);

create table public.children (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  first_name text not null,
  last_name text not null,
  birth_date date not null,
  site_id text not null references public.sites(id),
  uniform_size text,
  esa boolean not null default false,
  house text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index children_family_idx on public.children(family_id);
create index children_site_idx on public.children(site_id);

create table public.care_notes (
  child_id uuid primary key references public.children(id) on delete cascade,
  allergies text,
  medications text,
  emergency_contacts jsonb not null default '[]'::jsonb,
  authorized_pickups jsonb not null default '[]'::jsonb,
  notes text,
  updated_at timestamptz not null default now()
);

create table public.agreements (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  kind text not null,
  signed_at timestamptz,
  signed_by text,
  created_at timestamptz not null default now()
);
create index agreements_family_idx on public.agreements(family_id);

create table public.enrollments (
  id uuid primary key default gen_random_uuid(),
  child_id uuid not null references public.children(id) on delete cascade,
  program_id text not null references public.programs(id),
  status public.enrollment_status not null default 'active',
  pay public.enroll_pay not null default 'card',
  start_date date not null default current_date,
  end_date date,
  stripe_subscription_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (child_id, program_id)
);
create index enrollments_program_idx on public.enrollments(program_id);
create index enrollments_child_idx on public.enrollments(child_id);

create table public.coach_assignments (
  staff_id uuid not null references public.staff(id) on delete cascade,
  program_id text not null references public.programs(id) on delete cascade,
  primary key (staff_id, program_id)
);
create index coach_assignments_program_idx on public.coach_assignments(program_id);

create table public.esa_invoices (
  id uuid primary key default gen_random_uuid(),
  child_id uuid not null references public.children(id) on delete cascade,
  enrollment_id uuid references public.enrollments(id) on delete set null,
  class_month date not null,
  amount_cents integer not null,
  stripe_invoice_id text unique,
  hosted_invoice_url text,
  status public.esa_status not null default 'draft',
  sent_at timestamptz,
  paid_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (child_id, class_month)
);
create index esa_invoices_child_idx on public.esa_invoices(child_id);

create table public.closures (
  id uuid primary key default gen_random_uuid(),
  site_id text references public.sites(id),
  on_date date not null,
  title text not null,
  note text,
  created_at timestamptz not null default now()
);
create index closures_date_idx on public.closures(on_date);

create table public.audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor_user_id uuid,
  actor_email text,
  action text not null,
  entity text not null,
  entity_id text,
  reason text,
  before jsonb,
  after jsonb
);
create index audit_log_entity_idx on public.audit_log(entity, entity_id);
create index audit_log_at_idx on public.audit_log(at desc);
