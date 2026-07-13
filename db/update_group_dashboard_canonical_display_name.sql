-- Groups dashboard canonical display-name migration.
--
-- TARGET: staging project nhacglvxdypevrbvvkhn only.
-- PRODUCTION WARNING: Do not execute this file in production without a separate approval and a
-- fresh live-function fingerprint capture from the production project.
--
-- This file was derived from the complete live staging function captured on 2026-07-12:
-- public.get_group_dashboard(uuid, text, timestamptz, timestamptz)
-- md5(pg_get_functiondef(...)) = db73738e4181cd13edf70abec2a14ca6
--
-- The CREATE OR REPLACE body intentionally differs from that live function in only two places:
--   1. gm.user_name -> coalesce(udp.display_name, gm.user_name, 'Unknown') as user_name
--   2. one LEFT JOIN public.user_display_profiles udp ON udp.user_id::text = gm.user_id
--
-- No group_members row, profile row, history row, policy, grant, role, totals query, membership
-- authorization, SECURITY DEFINER attribute, search_path, function signature, or UI code changes.

-- =============================================================================
-- SECTION 1 — READ-ONLY PRECHECK
-- =============================================================================

select
  p.oid::regprocedure as function_signature,
  pg_get_userbyid(p.proowner) as owner,
  p.prosecdef as security_definer,
  p.proconfig as function_config,
  md5(pg_get_functiondef(p.oid)) as live_fingerprint,
  pg_get_function_result(p.oid) as return_type
from pg_proc p
where p.oid = 'public.get_group_dashboard(uuid, text, timestamptz, timestamptz)'::regprocedure;

select to_regclass('public.user_display_profiles') as canonical_profile_table;

-- =============================================================================
-- SECTION 2 — GUARDED STAGING APPLY (DDL only; changes no table rows)
-- =============================================================================

begin;

do $preflight$
declare
  current_fingerprint text;
  current_owner text;
  current_security_definer boolean;
  current_config text[];
begin
  if to_regclass('public.user_display_profiles') is null then
    raise exception 'user_display_profiles is required before this display-name migration';
  end if;

  select
    md5(pg_get_functiondef(p.oid)),
    pg_get_userbyid(p.proowner),
    p.prosecdef,
    p.proconfig
  into current_fingerprint, current_owner, current_security_definer, current_config
  from pg_proc p
  where p.oid = 'public.get_group_dashboard(uuid, text, timestamptz, timestamptz)'::regprocedure;

  if current_fingerprint is distinct from 'db73738e4181cd13edf70abec2a14ca6' then
    raise exception 'get_group_dashboard fingerprint changed (%); stop and recapture live source', current_fingerprint;
  end if;

  if current_owner is distinct from 'postgres'
    or current_security_definer is not true
    or current_config is distinct from array['search_path=public'] then
    raise exception 'get_group_dashboard security metadata differs from captured live staging function';
  end if;
end;
$preflight$;

create or replace function public.get_group_dashboard(
  p_group_id uuid,
  p_current_user_id text,
  p_today_start timestamp with time zone,
  p_today_end timestamp with time zone
)
returns table(
  user_id text,
  user_name text,
  role text,
  joined_at timestamp with time zone,
  today_malas integer,
  today_count integer,
  total_malas integer,
  total_count integer,
  last_updated timestamp with time zone
)
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  -- Only a member of this group can read its dashboard.
  if not exists (
    select 1
    from public.group_members gm_check
    where gm_check.group_id = p_group_id
      and gm_check.user_id = p_current_user_id
  ) then
    raise exception 'not a member of this group';
  end if;

  return query
  select
    gm.user_id,
    coalesce(udp.display_name, gm.user_name, 'Unknown') as user_name,
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

-- Fail closed before COMMIT if the exact function contract is not present.
do $postcheck$
declare
  body text;
  owner_name text;
  security_definer boolean;
  function_config text[];
