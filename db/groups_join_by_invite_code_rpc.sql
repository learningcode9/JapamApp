-- Phase A — backward-compatible secure Groups join RPC.
--
-- Replaces the client-side INSERT into public.group_members. The joining identity is always
-- derived from auth.uid(); p_user_name is display-only and cannot select another user's row.
-- Run the precheck first, then apply SECTION 2 only after review in the intended Supabase project.
-- Keep the legacy direct INSERT policy during this phase so installed old clients are not broken.

-- SECTION 1 — READ-ONLY PRECHECK
-- A. Existing overloads. Expected: no rows, or exactly the text,text signature.
select
  p.oid::regprocedure as signature,
  r.rolname as owner,
  p.prosecdef as security_definer,
  p.proconfig
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
join pg_roles r on r.oid = p.proowner
where n.nspname = 'public'
  and p.proname = 'join_group_by_invite_code'
order by signature;

-- B. The unique constraint/index used by ON CONFLICT (group_id, user_id).
select conname, pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'public.group_members'::regclass
  and contype = 'u'
order by conname;

-- C. RLS must remain enabled.
select c.relname, c.relrowsecurity, c.relforcerowsecurity
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname = 'group_members';

-- D. Keep the legacy policy unchanged in Phase A.
select policyname, cmd, roles, with_check
from pg_policies
where schemaname = 'public'
  and tablename = 'group_members'
order by policyname;

-- E. Row snapshot. This migration contains no DML; compare after apply while accounting for
-- normal concurrent app activity.
select count(*) as group_members_count from public.group_members;

-- SECTION 2 — APPLY
-- Guard against ambiguous PostgREST RPC overloads. If this raises, stop and review the
-- precheck output instead of creating another function with the same RPC name.
do $$
declare
  v_expected oid := to_regprocedure('public.join_group_by_invite_code(text,text)')::oid;
begin
  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'join_group_by_invite_code'
      and (v_expected is null or p.oid <> v_expected)
  ) then
    raise exception 'unexpected join_group_by_invite_code overload exists; review before applying';
  end if;
end;
$$;

create or replace function public.join_group_by_invite_code(
  p_invite_code text,
  p_user_name text
)
returns table (
  id uuid,
  name text,
  is_active boolean,
  already_member boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id text := auth.uid()::text;
  v_group_id uuid;
  v_group_name text;
  v_is_active boolean;
  v_inserted boolean;
begin
  if v_user_id is null then
    raise exception 'authentication required to join a group'
      using errcode = '42501';
  end if;

  select g.id, g.name, g.is_active
    into v_group_id, v_group_name, v_is_active
  from public.groups g
  where g.invite_code = upper(btrim(p_invite_code));

  if not found then
    return;
  end if;

  if not v_is_active then
    return query select v_group_id, v_group_name, false, false;
    return;
  end if;

  insert into public.group_members (group_id, user_id, user_name, role)
  values (v_group_id, v_user_id, nullif(btrim(p_user_name), ''), 'member')
  on conflict (group_id, user_id) do nothing;

  v_inserted := found;
  return query select v_group_id, v_group_name, true, not v_inserted;
end;
$$;

revoke all on function public.join_group_by_invite_code(text, text) from public;
revoke execute on function public.join_group_by_invite_code(text, text) from anon;
grant execute on function public.join_group_by_invite_code(text, text) to authenticated;

-- SECTION 3 — READ-ONLY POST-APPLY VERIFICATION
-- Expected: exactly public.join_group_by_invite_code(text,text), owner is a privileged project
-- role, security_definer=true, and search_path=public, pg_temp.
select
  p.oid::regprocedure as signature,
  r.rolname as owner,
  p.prosecdef as security_definer,
  p.proconfig
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
join pg_roles r on r.oid = p.proowner
where p.oid = 'public.join_group_by_invite_code(text,text)'::regprocedure;

-- Expected: authenticated=true; public=false; anon=false.
select
  has_function_privilege('authenticated', 'public.join_group_by_invite_code(text,text)', 'EXECUTE')
    as authenticated_execute,
  has_function_privilege('anon', 'public.join_group_by_invite_code(text,text)', 'EXECUTE')
    as anon_execute,
  exists (
    select 1
    from aclexplode(
      coalesce(
        (select p.proacl from pg_proc p where p.oid = 'public.join_group_by_invite_code(text,text)'::regprocedure),
        acldefault('f', (select p.proowner from pg_proc p where p.oid = 'public.join_group_by_invite_code(text,text)'::regprocedure))
      )
    ) acl
    where acl.grantee = 0 -- PostgreSQL ACL sentinel for PUBLIC
      and acl.privilege_type = 'EXECUTE'
  ) as public_execute;

-- Expected: legacy direct INSERT policy is still present in Phase A.
select policyname, cmd, roles, with_check
from pg_policies
where schemaname = 'public'
  and tablename = 'group_members'
order by policyname;

-- Expected: unchanged from the precheck unless normal app activity occurred concurrently.
select count(*) as group_members_count from public.group_members;
