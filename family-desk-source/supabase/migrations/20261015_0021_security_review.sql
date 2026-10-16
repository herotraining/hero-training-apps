-- Security review of October 11, 2026: findings F1 to F7 closed in the database. (F8 lives in staff-signin and the
-- app's sign-in flow; F9 in esa-invoices.) Nothing is removed here: functions are replaced, policies altered,
-- triggers switched off and re-made, grants narrowed.

-- ---------------------------------------------------------------------------------------------------------------
-- F1. A new auth user links to a staff row only when it was made from the Staff screen: staff-signin's createUser
-- stamps app_metadata.family_desk = 'staff'. Any other new user, and any anonymous one, is refused. The two owner
-- sign-ins that already exist have their staff rows linked, so nothing changes for them.
create or replace function app.on_auth_user_created()
returns trigger language plpgsql security definer set search_path = public
as $$
declare s public.staff;
begin
  if coalesce(new.is_anonymous, false) then
    raise exception 'Anonymous sign-ins are not used by Family Desk.' using errcode = 'P0001';
  end if;
  if coalesce(new.raw_app_meta_data ->> 'family_desk', '') <> 'staff' then
    raise exception 'Sign-ins are created from the Staff screen in Family Desk.' using errcode = 'P0001';
  end if;
  select * into s from public.staff
   where lower(email) = lower(new.email) and active and user_id is null limit 1;
  if s.id is null then
    raise exception 'This email is not on the HERO staff list, or already has a sign-in.' using errcode = 'P0001';
  end if;
  update public.staff set user_id = new.id where id = s.id;
  return new;
end $$;
revoke execute on function app.on_auth_user_created() from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- F2. The inbox feed, ClassWallet receipts and bank deposits are scoped like everything else: an owner or an
-- all-sites admin sees them all; an admin pinned to a site sees rows whose family is at that site (for a deposit,
-- the family on its linked receipt) and rows tied to no family at all. Staff may change only the columns the
-- screens change, and every column change on a deposit is audited.
create or replace function app.admin_for_family(p_family uuid) returns boolean
language sql stable security definer set search_path = public
as $$
  select app.aal2() and (
    app.role() = 'owner'
    or (app.role() = 'admin' and (app.site() is null or p_family is null or app.family_site(p_family) = app.site()))
  )
$$;
revoke execute on function app.admin_for_family(uuid) from public, anon;
grant execute on function app.admin_for_family(uuid) to authenticated;

create or replace function app.order_family(p_order text) returns uuid
language sql stable security definer set search_path = public
as $$ select o.family_id from public.classwallet_orders o where o.order_no = p_order $$;
revoke execute on function app.order_family(text) from public, anon;
grant execute on function app.order_family(text) to authenticated;

alter policy desk_feed_read on public.desk_feed using (app.admin_for_family(family_id));
alter policy desk_feed_update on public.desk_feed
  using (app.admin_for_family(family_id)) with check (app.admin_for_family(family_id));
alter policy cw_orders_read on public.classwallet_orders using (app.admin_for_family(family_id));
alter policy cw_deposits_read on public.classwallet_deposits using (app.admin_for_family(app.order_family(order_no)));
alter policy cw_deposits_update on public.classwallet_deposits
  using (app.admin_for_family(app.order_family(order_no))) with check (app.admin_for_family(app.order_family(order_no)));

revoke update on public.desk_feed from authenticated;
grant update (status) on public.desk_feed to authenticated;
revoke update on public.classwallet_deposits from authenticated;
grant update (status, esa_invoice_id, note) on public.classwallet_deposits to authenticated;

alter table public.classwallet_deposits disable trigger audit_cw_deposits;
create or replace trigger audit_cw_deposits_all after update on public.classwallet_deposits
  for each row execute function app.audit();

-- ---------------------------------------------------------------------------------------------------------------
-- F3 (ESA part). An invoice becomes paid only with a reason on the transaction, which public.mark_esa_paid sets
-- (the Mark paid button, and the esa-invoices function after Stripe agrees). A plain update to 'paid' is refused.
-- The links staff open from the screens may only point at Stripe's invoice page, Gmail, or Stripe Checkout.
create or replace function app.guard_esa_paid() returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.status = 'paid' and (tg_op = 'INSERT' or old.status is distinct from 'paid')
     and coalesce(current_setting('app.reason', true), '') = '' then
    raise exception 'An ESA invoice is marked paid with a reason, through Mark paid.' using errcode = 'P0001';
  end if;
  return new;
end $$;
revoke execute on function app.guard_esa_paid() from public, anon, authenticated;
create or replace trigger guard_esa_paid before insert or update on public.esa_invoices
  for each row execute function app.guard_esa_paid();

-- Added "not valid" so applying never stops on an old row; new and changed rows are checked from now on. Run
-- "alter table ... validate constraint ..." for each once the existing rows are confirmed clean.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'esa_invoices_hosted_url_is_stripe') then
    alter table public.esa_invoices add constraint esa_invoices_hosted_url_is_stripe
      check (hosted_invoice_url is null or hosted_invoice_url ~ '^https://invoice\.stripe\.com/') not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'desk_feed_link_is_gmail') then
    alter table public.desk_feed add constraint desk_feed_link_is_gmail
      check (link is null or link ~ '^https://mail\.google\.com/') not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'store_sales_stripe_url_is_checkout') then
    alter table public.store_sales add constraint store_sales_stripe_url_is_checkout
      check (stripe_url is null or stripe_url ~ '^https://checkout\.stripe\.com/') not valid;
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- F4. A coach marks attendance for an active enrollment in a program they coach, for a date in the last seven days
-- through today (Arizona), and only on that program's class day when it has one. A coach reads only the active
-- enrollments of their programs. Admins' paths are unchanged.
create or replace function app.today_arizona() returns date
language sql stable set search_path = public
as $$ select (now() at time zone 'America/Phoenix')::date $$;
revoke execute on function app.today_arizona() from public, anon;
grant execute on function app.today_arizona() to authenticated;

