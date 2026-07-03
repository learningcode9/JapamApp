-- Groups / Family Japam — Phase D1 (database layer only).
-- Run ONCE in the Supabase SQL editor. NOT YET RUN as of writing this file — creating the file
-- is Phase D1; executing it against the live project is a separate, later, explicitly-authorized
-- step.
--
-- Scope: this migration adds ONLY the `groups` and `group_members` tables. It does not modify
-- japam_history, japam_timer_state, user_profiles, japam_user_totals, or deleted_completions in
-- any way.
--
-- Why group_members.user_id is `text`, with no UUID-shape validation:
-- Live data inspected directly from this project (read-only queries, not assumptions) shows
-- japam_history/japam_user_totals already contain a mix of Google numeric account IDs (e.g.
-- "115479536751828543797"), Supabase anonymous-auth UUIDs (e.g. "58b4c1e5-2f8a-4bf7-911a-..."),
-- and synthetic test ids (e.g. "test-user"); user_profiles additionally contains rows keyed by
-- email address instead of either format. group_members.user_id must accept whichever of these
-- the joining user currently has, as an opaque identifier — never validated or cast.

create extension if not exists pgcrypto;

-- 1) groups: one row per Family Japam group.
create table if not exists public.groups (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  invite_code   text not null unique,
  created_by    text not null,
  created_at    timestamptz not null default now(),
  is_active     boolean not null default true
);

-- No separate index on invite_code: the `unique` constraint above already creates one
-- automatically (PostgreSQL always backs a unique constraint with a unique btree index), so a
-- dedicated `create index ... (invite_code)` would just duplicate it for no benefit.

-- 2) group_members: membership rows.
-- user_name is denormalized at join time — deliberately NOT joined from user_profiles, since
-- that table's user_id column is confirmed inconsistent in live data (some rows store an email
-- instead of the id format used everywhere else). Denormalizing avoids depending on a join that
-- is known not to reliably resolve to a display name.
create table if not exists public.group_members (
  id            uuid primary key default gen_random_uuid(),
  group_id      uuid not null references public.groups(id) on delete cascade,
  user_id       text not null,
  user_name     text,
  role          text not null default 'member' check (role in ('admin', 'member')),
  joined_at     timestamptz not null default now(),
  unique (group_id, user_id)
);

