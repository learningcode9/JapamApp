-- Phase B — deferred cleanup for the legacy direct membership INSERT policy.
--
-- Do NOT run until all of these are true:
--   1. The Phase A join_group_by_invite_code RPC is applied.
--   2. The RPC-based app has passed staging/device Join Group validation.
--   3. The production OTA has sufficient adoption.
--   4. Product confirms that any remaining no-session/legacy Groups client is unsupported.

-- READ-ONLY PRECHECK
select policyname, cmd, roles, with_check
from pg_policies
where schemaname = 'public'
  and tablename = 'group_members'
  and policyname = 'anon insert group_members';

select routine_name, security_type
from information_schema.routines
where routine_schema = 'public'
  and routine_name = 'join_group_by_invite_code';

-- APPLY ONLY AFTER THE FOUR CONDITIONS ABOVE ARE MET
drop policy if exists "anon insert group_members" on public.group_members;

-- READ-ONLY POST-APPLY VERIFICATION
select policyname, cmd, roles, with_check
from pg_policies
where schemaname = 'public'
  and tablename = 'group_members'
order by policyname;
