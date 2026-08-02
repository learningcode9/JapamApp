-- Groups / Family Japam — Japam workspace isolation (Issue 3).
--
-- Root cause (reproduction-backed, see the diagnosis report and
-- db/__tests__/groups_workspace_isolation.repro.local.sql): groups and group_members had no
-- workspace dimension at all, so every member's dashboard totals were summed from
-- japam_history by user_id ONLY (ignoring japam_id), and get_my_groups returned every group the
-- caller belonged to regardless of which Japam workspace was selected. Activity recorded under
-- one Japam leaked into every group's dashboard and every workspace's group list.
--
-- Authoritative design (per Issue 3 approval):
--   - group_members.japam_id  is the ONLY workspace link. Each membership maps that one member
--     to THEIR OWN selected Japam (different members' Japam UUIDs differ even for the same
--     mantra name). The creator's Japam UUID is NEVER used to filter another member's History.
--   - Dashboard aggregation per member: h.user_id = gm.user_id AND h.japam_id = gm.japam_id.
--   - memberships with japam_id IS NULL are "unassigned" (legacy, or the member's Japam was
--     permanently deleted) and contribute nothing to dashboard totals.
--   - japam_history.japam_id IS NULL legacy rows are never counted in Groups; no name-based
--     legacy attribution for Groups; never sum by user_id alone.
--   - ON DELETE SET NULL: permanently deleting a personal Japam (Issue 1) drops the workspace
--     link from the member's memberships, never the shared group or other members.
--
-- This migration is additive and idempotent: safe to run once and safe to re-run.
-- Run ONCE in the Supabase SQL editor against the intended project (LOCAL Supabase for this
-- work; staging/production only through the normal release path, never casually).
-- Every statement below is guarded (IF NOT EXISTS / CREATE OR REPLACE).

-- ─── SECTION 1: PRE-APPLY VERIFICATION (read-only) ───────────────────────────
-- Expected before applying: no group_members.japam_id column yet (0 rows).

select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name = 'group_members'
  and column_name = 'japam_id';

select count(*) as memberships
from public.group_members;


