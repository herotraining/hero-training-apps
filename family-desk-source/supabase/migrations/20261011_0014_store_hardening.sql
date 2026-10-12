-- Store hardening (Oct 11, after an independent review). The database, not just the app, now holds the money rules:
-- a card sale with a Stripe payment page is settled only by the store function after it checks Stripe, a sale on an
-- ESA invoice can't go back, a uniform on an ESA invoice can't be let go except when that invoice is thrown away,
-- and a uniform is claimed for an invoice only while its sale is still waiting for one (with the sale locked, so a
-- void can't slip in between). Prices are locked while a sale is rung up and checked against what the cart showed.

-- Calls from the store function's service key, or straight from the database (migrations, the morning sweep), as
-- opposed to a signed-in staff member's own session.
create or replace function app.trusted_writer() returns boolean
language sql stable
as $$ select auth.jwt() is null or coalesce(auth.jwt() ->> 'role', '') = 'service_role' $$;
revoke execute on function app.trusted_writer() from public, anon, authenticated;

-- Who confirmed a card sale's outcome in Stripe (the store function writes it with its service key).
alter table public.store_sales add column if not exists settled_by uuid references public.staff(id);

create or replace function app.stamp_store_sale() returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    new.sold_by := (app.me()).id;
    new.created_at := now();
    new.paid_at := null;
    new.settled_by := null;
  else
    new.site_id := old.site_id; new.pay := old.pay; new.total_cents := old.total_cents;
    new.sold_by := old.sold_by; new.created_at := old.created_at;
    -- A sale never moves to another family; it only loses the link if the family record is deleted.
    if new.family_id is not null then new.family_id := old.family_id; end if;
    if not app.trusted_writer() then
      new.settled_by := old.settled_by;
      if new.stripe_checkout_id is distinct from old.stripe_checkout_id
         or new.stripe_url is distinct from old.stripe_url or new.stripe_live is distinct from old.stripe_live then
        raise exception 'Only the Store''s payment step sets the Stripe payment page.' using errcode = 'P0001';
      end if;
      if old.pay = 'card' and new.status is distinct from old.status
         and not (old.status = 'waiting' and new.status = 'void' and old.stripe_checkout_id is null) then
        raise exception 'A card sale is settled through Stripe from the Store screen.' using errcode = 'P0001';
      end if;
    end if;
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
    if old.status = 'invoiced' and new.status <> 'invoiced' then
      raise exception 'This sale is on an ESA invoice already.' using errcode = 'P0001';
    end if;
    if old.status = 'on_esa' and new.status = 'invoiced'
       and exists (select 1 from public.store_sale_lines l where l.sale_id = old.id and l.esa_invoice_id is null) then
      raise exception 'Every uniform in the sale has to be on an ESA invoice first.' using errcode = 'P0001';
    end if;
  end if;
  new.updated_at := now();
  if new.status = 'done' and new.pay in ('card', 'cash', 'free') and new.paid_at is null then new.paid_at := now(); end if;
  return new;
end $$;
revoke execute on function app.stamp_store_sale() from public, anon, authenticated;

-- A line keeps what was sold; only "handed out" and its ESA invoice change, under these rules.
create or replace function app.guard_store_line() returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  new.sale_id := old.sale_id; new.name := old.name; new.size := old.size;
  new.quantity := old.quantity; new.unit_cents := old.unit_cents; new.created_at := old.created_at;
  -- The item or child link may only be emptied (their record was deleted), never pointed elsewhere.
  if new.item_id is not null then new.item_id := old.item_id; end if;
  if new.child_id is not null then new.child_id := old.child_id; end if;
  if new.esa_invoice_id is distinct from old.esa_invoice_id then
    if new.esa_invoice_id is null then
      -- Let go only when the invoice it was on has been thrown away (a failed invoice run).
      if not app.trusted_writer() and exists (select 1 from public.esa_invoices i where i.id = old.esa_invoice_id) then
        raise exception 'A uniform on an ESA invoice stays on it.' using errcode = 'P0001';
      end if;
    else
      if old.esa_invoice_id is not null then
        raise exception 'This uniform is already on an ESA invoice.' using errcode = 'P0001';
      end if;
      perform 1 from public.store_sales s where s.id = old.sale_id and s.pay = 'esa' and s.status = 'on_esa' for update;
      if not found then
        raise exception 'This uniform is not waiting for an ESA invoice.' using errcode = 'P0001';
      end if;
      if not exists (select 1 from public.esa_invoices i where i.id = new.esa_invoice_id and i.child_id = old.child_id and i.status = 'draft') then
        raise exception 'A uniform goes only on its own child''s new ESA invoice.' using errcode = 'P0001';
      end if;
    end if;
  end if;
  return new;
end $$;
revoke execute on function app.guard_store_line() from public, anon, authenticated;
create or replace trigger guard_store_line before update on public.store_sale_lines for each row execute function app.guard_store_line();

-- Ring up a sale (unchanged rules), now holding the price list rows steady while the sale is written, and refusing a
-- line whose price changed since it went into the cart (p_lines may carry the unit_cents the cart showed).
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

  for l in select value from jsonb_array_elements(p_lines) loop
    select * into it from public.store_items where id = (l ->> 'item_id')::uuid and active for share;
    if it.id is null then raise exception 'An item in the cart is no longer for sale. Remove it and add it again.'; end if;
    if nullif(l ->> 'unit_cents', '') is not null and (l ->> 'unit_cents')::integer <> it.price_cents then
      raise exception 'The price of the % changed to %. Remove it from the cart and add it again.', it.name, to_char(it.price_cents / 100.0, 'FM$999,990.00');
    end if;
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
    if it.kind = 'uniform' and sz is not null and nullif(l ->> 'child_id', '') is not null then
      update public.children set uniform_size = sz where id = (l ->> 'child_id')::uuid and uniform_size is null;
    end if;
  end loop;
  return s;
end $$;
revoke execute on function public.store_create_sale(text, uuid, text, boolean, text, jsonb) from public, anon;
grant execute on function public.store_create_sale(text, uuid, text, boolean, text, jsonb) to authenticated;
