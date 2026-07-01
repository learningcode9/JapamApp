-- Make get_group_dashboard tombstone-aware, so it can never overstate totals relative to the
-- History screen, even if a future delete's remote step is delayed (offline window) or a zombie
-- row is ever reintroduced.
--
-- STATUS: already applied directly in the Supabase SQL Editor and validated. This file exists so
-- the change is captured in source control and reproducible — it does not need to be re-run.
-- Re-running is safe regardless (CREATE OR REPLACE, idempotent), but not required.
--
-- Why this was needed:
-- Both the "today" and "lifetime total" subqueries in get_group_dashboard summed directly from
-- japam_history with no awareness of deleted_completions (the tombstone table). The History
-- screen, by contrast, always filters tombstoned completion_ids client-side before summing. Any
-- row that was tombstoned but not yet physically deleted from japam_history (a "zombie" row —
-- see db/cleanup_zombie_history_rows.sql and db/atomic_delete_history_rpc.sql for the root cause
-- and permanent fix for how those were created) was silently included in the dashboard's totals
-- but correctly excluded from History's, causing the two screens to disagree for the same user.
--
-- The live function signature was confirmed via:
--   select pg_get_functiondef('public.get_group_dashboard(uuid, text, timestamptz, timestamptz)'::regprocedure);
-- before writing this fix, since the on-disk db/groups_migration.sql was already stale relative
-- to production (that file's version reads total_malas/total_count from a join to
-- japam_user_totals; the live version instead sums japam_history directly — this file's fix
-- targets the confirmed live version, not the stale file's).
--
-- Scope: this file only replaces get_group_dashboard's body to add a NOT EXISTS filter against
-- deleted_completions in both subqueries. No schema changes, no other function bodies touched,
-- no data changes.


-- ─── PRE-VERIFICATION (read-only, confirms today's state before the fix) ────────────────────
--
-- Since all known zombie rows were already cleaned up (db/cleanup_zombie_history_rows.sql), these
-- two should return identical values today — proving the fix changes nothing right now and is
-- purely preventive for any future zombie.

select
  h.user_id,
  sum(h.malas) as current_total_malas,
  sum(h.count) as current_total_count
from public.japam_history h
where h.user_id = '2793fca2-38fa-4c9e-9856-26c2b34d0acb'
group by h.user_id;

select
  h.user_id,
  sum(h.malas) as tombstone_aware_total_malas,
  sum(h.count) as tombstone_aware_total_count
from public.japam_history h
where h.user_id = '2793fca2-38fa-4c9e-9856-26c2b34d0acb'
  and not exists (
    select 1 from public.deleted_completions dc where dc.completion_id = h.completion_id
  )
group by h.user_id;

-- Expected (at time of writing): both return total_malas=31, total_count=3348 for bsravani89
-- (reflects real data at the time this was validated, including an intentional test deletion
-- made during atomic-delete-RPC validation — not itself a bug).


-- ─── THE FIX (already applied; CREATE OR REPLACE is idempotent if re-run) ───────────────────

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
    gm.user_name,
    gm.role,
    gm.joined_at,
    coalesce(today.today_malas, 0)::integer    as today_malas,
    coalesce(today.today_count, 0)::integer    as today_count,
    coalesce(lifetime.total_malas, 0)::integer as total_malas,
    coalesce(lifetime.total_count, 0)::integer as total_count,
    lifetime.last_completed_at                 as last_updated
  from public.group_members gm
  left join (
    select
      h.user_id,
      sum(h.malas)      as total_malas,
      sum(h.count)      as total_count,
      max(h.created_at) as last_completed_at
    from public.japam_history h
    where not exists (
      select 1
      from public.deleted_completions dc
      where dc.completion_id = h.completion_id
    )
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
      and not exists (
        select 1
        from public.deleted_completions dc
        where dc.completion_id = h.completion_id
      )
    group by h.user_id
  ) today on today.user_id = gm.user_id
  where gm.group_id = p_group_id;
end;
$function$;


-- ─── POST-VERIFICATION (confirms the fix took effect and introduced no regression) ──────────

-- Confirm the replacement actually happened.
select pg_get_functiondef('public.get_group_dashboard(uuid, text, timestamptz, timestamptz)'::regprocedure)
  like '%deleted_completions%' as has_tombstone_exclusion;
-- Expected: true

-- Re-call the function directly (any valid today-window works — only total_malas/total_count are
-- asserted here; today_malas/today_count depend on the caller's local-day boundary and should be
-- verified via the app UI instead of a hardcoded UTC window — see docs/RELEASE_DATA_INTEGRITY_V1.md).
select user_id, total_malas, total_count
from public.get_group_dashboard(
  '66e69ad4-ce76-4af7-bbae-b0453389e508'::uuid,
  '2793fca2-38fa-4c9e-9856-26c2b34d0acb',
  now(), now()
)
where user_id = '2793fca2-38fa-4c9e-9856-26c2b34d0acb';
-- Expected: total_malas and total_count unchanged from pre-verification (no regression for a
-- real member with no zombie rows).

-- ─── ACTUAL VALIDATION RESULT (recorded here for reference) ─────────────────────────────────
--
-- has_tombstone_exclusion: true
-- get_group_dashboard total_malas/total_count for bsravani89: 31 / 3348
-- Raw japam_history sum (tombstone-excluded) for bsravani89: 31 / 3348 — exact match
-- App UI: History screen total = 31/3348, Groups Dashboard total (Sravani row) = 31/3348 — exact
-- match, confirmed on-device via the real app, not just direct RPC calls
-- No RPC/permission/"not a member" errors observed in logcat during validation
