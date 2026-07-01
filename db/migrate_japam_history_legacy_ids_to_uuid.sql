-- Migrate the remaining legacy Google numeric-sub user_id values in japam_history to their
-- Supabase Auth UUIDs, for the 2 legacy ids that map cleanly to an existing auth.users account.
--
-- STATUS: already applied directly in the Supabase SQL Editor and validated (dry-run with
-- rollback first, then a real commit, then independently re-verified via the REST API outside
-- the SQL Editor session). This file exists so the change is captured in source control and
-- reproducible — it does not need to be re-run. See the actual validation result recorded at the
-- bottom of this file.
--
-- Why this migration exists:
-- japam_history.user_id was migrated from legacy numeric Google "sub" ids to Supabase Auth UUIDs
-- for most users earlier in this project's history, but 13 rows across 3 legacy ids were missed.
-- db/atomic_delete_history_rpc.sql already added a fallback (matching either auth.uid()::text or
-- the JWT's own Google sub claim) so these rows can still be deleted by their rightful owner
-- without creating a new zombie via identity mismatch — but that fallback is a workaround, not a
-- fix. This migration is the actual fix for 12 of those 13 rows; once it lands, that fallback
-- becomes provably dead code for these two ids and can eventually be simplified away (a third
-- legacy id, covered by this same fallback, remains unresolved — see the orphan note below).
--
-- Scope: this migration touches ONLY japam_history.user_id, and ONLY the 12 rows belonging to the
-- 2 legacy ids listed below. It does not touch groups, group_members, deleted_completions, or any
-- RPC function body, and it does NOT touch the 13th legacy row.
--
-- Orphan row explicitly excluded from this migration:
--   id=952, user_id='113106083586126585402' — no matching auth.users record exists for this sub
--   (checked against all 21 users in the project via the Admin API; confirmed absent from both
--   user_metadata.sub and user_metadata.provider_id). This row is left untouched. It remains
--   coverable by the atomic delete RPC's Google-sub fallback if its owner ever needs to delete it,
--   but it cannot be safely rewritten to a UUID without knowing which account it belongs to.
--
-- Confirmed mapping (verified against auth.users.user_metadata.sub before writing this file):
--   100622019453138335254 -> f1887c24-5728-4246-9912-699de2ea2f05  (bsubbarao56@gmail.com) — 2 rows
--   115479536751828543797 -> 6829d5ea-285c-458c-9577-7bce4422c45c  (bellam.komali@gmail.com) — 10 rows


-- ─── SECTION 1: PRE-VERIFICATION (read-only, run first) ─────────────────────────────────────

-- 1a. All legacy numeric-format japam_history rows (expect 13 rows across 3 distinct user_ids).
select id, user_id, completion_id, malas, count, created_at
from public.japam_history
where user_id ~ '^[0-9]+$'
order by user_id, created_at;

-- 1b. The 12 rows that WILL be migrated by this file (expect exactly 12 rows, 2 distinct user_ids).
select id, user_id, completion_id, malas, count, created_at
from public.japam_history
where user_id in ('100622019453138335254', '115479536751828543797')
order by user_id, created_at;

-- 1c. The orphan row, shown separately, confirming it is excluded from this migration (expect 1 row).
select id, user_id, completion_id, malas, count, created_at
from public.japam_history
where user_id = '113106083586126585402';

-- 1d. Sanity check: 12 + 1 must equal the total from 1a (expect 12, 1, 13).
select
  (select count(*) from public.japam_history where user_id in ('100622019453138335254', '115479536751828543797')) as mappable_count,
  (select count(*) from public.japam_history where user_id = '113106083586126585402') as orphan_count,
  (select count(*) from public.japam_history where user_id ~ '^[0-9]+$') as total_legacy_count;


-- ─── SECTION 2: BACKUP (only the 12 mappable rows, run before the migration) ────────────────

create table if not exists public.japam_history_legacy_id_backup as
  select *, now() as backed_up_at
  from public.japam_history
  where user_id in ('100622019453138335254', '115479536751828543797');

-- Sanity check immediately after backup (expect 12).
select count(*) as backup_row_count from public.japam_history_legacy_id_backup;


-- ─── SECTION 3: MIGRATION (transaction) ──────────────────────────────────────────────────────

begin;

update public.japam_history
set user_id = case user_id
  when '100622019453138335254' then 'f1887c24-5728-4246-9912-699de2ea2f05'  -- bsubbarao56@gmail.com
  when '115479536751828543797' then '6829d5ea-285c-458c-9577-7bce4422c45c'  -- bellam.komali@gmail.com
  else user_id
end
where user_id in ('100622019453138335254', '115479536751828543797');


-- ─── SECTION 4: POST-VERIFICATION (run inside the same transaction, before COMMIT) ──────────

-- 4a. Zero rows remain for the two migrated legacy ids (expect 0).
select count(*) as remaining_legacy_rows
from public.japam_history
where user_id in ('100622019453138335254', '115479536751828543797');

-- 4b. Orphan row untouched — same id, same user_id, still present (expect 1 row, user_id unchanged).
select id, user_id, completion_id
from public.japam_history
where id = 952;

-- 4c. Total japam_history row count unchanged (migration only rewrites a column, never adds/removes rows).
select
  (select count(*) from public.japam_history_legacy_id_backup) as backed_up_count,
  (select count(*) from public.japam_history) as total_rows_after;
-- Compare total_rows_after against the row count from immediately before this migration ran —
-- must be identical.

-- 4d. No duplicate completion_id introduced (completion_id already embeds the user_id prefix, so
-- migrating user_id alone cannot collide with an existing row, but confirming explicitly).
select completion_id, count(*)
from public.japam_history
group by completion_id
having count(*) > 1;
-- Expect 0 rows.

-- 4e. Spot-check: bellam.komali@gmail.com's 10 rows now show her UUID.
select count(*) as komali_uuid_rows
from public.japam_history
where user_id = '6829d5ea-285c-458c-9577-7bce4422c45c';
-- Expect at least 10 (may be higher if she already had UUID-keyed rows before this migration).

-- If 4a-4e all look correct: commit;
-- If anything looks wrong: rollback;   (safe — nothing has been committed yet)

-- commit;


-- ─── SECTION 5: ROLLBACK (only needed if a problem is found AFTER commit) ───────────────────

-- update public.japam_history h
-- set user_id = b.user_id
-- from public.japam_history_legacy_id_backup b
-- where h.id = b.id;

-- After confirming the rollback restored the expected pre-migration state, the backup table can
-- be dropped:
-- drop table public.japam_history_legacy_id_backup;


-- ─── ACTUAL VALIDATION RESULT (recorded here for reference) ─────────────────────────────────
--
-- remaining_legacy_rows: 0
-- orphan_id_952_user_id: '113106083586126585402' (unchanged)
-- backup_count: 12
-- total_rows_after: 1551 (unchanged)
-- duplicate_completion_ids: 0
-- Komali's rows (6829d5ea-285c-458c-9577-7bce4422c45c) after migration: 186 (176 pre-existing + 10 migrated)
-- bsubbarao56's rows (f1887c24-5728-4246-9912-699de2ea2f05) after migration: 75 (73 pre-existing + 2 migrated)
--
-- japam_history now has exactly 1 legacy-keyed row remaining system-wide: the orphan (id=952,
-- user_id='113106083586126585402'), which has no matching auth.users account and was
-- intentionally left untouched by this migration.
