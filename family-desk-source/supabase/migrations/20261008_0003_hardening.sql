alter function app.touch() set search_path = public;
alter function app.aal2() set search_path = public;
alter function app.today_weekday() set search_path = public;

create or replace function public.my_profile()
returns jsonb language sql stable security invoker set search_path = public
as $$
  select jsonb_build_object('staff', to_jsonb(app.me()), 'aal', auth.jwt() ->> 'aal')
$$;

revoke execute on function public.my_profile() from public, anon;
revoke execute on function public.mark_esa_paid(uuid, text) from public, anon;
grant execute on function public.my_profile() to authenticated;
grant execute on function public.mark_esa_paid(uuid, text) to authenticated;
revoke execute on all functions in schema app from public, anon;
grant execute on all functions in schema app to authenticated;
revoke execute on function app.on_auth_user_created() from authenticated;
revoke execute on function app.audit() from authenticated;
revoke execute on function app.touch() from authenticated;
alter default privileges in schema public revoke execute on functions from public;
alter default privileges in schema app revoke execute on functions from public;
