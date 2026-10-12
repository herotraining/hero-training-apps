-- Uniform requests (Oct 12): a parent with a child in a class asks for a uniform (shirt type, color, size) from the
-- Family Hub; the request waits here until staff fill it and bill it (ESA invoice, the card on file, or Jackrabbit).
-- Rows are written by the uniform-request function (service role) after it checks the parent's email against the
-- family. Staff read them and move them along; nothing here emails anyone.
create table if not exists public.uniform_requests (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  child_id uuid not null references public.children(id) on delete cascade,
  item_id uuid references public.store_items(id) on delete set null,
  item_name text not null,
  size text,
  color text,
  quantity integer not null default 1 check (quantity between 1 and 10),
  note text,
  requested_by_email text,
  status text not null default 'new' check (status in ('new', 'fulfilled', 'canceled')),
  sale_id uuid references public.store_sales(id) on delete set null,   -- the sale that billed it
  closed_by uuid references public.staff(id),
  closed_at timestamptz,
  closed_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists uniform_requests_open_idx on public.uniform_requests (status, created_at) where status = 'new';
create index if not exists uniform_requests_family_idx on public.uniform_requests (family_id);
alter table public.uniform_requests enable row level security;

-- Owners and admins see and settle requests for children at their sites. Only the function inserts.
create policy uniform_requests_read on public.uniform_requests for select to authenticated
  using (app.admin_for(app.child_site(child_id)));
create policy uniform_requests_update on public.uniform_requests for update to authenticated
  using (app.admin_for(app.child_site(child_id))) with check (app.admin_for(app.child_site(child_id)));
grant select on public.uniform_requests to authenticated;
grant update (status, sale_id, closed_note) on public.uniform_requests to authenticated;
revoke insert, delete, truncate, trigger, references on public.uniform_requests from anon, authenticated;

-- What was asked for never changes; closing a request stamps who and when.
create or replace function app.stamp_uniform_request() returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  new.family_id := old.family_id; new.child_id := old.child_id; new.item_id := old.item_id; new.item_name := old.item_name;
  new.size := old.size; new.color := old.color; new.quantity := old.quantity; new.note := old.note;
  new.requested_by_email := old.requested_by_email; new.created_at := old.created_at;
  if old.status <> 'new' and new.status <> old.status then
    raise exception 'This request is already %.', old.status using errcode = 'P0001';
  end if;
  if new.status = 'fulfilled' and new.sale_id is null then
    raise exception 'A fulfilled request names the sale that billed it.' using errcode = 'P0001';
  end if;
  if new.status <> 'new' and old.status = 'new' then
    new.closed_by := coalesce((app.me()).id, new.closed_by);
    new.closed_at := now();
  end if;
  new.updated_at := now();
  return new;
end $$;
revoke execute on function app.stamp_uniform_request() from public, anon, authenticated;
create trigger stamp_uniform_request before update on public.uniform_requests for each row execute function app.stamp_uniform_request();
create trigger audit_uniform_requests after update on public.uniform_requests for each row execute function app.audit();

-- A card-on-file charge for a sale (a uniform request filled and billed to the family's saved card) is a Stripe
-- PaymentIntent, kept apart from the QR code's Checkout Session. Written by the store function's service key only.
alter table public.store_sales add column if not exists stripe_payment_intent_id text unique;
