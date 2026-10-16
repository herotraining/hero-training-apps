-- Kajabi is gone (canceled October 15, 2026). The access ledger it kept is retired: renamed, closed to the API
-- roles, and its one policy shut. The table itself stays only because migrations are applied with a tool that
-- cannot remove objects; an owner may remove public.retired_kajabi_access by hand in the SQL editor later.
alter table public.kajabi_access rename to retired_kajabi_access;
revoke all on public.retired_kajabi_access from anon, authenticated;
alter policy kajabi_access_owner_read on public.retired_kajabi_access using (false);
