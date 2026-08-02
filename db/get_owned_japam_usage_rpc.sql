-- Read-only usage probe for one owned Japam. This is used to choose a canonical restore target
-- and to prove a conflicting default is actually empty before it is retired.

create or replace function public.get_owned_japam_usage(
  p_japam_id uuid
)
returns table (
  japam_id uuid,
  name text,
  archived_at timestamptz,
  history_count bigint,
  group_ref_count bigint
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid text;
  v_legacy_uid text;
begin
  v_uid := auth.uid()::text;
  v_legacy_uid := auth.jwt()->'user_metadata'->>'sub';

  if v_uid is null and v_legacy_uid is null then
    raise exception 'authentication required';
  end if;

  return query
  select
    j.id,
    j.name,
    j.archived_at,
    (select count(*) from public.japam_history h where h.user_id = j.user_id and h.japam_id = j.id)::bigint,
    (select count(*) from public.group_members gm where gm.user_id = j.user_id and gm.japam_id = j.id)::bigint
  from public.japams j
  where j.id = p_japam_id
    and (j.user_id = v_uid or j.user_id = v_legacy_uid);
end;
$$;

revoke all on function public.get_owned_japam_usage(uuid) from public;
revoke all on function public.get_owned_japam_usage(uuid) from anon;
revoke all on function public.get_owned_japam_usage(uuid) from authenticated;
grant execute on function public.get_owned_japam_usage(uuid) to authenticated;
