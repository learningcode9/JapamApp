-- Restore one owned Japam atomically.
-- Rules:
--   - verify ownership
--   - clear the target tombstone
--   - unarchive the target
--   - if a conflicting active normalized "My Japam" exists, retire it only when it has zero
--     History rows and zero group references
--   - preserve every History row and every group_members link on the target
--   - fail closed otherwise
-- Deployment order: 1) db/get_owned_japam_usage_rpc.sql 2) db/pending_japam_adoption.sql
-- 3) db/restore_owned_japam_rpc.sql 4) web/client deployment that calls restore_owned_japam.

create or replace function public.restore_owned_japam(
  p_japam_id uuid
)
returns table (
  restored_japam_id uuid,
  tombstones_deleted bigint
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid text;
  v_legacy_uid text;
  v_row_count integer;
  v_target_name text;
  v_target_user_id text;
  v_conflict_count integer;
  v_conflict_id uuid;
  v_conflict_history bigint;
  v_conflict_groups bigint;
begin
  v_uid := auth.uid()::text;
  v_legacy_uid := auth.jwt()->'user_metadata'->>'sub';

  if v_uid is null and v_legacy_uid is null then
    raise exception 'authentication required';
  end if;

  select j.name into v_target_name
  from public.japams j
  where j.id = p_japam_id
    and (j.user_id = v_uid or j.user_id = v_legacy_uid);

  if v_target_name is null then
    raise exception 'restore_owned_japam failed to restore exactly one owned Japam';
  end if;

  -- The adoption marker is keyed by the target Japam's ACTUAL user_id (the value the
  -- client stores as its userId), not by auth.uid(). For legacy Google sign-in
  -- auth.uid() is a different UUID while japams.user_id holds the legacy stored sub;
  -- keying the marker by the japam's user_id keeps peek/ack resolvable by the client's
  -- stored userId.
  select j.user_id
    into v_target_user_id
  from public.japams j
  where j.id = p_japam_id;

  -- From here on, every target-owner-scoped operation uses v_target_user_id — the
  -- target Japam row's actual user_id — instead of coalesce(v_uid, v_legacy_uid).
  -- When auth.uid() differs from the stored/legacy userId, coalescing to the auth
  -- uuid would miss the legacy owner's rows (conflicts, tombstones, history) and
  -- corrupt the restore.

  select count(*), min(j.id::text)::uuid
    into v_conflict_count, v_conflict_id
  from public.japams j
  where j.user_id = v_target_user_id
    and j.id <> p_japam_id
    and j.archived_at is null
    and lower(btrim(regexp_replace(j.name, '\\s+'::text, ' '::text, 'g'::text))) = 'my japam'
    and lower(btrim(regexp_replace(v_target_name, '\\s+'::text, ' '::text, 'g'::text))) = 'my japam';

  if v_conflict_count > 1 then
    raise exception 'restore_owned_japam failed: multiple active normalized My Japam conflicts exist';
  end if;

  if v_conflict_count = 1 then
    select
      (select count(*) from public.japam_history h where h.user_id = j.user_id and h.japam_id = j.id),
      (select count(*) from public.group_members gm where gm.user_id = j.user_id and gm.japam_id = j.id)
      into v_conflict_history, v_conflict_groups
    from public.japams j
    where j.id = v_conflict_id
      and j.user_id = v_target_user_id;

    if coalesce(v_conflict_history, 0) > 0 or coalesce(v_conflict_groups, 0) > 0 then
      raise exception 'restore_owned_japam failed: conflicting active My Japam has History or group membership';
    end if;

    update public.japams
    set archived_at = now(),
        updated_at = now()
    where id = v_conflict_id
      and user_id = v_target_user_id;

    insert into public.deleted_japams (japam_id, user_id, deleted_at)
    values (v_conflict_id, v_target_user_id, now())
    on conflict (japam_id) do nothing;
  end if;

  delete from public.deleted_japams
  where japam_id = p_japam_id
    and user_id = v_target_user_id;

  get diagnostics v_row_count = row_count;
  tombstones_deleted := v_row_count::bigint;

  update public.japams
  set archived_at = null,
      updated_at = now()
  where id = p_japam_id
    and user_id = v_target_user_id
  returning id into restored_japam_id;

  if restored_japam_id is null then
    raise exception 'restore_owned_japam failed to restore exactly one owned Japam';
  end if;

  -- Pending selection adoption marker. Inserted IN THE SAME TRANSACTION as the
  -- restore itself, so a restore without a marker is impossible and a marker
  -- without a committed restore is impossible. The client peeks this marker via
  -- `get_pending_japam_adoption` on the next refresh, persists `p_japam_id` as
  -- the current selection (overriding any stale persisted pointer left from
  -- before the canonical "My Japam" was archived), and only then deletes the
  -- marker via `acknowledge_pending_japam_adoption(marker_id)`. The two-phase
  -- peek+ack keeps the marker alive across any client failure between peek and
  -- durable persist. ON CONFLICT refreshes created_at so the latest restore
  -- wins queue ordering; the UNIQUE(user_id, japam_id) constraint keeps at most
  -- one marker per (user, Japam) pair.
  --
  -- Identity: the marker is keyed by the TARGET Japam row's actual user_id, not
  -- by the caller's auth.uid(). The client's stored userId (the AsyncStorage
  -- `currentJapamId:<uid>` key) is exactly this value — for legacy Google
  -- sign-in the japams.user_id column holds the legacy `sub` while auth.uid()
  -- returns a different UUID. Keying the marker by the japam's user_id guarantees
  -- peek (`get_pending_japam_adoption(p_user_id)`) and acknowledge
  -- (`acknowledge_pending_japam_adoption(p_user_id, marker_id)`) find the marker
  -- when the client passes its stored userId, even though auth.uid() differs.
  insert into public.pending_japam_adoption (id, user_id, japam_id, created_at)
  values (
    gen_random_uuid(),
    v_target_user_id,
    p_japam_id,
    now()
  )
  on conflict (user_id, japam_id) do update
  set created_at = now();

  return next;
end;
$$;

revoke all on function public.restore_owned_japam(uuid) from public;
revoke all on function public.restore_owned_japam(uuid) from anon;
revoke all on function public.restore_owned_japam(uuid) from authenticated;
grant execute on function public.restore_owned_japam(uuid) to authenticated;
