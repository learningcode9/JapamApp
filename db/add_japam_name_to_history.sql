-- Add japam_name to public.japam_history
--
-- Feature: Custom Japam Name per Session. Lets each completed session optionally carry the
-- plain-text japam/mantra name the user typed for that one session (e.g. "Gayatri",
-- "Om Namah Shivaya"). This is NOT the same as user_profiles.japam_name, which is an unrelated
-- per-user singular label used to rename "the japam" app-wide — this column is per-completion,
-- on japam_history.
--
-- NULL means no name was given. The app displays "Japam" for NULL, matching
-- lib/historyStore.ts's normalizeJapamName() — see that function's doc comment for the shared
-- trim/blank-handling contract every read/write path relies on.
--
-- Safety (additive only, per this project's migration convention):
--   - Nullable, no default, no backfill.
--   - No existing column is altered or retyped.
--   - Old app builds that don't send japam_name keep working — the column is simply null for
--     their rows, and old rows continue to display "Japam" with zero migration required.
--
-- DO NOT RUN until explicitly approved.
-- Run in: Supabase SQL editor (live project).
-- Run ONCE. Safe to re-run: IF NOT EXISTS guard is idempotent.


-- ─── SECTION 1: PRE-APPLY VERIFICATION (read-only) ───────────────────────────
--
-- Run this first to confirm the column does not already exist.
-- Expected before applying: zero rows returned.

select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name = 'japam_history'
  and column_name = 'japam_name';


-- ─── SECTION 2: APPLY ─────────────────────────────────────────────────────────

alter table public.japam_history
  add column if not exists japam_name text;


-- ─── SECTION 3: POST-APPLY VERIFICATION (read-only) ──────────────────────────
--
-- Expected after applying:
--   - column_name=japam_name  data_type=text  is_nullable=YES

select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name = 'japam_history'
  and column_name = 'japam_name';

-- Confirm existing rows are unaffected (all null, no backfill).
select count(*) as total_rows, count(japam_name) as rows_with_name
from public.japam_history;


-- ─── SECTION 4: ROLLBACK ──────────────────────────────────────────────────────
--
-- Run ONLY if this column causes an unexpected problem.
-- Effect: drops the column and any data written to it. Harmless to the rest of the table.

-- alter table public.japam_history drop column if exists japam_name;
