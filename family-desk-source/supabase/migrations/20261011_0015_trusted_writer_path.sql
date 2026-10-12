-- Pin the search path on the helper added in 0014 (Supabase advisor 0011).
alter function app.trusted_writer() set search_path = public;
