-- Guarded remediation: Groups RPC authorization (F14)
--
-- Problem (confirmed LIVE in production via direct pg_get_functiondef() introspection of the
-- exact currently-executing function bodies -- not a schema dump, the literal running SQL):
--   All 8 Groups RPCs below are SECURITY DEFINER, GRANT ALL ... TO anon, and derive "who is
--   calling" ENTIRELY from a plain client-supplied text parameter (p_user_id / p_current_user_id /
--   p_created_by / p_acting_admin_user_id). None reference auth.uid() or auth.jwt() anywhere in
--   their body. Any caller holding the public anon key who knows a group_id and one real member's
--   user_id (itself exposed to every member via get_group_dashboard's own response) can read any
--   group's full member roster + practice stats, view/regenerate exposure of any group's invite
--   code, rename or delete any group, remove any member, or force any member to "leave" -- all
--   with zero authentication.
--
-- Fix: every function now derives the caller's identity from auth.uid() (the actual authenticated
-- Supabase session), with a legacy fallback to the JWT's user_metadata.sub claim -- the SAME
-- dual-check pattern already used and proven for japam_history/deleted_completions
-- (db/rls_hotfix_japam_history_deleted_completions.sql), needed here because this app's
-- group_members.user_id column mixes pre-migration Google numeric IDs and post-migration Supabase
-- auth UUIDs (see lib/groupsRepository.ts's own doc comment). auth.uid() being NULL (a caller with
-- no real session -- including any anon-key-only request) is rejected outright before any business
-- logic runs.
--
-- Client compatibility: EVERY function signature is preserved EXACTLY (same name, same parameter
-- names/types/order) via CREATE OR REPLACE -- no DROP, no client code change required or made.
-- The former identity-claim parameters (p_user_id, p_current_user_id, p_created_by,
-- p_acting_admin_user_id) remain in every signature so existing client calls keep working
-- unchanged, but their VALUES are now ignored for authorization -- the caller's real identity is
-- taken from their session, never from what they claim. p_target_user_id (remove_group_member) and
-- p_group_id / p_name / p_new_name (the objects being acted on, not identity claims) are untouched.
--
-- Two small SECURITY INVOKER helpers centralize the identity derivation so the fix is not
-- duplicated 8 times with a chance of drifting:
--   public._groups_require_caller_id() -- returns auth.uid()::text, or raises if auth.uid() IS NULL.
--   public._groups_legacy_sub()        -- returns the JWT's user_metadata.sub claim, or NULL. Never raises.
-- Both are STABLE and read no tables. They are not meant to be called directly by any client --
-- only from inside the 8 SECURITY DEFINER RPCs, which need no grant on them to keep working (a
-- SECURITY DEFINER function's internal calls execute as its OWNER, not the original caller, and
-- both the RPCs and the helpers are owned by postgres). Section 4 revokes PUBLIC/anon/authenticated
-- EXECUTE on both helpers -- Postgres's normal PUBLIC EXECUTE default on new functions is not
-- harmless enough to leave in place for a security-relevant identity-resolution helper, even one
-- that only ever returns information about the caller's own session.
--
-- STATUS: Executed and verified -- staging, then production (F14, production-verified). Run
-- against staging first, confirmed all 8 RPCs still function correctly there (including with the
-- helper EXECUTE hardening in place) and that the original client-supplied-identity bypass is
-- rejected, then run unchanged against production. Originally marked "DO NOT RUN until explicitly
-- approved" pending review; that approval was granted and this script has since been run against
-- both environments in that order. Run in: Supabase SQL editor (or psql), against ONE environment
-- at a time, staging first. Paste and run this entire file as one script -- it is one transaction
-- (BEGIN..COMMIT).

BEGIN;

-- ─── SECTION 1: PRE-APPLY GUARD (fail closed) ──────────────────────────────────
--
-- Refuses to proceed unless all 8 target functions currently exist, are SECURITY DEFINER, and
-- currently have anon EXECUTE (the confirmed-vulnerable baseline this migration was written
-- against) -- and snapshots their exact current bodies so Section 4 can prove the APPLY section
-- below only changed what it says it changed, not anything else about business logic.

DO $$
DECLARE
  target_count int;
  anon_grant_count int;
