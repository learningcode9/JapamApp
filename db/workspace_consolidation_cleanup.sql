-- =============================================================================
-- Family Japam consolidation — CLEANUP (removes backup artifacts only).
-- =============================================================================
-- Removes the backup artifacts (migration_backup schema + manifest) AFTER FINAL
-- APPROVAL only. This is NOT rollback and does NOT restore the migration: once the
-- consolidated state is approved as final, the pre-apply snapshot has no further use and
-- is destroyed. The write-guard triggers installed by the apply are DURABLE protection
-- and are intentionally kept by this file.
--
-- GUARDRAIL: this file refuses to drop the backup schema while the consolidated
-- invariants (one active Japam per member, every Family membership linked, no null-japam
-- History) do NOT hold. If a post-consolidation regression ever breaks them, the backup
-- safety net is preserved instead of silently destroyed.
--
-- If the apply never committed, there is nothing to clean: this file raises a clear error
-- rather than guessing.
--
-- Runs as the SQL editor (postgres). One transaction. No production SQL was or will be
-- run by tooling; this is staged/operator tooling only.
-- =============================================================================

begin;

do $$
declare
  v_msgs text := '';
  v_count int;
  v_manifest int;
  r record;
begin
  select count(*) into v_manifest
  from pg_namespace n
  where n.nspname = 'migration_backup';
  if v_manifest = 0 then
    raise exception 'WS_CLEANUP_NOTHING: migration_backup schema not found — the apply never committed here; nothing to clean.';
  end if;

  -- Refuse to destroy the safety net while the consolidated state is broken.
  for r in
    select u.user_id
    from (values
      ('3c313835-e391-4607-853f-e23a108d9c2b'::text),
      ('6829d5ea-285c-458c-9577-7bce4422c45c'::text),
      ('d25472a6-741a-48ee-8c6e-fcb8ea8394f5'::text),
      ('f1887c24-5728-4246-9912-699de2ea2f05'::text),
      ('87f50692-bdf2-49ad-97cf-0e79da8788fa'::text)
    ) as u(user_id)
  loop
    select count(*) into v_count
    from public.japams j
    where j.user_id = r.user_id and j.archived_at is null;
    if v_count <> 1 then
      v_msgs := v_msgs || format(E'\n- %s does not have exactly one active Japam (%s found)', r.user_id, v_count);
    end if;
  end loop;

  select count(*) into v_count
  from public.group_members gm
  where gm.group_id = 'c469d784-1ce9-4094-aa97-b26ed2865acb' and gm.japam_id is null;
  if v_count <> 0 then
    v_msgs := v_msgs || format(E'\n- %s Family membership(s) unassigned', v_count);
  end if;

  select count(*) into v_count
  from public.japam_history h
  where h.user_id in (
    '3c313835-e391-4607-853f-e23a108d9c2b',
    '6829d5ea-285c-458c-9577-7bce4422c45c',
    'd25472a6-741a-48ee-8c6e-fcb8ea8394f5',
    'f1887c24-5728-4246-9912-699de2ea2f05',
    '87f50692-bdf2-49ad-97cf-0e79da8788fa'
  ) and h.japam_id is null;
  if v_count <> 0 then
    v_msgs := v_msgs || format(E'\n- %s null-japam History rows remain', v_count);
  end if;

  if v_msgs <> '' then
    raise exception 'WS_CLEANUP_REFUSED: consolidated invariants are broken:% Keep the backup schema until the regression is fixed.', v_msgs;
  end if;
end $$;

-- Final approval assumed: drop the backup schema and everything in it.
drop schema if exists migration_backup cascade;

commit;

-- ─── POST-COMMIT REPORT (read-only; only reached if cleanup succeeded) ──
select 'WS_CLEANUP_OK' as status,
       'migration_backup schema destroyed; write-guard triggers kept; nothing restored' as note;
