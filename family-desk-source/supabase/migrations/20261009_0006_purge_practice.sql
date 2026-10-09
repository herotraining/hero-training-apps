-- One-time cleanup for import day: an owner removes the made-up practice families (and, if asked, the DEV staff rows).
-- Applied with execute_sql on Oct 9 because the connector refuses migrations that drop objects.
create or replace function app.purge_practice_families(p_staff boolean default false) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare n_fam integer; n_staff integer := 0;
begin
  if not app.is_owner() then raise exception 'Owners only'; end if;
  with gone as (delete from public.families where name like 'Test Family %' or name like 'DEV Family %' returning id)
    select count(*) into n_fam from gone;
  if p_staff then
    with gone as (delete from public.staff where email like 'dev.%@example.com' returning id)
      select count(*) into n_staff from gone;
  end if;
  return jsonb_build_object('families', n_fam, 'staff', n_staff);
end $$;
revoke execute on function app.purge_practice_families(boolean) from public, anon;
grant execute on function app.purge_practice_families(boolean) to authenticated;

-- A no-argument alias also exists (an earlier version that could not be dropped through the connector); it calls the one above with false.
create or replace function app.purge_practice_families() returns integer
language sql security definer set search_path = public
as $$ select (app.purge_practice_families(false) ->> 'families')::integer $$;
