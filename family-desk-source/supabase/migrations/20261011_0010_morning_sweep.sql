-- Morning sweep (Oct 11): what Claude's daily read-only pass over the front-desk inbox and the bank feed leaves for staff.
-- Rows are written by the sweep (service role). Staff only read them and tick them off; nothing here emails anyone.

-- 1. Inbox items that need a reply (parent emails; notifications are skipped).
create table if not exists public.desk_feed (
  id uuid primary key default gen_random_uuid(),
  kind text not null default 'email' check (kind in ('email')),
  source_id text not null unique,            -- Gmail thread id
  title text not null,                       -- subject
  summary text,                              -- one line: what they are asking
  from_name text,
  from_email text,
  family_id uuid references public.families(id) on delete set null,
  link text,                                 -- opens the thread in Gmail
  last_message_at timestamptz,
  status text not null default 'open' check (status in ('open', 'done')),
  done_by uuid references public.staff(id),
  done_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists desk_feed_open_idx on public.desk_feed (status, last_message_at desc);
alter table public.desk_feed enable row level security;

-- 2. ClassWallet deposits from the bank feed: one ACH per order, net of ClassWallet's 2% fee, no family name.
create table if not exists public.classwallet_deposits (
  id uuid primary key default gen_random_uuid(),
  bank_txn_id text not null unique,          -- SuperBooks transaction id
  on_date date not null,
  net_cents integer not null,                -- what landed in the bank
  gross_cents integer not null,              -- net / 0.98, rounded: the invoice amount the parent submitted
  fee_cents integer not null,                -- gross - net
  status text not null default 'new' check (status in ('new', 'confirmed', 'ignored')),
  esa_invoice_id uuid references public.esa_invoices(id) on delete set null,
  note text,
  confirmed_by uuid references public.staff(id),
  confirmed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists classwallet_deposits_date_idx on public.classwallet_deposits (on_date desc);
alter table public.classwallet_deposits enable row level security;

-- 3. Venmo payouts to trainers and landlords, from the Venmo receipts in the inbox (owners only).
create table if not exists public.trainer_pay (
  id uuid primary key default gen_random_uuid(),
  gmail_message_id text not null unique,
  paid_on date not null,
  payee text not null,                       -- who received the Venmo
  amount_cents integer not null,
  memo text,                                 -- the Venmo note as written
  period text,                               -- e.g. 9/16-9/30
  hours numeric(6,2),
  kind text not null default 'trainer' check (kind in ('trainer', 'facility', 'other')),
  bank_txn_id text,                          -- the matching VENMO line in SuperBooks, when found
  created_at timestamptz not null default now()
);
create index if not exists trainer_pay_date_idx on public.trainer_pay (paid_on desc);
alter table public.trainer_pay enable row level security;

-- Who sees what. Owners and admins work the feed and the deposits; only owners see pay.
create policy desk_feed_read on public.desk_feed for select to authenticated
  using (app.aal2() and app.role() in ('owner', 'admin'));
create policy desk_feed_update on public.desk_feed for update to authenticated
  using (app.aal2() and app.role() in ('owner', 'admin'))
  with check (app.aal2() and app.role() in ('owner', 'admin'));

create policy cw_deposits_read on public.classwallet_deposits for select to authenticated
  using (app.aal2() and app.role() in ('owner', 'admin'));
create policy cw_deposits_update on public.classwallet_deposits for update to authenticated
  using (app.aal2() and app.role() in ('owner', 'admin'))
  with check (app.aal2() and app.role() in ('owner', 'admin'));

create policy trainer_pay_read on public.trainer_pay for select to authenticated
  using (app.is_owner());

grant select, update on public.desk_feed to authenticated;
grant select, update on public.classwallet_deposits to authenticated;
grant select on public.trainer_pay to authenticated;
revoke insert, delete, truncate, trigger, references on public.desk_feed from authenticated;
revoke insert, delete, truncate, trigger, references on public.classwallet_deposits from authenticated;
revoke insert, update, delete, truncate, trigger, references on public.trainer_pay from authenticated;

-- Stamp who ticked an item off or confirmed a deposit, from the session.
create or replace function app.stamp_desk_feed() returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  new.updated_at := now();
  if new.status = 'done' and (old.status is distinct from 'done') then
    new.done_by := (app.me()).id;
    new.done_at := now();
  elsif new.status = 'open' then
    new.done_by := null;
    new.done_at := null;
  end if;
  return new;
end $$;
revoke execute on function app.stamp_desk_feed() from public, anon, authenticated;
create trigger stamp_desk_feed before update on public.desk_feed for each row execute function app.stamp_desk_feed();

create or replace function app.stamp_cw_deposit() returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.status in ('confirmed', 'ignored') and (old.status is distinct from new.status) then
    new.confirmed_by := (app.me()).id;
    new.confirmed_at := now();
  elsif new.status = 'new' then
    new.confirmed_by := null;
    new.confirmed_at := null;
    new.esa_invoice_id := null;
  end if;
  return new;
end $$;
revoke execute on function app.stamp_cw_deposit() from public, anon, authenticated;
create trigger stamp_cw_deposit before update on public.classwallet_deposits for each row execute function app.stamp_cw_deposit();
create trigger audit_cw_deposits after update on public.classwallet_deposits for each row execute function app.audit();
