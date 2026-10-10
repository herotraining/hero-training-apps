-- Two years of Jackrabbit fees and payments per family (Transaction Listing export, Jul 31 2025 to Oct 9 2026).
-- Read-only reference for owners/admins on the Family page; no card or bank details were brought over.
create table if not exists public.jackrabbit_history (
  id uuid primary key,
  family_id uuid references public.families(id) on delete set null,
  last_name text not null,
  on_date date not null,
  kind text not null,        -- Jackrabbit's type: Tuition Fee, Payment, Uniform: (Required), Surcharge, Drop-In, refunds, credits
  subtype text,              -- month the payment covered, or the uniform item
  student text,
  activity text,             -- Jackrabbit class name as it was then
  amount_cents integer not null,  -- positive = charged, negative = paid or credited
  note text
);
create index if not exists jackrabbit_history_family on public.jackrabbit_history (family_id, on_date);
create index if not exists jackrabbit_history_last on public.jackrabbit_history (lower(last_name));
alter table public.jackrabbit_history enable row level security;

create or replace function app.family_site(p_family uuid) returns text
language sql stable security definer set search_path = public as
$$ select f.site_id from public.families f where f.id = p_family $$;

create policy jr_history_read on public.jackrabbit_history for select to authenticated
  using (app.admin_for(app.family_site(family_id)));
create policy jr_history_write on public.jackrabbit_history for all to authenticated
  using (app.is_owner()) with check (app.is_owner());
grant select, insert, update, delete on public.jackrabbit_history to authenticated;

-- Rows were loaded from the export in chunks; family matching: student first name within the surname, then
-- unique surname, then (for shared surnames) a subset-sum fit against Jackrabbit's own balance report so every
-- family's total equals its Jackrabbit balance. Those guessed rows carry "(shared surname: matched to this family by balance)".