create or replace function app.coach_marks(p_enrollment uuid, p_date date) returns boolean
language sql stable security definer set search_path = public
as $$
  select app.aal2() and p_date is not null
    and p_date <= app.today_arizona() and p_date >= app.today_arizona() - 7
    and exists (
      select 1 from public.enrollments e
      join public.coach_assignments ca on ca.program_id = e.program_id
      join public.programs p on p.id = e.program_id
      where e.id = p_enrollment and e.status = 'active' and ca.staff_id = (app.me()).id
        and (p.weekday is null or p.weekday = extract(dow from p_date)::smallint))
$$;
revoke execute on function app.coach_marks(uuid, date) from public, anon;
grant execute on function app.coach_marks(uuid, date) to authenticated;

alter policy attendance_write on public.attendance
  using (app.admin_for(app.child_site(app.enrollment_child(enrollment_id))) or app.coach_marks(enrollment_id, on_date))
  with check (app.admin_for(app.child_site(app.enrollment_child(enrollment_id))) or app.coach_marks(enrollment_id, on_date));

-- Site leads (F7) and coaches read active enrollments only; owners and admins read them all.
alter policy enrollments_read on public.enrollments
  using (app.admin_for(app.child_site(child_id))
         or (app.aal2() and app.role() = 'site_lead' and app.site() = app.child_site(child_id) and status = 'active')
         or (app.coach_on(program_id) and status = 'active'));

-- ---------------------------------------------------------------------------------------------------------------
-- F5. A site-pinned admin can't write a row that points at another site's records: a child in another site's
-- family, an enrollment in another site's program, an invoice on another child's enrollment, a coach assignment
-- for a staff member pinned elsewhere.
create or replace function app.staff_site(p_staff uuid) returns text
language sql stable security definer set search_path = public
as $$ select s.site_id from public.staff s where s.id = p_staff $$;
revoke execute on function app.staff_site(uuid) from public, anon;
grant execute on function app.staff_site(uuid) to authenticated;