-- No separate index on group_id alone: the composite `unique(group_id, user_id)` constraint
-- above already creates an index physically ordered by (group_id, user_id), and PostgreSQL can
-- use that index's leading column for a plain `where group_id = ...` query without needing a
-- dedicated single-column index. (user_id alone, below, is the trailing column of that composite
-- index and can't be served efficiently by it, so it still needs its own index.)
create index if not exists group_members_user_id_idx on public.group_members (user_id);

-- 3) RLS — revised TWICE now after explicit review.
--
-- Round 1 (see GUEST_TO_ANON_AUTH_MIGRATION.md and the first Phase D1 RLS review): replaced a
-- single blanket `for all using(true)` policy per table with separate per-action policies,
-- closing the admin-self-promotion hole on `group_members` INSERT via the created_by-matching
-- check below, and granting no UPDATE/DELETE to anon at all (deferred to RPCs — see below).
--
-- Round 2 (this revision): the per-action policies from Round 1 still included a blanket
-- `for select using(true)` on BOTH tables. That was found, on closer review, to be just as
-- significant a problem as the INSERT escalation Round 1 fixed: `using(true)` on SELECT doesn't
-- just let a client check "does this one invite code exist" — it lets ANY anon-key holder run
-- an unfiltered `select *` and bulk-enumerate every group, every invite code, and every
-- member's name/role across every Family Japam group in the app at once. An invite code that
-- can be harvested in bulk without ever being shared by a real member isn't really an invite
-- code. This revision removes both blanket SELECT policies entirely (no anon SELECT policy on
-- either table — denied by default under RLS, same as UPDATE/DELETE already are) and replaces
-- the read paths the app actually needs with three SECURITY DEFINER functions that each return
-- only the minimum a legitimate caller needs, never a full table scan:
--   - find_group_by_invite_code(invite_code): returns id/name/is_active for ONE matching group,
--     never created_by (a raw user_id) and never the full row. Needed for the Join Group flow.
--   - get_my_groups(current_user_id): returns only the groups that current_user_id is actually
--     a member of. Needed for a "your groups" list.
--   - get_group_dashboard(group_id, current_user_id, today_start, today_end): FIRST checks that
--     current_user_id is a member of group_id and raises an exception if not — only then
--     returns that group's roster, today's malas/count (summed from japam_history within the
--     caller-supplied [today_start, today_end) range), and lifetime totals (from
--     japam_user_totals). The day boundary is a parameter, not computed in SQL, because the
--     database has no way to know the viewing device's timezone — today_start/today_end must be
--     derived client-side the same way every other screen already determines "today" via
--     lib/historyStore.ts's toLocalDayKey/todayStatsFor, so the dashboard's definition of
--     "today" never diverges from what a member sees on their own device. (See the Group
--     Dashboard daily-stats design review: a server-maintained daily counter was considered and
--     rejected, since any server-side day boundary would disagree with this app's
--     local-device-day "today" near midnight for members outside that boundary's timezone.)
--
-- Round 3 (this revision): Create Group was originally implemented as two separate client-side
-- INSERTs — one into `groups`, then one into `group_members` with role='admin' — relying on the
-- `anon insert group_members` policy's created_by-matching check from Round 1 to allow the
-- second insert. That has a real atomicity problem: if the first insert succeeds and the second
-- fails (network drop, app backgrounded mid-request, etc.), the result is a permanently orphaned
-- group with no admin and no member, since nothing in this schema can clean that up — there is
-- no DELETE policy on `groups`, and the client has no way to know the failure was partial rather
-- than total. This revision replaces both client-side inserts with a single `create_group`
-- SECURITY DEFINER function that performs both inserts as one PL/pgSQL function body. A single
-- function invocation runs inside one implicit transaction: if anything inside it raises (e.g.
-- the second insert failing), PostgreSQL rolls back everything the function did, including the
-- first insert — so there is no longer a way to end up with a `groups` row and no matching admin
-- `group_members` row. Invite code generation also moves server-side (inside this function),
-- with a bounded retry loop on a rare unique-constraint collision.
--
-- Because `create_group` is now the ONLY path that ever creates a `groups` row or an admin
-- `group_members` row, and it runs as SECURITY DEFINER (bypassing RLS entirely for its own
-- inserts), two policies from Round 1 are no longer needed and have been removed/tightened:
--   - `anon insert groups` is REMOVED entirely — there is no remaining legitimate reason for a
--     client to INSERT into `groups` directly; doing so would just bypass create_group's
--     validation and atomicity guarantees.
--   - `anon insert group_members` is TIGHTENED to allow only `role = 'member'` — the
--     previous `role = 'admin' and exists(...)` branch existed solely to support the old
--     two-insert Create Group flow, which no longer exists. Removing it closes even the
--     narrower self-promotion path Round 1 left in place, since there is now no legitimate
--     reason for ANY direct client INSERT to ever claim role='admin'.
--
-- Join Group is unaffected and was reviewed for the same class of risk: it is a single INSERT
-- (after a read-only find_group_by_invite_code call), not a two-step write, so there is no
-- analogous orphan/partial-failure state for it to land in. It keeps using direct INSERT via the
-- (now member-only) `anon insert group_members` policy.
--
-- IMPORTANT LIMITATION, restated and still true after this revision: every `current_user_id` /
-- `p_current_user_id` parameter below is still a plain client-supplied string, NOT a verified
-- Supabase Auth session — auth.uid() is not used anywhere in this project yet (see
-- GUEST_TO_ANON_AUTH_MIGRATION.md for the parked migration that would introduce it). These
-- functions enforce that the request is internally consistent (e.g. "the user_id calling
-- get_group_dashboard is actually recorded as a member of this group_id"), NOT that the caller
-- cryptographically is who they claim to be. A sufficiently motivated attacker who already
-- knows or guesses another real user's user_id can still pass it as their own and read that
-- user's group membership/dashboard data. Closing that fully requires auth.uid()-based RLS,
-- which depends on the paused Anonymous Auth migration landing — not something achievable at
-- the database layer alone today.
--
-- Deferred, not forgotten (unchanged from Round 1): Rename Group, Regenerate Invite Code, Remove
-- Member, and Leave Group all require a write that only that group's admin (or, for Leave, only
-- that member themself) should be able to perform. These remain planned as SECURITY DEFINER RPC
-- functions for whenever they're actually built, with no direct table UPDATE/DELETE grant to
-- anon — not added in this migration since no UI for them exists yet.
alter table public.groups enable row level security;
alter table public.group_members enable row level security;

drop policy if exists "anon manage groups" on public.groups;
drop policy if exists "anon manage group_members" on public.group_members;
drop policy if exists "anon select groups" on public.groups;
drop policy if exists "anon select group_members" on public.group_members;
drop policy if exists "anon insert groups" on public.groups;

-- No anon INSERT policy on `groups` at all (see Round 3 above): the only legitimate way to
-- create a group is the create_group() function below, which writes as SECURITY DEFINER and is
-- therefore not subject to — and does not need — a table-level INSERT grant.

create policy "anon insert group_members"
  on public.group_members
  for insert
  to anon
  with check (role = 'member');
  -- Member-only, per Round 3: admin-row creation now exclusively happens inside create_group(),
  -- which bypasses this policy entirely (SECURITY DEFINER). There is no longer any legitimate
  -- direct-insert path for role='admin', so it is no longer permitted by this check at all.

-- 4) Write/Read-access RPCs. Each is SECURITY DEFINER (runs with the function owner's
-- privileges, not the caller's), with `search_path` pinned to `public` to avoid
-- search_path-hijacking attacks on SECURITY DEFINER functions, and EXECUTE explicitly revoked
-- from PUBLIC and granted only to `anon` (matching this app's existing anon-key REST model).

-- create_group: the sole path for creating a group (see Round 3 above for why this replaced two
-- separate client-side inserts). Validates a non-empty name, generates a unique invite code
-- server-side with a bounded retry loop, inserts the group, then inserts the creator as its
-- admin — all inside one function invocation, so a failure partway rolls back everything the
-- function did, leaving no orphaned group and no orphaned membership row.
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
    -- Random 7-character uppercase alphanumeric code. Collisions are expected to be rare given
    -- the keyspace, but are handled explicitly rather than assumed away.
    v_invite_code := upper(substr(md5(random()::text || clock_timestamp()::text), 1, 7));

    begin
      insert into public.groups (name, invite_code, created_by)
      values (v_name, v_invite_code, p_created_by)
      returning id into v_group_id;

      exit; -- insert succeeded, stop retrying
    exception when unique_violation then
      if v_attempt >= 5 then
        raise exception 'could not generate a unique invite code, please try again';
      end if;
      -- otherwise loop and try a new code
    end;
  end loop;

  insert into public.group_members (group_id, user_id, user_name, role)
  values (v_group_id, p_created_by, p_user_name, 'admin');

  return query select v_group_id, v_name, v_invite_code;
end;
$$;

revoke all on function public.create_group(text, text, text) from public;
grant execute on function public.create_group(text, text, text) to anon;

create or replace function public.find_group_by_invite_code(p_invite_code text)
returns table (id uuid, name text, is_active boolean)
language sql
security definer
set search_path = public
as $$
  select g.id, g.name, g.is_active
  from public.groups g
  where g.invite_code = p_invite_code;
$$;

revoke all on function public.find_group_by_invite_code(text) from public;
grant execute on function public.find_group_by_invite_code(text) to anon;

create or replace function public.get_my_groups(p_user_id text)
returns table (
  group_id   uuid,
  name       text,
  role       text,
  is_active  boolean,
  joined_at  timestamptz
)
language sql
security definer
set search_path = public
as $$
  select g.id, g.name, gm.role, g.is_active, gm.joined_at
  from public.group_members gm
  join public.groups g on g.id = gm.group_id
  where gm.user_id = p_user_id;
$$;

revoke all on function public.get_my_groups(text) from public;
grant execute on function public.get_my_groups(text) to anon;

-- Performance note (not yet acted on — see the "future index" comment further below): this
-- function's today-stats join filters japam_history by user_id + a created_at range. An index
-- on japam_history(user_id, created_at) would let that filter use an index range scan instead
-- of a broader scan per member. Not added in this migration — japam_history is an existing,
-- actively-written table outside this migration's scope, and this is the first concrete
-- consumer that would benefit from such an index, which is a reason to consider it later, not a
-- justification to add it here unreviewed.
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
begin
  -- Membership gate: only an actual member of this group may read its roster/stats.
  -- Table-qualified with an alias (gm_check) because this function's RETURNS TABLE defines an
  -- output column also named user_id; PL/pgSQL exposes RETURNS TABLE columns as implicit
  -- variables inside the function body, so an unqualified `user_id` here is genuinely ambiguous
  -- between that variable and group_members.user_id (confirmed live: PostgreSQL error 42702,
  -- "column reference \"user_id\" is ambiguous", caught during QA verification after the first
  -- version of this migration was run). group_id is qualified too for the same reason/clarity,
  -- even though it isn't itself one of the output columns.
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
    coalesce(today.today_malas, 0)::integer  as today_malas,
    coalesce(today.today_count, 0)::integer  as today_count,
    coalesce(t.malas, 0)::integer             as total_malas,
    coalesce(t.total_count, 0)::integer       as total_count,
    t.updated_at                               as last_updated
  from public.group_members gm
  left join public.japam_user_totals t on t.user_id = gm.user_id
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
$$;

-- Future index recommendation (NOT added by this migration — see the performance note above
-- the function): once this RPC is in real use, consider:
--   create index if not exists japam_history_user_id_created_at_idx
--     on public.japam_history (user_id, created_at);
-- Deferred deliberately: japam_history is an existing, actively-written table that this
-- migration otherwise never touches, and adding an index to it deserves its own reviewed,
-- separate migration rather than being bundled into the Groups schema as an afterthought.

revoke all on function public.get_group_dashboard(uuid, text, timestamptz, timestamptz) from public;
grant execute on function public.get_group_dashboard(uuid, text, timestamptz, timestamptz) to anon;
