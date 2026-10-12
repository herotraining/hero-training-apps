-- Store (Oct 11): uniforms and gear sold by staff at the front desk.
-- Card payments happen on Stripe's own pages (a Checkout QR code the parent scans) or with Tap to Pay in the
-- Stripe Dashboard app; no card details ever reach Family Desk. A required uniform for an ESA family billed in
-- Family Desk rides on that child's next ESA invoice; a family still billed in Jackrabbit has it posted there.
create table if not exists public.store_items (
  id uuid primary key default gen_random_uuid(),
  name text not null check (btrim(name) <> ''),
  kind text not null default 'uniform' check (kind in ('uniform', 'gear', 'other')),
  price_cents integer not null check (price_cents >= 0 and price_cents <= 100000),
  sizes text[] not null default '{}',          -- empty = one size
  esa_ok boolean not null default false,        -- a required uniform: may go on an ESA invoice
  active boolean not null default true,
  sort integer not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.store_sales (
  id uuid primary key default gen_random_uuid(),
  family_id uuid references public.families(id) on delete set null,
  site_id text not null references public.sites(id),
  pay text not null check (pay in ('card', 'esa', 'jackrabbit', 'cash', 'free')),
  status text not null check (status in ('waiting', 'done', 'on_esa', 'invoiced', 'void')),
  total_cents integer not null check (total_cents >= 0),
  stripe_checkout_id text unique,               -- the QR code's Checkout Session; empty for Tap to Pay
  stripe_url text,
  stripe_live boolean,                          -- false = a practice (sandbox) payment, no real money
  note text,
  sold_by uuid references public.staff(id),
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint store_sales_pay_status check (
    (pay = 'card' and status in ('waiting', 'done', 'void')) or
    (pay = 'esa' and status in ('on_esa', 'invoiced', 'void')) or
    (pay in ('jackrabbit', 'cash', 'free') and status in ('done', 'void'))),
  constraint store_sales_free_needs_reason check (pay <> 'free' or coalesce(btrim(note), '') <> '')
);
create index if not exists store_sales_created_idx on public.store_sales (created_at desc);
create index if not exists store_sales_family_idx on public.store_sales (family_id);
create index if not exists store_sales_waiting_idx on public.store_sales (status) where status in ('waiting', 'on_esa');

create table if not exists public.store_sale_lines (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.store_sales(id) on delete cascade,
  item_id uuid references public.store_items(id) on delete set null,
  child_id uuid references public.children(id) on delete set null,
  name text not null,
  size text,
  quantity integer not null default 1 check (quantity between 1 and 50),
  unit_cents integer not null check (unit_cents >= 0),
  esa_invoice_id uuid references public.esa_invoices(id) on delete set null,
  handed_out_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists store_lines_sale_idx on public.store_sale_lines (sale_id);
create index if not exists store_lines_child_idx on public.store_sale_lines (child_id);
create index if not exists store_lines_item_idx on public.store_sale_lines (item_id);
create index if not exists store_lines_invoice_idx on public.store_sale_lines (esa_invoice_id);

alter table public.store_items enable row level security;
alter table public.store_sales enable row level security;
alter table public.store_sale_lines enable row level security;

create or replace function app.store_sale_site(p uuid) returns text
language sql stable security definer set search_path = public
as $$ select s.site_id from public.store_sales s where s.id = p $$;
revoke execute on function app.store_sale_site(uuid) from public, anon;
grant execute on function app.store_sale_site(uuid) to authenticated;

-- Owners and admins sell (an admin pinned to a site sells and sees that site's sales); owners keep the price list.
create policy store_items_read on public.store_items for select to authenticated
  using (app.aal2() and app.role() in ('owner', 'admin'));
create policy store_items_owner_insert on public.store_items for insert to authenticated
  with check (app.is_owner());
create policy store_items_owner_update on public.store_items for update to authenticated
  using (app.is_owner()) with check (app.is_owner());
create policy store_sales_read on public.store_sales for select to authenticated
  using (app.admin_for(site_id));
create policy store_sales_update on public.store_sales for update to authenticated
  using (app.admin_for(site_id)) with check (app.admin_for(site_id));
create policy store_lines_read on public.store_sale_lines for select to authenticated
  using (app.admin_for(app.store_sale_site(sale_id)));
create policy store_lines_update on public.store_sale_lines for update to authenticated
  using (app.admin_for(app.store_sale_site(sale_id))) with check (app.admin_for(app.store_sale_site(sale_id)));

-- Sales are only made through store_create_sale (prices come from the price list, never from the app). After that,
-- staff may move a sale along (paid, voided, a note) and tick items handed out; what was sold never changes.
revoke all on public.store_items, public.store_sales, public.store_sale_lines from anon, authenticated;
grant select, insert, update on public.store_items to authenticated;
grant select on public.store_sales, public.store_sale_lines to authenticated;
grant update (status, note, stripe_checkout_id, stripe_url, stripe_live) on public.store_sales to authenticated;
grant update (handed_out_at, esa_invoice_id) on public.store_sale_lines to authenticated;

-- Who sold it comes from the session; paid_at is stamped when a sale is done. A paid card sale is refunded in
-- Stripe, and a uniform already on an ESA invoice stays there, so neither can be voided here.
create or replace function app.stamp_store_sale() returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    new.sold_by := (app.me()).id;
    new.created_at := now();
    new.paid_at := null;
  else
    new.family_id := old.family_id; new.site_id := old.site_id; new.pay := old.pay;
    new.total_cents := old.total_cents; new.sold_by := old.sold_by; new.created_at := old.created_at;
    if old.status = 'void' and new.status <> 'void' then
      raise exception 'A voided sale stays void. Ring it up again instead.' using errcode = 'P0001';
    end if;
    if new.status = 'void' and old.status <> 'void' then
      if old.pay = 'card' and old.status = 'done' then
        raise exception 'This card payment went through. Refund it in Stripe instead.' using errcode = 'P0001';
      end if;
      if old.status = 'invoiced' or exists (select 1 from public.store_sale_lines l where l.sale_id = old.id and l.esa_invoice_id is not null) then
        raise exception 'This uniform is already on an ESA invoice.' using errcode = 'P0001';
      end if;
    end if;
    if old.status = 'done' and new.status not in ('done', 'void') then
      raise exception 'A finished sale can only be voided.' using errcode = 'P0001';
    end if;
  end if;
  new.updated_at := now();
  -- Paid at the desk (card, cash) or settled (no charge). A Jackrabbit posting is paid later, through Jackrabbit.
  if new.status = 'done' and new.pay in ('card', 'cash', 'free') and new.paid_at is null then new.paid_at := now(); end if;
  return new;
end $$;
revoke execute on function app.stamp_store_sale() from public, anon, authenticated;
create trigger stamp_store_sale before insert or update on public.store_sales for each row execute function app.stamp_store_sale();
create trigger touch_store_items before update on public.store_items for each row execute function app.touch();
create trigger audit_store_items after insert or update on public.store_items for each row execute function app.audit();
create trigger audit_store_sales after insert or update on public.store_sales for each row execute function app.audit();
create trigger audit_store_lines after insert or update on public.store_sale_lines for each row execute function app.audit();

-- Ring up a sale. p_lines: [{item_id, size, quantity, child_id}]. Prices come from the price list.
--   card: a QR code to pay on Stripe's page (waiting until Stripe says paid), or p_card_tapped = Tap to Pay done
--   esa: on the child's next Family Desk ESA invoice (required uniforms, ESA children, family billed in Family Desk)
--   jackrabbit: posted to the family's Jackrabbit account by the person at the desk
--   cash, free (free needs a reason)
create or replace function public.store_create_sale(
  p_site text, p_family uuid, p_pay text, p_card_tapped boolean, p_note text, p_lines jsonb)
returns public.store_sales
language plpgsql security definer set search_path = public
as $$
declare
  s public.store_sales;
  fam public.families;
  it public.store_items;
  kid public.children;
  l jsonb;
  q integer;
  sz text;
  total integer := 0;
  st text;
begin
  if not coalesce(app.admin_for(p_site), false) then
    raise exception 'Only owners and admins of this site can sell.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.sites where id = p_site) then raise exception 'Pick a site.'; end if;
  if p_pay is null or p_pay not in ('card', 'esa', 'jackrabbit', 'cash', 'free') then raise exception 'Pick how they are paying.'; end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then raise exception 'Add at least one item.'; end if;
  if jsonb_array_length(p_lines) = 0 then raise exception 'Add at least one item.'; end if;
  if jsonb_array_length(p_lines) > 30 then raise exception 'Too many lines for one sale.'; end if;
  if p_family is not null then
    select * into fam from public.families where id = p_family;
    if fam.id is null or not app.admin_for(fam.site_id) then raise exception 'Family not found, or not yours to see.'; end if;
  end if;
  if p_pay in ('esa', 'jackrabbit') and fam.id is null then raise exception 'Pick the family first.'; end if;
  if p_pay = 'esa' and fam.stripe_customer_id is null then
    raise exception 'This family is still billed in Jackrabbit. Add it to their Jackrabbit account instead.';
  end if;
  if p_pay = 'jackrabbit' and fam.stripe_customer_id is not null then
    raise exception 'This family is billed in Family Desk now, not Jackrabbit.';
  end if;
  if p_pay = 'free' and coalesce(btrim(p_note), '') = '' then raise exception 'Say why there is no charge.'; end if;

  -- Check every line and add up the price before anything is written.
  for l in select value from jsonb_array_elements(p_lines) loop
    select * into it from public.store_items where id = (l ->> 'item_id')::uuid and active;
    if it.id is null then raise exception 'An item in the cart is no longer for sale. Remove it and add it again.'; end if;
    q := coalesce((l ->> 'quantity')::integer, 1);
    if q < 1 or q > 50 then raise exception 'Quantity must be 1 to 50.'; end if;
    sz := nullif(btrim(l ->> 'size'), '');
    if cardinality(it.sizes) > 0 and (sz is null or not (sz = any (it.sizes))) then raise exception 'Pick a size for the %.', it.name; end if;
    kid := null;
    if nullif(l ->> 'child_id', '') is not null then
      if fam.id is null then raise exception 'Pick the family before naming a child.'; end if;
      select * into kid from public.children where id = (l ->> 'child_id')::uuid and family_id = fam.id;
      if kid.id is null then raise exception 'That child is not in this family.'; end if;
    end if;
    if p_pay = 'esa' then
      if not it.esa_ok then raise exception 'The % is not a required uniform, so ESA can''t pay for it.', it.name; end if;
      if kid.id is null then raise exception 'Pick which child each uniform is for, so it lands on their ESA invoice.'; end if;
      if not exists (select 1 from public.enrollments e where e.child_id = kid.id and e.pay = 'esa' and e.status = 'active') then
        raise exception '% has no active ESA class, so there is no ESA invoice for the uniform to ride on.', kid.first_name;
      end if;
    end if;
    total := total + case when p_pay = 'free' then 0 else it.price_cents * q end;
  end loop;
  if p_pay = 'card' and not coalesce(p_card_tapped, false) and total < 50 then
    raise exception 'Stripe can''t take a card payment under $0.50.';
  end if;

  st := case when p_pay = 'card' then case when coalesce(p_card_tapped, false) then 'done' else 'waiting' end
             when p_pay = 'esa' then 'on_esa' else 'done' end;
  insert into public.store_sales (family_id, site_id, pay, status, total_cents, note)
  values (fam.id, p_site, p_pay, st, total, nullif(btrim(p_note), ''))
  returning * into s;

  for l in select value from jsonb_array_elements(p_lines) loop
    select * into it from public.store_items where id = (l ->> 'item_id')::uuid;
    q := coalesce((l ->> 'quantity')::integer, 1);
    sz := case when cardinality(it.sizes) > 0 then nullif(btrim(l ->> 'size'), '') end;
    insert into public.store_sale_lines (sale_id, item_id, child_id, name, size, quantity, unit_cents)
    values (s.id, it.id, nullif(l ->> 'child_id', '')::uuid, it.name, sz, q, case when p_pay = 'free' then 0 else it.price_cents end);
    -- The first uniform sold for a child records their size on the child, so the next sale starts there.
    if it.kind = 'uniform' and sz is not null and nullif(l ->> 'child_id', '') is not null then
      update public.children set uniform_size = sz where id = (l ->> 'child_id')::uuid and uniform_size is null;
    end if;
  end loop;
  return s;
end $$;
revoke execute on function public.store_create_sale(text, uuid, text, boolean, text, jsonb) from public, anon;
grant execute on function public.store_create_sale(text, uuid, text, boolean, text, jsonb) to authenticated;

-- Starting price list, from what Jackrabbit charged in 2025-26 (owners can change it on the Store screen).
insert into public.store_items (name, kind, price_cents, sizes, esa_ok, sort)
select v.name, v.kind, v.price_cents, v.sizes, v.esa_ok, v.sort
from (values
  ('HERO uniform tank top', 'uniform', 2500, array['Youth XS','Youth S','Youth M','Youth L','Youth XL','Adult S','Adult M','Adult L','Adult XL','Adult 2XL'], true, 10),
  ('HERO uniform T-shirt',  'uniform', 2500, array['Youth XS','Youth S','Youth M','Youth L','Youth XL','Adult S','Adult M','Adult L','Adult XL','Adult 2XL'], true, 20),
  ('HERO uniform hoodie',   'uniform', 2500, array['Youth XS','Youth S','Youth M','Youth L','Youth XL','Adult S','Adult M','Adult L','Adult XL','Adult 2XL'], true, 30),
  ('Extra HERO T-shirt',    'gear',    1500, array['Youth XS','Youth S','Youth M','Youth L','Youth XL','Adult S','Adult M','Adult L','Adult XL','Adult 2XL'], false, 40)
) as v(name, kind, price_cents, sizes, esa_ok, sort)
where not exists (select 1 from public.store_items);
