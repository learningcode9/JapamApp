-- Groups / Family Japam — admin invite-code retrieval RPC.
-- Run ONCE in the Supabase SQL editor, same as db/groups_migration.sql.
--
-- Adds ONE new function only. Does not modify groups, group_members, get_my_groups, or
-- get_group_dashboard. Does not generate a new invite_code — it only reads back the one already
-- stored on public.groups at creation time (db/groups_migration.sql's create_group function),
-- so existing groups' original codes are returned unchanged.

-- Parameter is named p_current_user_id (matching get_group_dashboard's naming convention) — this
-- is what's actually deployed; PostgREST matches RPC calls by parameter name, so the app code in
-- lib/groupsRepository.ts must send this exact name.
create or replace function public.get_group_invite_code(
  p_group_id uuid,
  p_current_user_id text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invite_code text;
begin
  -- Admin gate: only an admin member of this exact group may read its invite code back out.
  -- Mirrors get_group_dashboard's "member of this group" gate, but additionally requires
  -- role = 'admin' — the invite code is more sensitive than the roster/stats that gate already
  -- protects, since anyone holding the code can add new members.
  if not exists (
    select 1
    from public.group_members gm
    where gm.group_id = p_group_id
      and gm.user_id = p_current_user_id
      and gm.role = 'admin'
  ) then
    raise exception 'only group admin can view invite code';
  end if;

  select g.invite_code into v_invite_code
  from public.groups g
  where g.id = p_group_id;

  return v_invite_code;
end;
$$;

revoke all on function public.get_group_invite_code(uuid, text) from public;
grant execute on function public.get_group_invite_code(uuid, text) to anon;
