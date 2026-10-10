-- Applied Oct 9, 2026 (via the Supabase connector) before this file was written; kept here as the record.
-- Enrollment rows become history: a child may have several rows per program over time, but only one OPEN one.
alter table public.enrollments drop constraint if exists enrollments_child_id_program_id_key;
create unique index if not exists enrollments_one_open_per_program
  on public.enrollments (child_id, program_id) where status in ('active', 'hold', 'waitlist');
alter table public.enrollments add column if not exists note text;

-- Programs that ran in Jackrabbit but no longer run, so past enrollments have somewhere to point.
-- (kind values clinic / open_gym / event were added alongside; all inserted with active = false.)
-- See scratch import for the ten rows: 2025-26 half-day academies, adult tumbling, open training, holiday camp, handspring clinic, Heroic Games, LAB/Mesa/Prescott co-ops.
