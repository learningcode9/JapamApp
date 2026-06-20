-- Groups / Family Japam — member leave RPC.
-- Run ONCE in the Supabase SQL editor after db/groups_migration.sql.
--
-- Lets a group member remove only their own membership row. Personal Japam history, totals,
-- timer state, and other members are untouched.

create or replace function public.leave_group(
  p_group_id uuid,
  p_current_user_id text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current_role text;
  v_admin_count integer;
begin
  -- Lock the group's membership rows while checking/removing so concurrent admin leaves/removes
  -- cannot accidentally leave the group without an admin.
  perform 1
  from public.group_members gm
  where gm.group_id = p_group_id
  for update;

  select gm.role into v_current_role
  from public.group_members gm
  where gm.group_id = p_group_id
    and gm.user_id = p_current_user_id;

  if v_current_role is null then
    raise exception 'not a member of this group';
  end if;

  if v_current_role = 'admin' then
    select count(*)::integer into v_admin_count
    from public.group_members gm
    where gm.group_id = p_group_id
      and gm.role = 'admin';

    if v_admin_count <= 1 then
      raise exception 'cannot leave group as last admin';
    end if;
  end if;

  delete from public.group_members gm
  where gm.group_id = p_group_id
    and gm.user_id = p_current_user_id;

  return true;
end;
$$;

revoke all on function public.leave_group(uuid, text) from public;
grant execute on function public.leave_group(uuid, text) to anon;