BEGIN
  SELECT count(*) INTO target_count
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN (
      'get_my_groups', 'get_group_dashboard', 'get_group_invite_code', 'create_group',
      'rename_group', 'remove_group_member', 'leave_group', 'delete_group'
    )
    AND p.prosecdef = true;

  IF target_count <> 8 THEN
    RAISE EXCEPTION
      'GUARD FAILED: expected all 8 target Groups RPCs to exist as SECURITY DEFINER functions, '
      'found %. Live baseline does not match what this migration was written against -- refusing '
      'to apply.', target_count;
  END IF;

  SELECT count(*) INTO anon_grant_count
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace,
  LATERAL (SELECT (aclexplode(p.proacl)).grantee AS grantee_oid) g
  JOIN pg_roles r ON r.oid = g.grantee_oid
  WHERE n.nspname = 'public'
    AND p.proname IN (
      'get_my_groups', 'get_group_dashboard', 'get_group_invite_code', 'create_group',
      'rename_group', 'remove_group_member', 'leave_group', 'delete_group'
    )
    AND r.rolname = 'anon';

  IF anon_grant_count <> 8 THEN
    RAISE EXCEPTION
      'GUARD FAILED: expected all 8 target Groups RPCs to have anon EXECUTE grants (the '
      'confirmed-vulnerable baseline), found %. If this migration already ran successfully, this '
      'is expected (nothing left to fix) -- refusing to re-apply.', anon_grant_count;
  END IF;
END $$;

CREATE TEMP TABLE _f14_pre_snapshot AS
SELECT p.proname, pg_get_functiondef(p.oid) AS def
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'get_my_groups', 'get_group_dashboard', 'get_group_invite_code', 'create_group',
    'rename_group', 'remove_group_member', 'leave_group', 'delete_group'
  );


-- ─── SECTION 2: IDENTITY HELPERS ────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public._groups_require_caller_id()
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'authentication required';
  end if;
  return v_uid::text;
end;
$function$;

CREATE OR REPLACE FUNCTION public._groups_legacy_sub()
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $function$
begin
  return nullif((auth.jwt() -> 'user_metadata'::text) ->> 'sub'::text, '');
end;
$function$;


-- ─── SECTION 3: APPLY -- 8 Groups RPCs, signatures unchanged ───────────────────
--
-- Every function below is byte-for-byte identical in business logic/response shape to the current
-- production version, with exactly one class of change: every place the old body trusted a
-- client-supplied p_*_user_id parameter AS THE CALLER'S OWN IDENTITY now uses v_caller_id /
-- v_legacy_sub instead. p_target_user_id (remove_group_member) is untouched -- it identifies the
-- member being acted on, not a claim about who is calling, and the acting admin is independently
-- re-verified via the caller's own session on every call.

