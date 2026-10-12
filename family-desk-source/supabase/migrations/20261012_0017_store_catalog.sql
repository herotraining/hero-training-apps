-- Store catalog (Oct 12): items get a photo, colors and a short description, so the Store reads like a shop and a
-- uniform request can name the color. A sale line keeps the color it was sold in. Photos live in a public storage
-- bucket that only owners write to.
alter table public.store_items add column if not exists image_url text;
alter table public.store_items add column if not exists colors text[] not null default '{}';   -- empty = one color
alter table public.store_items add column if not exists description text;
alter table public.store_sale_lines add column if not exists color text;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('store-images', 'store-images', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;
drop policy if exists store_images_read on storage.objects;
create policy store_images_read on storage.objects for select to public using (bucket_id = 'store-images');
drop policy if exists store_images_owner_insert on storage.objects;
create policy store_images_owner_insert on storage.objects for insert to authenticated with check (bucket_id = 'store-images' and app.is_owner());
drop policy if exists store_images_owner_update on storage.objects;
create policy store_images_owner_update on storage.objects for update to authenticated using (bucket_id = 'store-images' and app.is_owner());
drop policy if exists store_images_owner_delete on storage.objects;
create policy store_images_owner_delete on storage.objects for delete to authenticated using (bucket_id = 'store-images' and app.is_owner());

-- A line keeps what was sold, color included; the rest is unchanged from migration 0014.
create or replace function app.guard_store_line() returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  new.sale_id := old.sale_id; new.name := old.name; new.size := old.size; new.color := old.color;
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

-- Ring up a sale: the rules of migration 0014, plus a color on each line when the item comes in colors.
-- p_lines: [{item_id, size, color, quantity, child_id, unit_cents}].
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
  co text;
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
    co := nullif(btrim(l ->> 'color'), '');
    if cardinality(it.colors) > 0 and (co is null or not (co = any (it.colors))) then raise exception 'Pick a color for the %.', it.name; end if;
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
    co := case when cardinality(it.colors) > 0 then nullif(btrim(l ->> 'color'), '') end;
    insert into public.store_sale_lines (sale_id, item_id, child_id, name, size, color, quantity, unit_cents)
    values (s.id, it.id, nullif(l ->> 'child_id', '')::uuid, it.name, sz, co, q, case when p_pay = 'free' then 0 else it.price_cents end);
    if it.kind = 'uniform' and sz is not null and nullif(l ->> 'child_id', '') is not null then
      update public.children set uniform_size = sz where id = (l ->> 'child_id')::uuid and uniform_size is null;
    end if;
  end loop;
  return s;
end $$;
revoke execute on function public.store_create_sale(text, uuid, text, boolean, text, jsonb) from public, anon;
grant execute on function public.store_create_sale(text, uuid, text, boolean, text, jsonb) to authenticated;
