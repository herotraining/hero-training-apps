-- Fixes from the independent access review (Oct 8, 2026).

-- 1. Money is for owners and admins of the family's site only (the Stripe function checks this).
create or replace function public.can_see_money(p_family uuid) returns boolean
language sql stable security invoker set search_path = public
as $$ select app.admin_for(app.family_site(p_family)) $$;
revoke execute on function public.can_see_money(uuid) from public, anon;
grant execute on function public.can_see_money(uuid) to authenticated;

-- 2. Coach assignments are scoped to the program's site, so a site-pinned admin can't reach other sites.
create or replace function app.program_site(p text) returns text
language sql stable security definer set search_path = public
as $$ select site_id from public.programs where id = p $$;
revoke execute on function app.program_site(text) from public, anon;
grant execute on function app.program_site(text) to authenticated;
alter policy coach_assignments_write on public.coach_assignments
  using (app.admin_for(app.program_site(program_id)))
  with check (app.admin_for(app.program_site(program_id)));

-- 3. An account links to a staff row only once, and counts only after the email is confirmed.
create or replace function app.on_auth_user_created()
returns trigger language plpgsql security definer set search_path = public
as $$
declare s public.staff;
begin
  select * into s from public.staff
   where lower(email) = lower(new.email) and active and user_id is null limit 1;
  if s.id is null then
    raise exception 'This email is not on the HERO staff list, or already has a sign-in.' using errcode = 'P0001';
  end if;
  update public.staff set user_id = new.id where id = s.id;
  return new;
end $$;

create or replace function app.me()
returns public.staff
language sql stable security definer set search_path = public
as $$
  select s.* from public.staff s
  join auth.users u on u.id = s.user_id
  where s.user_id = auth.uid() and s.active and u.email_confirmed_at is not null
  limit 1;
$$;

-- 4. Guardians are audited too; assignment rows get a readable id.
create or replace function app.audit()
returns trigger language plpgsql security definer set search_path = public
as $$
declare v_email text; v_id text; j jsonb;
begin
  j := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  select email into v_email from public.staff where user_id = auth.uid() limit 1;
  v_id := coalesce(j ->> 'id', j ->> 'child_id', (j ->> 'staff_id') || ':' || (j ->> 'program_id'));
  insert into public.audit_log (actor_user_id, actor_email, action, entity, entity_id, reason, before, after)
  values (auth.uid(), v_email, lower(tg_op), tg_table_name, v_id,
          nullif(current_setting('app.reason', true), ''),
          case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end,
          case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end);
  return coalesce(new, old);
end $$;
create trigger audit_guardians after insert or update or delete on public.guardians
  for each row execute function app.audit();

-- 5. A coach sees only the enrollments of programs they coach.
create or replace function app.coach_on(p text) returns boolean
language sql stable security definer set search_path = public
as $$ select app.aal2() and exists (select 1 from public.coach_assignments ca where ca.program_id = p and ca.staff_id = (app.me()).id) $$;
revoke execute on function app.coach_on(text) from public, anon;
grant execute on function app.coach_on(text) to authenticated;
alter policy enrollments_read on public.enrollments
  using (app.sees_site(app.child_site(child_id)) or app.coach_on(program_id));

-- 6. Site-pinned admins stay inside their site for closures and the staff list.
alter policy closures_write on public.closures
  using (app.admin_for(site_id)) with check (app.admin_for(site_id));
alter policy staff_admin_read on public.staff
  using (app.aal2() and app.role() in ('owner','admin') and (app.site() is null or site_id = app.site()));

-- 7. Tighter defaults for API roles.
alter default privileges in schema public revoke execute on functions from anon, authenticated;
alter default privileges in schema app revoke execute on functions from anon, authenticated;
revoke truncate, trigger, references on all tables in schema public from anon, authenticated;
alter default privileges in schema public revoke truncate, trigger, references on tables from anon, authenticated;

-- Only an open invoice can be marked paid.
create or replace function public.mark_esa_paid(p_id uuid, p_reason text)
returns public.esa_invoices
language plpgsql security invoker set search_path = public
as $$
declare r public.esa_invoices;
begin
  if coalesce(p_reason, '') = '' then raise exception 'A reason is required.'; end if;
  perform set_config('app.reason', p_reason, true);
  update public.esa_invoices set status = 'paid', paid_at = now()
   where id = p_id and status in ('sent','submitted','rejected') returning * into r;
  if r.id is null then raise exception 'Invoice not found, not open, or not yours to change.'; end if;
  return r;
end $$;
