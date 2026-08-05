-- Tombstone exactly one owned Japam, authenticated-only, with fixed search_path.
-- This RPC is the only runtime path for permanent Japam delete.

create or replace function public.delete_owned_japam(
  p_japam_id uuid
)
returns table (
  deleted_japam_id uuid,
  scoped_history_deleted bigint,
  legacy_history_deleted bigint,
  tombstones_written bigint,
  ambiguous_legacy_count bigint
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid text;
  v_legacy_uid text;
  v_deleted_id uuid;
  v_deleted_owner_id text;
  v_row_count integer;
  v_tombstones_written bigint := 0;
begin
  v_uid := auth.uid()::text;
  v_legacy_uid := auth.jwt()->'user_metadata'->>'sub';

  if v_uid is null and v_legacy_uid is null then
    raise exception 'authentication required';
  end if;

  select id, user_id into v_deleted_id, v_deleted_owner_id
  from public.japams
  where id = p_japam_id
    and (user_id = v_uid or user_id = v_legacy_uid);

  if v_deleted_id is null then
    raise exception 'delete_owned_japam failed to delete exactly one owned Japam';
  end if;

  insert into public.deleted_japams (japam_id, user_id, deleted_at)
  values (p_japam_id, v_deleted_owner_id, now())
  on conflict (japam_id) do nothing;

  get diagnostics v_row_count = row_count;
  v_tombstones_written := v_row_count::bigint;

  deleted_japam_id := v_deleted_id;
  scoped_history_deleted := 0;
  legacy_history_deleted := 0;
  tombstones_written := v_tombstones_written;
  ambiguous_legacy_count := 0;
  return next;
end;
$$;

revoke all on function public.delete_owned_japam(uuid) from public;
revoke all on function public.delete_owned_japam(uuid) from anon;
revoke all on function public.delete_owned_japam(uuid) from authenticated;
grant execute on function public.delete_owned_japam(uuid) to authenticated;
