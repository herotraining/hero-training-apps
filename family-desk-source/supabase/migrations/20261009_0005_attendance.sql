-- Attendance: one row per enrollment per class day. Coaches mark their own programs; admins mark their site.
create table if not exists public.attendance (
  id uuid primary key default gen_random_uuid(),
  enrollment_id uuid not null references public.enrollments(id) on delete cascade,
  on_date date not null,
  status text not null check (status in ('present', 'absent')),
  marked_by uuid references public.staff(id),
  marked_at timestamptz not null default now(),
  unique (enrollment_id, on_date)
);
create index if not exists attendance_date_idx on public.attendance(on_date);
alter table public.attendance enable row level security;

create or replace function app.enrollment_child(p uuid) returns uuid
language sql stable security definer set search_path = public
as $$ select e.child_id from public.enrollments e where e.id = p $$;

create or replace function app.enrollment_program(p uuid) returns text
language sql stable security definer set search_path = public
as $$ select e.program_id from public.enrollments e where e.id = p $$;

revoke execute on function app.enrollment_child(uuid) from public, anon;
revoke execute on function app.enrollment_program(uuid) from public, anon;
grant execute on function app.enrollment_child(uuid) to authenticated;
grant execute on function app.enrollment_program(uuid) to authenticated;

-- Who can see a row: anyone who can see that enrollment.
create policy attendance_read on public.attendance for select to authenticated
  using (app.sees_site(app.child_site(app.enrollment_child(enrollment_id))) or app.coach_on(app.enrollment_program(enrollment_id)));

-- Who can mark: admins for the child's site, or the program's coach.
create policy attendance_write on public.attendance for all to authenticated
  using (app.admin_for(app.child_site(app.enrollment_child(enrollment_id))) or app.coach_on(app.enrollment_program(enrollment_id)))
  with check (app.admin_for(app.child_site(app.enrollment_child(enrollment_id))) or app.coach_on(app.enrollment_program(enrollment_id)));

-- Stamp who marked it, from the session, so the app can't claim someone else did.
create or replace function app.stamp_attendance() returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  new.marked_by := (app.me()).id;
  new.marked_at := now();
  return new;
end $$;
revoke execute on function app.stamp_attendance() from public, anon, authenticated;
create trigger stamp_attendance before insert or update on public.attendance for each row execute function app.stamp_attendance();
create trigger audit_attendance after insert or update or delete on public.attendance for each row execute function app.audit();

revoke truncate, trigger, references on public.attendance from authenticated;
