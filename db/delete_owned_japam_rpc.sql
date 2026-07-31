-- Delete exactly one owned Japam, authenticated-only, with fixed search_path.
-- This RPC is the only runtime path for permanent Japam delete.

create or replace function public.delete_owned_japam(
  p_japam_id uuid
)
returns table (deleted_japam_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid text;
  v_deleted_id uuid;
  v_row_count integer;
begin
  v_uid := auth.uid()::text;

  if v_uid is null then
    raise exception 'authentication required';
  end if;

  delete from public.japams
  where id = p_japam_id
    and user_id = v_uid
  returning id into v_deleted_id;

  get diagnostics v_row_count = row_count;

  if v_row_count <> 1 or v_deleted_id is distinct from p_japam_id then
    raise exception 'delete_owned_japam failed to delete exactly one owned Japam';
  end if;

  deleted_japam_id := v_deleted_id;
  return next;
end;
$$;

revoke all on function public.delete_owned_japam(uuid) from public;
revoke all on function public.delete_owned_japam(uuid) from anon;
revoke all on function public.delete_owned_japam(uuid) from authenticated;
grant execute on function public.delete_owned_japam(uuid) to authenticated;
