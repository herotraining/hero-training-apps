-- Helper functions, triggers, and row-level security.

-- Who is calling, from the staff list. Security definer so it can read staff regardless of RLS.
create or replace function app.me()
returns public.staff
language sql stable security definer set search_path = public
as $$
  select s.* from public.staff s where s.user_id = auth.uid() and s.active limit 1;
$$;

create or replace function app.aal2()
returns boolean language sql stable
as $$ select coalesce(auth.jwt() ->> 'aal', '') = 'aal2' $$;

create or replace function app.role()
returns public.staff_role language sql stable security definer set search_path = public
as $$ select (app.me()).role $$;

create or replace function app.site()
returns text language sql stable security definer set search_path = public
as $$ select (app.me()).site_id $$;

create or replace function app.is_staff()
returns boolean language sql stable security definer set search_path = public
as $$ select app.aal2() and (app.me()).id is not null $$;

create or replace function app.is_owner()
returns boolean language sql stable security definer set search_path = public
as $$ select app.aal2() and app.role() = 'owner' $$;

-- Owner anywhere; admin everywhere unless pinned to a site.
create or replace function app.admin_for(p_site text)
returns boolean language sql stable security definer set search_path = public
as $$
  select app.aal2() and (
    app.role() = 'owner'
    or (app.role() = 'admin' and (app.site() is null or app.site() = p_site))
  )
$$;

-- Owner, admin for the site, or the site's lead.
create or replace function app.sees_site(p_site text)
returns boolean language sql stable security definer set search_path = public
as $$
  select app.admin_for(p_site)
    or (app.aal2() and app.role() = 'site_lead' and app.site() = p_site)
$$;

create or replace function app.today_weekday()
returns smallint language sql stable
as $$ select extract(dow from (now() at time zone 'America/Phoenix'))::smallint $$;

