-- =============================================================================
-- Family Japam consolidation — ROLLBACK (restores the migration).
-- =============================================================================
-- RESTORES the apply from db/workspace_consolidation.sql. This is NOT cleanup: it never
-- removes backup artifacts. The backup tables (migration_backup.ws1_*) stay intact so the
-- operator can still inspect them and, only after final approval, run
-- db/workspace_consolidation_cleanup.sql.
--
-- SAFETY: rollback REFUSES (raises) when unexpected post-migration writes exist. It
-- compares the CURRENT row set (count + md5 checksum, ordered by PK) of the three
-- affected row sets against the POST-apply state the apply committed (recorded in
-- migration_backup.ws1_manifest). Any new history write, deletion, membership change or
-- Japam change that happened AFTER the apply means current != committed -> rollback
-- refuses, because restoring would destroy that newer data. Only when the current state
-- is byte-identical to the committed post-apply state does rollback restore the exact
-- pre-apply snapshot and drop the write-guard triggers the apply installed.
--
-- If the apply never committed there is no manifest and nothing to restore: this file
-- raises a clear 'nothing to roll back' error instead of guessing.
--
-- Runs as the SQL editor (postgres). One transaction. No production SQL was or will be
-- run by tooling; this is staged/operator tooling only.
-- =============================================================================

begin;

do $$
declare
  v_fail  text := '';
  v_cnt   bigint;
  v_chk   text;
  v_post_cnt bigint;
  v_post_chk text;
  v_manifest int;
begin
  -- Nothing to roll back if the apply never created a manifest.
  select count(*) into v_manifest from migration_backup.ws1_manifest;
  if v_manifest = 0 then
    raise exception 'WS_ROLLBACK_NOTHING: no migration_backup.ws1_manifest found — the apply never committed here; nothing to roll back.';
  end if;

  -- Refusal checks: current state must be byte-identical to the committed post-apply state.
  select count(*), md5(coalesce(string_agg(md5(row_to_json(t)::text), ',' order by t.id), ''))
    into v_cnt, v_chk
  from public.japam_history t
  where t.user_id in (
    '3c313835-e391-4607-853f-e23a108d9c2b',
    '6829d5ea-285c-458c-9577-7bce4422c45c',
    'd25472a6-741a-48ee-8c6e-fcb8ea8394f5',
    'f1887c24-5728-4246-9912-699de2ea2f05',
    '87f50692-bdf2-49ad-97cf-0e79da8788fa'
  );
  select post_row_count, post_checksum into v_post_cnt, v_post_chk
  from migration_backup.ws1_manifest where backup_name = 'ws1_japam_history';
  if v_cnt <> v_post_cnt or v_chk <> v_post_chk then
    v_fail := v_fail || 'japam_history for the family members changed after apply; ';
  end if;

  select count(*), md5(coalesce(string_agg(md5(row_to_json(t)::text), ',' order by t.id), ''))
    into v_cnt, v_chk
  from public.group_members t
  where t.group_id = 'c469d784-1ce9-4094-aa97-b26ed2865acb';
  select post_row_count, post_checksum into v_post_cnt, v_post_chk
  from migration_backup.ws1_manifest where backup_name = 'ws1_group_members';
  if v_cnt <> v_post_cnt or v_chk <> v_post_chk then
    v_fail := v_fail || 'family group memberships changed after apply; ';
  end if;

  select count(*), md5(coalesce(string_agg(md5(row_to_json(t)::text), ',' order by t.id), ''))
    into v_cnt, v_chk
  from public.japams t
  where t.user_id in (
    '3c313835-e391-4607-853f-e23a108d9c2b',
    '6829d5ea-285c-458c-9577-7bce4422c45c',
    'd25472a6-741a-48ee-8c6e-fcb8ea8394f5',
    'f1887c24-5728-4246-9912-699de2ea2f05',
    '87f50692-bdf2-49ad-97cf-0e79da8788fa'
  );
  select post_row_count, post_checksum into v_post_cnt, v_post_chk
  from migration_backup.ws1_manifest where backup_name = 'ws1_japams';
  if v_cnt <> v_post_cnt or v_chk <> v_post_chk then
    v_fail := v_fail || 'japams for the family members changed after apply; ';
  end if;

  if v_fail <> '' then
    raise exception 'WS_ROLLBACK_REFUSED: % rollback would destroy data written after the migration committed. Investigate the post-migration writes first.', v_fail;
  end if;
end $$;

-- Drop the guards before restore: rollback has already proved the current state matches
-- the committed post-apply manifest, so the restore is safe and must be able to unarchive.
drop trigger if exists _ws_no_history_to_archived_japam on public.japam_history;
drop function if exists public._ws_guard_history_archived_japam();
drop trigger if exists _ws_no_unarchive on public.japams;
drop function if exists public._ws_guard_no_unarchive();

-- 1. Restore japam_history.japam_id to the exact pre-apply values.
update public.japam_history h
set japam_id = b.japam_id
from migration_backup.ws1_japam_history b
where b.id = h.id;

-- 2. Restore group_members.japam_id (and the identity fields, defensively).
update public.group_members gm
set japam_id = b.japam_id, user_name = b.user_name, role = b.role, joined_at = b.joined_at
from migration_backup.ws1_group_members b
where b.id = gm.id;

-- 3. Delete any Japam this migration CREATED (the deterministic bellam default). It has no
--    backup row. History and memberships were restored above, so nothing references it.
delete from public.japams j
where j.user_id in (
    '3c313835-e391-4607-853f-e23a108d9c2b',
    '6829d5ea-285c-458c-9577-7bce4422c45c',
    'd25472a6-741a-48ee-8c6e-fcb8ea8394f5',
    'f1887c24-5728-4246-9912-699de2ea2f05',
    '87f50692-bdf2-49ad-97cf-0e79da8788fa'
  )
  and not exists (select 1 from migration_backup.ws1_japams b where b.id = j.id);

-- 4. Restore japams.archived_at (and the identity fields, defensively) — this un-archives
--    the duplicates exactly as they were before the apply.
update public.japams j
set name = b.name, display_order = b.display_order, created_at = b.created_at,
    updated_at = b.updated_at, archived_at = b.archived_at
from migration_backup.ws1_japams b
where b.id = j.id;

commit;

-- ─── POST-COMMIT REPORT (read-only; only reached if rollback succeeded) ──
select 'WS_ROLLBACK_OK' as status,
       'migration restored from migration_backup.ws1_*; backup artifacts intentionally kept (see cleanup file)' as note;