alter policy children_write on public.children
  with check (app.admin_for(site_id) and app.admin_for(app.family_site(family_id)));
alter policy enrollments_write on public.enrollments
  with check (app.admin_for(app.child_site(child_id)) and app.admin_for(app.program_site(program_id)));
alter policy esa_write on public.esa_invoices
  with check (app.admin_for(app.child_site(child_id)) and (enrollment_id is null or app.enrollment_child(enrollment_id) = child_id));
alter policy coach_assignments_write on public.coach_assignments
  with check (app.admin_for(app.program_site(program_id)) and app.admin_for(app.staff_site(staff_id)));

-- ---------------------------------------------------------------------------------------------------------------
-- F6. The anonymous API role holds nothing in public, and neither anon nor authenticated gets anything on a new
-- table by default: every table grants what it needs on purpose. Today's grants for authenticated are untouched.
-- (uniform-request, the one function without a sign-in, writes with the service key, so it needs no anon grant.)
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke all on all functions in schema public from anon;
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- F7. A site lead running the door sees their site's families as a roster: the family's name and status, the
-- guardians' names and mobile numbers (no emails), the children and their active enrollments, attendance, and
-- care notes for a program at their site on its class day. Not addresses, family notes, how they pay, Stripe ids,
-- agreements or money. The full family and guardian tables are for owners and admins; site leads read the roster
-- views, which carry only those columns. Each view runs as the caller (security invoker) over a helper that
-- applies the same "who sees this site" rule as the rest of the database.
alter policy families_read on public.families using (app.admin_for(site_id));
alter policy guardians_read on public.guardians using (app.admin_for(app.family_site(family_id)));
alter policy agreements_read on public.agreements using (app.admin_for(app.family_site(family_id)));

create or replace function app.lead_sees_care(p_child uuid) returns boolean
language sql stable security definer set search_path = public
as $$
  select app.aal2() and app.role() = 'site_lead' and app.site() is not null and app.site() = app.child_site(p_child)
    and exists (
      select 1 from public.enrollments e join public.programs p on p.id = e.program_id
      where e.child_id = p_child and e.status = 'active' and p.site_id = app.site() and p.weekday = app.today_weekday())
$$;
revoke execute on function app.lead_sees_care(uuid) from public, anon;
grant execute on function app.lead_sees_care(uuid) to authenticated;
alter policy care_read on public.care_notes
  using (app.admin_for(app.child_site(child_id)) or app.coach_sees_care(child_id) or app.lead_sees_care(child_id));

create or replace function app.roster_families()
returns table (id uuid, name text, site_id text, status text)
language sql stable security definer set search_path = public
as $$ select f.id, f.name, f.site_id, f.status from public.families f where app.sees_site(f.site_id) $$;
revoke execute on function app.roster_families() from public, anon;
grant execute on function app.roster_families() to authenticated;

create or replace function app.roster_guardians()
returns table (id uuid, family_id uuid, name text, mobile text, is_primary boolean)
language sql stable security definer set search_path = public
as $$
  select g.id, g.family_id, g.name, g.mobile, g.is_primary
  from public.guardians g join public.families f on f.id = g.family_id
  where app.sees_site(f.site_id)
$$;
revoke execute on function app.roster_guardians() from public, anon;
grant execute on function app.roster_guardians() to authenticated;

create or replace view public.roster_families with (security_invoker = true) as select * from app.roster_families();
create or replace view public.roster_guardians with (security_invoker = true) as select * from app.roster_guardians();
revoke all on public.roster_families, public.roster_guardians from public, anon;
grant select on public.roster_families, public.roster_guardians to authenticated;
