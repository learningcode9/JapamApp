-- Groups / Family Japam — admin controls RPCs.
-- Run ONCE in the Supabase SQL editor after db/groups_migration.sql.
--
-- Adds admin-only write paths without granting direct client UPDATE/DELETE policies on
-- public.groups or public.group_members. These functions preserve the existing admin/member
-- role model and keep personal Japam history untouched.

create or replace function public.rename_group(
  p_group_id uuid,
  p_acting_admin_user_id text,
  p_new_name text
)
returns table (name text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text := btrim(p_new_name);
begin
  if v_name is null or v_name = '' then
    raise exception 'group name must not be empty';
  end if;

  if not exists (
    select 1
    from public.groups g
    left join public.group_members gm
      on gm.group_id = g.id
      and gm.user_id = p_acting_admin_user_id
      and gm.role = 'admin'
    where g.id = p_group_id
      and (gm.user_id is not null or g.created_by = p_acting_admin_user_id)
  ) then
    raise exception 'not a group admin';
  end if;

  update public.groups g
  set name = v_name
  where g.id = p_group_id;

  if not found then
    raise exception 'group not found';
  end if;

  return query select v_name;
end;
$$;

revoke all on function public.rename_group(uuid, text, text) from public;
grant execute on function public.rename_group(uuid, text, text) to anon;

create or replace function public.remove_group_member(
  p_group_id uuid,
  p_acting_admin_user_id text,
  p_target_user_id text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target_role text;
  v_admin_count integer;
begin
  if p_acting_admin_user_id = p_target_user_id then
    raise exception 'cannot remove yourself; use leave group';
  end if;

  -- Lock the group's membership rows while checking/removing so concurrent admin removals can't
  -- accidentally leave the group without an admin.
  perform 1
  from public.group_members gm
  where gm.group_id = p_group_id
  for update;

  if not exists (
    select 1
    from public.groups g
    left join public.group_members gm
      on gm.group_id = g.id
      and gm.user_id = p_acting_admin_user_id
      and gm.role = 'admin'
    where g.id = p_group_id
      and (gm.user_id is not null or g.created_by = p_acting_admin_user_id)
  ) then
    raise exception 'not a group admin';
  end if;

  select gm.role into v_target_role
  from public.group_members gm
  where gm.group_id = p_group_id
    and gm.user_id = p_target_user_id;

  if v_target_role is null then
    raise exception 'member not found';
  end if;

  if v_target_role = 'admin' then
    select count(*)::integer into v_admin_count
    from public.group_members gm
    where gm.group_id = p_group_id
      and gm.role = 'admin';

    if v_admin_count <= 1 then
      raise exception 'cannot remove last admin';
    end if;
  end if;

  delete from public.group_members gm
  where gm.group_id = p_group_id
    and gm.user_id = p_target_user_id;

  return true;
end;
$$;

revoke all on function public.remove_group_member(uuid, text, text) from public;
grant execute on function public.remove_group_member(uuid, text, text) to anon;

create or replace function public.delete_group(
  p_group_id uuid,
  p_acting_admin_user_id text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1
    from public.groups g
    left join public.group_members gm
      on gm.group_id = g.id
      and gm.user_id = p_acting_admin_user_id
      and gm.role = 'admin'
    where g.id = p_group_id
      and (gm.user_id is not null or g.created_by = p_acting_admin_user_id)
  ) then
    raise exception 'not a group admin';
  end if;

  -- public.group_members has group_id references public.groups(id) on delete cascade, so this
  -- single delete safely removes memberships while leaving each user's personal Japam history.
  delete from public.groups g
  where g.id = p_group_id;

  if not found then
    raise exception 'group not found';
  end if;

  return true;
end;
$$;

revoke all on function public.delete_group(uuid, text) from public;
grant execute on function public.delete_group(uuid, text) to anon;
