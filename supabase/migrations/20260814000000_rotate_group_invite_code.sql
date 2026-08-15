-- Local Supabase migration: rotate a group's invite code without changing group state.
-- This migration changes only public.groups.invite_code. It is intentionally kept in the local
-- Supabase migration flow and must not be run against staging or production from this file.

create or replace function public.rotate_group_invite_code(
  p_group_id uuid,
  p_acting_admin_user_id text
)
returns table(invite_code text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller_id text := auth.uid()::text;
  v_legacy_sub text := nullif((auth.jwt() -> 'user_metadata' ->> 'sub'), '');
  v_old_code text;
  v_new_code text;
  v_attempt integer := 0;
begin
  if v_caller_id is null then
    raise exception 'authentication required';
  end if;

  -- The client parameter is retained for the stable RPC contract, but authorization is based on
  -- the verified session identity. The legacy JWT sub supports pre-UUID group memberships.
  if not exists (
    select 1
    from public.group_members gm
    where gm.group_id = p_group_id
      and gm.role = 'admin'
      and (
        gm.user_id = v_caller_id
        or (v_legacy_sub is not null and gm.user_id = v_legacy_sub)
      )
  ) then
    raise exception 'not a group admin';
  end if;

  -- Lock the group row so concurrent rotations cannot return stale codes for this group.
  select g.invite_code
    into v_old_code
    from public.groups g
   where g.id = p_group_id
     and g.is_active = true
   for update;

  if not found then
    raise exception 'group not found or inactive';
  end if;

  loop
    v_attempt := v_attempt + 1;
    v_new_code := upper(substr(md5(random()::text || clock_timestamp()::text), 1, 7));

    -- A rotation must produce a different code, not merely a code that satisfies the unique
    -- constraint. The unique constraint on groups.invite_code handles cross-group collisions.
    if v_new_code = v_old_code then
      if v_attempt >= 10 then
        raise exception 'could not generate a new unique invite code';
      end if;
      continue;
    end if;

    begin
      update public.groups
         set invite_code = v_new_code
       where id = p_group_id;

      return query select v_new_code;
      return;
    exception
      when unique_violation then
        if v_attempt >= 10 then
          raise exception 'could not generate a new unique invite code';
        end if;
    end;
  end loop;
end;
$$;

revoke all on function public.rotate_group_invite_code(uuid, text) from public;
grant execute on function public.rotate_group_invite_code(uuid, text) to authenticated;
grant execute on function public.rotate_group_invite_code(uuid, text) to service_role;