begin
  select pg_get_functiondef(p.oid), pg_get_userbyid(p.proowner), p.prosecdef, p.proconfig
  into body, owner_name, security_definer, function_config
  from pg_proc p
  where p.oid = 'public.get_group_dashboard(uuid, text, timestamptz, timestamptz)'::regprocedure;

  if owner_name is distinct from 'postgres'
    or security_definer is not true
    or function_config is distinct from array['search_path=public']
    or body not like '%coalesce(udp.display_name, gm.user_name, ''Unknown'') as user_name%'
    or body not like '%left join public.user_display_profiles udp%'
    or body not like '%on udp.user_id::text = gm.user_id%'
    or body not like '%not a member of this group%'
    or body not like '%sum(h.malas) as total_malas%'
    or body not like '%sum(h.count) as total_count%'
    or body not like '%max(h.created_at) as last_completed_at%'
    or body like '%deleted_completions%'
  then
    raise exception 'get_group_dashboard postcheck failed; transaction will roll back';
  end if;
end;
$postcheck$;

commit;

-- =============================================================================
-- SECTION 3 — POST-APPLY READ-ONLY VERIFICATION
-- =============================================================================
-- Verify, with a staging member/group pair, that a canonical profile name overrides the member
-- snapshot while role, row count, and today/lifetime totals are unchanged. Also verify a member
-- with no canonical profile continues to receive its group_members.user_name snapshot.

select
  p.oid::regprocedure as function_signature,
  pg_get_userbyid(p.proowner) as owner,
  p.prosecdef as security_definer,
  p.proconfig as function_config,
  pg_get_functiondef(p.oid) like '%coalesce(udp.display_name, gm.user_name, ''Unknown'') as user_name%'
    as canonical_name_expression_present,
  pg_get_functiondef(p.oid) like '%on udp.user_id::text = gm.user_id%'
    as safe_profile_join_present
from pg_proc p
where p.oid = 'public.get_group_dashboard(uuid, text, timestamptz, timestamptz)'::regprocedure;

-- =============================================================================
-- SECTION 4 — ROLLBACK (DO NOT RUN unless staging validation fails)
-- =============================================================================
-- Restore the exact captured live staging body. This is DDL-only and does not change rows.
-- Run the commented transaction separately, then repeat Section 3 verification.
--
-- begin;
-- create or replace function public.get_group_dashboard(
--   p_group_id uuid,
--   p_current_user_id text,
--   p_today_start timestamp with time zone,
--   p_today_end timestamp with time zone
-- )
-- returns table(
--   user_id text, user_name text, role text, joined_at timestamp with time zone,
--   today_malas integer, today_count integer, total_malas integer, total_count integer,
--   last_updated timestamp with time zone
-- )
-- language plpgsql security definer set search_path to 'public'
-- as $rollback$
-- begin
--   if not exists (
--     select 1 from public.group_members gm_check
--     where gm_check.group_id = p_group_id and gm_check.user_id = p_current_user_id
--   ) then
--     raise exception 'not a member of this group';
--   end if;
--
--   return query
--   select
--     gm.user_id,
--     gm.user_name,
--     gm.role,
--     gm.joined_at,
--     coalesce(today.today_malas, 0)::integer as today_malas,
--     coalesce(today.today_count, 0)::integer as today_count,
--     coalesce(lifetime.total_malas, 0)::integer as total_malas,
--     coalesce(lifetime.total_count, 0)::integer as total_count,
--     lifetime.last_completed_at as last_updated
--   from public.group_members gm
--   left join (
--     select
--       h.user_id,
--       sum(h.malas) as total_malas,
--       sum(h.count) as total_count,
--       max(h.created_at) as last_completed_at
--     from public.japam_history h
--     group by h.user_id
--   ) lifetime on lifetime.user_id = gm.user_id
--   left join (
--     select
--       h.user_id,
--       sum(h.malas) as today_malas,
--       sum(h.count) as today_count
--     from public.japam_history h
--     where h.created_at >= p_today_start
--       and h.created_at < p_today_end
--     group by h.user_id
--   ) today on today.user_id = gm.user_id
--   where gm.group_id = p_group_id;
-- end;
-- $rollback$;
-- commit;
