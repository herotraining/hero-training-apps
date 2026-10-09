-- Applied Oct 9, 2026 with the real import. birth_date became nullable (adult students in Adult Tumbling).
alter table public.children alter column birth_date drop not null;

-- Programs as they actually run in Jackrabbit (Oct 9, 2026). Prices stay at the owners' decided November amounts;
-- the Jackrabbit tuition today is noted beside each for comparison.
update public.programs set start_time = '12:00', end_time = '14:00' where id = 'star-team-peoria';                -- Jackrabbit $120
update public.programs set name = 'Tumbling, Peoria, Fridays 11 am', start_time = '11:00', end_time = '12:00' where id = 'tumbling-peoria-fri';  -- Jackrabbit $95
update public.programs set name = 'Saber, Peoria, Wednesdays' where id = 'rally-saber-peoria';                      -- Jackrabbit $120
insert into public.programs (id, name, kind, site_id, weekday, start_time, end_time, monthly_price_cents, active) values
  ('tumbling-peoria-fri-12', 'Tumbling, Peoria, Fridays 12 pm', 'tumbling', 'peoria', 5, '12:00', '13:00', 13500, true),   -- Jackrabbit $95
  ('tumbling-peoria-fri-1',  'Tumbling, Peoria, Fridays 1 pm',  'tumbling', 'peoria', 5, '13:00', '14:00', 13500, true),   -- Jackrabbit $95
  ('coop-lab-fri',           'Co-op Day, L.A.B., Fridays',      'coop',     'lab',    5, '10:00', '14:00', 12500, true),   -- Jackrabbit $125
  ('adult-tumbling-peoria-wed', 'Adult Tumbling, Peoria, Wednesdays', 'class', 'peoria', 3, '10:00', '11:00', 4000, true)  -- Jackrabbit $40
on conflict (id) do nothing;
-- Not in Jackrabbit: turn off until the owners schedule them.
update public.programs set active = false where id in ('class-peoria-wed', 'family-fitness-peoria-wed');