-- A coach sees a child when assigned to a program the child is active in.
create or replace function app.coach_sees_child(p_child uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select app.aal2() and exists (
    select 1 from public.enrollments e
    join public.coach_assignments ca on ca.program_id = e.program_id
    where e.child_id = p_child and e.status = 'active' and ca.staff_id = (app.me()).id
  )
$$;

-- Care notes open to the child's coach only on that program's class day.
create or replace function app.coach_sees_care(p_child uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select app.aal2() and exists (
    select 1 from public.enrollments e
    join public.coach_assignments ca on ca.program_id = e.program_id
    join public.programs p on p.id = e.program_id
    where e.child_id = p_child and e.status = 'active' and ca.staff_id = (app.me()).id
      and p.weekday = app.today_weekday()
  )
$$;

create or replace function app.child_site(p_child uuid)
returns text language sql stable security definer set search_path = public
as $$ select c.site_id from public.children c where c.id = p_child $$;

create or replace function app.family_site(p_family uuid)
returns text language sql stable security definer set search_path = public
as $$ select f.site_id from public.families f where f.id = p_family $$;

-- Only emails on the staff list may create an account; link the account to its staff row.
create or replace function app.on_auth_user_created()
returns trigger language plpgsql security definer set search_path = public
as $$
declare s public.staff;
begin
  select * into s from public.staff where lower(email) = lower(new.email) and active limit 1;
  if s.id is null then
    raise exception 'This email is not on the HERO staff list.' using errcode = 'P0001';
  end if;
  update public.staff set user_id = new.id where id = s.id;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function app.on_auth_user_created();

-- Audit: every change to money-bearing and family tables, with who and why.
create or replace function app.audit()
returns trigger language plpgsql security definer set search_path = public
as $$
declare v_email text; v_id text;
begin
  select email into v_email from public.staff where user_id = auth.uid() limit 1;
  v_id := coalesce((case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end) ->> 'id',
                   (case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end) ->> 'child_id');
  insert into public.audit_log (actor_user_id, actor_email, action, entity, entity_id, reason, before, after)
  values (auth.uid(), v_email, lower(tg_op), tg_table_name, v_id,
          nullif(current_setting('app.reason', true), ''),
          case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end,
          case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end);
  return coalesce(new, old);
end $$;

create or replace function app.touch()
returns trigger language plpgsql
as $$ begin new.updated_at = now(); return new; end $$;

do $$
declare t text;
begin
  foreach t in array array['families','children','care_notes','agreements','enrollments','esa_invoices','staff','coach_assignments','programs'] loop
    execute format('create trigger audit_%1$s after insert or update or delete on public.%1$s for each row execute function app.audit()', t);
  end loop;
  foreach t in array array['families','children','care_notes','enrollments','esa_invoices'] loop
    execute format('create trigger touch_%1$s before update on public.%1$s for each row execute function app.touch()', t);
  end loop;
end $$;

-- Mark an ESA invoice paid, with a reason, in one transaction (the app calls this).
create or replace function public.mark_esa_paid(p_id uuid, p_reason text)
returns public.esa_invoices
language plpgsql security invoker set search_path = public
as $$
declare r public.esa_invoices;
begin
  if coalesce(p_reason, '') = '' then raise exception 'A reason is required.'; end if;
  perform set_config('app.reason', p_reason, true);
  update public.esa_invoices set status = 'paid', paid_at = now() where id = p_id returning * into r;
  if r.id is null then raise exception 'Invoice not found or not yours to change.'; end if;
  return r;
end $$;

-- What the app needs after sign-in.
create or replace function public.my_profile()
returns jsonb language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'staff', to_jsonb(app.me()),
    'aal', auth.jwt() ->> 'aal'
  )
$$;

-- Row-level security.
alter table public.sites enable row level security;
alter table public.staff enable row level security;
alter table public.programs enable row level security;
alter table public.families enable row level security;
alter table public.guardians enable row level security;
alter table public.children enable row level security;
alter table public.care_notes enable row level security;
alter table public.agreements enable row level security;
alter table public.enrollments enable row level security;
alter table public.coach_assignments enable row level security;
alter table public.esa_invoices enable row level security;
alter table public.closures enable row level security;
alter table public.audit_log enable row level security;

create policy sites_read on public.sites for select to authenticated using (app.is_staff());
create policy sites_owner on public.sites for all to authenticated using (app.is_owner()) with check (app.is_owner());

create policy programs_read on public.programs for select to authenticated using (app.is_staff());
create policy programs_owner on public.programs for all to authenticated using (app.is_owner()) with check (app.is_owner());

-- Staff: own row at any assurance level (the app needs the role before 2FA); the list for owners and admins.
create policy staff_self on public.staff for select to authenticated using (user_id = auth.uid());
create policy staff_admin_read on public.staff for select to authenticated using (app.aal2() and app.role() in ('owner','admin'));
create policy staff_owner_write on public.staff for all to authenticated using (app.is_owner()) with check (app.is_owner());

create policy families_read on public.families for select to authenticated using (app.sees_site(site_id));
create policy families_write on public.families for all to authenticated using (app.admin_for(site_id)) with check (app.admin_for(site_id));

create policy guardians_read on public.guardians for select to authenticated using (app.sees_site(app.family_site(family_id)));
create policy guardians_write on public.guardians for all to authenticated using (app.admin_for(app.family_site(family_id))) with check (app.admin_for(app.family_site(family_id)));

create policy children_read on public.children for select to authenticated using (app.sees_site(site_id) or app.coach_sees_child(id));
create policy children_write on public.children for all to authenticated using (app.admin_for(site_id)) with check (app.admin_for(site_id));

create policy care_read on public.care_notes for select to authenticated using (app.admin_for(app.child_site(child_id)) or app.coach_sees_care(child_id));
create policy care_write on public.care_notes for all to authenticated using (app.admin_for(app.child_site(child_id))) with check (app.admin_for(app.child_site(child_id)));

create policy agreements_read on public.agreements for select to authenticated using (app.sees_site(app.family_site(family_id)));
create policy agreements_write on public.agreements for all to authenticated using (app.admin_for(app.family_site(family_id))) with check (app.admin_for(app.family_site(family_id)));

create policy enrollments_read on public.enrollments for select to authenticated using (app.sees_site(app.child_site(child_id)) or app.coach_sees_child(child_id));
create policy enrollments_write on public.enrollments for all to authenticated using (app.admin_for(app.child_site(child_id))) with check (app.admin_for(app.child_site(child_id)));

create policy coach_assignments_read on public.coach_assignments for select to authenticated using (app.is_staff());
create policy coach_assignments_write on public.coach_assignments for all to authenticated using (app.aal2() and app.role() in ('owner','admin')) with check (app.aal2() and app.role() in ('owner','admin'));

create policy esa_read on public.esa_invoices for select to authenticated using (app.admin_for(app.child_site(child_id)));
create policy esa_write on public.esa_invoices for all to authenticated using (app.admin_for(app.child_site(child_id))) with check (app.admin_for(app.child_site(child_id)));

create policy closures_read on public.closures for select to authenticated using (app.is_staff());
create policy closures_write on public.closures for all to authenticated using (app.aal2() and app.role() in ('owner','admin')) with check (app.aal2() and app.role() in ('owner','admin'));

create policy audit_owner_read on public.audit_log for select to authenticated using (app.is_owner());

grant usage on schema app to authenticated;
grant execute on all functions in schema app to authenticated;
revoke execute on function app.on_auth_user_created() from authenticated;
revoke execute on function app.audit() from authenticated;
grant execute on function public.my_profile() to authenticated;
grant execute on function public.mark_esa_paid(uuid, text) to authenticated;
revoke execute on function public.my_profile() from anon;
revoke execute on function public.mark_esa_paid(uuid, text) from anon;
