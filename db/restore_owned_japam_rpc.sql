-- Restore one owned Japam atomically.
-- Rules:
--   - verify ownership
--   - clear the target tombstone
--   - unarchive the target
--   - if a conflicting active normalized "My Japam" exists, retire it only when it has zero
--     History rows and zero group references
--   - preserve every History row and every group_members link on the target
--   - fail closed otherwise

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

  select count(*), min(j.id)
    into v_conflict_count, v_conflict_id
  from public.japams j
  where j.user_id = coalesce(v_uid, v_legacy_uid)
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
    where j.id = v_conflict_id;

    if coalesce(v_conflict_history, 0) > 0 or coalesce(v_conflict_groups, 0) > 0 then
      raise exception 'restore_owned_japam failed: conflicting active My Japam has History or group membership';
    end if;

    update public.japams
    set archived_at = now(),
        updated_at = now()
    where id = v_conflict_id;

    insert into public.deleted_japams (japam_id, user_id, deleted_at)
    values (v_conflict_id, coalesce(v_uid, v_legacy_uid), now())
    on conflict (japam_id) do nothing;
  end if;

  delete from public.deleted_japams
  where japam_id = p_japam_id
    and (user_id = v_uid or user_id = v_legacy_uid);

  get diagnostics v_row_count = row_count;
  tombstones_deleted := v_row_count::bigint;

  update public.japams
  set archived_at = null,
      updated_at = now()
  where id = p_japam_id
    and (user_id = v_uid or user_id = v_legacy_uid)
  returning id into restored_japam_id;

  if restored_japam_id is null then
    raise exception 'restore_owned_japam failed to restore exactly one owned Japam';
  end if;

  return next;
end;
$$;

revoke all on function public.restore_owned_japam(uuid) from public;
revoke all on function public.restore_owned_japam(uuid) from anon;
revoke all on function public.restore_owned_japam(uuid) from authenticated;
grant execute on function public.restore_owned_japam(uuid) to authenticated;