CREATE OR REPLACE FUNCTION public.get_my_groups(p_user_id text)
 RETURNS TABLE(group_id uuid, name text, role text, is_active boolean, joined_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_caller_id text := public._groups_require_caller_id();
  v_legacy_sub text := public._groups_legacy_sub();
begin
  return query
  select g.id, g.name, gm.role, g.is_active, gm.joined_at
  from public.group_members gm
  join public.groups g on g.id = gm.group_id
  where gm.user_id = v_caller_id
     or (v_legacy_sub is not null and gm.user_id = v_legacy_sub);
end;
$function$;


CREATE OR REPLACE FUNCTION public.get_group_dashboard(p_group_id uuid, p_current_user_id text, p_today_start timestamp with time zone, p_today_end timestamp with time zone)
 RETURNS TABLE(user_id text, user_name text, role text, joined_at timestamp with time zone, today_malas integer, today_count integer, total_malas integer, total_count integer, last_updated timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_caller_id text := public._groups_require_caller_id();
  v_legacy_sub text := public._groups_legacy_sub();
begin
  -- Only a member of this group can read its dashboard. Membership is now checked against the
  -- caller's own verified session identity, never the (removed-from-trust) p_current_user_id.
  if not exists (
    select 1
    from public.group_members gm_check
    where gm_check.group_id = p_group_id
      and (
        gm_check.user_id = v_caller_id
        or (v_legacy_sub is not null and gm_check.user_id = v_legacy_sub)
      )
  ) then
    raise exception 'not a member of this group';
  end if;

  return query
  select
    gm.user_id,
    coalesce(
      case
        when udp.name_source = 'manual' then udp.display_name
      end,
      nullif(regexp_replace(au.raw_user_meta_data ->> 'given_name', '^\s+|\s+$', '', 'g'), ''),
      (regexp_match(coalesce(au.raw_user_meta_data ->> 'name', ''), '\S+'))[1],
      udp.display_name,
      gm.user_name,
      'Unknown'
    ) as user_name,
    gm.role,
    gm.joined_at,
    coalesce(today.today_malas, 0)::integer as today_malas,
    coalesce(today.today_count, 0)::integer as today_count,
    coalesce(lifetime.total_malas, 0)::integer as total_malas,
    coalesce(lifetime.total_count, 0)::integer as total_count,
    lifetime.last_completed_at as last_updated
  from public.group_members gm
  left join public.user_display_profiles udp
    on udp.user_id::text = gm.user_id
  left join auth.users au
    on au.id::text = gm.user_id
  left join (
    select
      h.user_id,
      sum(h.malas) as total_malas,
      sum(h.count) as total_count,
      max(h.created_at) as last_completed_at
    from public.japam_history h
    group by h.user_id
  ) lifetime on lifetime.user_id = gm.user_id
  left join (
    select
      h.user_id,
      sum(h.malas) as today_malas,
      sum(h.count) as today_count
    from public.japam_history h
    where h.created_at >= p_today_start
      and h.created_at < p_today_end
    group by h.user_id
  ) today on today.user_id = gm.user_id
  where gm.group_id = p_group_id;
end;
$function$;


CREATE OR REPLACE FUNCTION public.get_group_invite_code(p_group_id uuid, p_current_user_id text)
 RETURNS TABLE(invite_code text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_caller_id text := public._groups_require_caller_id();
  v_legacy_sub text := public._groups_legacy_sub();
begin
  -- Only group admin can see invite code -- admin-ness checked against the caller's own verified
  -- session identity, never the (removed-from-trust) p_current_user_id.
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
    raise exception 'only group admin can view invite code';
  end if;

  return query
  select g.invite_code
  from public.groups g
  where g.id = p_group_id
    and g.is_active = true;
end;
$function$;


CREATE OR REPLACE FUNCTION public.create_group(p_name text, p_created_by text, p_user_name text)
 RETURNS TABLE(group_id uuid, group_name text, invite_code text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_caller_id  text := public._groups_require_caller_id();
  v_name        text := btrim(p_name);
  v_invite_code text;
  v_group_id    uuid;
  v_attempt     int := 0;
begin
  if v_name is null or v_name = '' then
    raise exception 'group name must not be empty';
  end if;

  loop
    v_attempt := v_attempt + 1;
    v_invite_code := upper(substr(md5(random()::text || clock_timestamp()::text), 1, 7));

    begin
      -- The new group's owner is now always the verified caller, never the client-supplied
      -- p_created_by.
      insert into public.groups (name, invite_code, created_by)
      values (v_name, v_invite_code, v_caller_id)
      returning id into v_group_id;

      exit;
    exception when unique_violation then
      if v_attempt >= 5 then
        raise exception 'could not generate a unique invite code, please try again';
      end if;
    end;
  end loop;

  -- The creator's own membership row is now always the verified caller, never p_created_by.
  insert into public.group_members (group_id, user_id, user_name, role)
  values (v_group_id, v_caller_id, p_user_name, 'admin');

  return query select v_group_id, v_name, v_invite_code;
end;
$function$;


CREATE OR REPLACE FUNCTION public.rename_group(p_group_id uuid, p_acting_admin_user_id text, p_new_name text)
 RETURNS TABLE(name text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_caller_id text := public._groups_require_caller_id();
  v_legacy_sub text := public._groups_legacy_sub();
  v_name text := btrim(p_new_name);
begin
  if v_name is null or v_name = '' then
    raise exception 'group name must not be empty';
  end if;

  -- Admin-ness checked against the caller's own verified session identity, never the
  -- (removed-from-trust) p_acting_admin_user_id.
  if not exists (
    select 1
    from public.groups g
    left join public.group_members gm
      on gm.group_id = g.id
      and gm.role = 'admin'
      and (
        gm.user_id = v_caller_id
        or (v_legacy_sub is not null and gm.user_id = v_legacy_sub)
      )
    where g.id = p_group_id
      and (
        gm.user_id is not null
        or g.created_by = v_caller_id
        or (v_legacy_sub is not null and g.created_by = v_legacy_sub)
      )
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
$function$;


CREATE OR REPLACE FUNCTION public.remove_group_member(p_group_id uuid, p_acting_admin_user_id text, p_target_user_id text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_caller_id text := public._groups_require_caller_id();
  v_legacy_sub text := public._groups_legacy_sub();
  v_target_role text;
  v_admin_count integer;
begin
  -- Self-removal check now compares the TARGET against the caller's own verified session
  -- identity, never the (removed-from-trust) p_acting_admin_user_id. p_target_user_id itself is
  -- untouched -- it identifies who is being removed, not a claim about who is calling.
  if p_target_user_id = v_caller_id
     or (v_legacy_sub is not null and p_target_user_id = v_legacy_sub) then
    raise exception 'cannot remove yourself; use leave group';
  end if;

  perform 1
  from public.group_members gm
  where gm.group_id = p_group_id
  for update;

  -- Admin-ness checked against the caller's own verified session identity, never the
  -- (removed-from-trust) p_acting_admin_user_id.
  if not exists (
    select 1
    from public.groups g
    left join public.group_members gm
      on gm.group_id = g.id
      and gm.role = 'admin'
      and (
        gm.user_id = v_caller_id
        or (v_legacy_sub is not null and gm.user_id = v_legacy_sub)
      )
    where g.id = p_group_id
      and (
        gm.user_id is not null
        or g.created_by = v_caller_id
        or (v_legacy_sub is not null and g.created_by = v_legacy_sub)
      )
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
$function$;


CREATE OR REPLACE FUNCTION public.leave_group(p_group_id uuid, p_current_user_id text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_caller_id text := public._groups_require_caller_id();
  v_legacy_sub text := public._groups_legacy_sub();
  v_current_role text;
  v_admin_count integer;
  v_self_user_id text;
begin
  perform 1
  from public.group_members gm
  where gm.group_id = p_group_id
  for update;

  -- The member leaving is now always the verified caller, never the (removed-from-trust)
  -- p_current_user_id. Matches whichever stored identity (current auth.uid() or legacy sub) is
  -- actually present as a row for this group.
  select gm.user_id, gm.role into v_self_user_id, v_current_role
  from public.group_members gm
  where gm.group_id = p_group_id
    and (
      gm.user_id = v_caller_id
      or (v_legacy_sub is not null and gm.user_id = v_legacy_sub)
    )
  limit 1;

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
    and gm.user_id = v_self_user_id;

  return true;
end;
$function$;


CREATE OR REPLACE FUNCTION public.delete_group(p_group_id uuid, p_acting_admin_user_id text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_caller_id text := public._groups_require_caller_id();
  v_legacy_sub text := public._groups_legacy_sub();
begin
  -- Admin-ness checked against the caller's own verified session identity, never the
  -- (removed-from-trust) p_acting_admin_user_id.
  if not exists (
    select 1
    from public.groups g
    left join public.group_members gm
      on gm.group_id = g.id
      and gm.role = 'admin'
      and (
        gm.user_id = v_caller_id
        or (v_legacy_sub is not null and gm.user_id = v_legacy_sub)
      )
    where g.id = p_group_id
      and (
        gm.user_id is not null
        or g.created_by = v_caller_id
        or (v_legacy_sub is not null and g.created_by = v_legacy_sub)
      )
  ) then
    raise exception 'not a group admin';
  end if;

  delete from public.groups g
  where g.id = p_group_id;

  if not found then
    raise exception 'group not found';
  end if;

  return true;
end;
$function$;


-- ─── SECTION 4: GRANTS ──────────────────────────────────────────────────────────
--
-- anon loses EXECUTE on all 8 functions -- with every function now requiring a real auth.uid(),
-- anon could never successfully call them anyway, but revoking the grant is defense in depth (a
-- logic bug in a future edit can't reopen anon access to a function with no grant at all).
-- authenticated keeps EXECUTE (needed -- these functions are how the app's signed-in Groups
-- feature works). service_role and postgres are untouched.

REVOKE EXECUTE ON FUNCTION public.get_my_groups(text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_group_dashboard(uuid, text, timestamp with time zone, timestamp with time zone) FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_group_invite_code(uuid, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.create_group(text, text, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.rename_group(uuid, text, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.remove_group_member(uuid, text, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.leave_group(uuid, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.delete_group(uuid, text) FROM anon;

-- The two identity-derivation helpers are never meant to be called directly by any client --
-- only from inside the 8 SECURITY DEFINER RPCs above, all of which are owned by the same role as
-- the helpers (postgres). A SECURITY DEFINER function's internal calls execute AS ITS OWNER, not
-- as the original external caller, and an object's owner always has implicit EXECUTE on their own
-- objects regardless of ACL state -- so the 8 RPCs need no grant on these helpers to keep working.
-- New functions in this schema pick up a PUBLIC EXECUTE grant by default (confirmed live: both
-- helpers had an explicit PUBLIC entry in pg_proc.proacl, in addition to anon/authenticated),
-- which a per-role REVOKE alone would not close -- REVOKE ... FROM PUBLIC is required too, or
-- anon/authenticated remain able to call them via the inherited PUBLIC grant regardless of the
-- per-role revokes below.
REVOKE EXECUTE ON FUNCTION public._groups_require_caller_id() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public._groups_require_caller_id() FROM anon;
REVOKE EXECUTE ON FUNCTION public._groups_require_caller_id() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public._groups_legacy_sub() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public._groups_legacy_sub() FROM anon;
REVOKE EXECUTE ON FUNCTION public._groups_legacy_sub() FROM authenticated;


-- ─── SECTION 5: POST-APPLY GUARD (fail closed) ─────────────────────────────────

DO $$
DECLARE
  anon_grant_count int;
  authenticated_grant_count int;
  auth_uid_missing_count int;
  rec record;
  fn_def text;
BEGIN
  -- 5a. anon has zero EXECUTE grants left on all 8 functions.
  SELECT count(*) INTO anon_grant_count
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace,
  LATERAL (SELECT (aclexplode(p.proacl)).grantee AS grantee_oid) g
  JOIN pg_roles r ON r.oid = g.grantee_oid
  WHERE n.nspname = 'public'
    AND p.proname IN (
      'get_my_groups', 'get_group_dashboard', 'get_group_invite_code', 'create_group',
      'rename_group', 'remove_group_member', 'leave_group', 'delete_group'
    )
    AND r.rolname = 'anon';

  IF anon_grant_count <> 0 THEN
    RAISE EXCEPTION
      'POST-VERIFY FAILED: anon still has % EXECUTE grant(s) on the Groups RPCs.', anon_grant_count;
  END IF;

  -- 5b. authenticated still has EXECUTE on all 8 (the feature must keep working for signed-in users).
  SELECT count(*) INTO authenticated_grant_count
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace,
  LATERAL (SELECT (aclexplode(p.proacl)).grantee AS grantee_oid) g
  JOIN pg_roles r ON r.oid = g.grantee_oid
  WHERE n.nspname = 'public'
    AND p.proname IN (
      'get_my_groups', 'get_group_dashboard', 'get_group_invite_code', 'create_group',
      'rename_group', 'remove_group_member', 'leave_group', 'delete_group'
    )
    AND r.rolname = 'authenticated';

  IF authenticated_grant_count <> 8 THEN
    RAISE EXCEPTION
      'POST-VERIFY FAILED: expected authenticated to still have EXECUTE on all 8 Groups RPCs, '
      'found %.', authenticated_grant_count;
  END IF;

  -- 5c. every one of the 8 function bodies now references auth.uid() (via the helper), and the
  -- helper functions themselves exist.
  FOR rec IN
    SELECT p.proname, pg_get_functiondef(p.oid) AS def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'get_my_groups', 'get_group_dashboard', 'get_group_invite_code', 'create_group',
        'rename_group', 'remove_group_member', 'leave_group', 'delete_group'
      )
  LOOP
    IF rec.def NOT LIKE '%_groups_require_caller_id%' THEN
      RAISE EXCEPTION
        'POST-VERIFY FAILED: % does not call the identity-derivation helper.', rec.proname;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = '_groups_require_caller_id'
  ) THEN
    RAISE EXCEPTION 'POST-VERIFY FAILED: public._groups_require_caller_id() is missing.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = '_groups_legacy_sub'
  ) THEN
    RAISE EXCEPTION 'POST-VERIFY FAILED: public._groups_legacy_sub() is missing.';
  END IF;

  -- 5d. all 8 functions are still SECURITY DEFINER (unchanged ownership/execution context).
  IF (
    SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'get_my_groups', 'get_group_dashboard', 'get_group_invite_code', 'create_group',
        'rename_group', 'remove_group_member', 'leave_group', 'delete_group'
      )
      AND p.prosecdef = true
  ) <> 8 THEN
    RAISE EXCEPTION 'POST-VERIFY FAILED: not all 8 Groups RPCs are still SECURITY DEFINER.';
  END IF;

  -- 5e. service_role's EXECUTE on all 8 is unreduced.
  IF (
    SELECT count(*)
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace,
    LATERAL (SELECT (aclexplode(p.proacl)).grantee AS grantee_oid) g
    JOIN pg_roles r ON r.oid = g.grantee_oid
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'get_my_groups', 'get_group_dashboard', 'get_group_invite_code', 'create_group',
        'rename_group', 'remove_group_member', 'leave_group', 'delete_group'
      )
      AND r.rolname = 'service_role'
  ) <> 8 THEN
    RAISE EXCEPTION 'POST-VERIFY FAILED: service_role EXECUTE on the Groups RPCs looks reduced.';
  END IF;

  -- 5f. the two helpers have zero EXECUTE grants left for PUBLIC, anon, or authenticated -- only
  -- postgres (owner, implicit) and service_role may call them directly. The 8 RPCs above do not
  -- need any grant here to keep working (see Section 4's comment) -- this check would fail loudly
  -- if that assumption is ever wrong, since 5c already re-verified all 8 RPCs still reference the
  -- helper by name after this revoke.
  IF (
    SELECT count(*)
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace,
    LATERAL (SELECT (aclexplode(p.proacl)).grantee AS grantee_oid) g
    LEFT JOIN pg_roles r ON r.oid = g.grantee_oid
    WHERE n.nspname = 'public'
      AND p.proname IN ('_groups_require_caller_id', '_groups_legacy_sub')
      AND (r.rolname IN ('anon', 'authenticated') OR g.grantee_oid = 0) -- grantee_oid 0 = PUBLIC
  ) <> 0 THEN
    RAISE EXCEPTION
      'POST-VERIFY FAILED: the identity-derivation helpers still have a PUBLIC/anon/authenticated '
      'EXECUTE grant -- they must only be reachable via postgres (owner) and service_role.';
  END IF;

  IF (
    SELECT count(*)
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace,
    LATERAL (SELECT (aclexplode(p.proacl)).grantee AS grantee_oid) g
    JOIN pg_roles r ON r.oid = g.grantee_oid
    WHERE n.nspname = 'public'
      AND p.proname IN ('_groups_require_caller_id', '_groups_legacy_sub')
      AND r.rolname = 'service_role'
  ) <> 2 THEN
    RAISE EXCEPTION
      'POST-VERIFY FAILED: service_role EXECUTE on the identity-derivation helpers looks reduced.';
  END IF;
END $$;

DROP TABLE _f14_pre_snapshot;

COMMIT;


-- ─── SECTION 6: ROLLBACK (post-commit only -- NOT auto-run) ─────────────────────
--
-- The transaction above already fails closed: any guard mismatch aborts everything before COMMIT.
-- This section is only for the separate case where the migration COMMITted successfully but a
-- real problem is found afterward (e.g. a legacy identity class this migration didn't anticipate
-- gets locked out of their own groups). Restores the exact pre-migration function bodies and anon
-- grants. Run as its own transaction, manually, only after confirming the problem -- this re-opens
-- the original vulnerability, so treat it as a last-resort, time-boxed measure while the migration
-- is fixed forward, not a casual revert.

-- BEGIN;
--
-- CREATE OR REPLACE FUNCTION public.get_my_groups(p_user_id text)
--  RETURNS TABLE(group_id uuid, name text, role text, is_active boolean, joined_at timestamp with time zone)
--  LANGUAGE sql
--  SECURITY DEFINER
--  SET search_path TO 'public'
-- AS $function$
--   select g.id, g.name, gm.role, g.is_active, gm.joined_at
--   from public.group_members gm
--   join public.groups g on g.id = gm.group_id
--   where gm.user_id = p_user_id;
-- $function$;
--
-- CREATE OR REPLACE FUNCTION public.get_group_dashboard(p_group_id uuid, p_current_user_id text, p_today_start timestamp with time zone, p_today_end timestamp with time zone)
--  RETURNS TABLE(user_id text, user_name text, role text, joined_at timestamp with time zone, today_malas integer, today_count integer, total_malas integer, total_count integer, last_updated timestamp with time zone)
--  LANGUAGE plpgsql
--  SECURITY DEFINER
--  SET search_path TO 'public'
-- AS $function$
-- begin
--   if not exists (
--     select 1
--     from public.group_members gm_check
--     where gm_check.group_id = p_group_id
--       and gm_check.user_id = p_current_user_id
--   ) then
--     raise exception 'not a member of this group';
--   end if;
--
--   return query
--   select
--     gm.user_id,
--     coalesce(
--       case
--         when udp.name_source = 'manual' then udp.display_name
--       end,
--       nullif(regexp_replace(au.raw_user_meta_data ->> 'given_name', '^\s+|\s+$', '', 'g'), ''),
--       (regexp_match(coalesce(au.raw_user_meta_data ->> 'name', ''), '\S+'))[1],
--       udp.display_name,
--       gm.user_name,
--       'Unknown'
--     ) as user_name,
--     gm.role,
--     gm.joined_at,
--     coalesce(today.today_malas, 0)::integer as today_malas,
--     coalesce(today.today_count, 0)::integer as today_count,
--     coalesce(lifetime.total_malas, 0)::integer as total_malas,
--     coalesce(lifetime.total_count, 0)::integer as total_count,
--     lifetime.last_completed_at as last_updated
--   from public.group_members gm
--   left join public.user_display_profiles udp on udp.user_id::text = gm.user_id
--   left join auth.users au on au.id::text = gm.user_id
--   left join (
--     select h.user_id, sum(h.malas) as total_malas, sum(h.count) as total_count, max(h.created_at) as last_completed_at
--     from public.japam_history h group by h.user_id
--   ) lifetime on lifetime.user_id = gm.user_id
--   left join (
--     select h.user_id, sum(h.malas) as today_malas, sum(h.count) as today_count
--     from public.japam_history h
--     where h.created_at >= p_today_start and h.created_at < p_today_end
--     group by h.user_id
--   ) today on today.user_id = gm.user_id
--   where gm.group_id = p_group_id;
-- end;
-- $function$;
--
-- CREATE OR REPLACE FUNCTION public.get_group_invite_code(p_group_id uuid, p_current_user_id text)
--  RETURNS TABLE(invite_code text)
--  LANGUAGE plpgsql
--  SECURITY DEFINER
--  SET search_path TO 'public'
-- AS $function$
-- begin
--   if not exists (
--     select 1 from public.group_members gm
--     where gm.group_id = p_group_id and gm.user_id = p_current_user_id and gm.role = 'admin'
--   ) then
--     raise exception 'only group admin can view invite code';
--   end if;
--   return query select g.invite_code from public.groups g where g.id = p_group_id and g.is_active = true;
-- end;
-- $function$;
--
-- CREATE OR REPLACE FUNCTION public.create_group(p_name text, p_created_by text, p_user_name text)
--  RETURNS TABLE(group_id uuid, group_name text, invite_code text)
--  LANGUAGE plpgsql
--  SECURITY DEFINER
--  SET search_path TO 'public'
-- AS $function$
-- declare
--   v_name text := btrim(p_name);
--   v_invite_code text;
--   v_group_id uuid;
--   v_attempt int := 0;
-- begin
--   if v_name is null or v_name = '' then raise exception 'group name must not be empty'; end if;
--   loop
--     v_attempt := v_attempt + 1;
--     v_invite_code := upper(substr(md5(random()::text || clock_timestamp()::text), 1, 7));
--     begin
--       insert into public.groups (name, invite_code, created_by) values (v_name, v_invite_code, p_created_by)
--       returning id into v_group_id;
--       exit;
--     exception when unique_violation then
--       if v_attempt >= 5 then raise exception 'could not generate a unique invite code, please try again'; end if;
--     end;
--   end loop;
--   insert into public.group_members (group_id, user_id, user_name, role) values (v_group_id, p_created_by, p_user_name, 'admin');
--   return query select v_group_id, v_name, v_invite_code;
-- end;
-- $function$;
--
-- CREATE OR REPLACE FUNCTION public.rename_group(p_group_id uuid, p_acting_admin_user_id text, p_new_name text)
--  RETURNS TABLE(name text)
--  LANGUAGE plpgsql
--  SECURITY DEFINER
--  SET search_path TO 'public'
-- AS $function$
-- declare
--   v_name text := btrim(p_new_name);
-- begin
--   if v_name is null or v_name = '' then raise exception 'group name must not be empty'; end if;
--   if not exists (
--     select 1 from public.groups g
--     left join public.group_members gm on gm.group_id = g.id and gm.user_id = p_acting_admin_user_id and gm.role = 'admin'
--     where g.id = p_group_id and (gm.user_id is not null or g.created_by = p_acting_admin_user_id)
--   ) then
--     raise exception 'not a group admin';
--   end if;
--   update public.groups g set name = v_name where g.id = p_group_id;
--   if not found then raise exception 'group not found'; end if;
--   return query select v_name;
-- end;
-- $function$;
--
-- CREATE OR REPLACE FUNCTION public.remove_group_member(p_group_id uuid, p_acting_admin_user_id text, p_target_user_id text)
--  RETURNS boolean
--  LANGUAGE plpgsql
--  SECURITY DEFINER
--  SET search_path TO 'public'
-- AS $function$
-- declare
--   v_target_role text;
--   v_admin_count integer;
-- begin
--   if p_acting_admin_user_id = p_target_user_id then raise exception 'cannot remove yourself; use leave group'; end if;
--   perform 1 from public.group_members gm where gm.group_id = p_group_id for update;
--   if not exists (
--     select 1 from public.groups g
--     left join public.group_members gm on gm.group_id = g.id and gm.user_id = p_acting_admin_user_id and gm.role = 'admin'
--     where g.id = p_group_id and (gm.user_id is not null or g.created_by = p_acting_admin_user_id)
--   ) then
--     raise exception 'not a group admin';
--   end if;
--   select gm.role into v_target_role from public.group_members gm where gm.group_id = p_group_id and gm.user_id = p_target_user_id;
--   if v_target_role is null then raise exception 'member not found'; end if;
--   if v_target_role = 'admin' then
--     select count(*)::integer into v_admin_count from public.group_members gm where gm.group_id = p_group_id and gm.role = 'admin';
--     if v_admin_count <= 1 then raise exception 'cannot remove last admin'; end if;
--   end if;
--   delete from public.group_members gm where gm.group_id = p_group_id and gm.user_id = p_target_user_id;
--   return true;
-- end;
-- $function$;
--
-- CREATE OR REPLACE FUNCTION public.leave_group(p_group_id uuid, p_current_user_id text)
--  RETURNS boolean
--  LANGUAGE plpgsql
--  SECURITY DEFINER
--  SET search_path TO 'public'
-- AS $function$
-- declare
--   v_current_role text;
--   v_admin_count integer;
-- begin
--   perform 1 from public.group_members gm where gm.group_id = p_group_id for update;
--   select gm.role into v_current_role from public.group_members gm where gm.group_id = p_group_id and gm.user_id = p_current_user_id;
--   if v_current_role is null then raise exception 'not a member of this group'; end if;
--   if v_current_role = 'admin' then
--     select count(*)::integer into v_admin_count from public.group_members gm where gm.group_id = p_group_id and gm.role = 'admin';
--     if v_admin_count <= 1 then raise exception 'cannot leave group as last admin'; end if;
--   end if;
--   delete from public.group_members gm where gm.group_id = p_group_id and gm.user_id = p_current_user_id;
--   return true;
-- end;
-- $function$;
--
-- CREATE OR REPLACE FUNCTION public.delete_group(p_group_id uuid, p_acting_admin_user_id text)
--  RETURNS boolean
--  LANGUAGE plpgsql
--  SECURITY DEFINER
--  SET search_path TO 'public'
-- AS $function$
-- begin
--   if not exists (
--     select 1 from public.groups g
--     left join public.group_members gm on gm.group_id = g.id and gm.user_id = p_acting_admin_user_id and gm.role = 'admin'
--     where g.id = p_group_id and (gm.user_id is not null or g.created_by = p_acting_admin_user_id)
--   ) then
--     raise exception 'not a group admin';
--   end if;
--   delete from public.groups g where g.id = p_group_id;
--   if not found then raise exception 'group not found'; end if;
--   return true;
-- end;
-- $function$;
--
-- GRANT EXECUTE ON FUNCTION public.get_my_groups(text) TO anon;
-- GRANT EXECUTE ON FUNCTION public.get_group_dashboard(uuid, text, timestamp with time zone, timestamp with time zone) TO anon;
-- GRANT EXECUTE ON FUNCTION public.get_group_invite_code(uuid, text) TO anon;
-- GRANT EXECUTE ON FUNCTION public.create_group(text, text, text) TO anon;
-- GRANT EXECUTE ON FUNCTION public.rename_group(uuid, text, text) TO anon;
-- GRANT EXECUTE ON FUNCTION public.remove_group_member(uuid, text, text) TO anon;
-- GRANT EXECUTE ON FUNCTION public.leave_group(uuid, text) TO anon;
-- GRANT EXECUTE ON FUNCTION public.delete_group(uuid, text) TO anon;
--
-- DROP FUNCTION IF EXISTS public._groups_require_caller_id();
-- DROP FUNCTION IF EXISTS public._groups_legacy_sub();
--
-- COMMIT;
