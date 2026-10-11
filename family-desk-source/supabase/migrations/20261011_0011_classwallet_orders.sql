-- ClassWallet "Payment Receipt" emails (vendor copies), one row per order: the student, the parent's email,
-- what was submitted, ClassWallet's 2% fee and what settles to the bank. ClassWallet emails a receipt for only
-- some orders (about one in five), so the bank deposits stay the complete record; a receipt, when there is one,
-- names the student for a deposit. Loaded from the owner's mailbox Oct 11 (Dec 2023 onward); the morning sweep adds new ones.
create table if not exists public.classwallet_orders (
  order_no text primary key,
  order_date date not null,
  student text not null,
  parent_email text,
  submitted_cents integer not null,
  fee_cents integer not null,
  settlement_cents integer not null,
  family_id uuid references public.families(id) on delete set null,
  child_id uuid references public.children(id) on delete set null,
  gmail_message_id text,
  created_at timestamptz not null default now()
);
create index if not exists classwallet_orders_date_idx on public.classwallet_orders (order_date desc);
create index if not exists classwallet_orders_child_idx on public.classwallet_orders (child_id);
alter table public.classwallet_orders enable row level security;

alter table public.classwallet_deposits add column if not exists order_no text references public.classwallet_orders(order_no) on delete set null;

create policy cw_orders_read on public.classwallet_orders for select to authenticated
  using (app.aal2() and app.role() in ('owner', 'admin'));
grant select on public.classwallet_orders to authenticated;
revoke insert, update, delete, truncate, trigger, references on public.classwallet_orders from authenticated;
