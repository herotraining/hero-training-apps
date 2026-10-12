-- Kajabi access (Oct 12): who Family Desk has let into the hubs on hero.training. Every guardian of an active family
-- with a child in a class gets Family Hub Access; every active staff member gets Staff Hub Access; both are taken
-- back when that stops being true. The kajabi-sync function (service role) works out the difference between what
-- should be and what is, grants and revokes through Kajabi's API, and keeps this ledger. Owners read it.
create table if not exists public.kajabi_access (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  kind text not null check (kind in ('family', 'staff')),
  offer_id text not null,                       -- the Kajabi offer that opens the hub
  kajabi_contact_id text,                       -- Kajabi's id for this person, once known
  status text not null check (status in ('granted', 'revoked', 'error')),
  granted_at timestamptz,
  revoked_at timestamptz,
  last_error text,
  synced_at timestamptz not null default now(),
  unique (email, offer_id)
);
create index if not exists kajabi_access_status_idx on public.kajabi_access (status);
alter table public.kajabi_access enable row level security;
create policy kajabi_access_owner_read on public.kajabi_access for select to authenticated using (app.is_owner());
grant select on public.kajabi_access to authenticated;
revoke insert, update, delete, truncate, trigger, references on public.kajabi_access from anon, authenticated;
