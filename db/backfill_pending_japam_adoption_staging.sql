-- =============================================================================
-- STAGING-ONLY ONE-OFF BACKFILL — Pending adoption marker for an already-
-- restored Japam whose restore happened BEFORE the peek+ack mechanism shipped.
-- =============================================================================
--
-- Background:
--   The user listed below has a "My Japam" that was restored server-side
--   (likely via an admin tool or migration) before `restore_owned_japam`
--   wrote adoption markers. Their client's persisted `currentJapamId:<uid>`
--   pointer is still on a different active workspace (PR55), so refresh
--   keeps PR55 selected and every Groups query — scoped via
--   `group_members.japam_id = <current>` — hides the Groups scoped to the
--   restored "My Japam".
--
--   Once the peek+ack mechanism is deployed (db/pending_japam_adoption.sql)
--   and the client ships the matching peek+ack refresh logic, this backfill
--   inserts ONE pending_japam_adoption marker for (user, My Japam). The user's
--   NEXT refresh will peek the marker, persist My Japam as currentJapamId,
--   acknowledge the marker, and surface My Japam (and its Groups) in-app.
--
-- Safety:
--   - Idempotent: re-running it is safe. Re-runs emit a NOTICE and skip.
--   - Inserts ONLY when ALL THREE conditions are true at apply time:
--       1. The user owns the Japam (japams.user_id matches the staged user_id).
--       2. The Japam is active (japams.archived_at IS NULL).
--       3. No marker already exists for (user_id, japam_id).
--   - Touches ONLY the staged (user, japam) pair; does not touch any other
--     user's rows or any other Japam owned by this user.
--   - Never run on production. This is a staging-only fixture to fix one
--     already-restored canonical state without requiring a fresh restore.
--
-- Deployment order:
--   1. db/get_owned_japam_usage_rpc.sql           (already on staging)
--   2. db/pending_japam_adoption.sql              (creates the marker table)
--   3. db/restore_owned_japam_rpc.sql             (updated to insert marker)
--   4. db/backfill_pending_japam_adoption_staging.sql  (THIS FILE — one-off)
--   5. web/client deploy                          (peek + ack refresh logic)
-- =============================================================================

do $$
declare
  v_user_id        text := '1269ca80-4798-47f9-8186-669262f58b31';
  v_japam_id       uuid := '0d443fb7-da00-490f-a535-806a83575584';
  v_owner          text;
  v_is_active      boolean;
  v_marker_exists  boolean;
begin
  -- (1) Ownership check: only the staged user's own Japam is eligible.
  select j.user_id
    into v_owner
  from public.japams j
  where j.id = v_japam_id;

  if v_owner is null then
    raise notice 'Backfill: no Japam found with id % — skipping.', v_japam_id;
    return;
  end if;

  if v_owner <> v_user_id then
    raise notice 'Backfill: Japam % is not owned by user % (actual owner=%) — skipping.',
      v_japam_id, v_user_id, v_owner;
    return;
  end if;

  -- (2) Active check: a re-archived Japam should not be silently adopted.
  select (j.archived_at is null)
    into v_is_active
  from public.japams j
  where j.id = v_japam_id;

  if not coalesce(v_is_active, false) then
    raise notice 'Backfill: Japam % is not active (archived_at is not null) — skipping.',
      v_japam_id;
    return;
  end if;

  -- (3) Idempotency check: if a marker already exists (from a prior backfill or
  --     from `restore_owned_japam` itself), leave it alone.
  select exists(
    select 1
    from public.pending_japam_adoption pjad
    where pjad.user_id = v_user_id
      and pjad.japam_id = v_japam_id
  ) into v_marker_exists;

  if coalesce(v_marker_exists, false) then
    raise notice 'Backfill: marker already exists for (user %, japam %) — skipping.',
      v_user_id, v_japam_id;
    return;
  end if;

  -- All three conditions met: insert exactly one marker.
  insert into public.pending_japam_adoption (id, user_id, japam_id, created_at)
  values (gen_random_uuid(), v_user_id, v_japam_id, now());

  raise notice 'Backfill: inserted adoption marker for (user %, japam %).',
    v_user_id, v_japam_id;
end;
$$;