-- ─── SECTION 2: SCHEMA ───────────────────────────────────────────────────────
-- 2a. The authoritative per-membership workspace link. Nullable: null means "unassigned"
--     (legacy membership created before Japams, or the member's Japam was permanently deleted).
--     `on delete set null` is deliberate: deleting a personal Japam must NOT cascade-delete a
--     shared family group or any other member's mapping — it just unassigns that one member.
alter table public.group_members
  add column if not exists japam_id uuid references public.japams(id) on delete set null;

comment on column public.group_members.japam_id is
  'Each membership maps that one member to THEIR OWN selected Japam (workspace). NULL = unassigned (legacy membership, or the member''s Japam was permanently deleted). Dashboard totals aggregate h.user_id = gm.user_id AND h.japam_id = gm.japam_id.';

-- 2b. Indexes supporting the workspace-scoped reads: the Groups-tab list (user_id + japam_id)
--     and per-group dashboard aggregation (group_id + japam_id).
create index if not exists group_members_user_id_japam_id_idx
  on public.group_members (user_id, japam_id);

create index if not exists group_members_group_id_japam_id_idx
  on public.group_members (group_id, japam_id);

-- The existing unique (group_id, user_id) constraint is preserved untouched.


-- ─── SECTION 3: IDENTITY/BACKFILL HELPERS (internal, like the other _groups_* helpers) ───────
-- 3a. Resolve the caller's SOLE active Japam, or raise a clear error. Used by the legacy RPC
--     wrapper signatures so an old client is never silently handed cross-workspace data: bind
--     only when unambiguous (exactly one active Japam), otherwise fail with a select-Japam/
--     upgrade error.
create or replace function public._groups_sole_active_japam_id()
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller text := public._groups_require_caller_id();
  v_count  int;
  v_id     uuid;
begin
  select count(*), min(j.id::text)::uuid
    into v_count, v_id
  from public.japams j
  where j.user_id = v_caller
    and j.archived_at is null;

  if v_count = 0 then
    raise exception 'no active Japam found for your account -- select a Japam in the app and retry';
  elsif v_count > 1 then
    raise exception 'multiple active Japams found for your account -- select one Japam and retry (or update the app)';
  end if;

  return v_id;
end;
$$;

-- 3b. Conservative one-time backfill: assign japam_id only where the member owns exactly ONE
--     active Japam. Never infer from group name, from History totals, or by picking the first
--     Japam arbitrarily; members with zero or multiple active Japams stay unassigned. Idempotent
--     (only touches memberships whose japam_id is still null). Returns the report counts the
--     migration is required to surface.
create or replace function public._groups_backfill_unassigned_memberships()
returns table (backfilled bigint, ambiguous bigint, no_active_japam bigint, still_unassigned bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_backfilled bigint;
begin
  update public.group_members gm
  set japam_id = sole.japam_id
  from (
    select m.id as membership_id, min(j.id::text)::uuid as japam_id
    from public.group_members m
    join public.japams j
      on j.user_id = m.user_id
     and j.archived_at is null
    group by m.id
    having count(j.id) = 1
  ) sole
  where gm.id = sole.membership_id
    and gm.japam_id is null;

  GET DIAGNOSTICS v_backfilled = ROW_COUNT;

  return query
  with unassigned as (
    select m.id, m.user_id, count(j.id) as active_count
    from public.group_members m
    left join public.japams j
      on j.user_id = m.user_id
     and j.archived_at is null
    where m.japam_id is null
    group by m.id, m.user_id
  )
  select
    v_backfilled::bigint                                                       as backfilled,
    count(*) filter (where active_count > 1)::bigint                            as ambiguous,
    count(*) filter (where active_count = 0)::bigint                            as no_active_japam,
    (select count(*) from public.group_members where japam_id is null)::bigint  as still_unassigned
  from unassigned;
end;
$$;

-- These two helpers must stay unreachable by name from anon/authenticated/PUBLIC — they are only
-- ever called inside the SECURITY DEFINER RPCs (or by the migration/backfill itself, which runs
-- as the table owner). Same discipline as _groups_require_caller_id/_groups_legacy_sub.
revoke all on function public._groups_sole_active_japam_id() from public;
revoke all on function public._groups_sole_active_japam_id() from anon;
revoke all on function public._groups_sole_active_japam_id() from authenticated;
revoke all on function public._groups_backfill_unassigned_memberships() from public;
revoke all on function public._groups_backfill_unassigned_memberships() from anon;
revoke all on function public._groups_backfill_unassigned_memberships() from authenticated;


-- ─── SECTION 4: BACKFILL + REPORT ────────────────────────────────────────────
select 'BACKFILL REPORT' as section;
select * from public._groups_backfill_unassigned_memberships();


-- ─── SECTION 5: RPCS ─────────────────────────────────────────────────────────
-- Every RPC below is SECURITY DEFINER (runs as its owner, postgres), pins search_path to
-- public, and derives the caller's real identity from auth.uid() via _groups_require_caller_id
-- — a client-supplied p_*_user_id is never trusted as "who is calling" (the F14 discipline).

-- ── 5a. create_group (authoritative) — requires the caller's selected p_japam_id. ──
-- Atomically: verifies the Japam belongs to the caller and is active; creates the group; inserts
-- the creator's admin membership bound to that same japam_id; returns the group. Any failure
-- (including invite-code collision after retries) raises, rolling back everything in the
-- function body.
create or replace function public.create_group(
  p_name text,
  p_created_by text,
  p_user_name text,
  p_japam_id uuid
)
returns table (
  group_id     uuid,
  group_name   text,
  invite_code  text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller      text := public._groups_require_caller_id();
  v_name        text := btrim(p_name);
  v_invite_code text;
  v_group_id    uuid;
  v_attempt     int := 0;
begin
  if v_name is null or v_name = '' then
    raise exception 'group name must not be empty';
  end if;

  if p_japam_id is null then
    raise exception 'selecting a Japam is required to create a group';
  end if;

  if not exists (
    select 1
    from public.japams j
    where j.id = p_japam_id
      and j.user_id = v_caller
      and j.archived_at is null
  ) then
    raise exception 'selected Japam does not belong to your account or is not active';
  end if;

  loop
    v_attempt := v_attempt + 1;
    v_invite_code := upper(substr(md5(random()::text || clock_timestamp()::text), 1, 7));

    begin
      insert into public.groups (name, invite_code, created_by)
      values (v_name, v_invite_code, v_caller)
      returning id into v_group_id;

      exit;
    exception when unique_violation then
      if v_attempt >= 5 then
        raise exception 'could not generate a unique invite code, please try again';
      end if;
    end;
  end loop;

  insert into public.group_members (group_id, user_id, user_name, role, japam_id)
  values (v_group_id, v_caller, p_user_name, 'admin', p_japam_id);

  return query select v_group_id, v_name, v_invite_code;
end;
$$;

-- ── 5b. create_group (legacy 3-arg wrapper) — old clients keep working only when the caller
--      owns exactly ONE active Japam (bind to it); otherwise fail clearly. Never creates a new
--      membership with japam_id = null.
create or replace function public.create_group(
  p_name text,
  p_created_by text,
  p_user_name text
)
returns table (
  group_id     uuid,
  group_name   text,
  invite_code  text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_japam uuid := public._groups_sole_active_japam_id();
begin
  return query select * from public.create_group(p_name, p_created_by, p_user_name, v_japam);
end;
$$;

-- ── 5c. join_group_by_invite_code (authoritative) — joining requires the caller's selected
--      p_japam_id: authenticates via auth.uid(), validates the Japam belongs to the caller and
--      is active, creates the membership bound to that japam_id, preserves (group_id, user_id)
--      uniqueness, and never touches any other member's mapping.
create or replace function public.join_group_by_invite_code(
  p_invite_code text,
  p_user_name text,
  p_japam_id uuid
)
returns table (
  id             uuid,
  name           text,
  is_active      boolean,
  already_member boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id          text := auth.uid()::text;
  v_legacy_sub      text := public._groups_legacy_sub();
  v_group_id        uuid;
  v_group_name      text;
  v_is_active       boolean;
  v_existing_user   text;
  v_existing_japam  uuid;
begin
  if v_user_id is null then
    raise exception 'authentication required to join a group'
      using errcode = '42501';
  end if;

  if p_japam_id is null then
    raise exception 'selecting a Japam is required to join a group';
  end if;

  if not exists (
    select 1
    from public.japams j
    where j.id = p_japam_id
      and j.user_id = v_user_id
      and j.archived_at is null
  ) then
    raise exception 'selected Japam does not belong to your account or is not active';
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

  -- Resolve both the current UUID and the legacy Google-sub identity before inserting. A
  -- pre-migration row may still be stored under the latter, and must not be duplicated under the
  -- current UUID. A null legacy membership can safely be attached to this selected Japam; a row
  -- already attached to another Japam is a real workspace conflict, not a successful join.
  loop
    select gm.user_id, gm.japam_id
      into v_existing_user, v_existing_japam
    from public.group_members gm
    where gm.group_id = v_group_id
      and (gm.user_id = v_user_id or (v_legacy_sub is not null and gm.user_id = v_legacy_sub))
    order by case when gm.user_id = v_user_id then 0 else 1 end
    limit 1;

    if found then
      if v_existing_japam is null then
        update public.group_members
        set japam_id = p_japam_id
        where group_id = v_group_id
          and user_id = v_existing_user
          and japam_id is null;
        if not found then
          continue;
        end if;
      elsif v_existing_japam <> p_japam_id then
        raise exception 'already a member of this group under a different Japam';
      end if;

      return query select v_group_id, v_group_name, true, true;
      return;
    end if;

    insert into public.group_members (group_id, user_id, user_name, role, japam_id)
    values (v_group_id, v_user_id, nullif(btrim(p_user_name), ''), 'member', p_japam_id)
    on conflict (group_id, user_id) do nothing;

    if found then
      return query select v_group_id, v_group_name, true, false;
      return;
    end if;
    -- A concurrent insert won the unique constraint; re-read it through the same identity and
    -- workspace checks instead of surfacing a raw conflict or reporting a false success.
  end loop;
end;
$$;

-- ── 5d. join_group_by_invite_code (legacy 2-arg wrapper) — auto-bind only when the caller has
--      exactly one active Japam; otherwise fail clearly; never a null-scoped new membership.
create or replace function public.join_group_by_invite_code(
  p_invite_code text,
  p_user_name text
)
returns table (
  id             uuid,
  name           text,
  is_active      boolean,
  already_member boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_japam uuid := public._groups_sole_active_japam_id();
begin
  return query select * from public.join_group_by_invite_code(p_invite_code, p_user_name, v_japam);
end;
$$;

-- ── 5e. get_my_groups (authoritative) — the Groups-tab list for ONE selected workspace. The
--      filter is enforced INSIDE the RPC (never just client-side React): only the caller's own
--      memberships whose japam_id = p_japam_id are returned. The requested Japam must belong to
--      the caller and be active.
create or replace function public.get_my_groups(
  p_user_id text,
  p_japam_id uuid
)
returns table (
  group_id   uuid,
  name       text,
  role       text,
  is_active  boolean,
  joined_at  timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller    text := public._groups_require_caller_id();
  v_legacy_sub text := public._groups_legacy_sub();
begin
  if p_japam_id is null then
    raise exception 'selecting a Japam is required';
  end if;

  if not exists (
    select 1
    from public.japams j
    where j.id = p_japam_id
      and j.user_id = v_caller
      and j.archived_at is null
  ) then
    raise exception 'selected Japam does not belong to your account or is not active';
  end if;

  return query
  select g.id, g.name, gm.role, g.is_active, gm.joined_at
  from public.group_members gm
  join public.groups g on g.id = gm.group_id
  where (gm.user_id = v_caller or (v_legacy_sub is not null and gm.user_id = v_legacy_sub))
    and gm.japam_id = p_japam_id;
end;
$$;

-- ── 5f. get_my_groups (legacy 1-arg wrapper) — old clients get a workspace-scoped list only
--      when their account has exactly one active Japam; otherwise a clear error. Never returns
--      cross-workspace data.
create or replace function public.get_my_groups(p_user_id text)
returns table (
  group_id   uuid,
  name       text,
  role       text,
  is_active  boolean,
  joined_at  timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_japam uuid := public._groups_sole_active_japam_id();
begin
  return query select * from public.get_my_groups(p_user_id, v_japam);
end;
$$;

-- ── 5g. get_my_unassigned_groups — the caller's memberships with japam_id IS NULL. Shown in a
--      separate clearly labelled "Unassigned" section; never displayed as belonging to every
--      workspace and never included in any workspace's totals.
create or replace function public.get_my_unassigned_groups()
returns table (
  group_id   uuid,
  name       text,
  role       text,
  is_active  boolean,
  joined_at  timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller     text := public._groups_require_caller_id();
  v_legacy_sub text := public._groups_legacy_sub();
begin
  return query
  select g.id, g.name, gm.role, g.is_active, gm.joined_at
  from public.group_members gm
  join public.groups g on g.id = gm.group_id
  where (gm.user_id = v_caller or (v_legacy_sub is not null and gm.user_id = v_legacy_sub))
    and gm.japam_id is null;
end;
$$;

-- ── 5h. attach_group_membership_to_japam — one-time assignment of the CALLER'S OWN unassigned
--      membership to a Japam they own. Verifies caller membership in the group, verifies the
--      Japam belongs to the caller and is active, requires the current membership japam_id to be
--      null, and never modifies any other member's mapping.
create or replace function public.attach_group_membership_to_japam(
  p_group_id uuid,
  p_japam_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller     text := public._groups_require_caller_id();
  v_legacy_sub text := public._groups_legacy_sub();
begin
  if p_japam_id is null then
    raise exception 'selecting a Japam is required';
  end if;

  if not exists (
    select 1
    from public.group_members gm
    where gm.group_id = p_group_id
      and (gm.user_id = v_caller or (v_legacy_sub is not null and gm.user_id = v_legacy_sub))
  ) then
    raise exception 'not a member of this group';
  end if;

  if not exists (
    select 1
    from public.japams j
    where j.id = p_japam_id
      and j.user_id = v_caller
      and j.archived_at is null
  ) then
    raise exception 'selected Japam does not belong to your account or is not active';
  end if;

  update public.group_members gm
  set japam_id = p_japam_id
  where gm.group_id = p_group_id
    and (gm.user_id = v_caller or (v_legacy_sub is not null and gm.user_id = v_legacy_sub))
    and gm.japam_id is null;

  if not found then
    raise exception 'membership is already attached to a Japam';
  end if;

  return true;
end;
$$;

-- ── 5i. get_group_dashboard (authoritative) — aggregates each member using THAT member's own
--      membership mapping: h.user_id = gm.user_id AND h.japam_id = gm.japam_id. Ignores
--      unassigned memberships; never counts japam_history.japam_id IS NULL legacy rows; never
--      uses name-based legacy attribution; never sums by user_id alone; never uses the viewer's
--      Japam for other members. The viewer's expected p_japam_id is verified: the viewer must be
--      a member, their own membership must be attached to p_japam_id, and that Japam must belong
--      to them and be active — a mismatch rejects the request instead of returning
--      cross-workspace data. Tombstone/deleted-completion exclusions are preserved.
create or replace function public.get_group_dashboard(
  p_group_id uuid,
  p_current_user_id text,
  p_today_start timestamptz,
  p_today_end timestamptz,
  p_japam_id uuid
)
returns table (
  user_id      text,
  user_name    text,
  role         text,
  joined_at    timestamptz,
  today_malas  integer,
  today_count  integer,
  total_malas  integer,
  total_count  integer,
  last_updated timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller     text := public._groups_require_caller_id();
  v_legacy_sub text := public._groups_legacy_sub();
begin
  -- 1. The viewer must be a member of this group.
  if not exists (
    select 1
    from public.group_members gm_check
    where gm_check.group_id = p_group_id
      and (gm_check.user_id = v_caller or (v_legacy_sub is not null and gm_check.user_id = v_legacy_sub))
  ) then
    raise exception 'not a member of this group';
  end if;

  -- 2. The viewer's own membership must be attached to the requested workspace.
  if not exists (
    select 1
    from public.group_members gm_check
    where gm_check.group_id = p_group_id
      and (gm_check.user_id = v_caller or (v_legacy_sub is not null and gm_check.user_id = v_legacy_sub))
      and gm_check.japam_id = p_japam_id
  ) then
    raise exception 'selected workspace does not match this group membership';
  end if;

  -- 3. The selected workspace must belong to the viewer and be active.
  if p_japam_id is null or not exists (
    select 1
    from public.japams j
    where j.id = p_japam_id
      and j.user_id = v_caller
      and j.archived_at is null
  ) then
    raise exception 'selected Japam does not belong to your account or is not active';
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
    coalesce(today.today_malas, 0)::integer  as today_malas,
    coalesce(today.today_count, 0)::integer  as today_count,
    coalesce(lifetime.total_malas, 0)::integer  as total_malas,
    coalesce(lifetime.total_count, 0)::integer  as total_count,
    lifetime.last_completed_at                  as last_updated
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
    join public.group_members gm_mapped
      on gm_mapped.user_id = h.user_id
     and gm_mapped.japam_id = h.japam_id
     and gm_mapped.group_id = p_group_id
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
    join public.group_members gm_mapped
      on gm_mapped.user_id = h.user_id
     and gm_mapped.japam_id = h.japam_id
     and gm_mapped.group_id = p_group_id
    where h.created_at >= p_today_start
      and h.created_at < p_today_end
      and not exists (
        select 1
        from public.deleted_completions dc
        where dc.completion_id = h.completion_id
      )
    group by h.user_id
  ) today on today.user_id = gm.user_id
  where gm.group_id = p_group_id
    and gm.japam_id is not null;
end;
$$;

-- ── 5j. get_group_dashboard (legacy 4-arg wrapper) — old clients are scoped to their sole
--      active Japam only; otherwise a clear error. Never exposes a dashboard through the wrong
--      (or no) workspace context.
create or replace function public.get_group_dashboard(
  p_group_id uuid,
  p_current_user_id text,
  p_today_start timestamptz,
  p_today_end timestamptz
)
returns table (
  user_id      text,
  user_name    text,
  role         text,
  joined_at    timestamptz,
  today_malas  integer,
  today_count  integer,
  total_malas  integer,
  total_count  integer,
  last_updated timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_japam uuid := public._groups_sole_active_japam_id();
begin
  return query select * from public.get_group_dashboard(p_group_id, p_current_user_id, p_today_start, p_today_end, v_japam);
end;
$$;


-- ─── SECTION 6: GRANTS (defense in depth, mirrors the F14 hotfix) ────────────
-- anon/PUBLIC lose EXECUTE on every RPC touched by this migration; authenticated and
-- service_role keep it (the app's signed-in calls use the authenticated JWT). CREATE OR REPLACE
-- preserves an existing function's ACL, so the statements below are idempotent re-assertions.

revoke all on function public.create_group(text, text, text, uuid) from public;
revoke all on function public.create_group(text, text, text, uuid) from anon;
grant execute on function public.create_group(text, text, text, uuid) to authenticated;
grant execute on function public.create_group(text, text, text, uuid) to service_role;

revoke all on function public.create_group(text, text, text) from public;
revoke all on function public.create_group(text, text, text) from anon;
grant execute on function public.create_group(text, text, text) to authenticated;
grant execute on function public.create_group(text, text, text) to service_role;

revoke all on function public.join_group_by_invite_code(text, text, uuid) from public;
revoke all on function public.join_group_by_invite_code(text, text, uuid) from anon;
grant execute on function public.join_group_by_invite_code(text, text, uuid) to authenticated;
grant execute on function public.join_group_by_invite_code(text, text, uuid) to service_role;

revoke all on function public.join_group_by_invite_code(text, text) from public;
revoke all on function public.join_group_by_invite_code(text, text) from anon;
grant execute on function public.join_group_by_invite_code(text, text) to authenticated;
grant execute on function public.join_group_by_invite_code(text, text) to service_role;

revoke all on function public.get_my_groups(text, uuid) from public;
revoke all on function public.get_my_groups(text, uuid) from anon;
grant execute on function public.get_my_groups(text, uuid) to authenticated;
grant execute on function public.get_my_groups(text, uuid) to service_role;

revoke all on function public.get_my_groups(text) from public;
revoke all on function public.get_my_groups(text) from anon;
grant execute on function public.get_my_groups(text) to authenticated;
grant execute on function public.get_my_groups(text) to service_role;

revoke all on function public.get_my_unassigned_groups() from public;
revoke all on function public.get_my_unassigned_groups() from anon;
grant execute on function public.get_my_unassigned_groups() to authenticated;
grant execute on function public.get_my_unassigned_groups() to service_role;

revoke all on function public.attach_group_membership_to_japam(uuid, uuid) from public;
revoke all on function public.attach_group_membership_to_japam(uuid, uuid) from anon;
grant execute on function public.attach_group_membership_to_japam(uuid, uuid) to authenticated;
grant execute on function public.attach_group_membership_to_japam(uuid, uuid) to service_role;

revoke all on function public.get_group_dashboard(uuid, text, timestamptz, timestamptz, uuid) from public;
revoke all on function public.get_group_dashboard(uuid, text, timestamptz, timestamptz, uuid) from anon;
grant execute on function public.get_group_dashboard(uuid, text, timestamptz, timestamptz, uuid) to authenticated;
grant execute on function public.get_group_dashboard(uuid, text, timestamptz, timestamptz, uuid) to service_role;

revoke all on function public.get_group_dashboard(uuid, text, timestamptz, timestamptz) from public;
revoke all on function public.get_group_dashboard(uuid, text, timestamptz, timestamptz) from anon;
grant execute on function public.get_group_dashboard(uuid, text, timestamptz, timestamptz) to authenticated;
grant execute on function public.get_group_dashboard(uuid, text, timestamptz, timestamptz) to service_role;


-- ─── SECTION 7: POST-APPLY VERIFICATION (read-only) ──────────────────────────
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name = 'group_members'
  and column_name = 'japam_id';

select indexname
from pg_indexes
where schemaname = 'public'
  and tablename = 'group_members'
  and indexname in ('group_members_user_id_japam_id_idx', 'group_members_group_id_japam_id_idx')
order by indexname;

-- Expect the unique (group_id, user_id) constraint to be intact.
select conname, contype
from pg_constraint
where conrelid = 'public.group_members'::regclass
  and conname = 'group_members_group_id_user_id_key';

-- Expect exactly the 10 group RPC signatures this migration owns.
select p.proname, pg_get_function_arguments(p.oid) as args
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'create_group', 'join_group_by_invite_code', 'get_my_groups',
    'get_my_unassigned_groups', 'attach_group_membership_to_japam', 'get_group_dashboard'
  )
order by p.proname, pg_get_function_arguments(p.oid);


-- ─── SECTION 8: ROLLBACK (run only if this migration must be undone) ─────────
-- Effect: drops the new column (which drops its two indexes), the new RPC overloads, the two
-- helpers, and restores the ORIGINAL function bodies of the four pre-existing RPCs. Because the
-- original create_group/join_group_by_invite_code/get_my_groups/get_group_dashboard bodies live
-- in db/groups_migration.sql and db/rls_hotfix_groups_rpc_auth.sql, re-running those files'
-- APPLY sections is the supported way back; the inline rollback below only removes what this
-- migration added.

-- alter table public.group_members drop column if exists japam_id;
-- drop function if exists public.get_group_dashboard(uuid, text, timestamptz, timestamptz, uuid);
-- drop function if exists public.get_my_groups(text, uuid);
-- drop function if exists public.join_group_by_invite_code(text, text, uuid);
-- drop function if exists public.create_group(text, text, text, uuid);
-- drop function if exists public.attach_group_membership_to_japam(uuid, uuid);
-- drop function if exists public.get_my_unassigned_groups();
-- drop function if exists public._groups_sole_active_japam_id();
-- drop function if exists public._groups_backfill_unassigned_memberships();
