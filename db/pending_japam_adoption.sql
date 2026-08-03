-- =============================================================================
-- STAGING-ONLY DEPLOYMENT — Pending Japam Selection Adoption marker.
-- =============================================================================
--
-- Purpose:
--   When `restore_owned_japam` restores a Japam server-side outside the client
--   restore flow (e.g. a migration / admin tool / backfill), the client's
--   persisted `currentJapamId:<uid>` AsyncStorage pointer may still reference a
--   different, unrelated active workspace (e.g. PR55) from before the canonical
--   "My Japam" was archived. On refresh the client would otherwise keep that
--   stale pointer indefinitely — the green check stays on the wrong workspace,
--   and every `get_my_groups` / `get_group_dashboard` call (scoped via
--   `group_members.japam_id = <current>`) hides every Group scoped to the
--   restored Japam.
--
--   This file deploys an explicit, server-side adoption mechanism using a
--   DURABLE marker + two-phase peek + acknowledge:
--     1. A `pending_japam_adoption` table that `restore_owned_japam` writes a
--        marker into IN THE SAME TRANSACTION as the restore itself.
--     2. A `get_pending_japam_adoption(p_user_id text)` SECURITY DEFINER RPC the
--        client calls on `CurrentJapamProvider` refresh. Returns the caller's
--        oldest marker (id + japam_id) WITHOUT deleting it.
--     3. An `acknowledge_pending_japam_adoption(p_user_id, p_marker_id)`
--        SECURITY DEFINER RPC the client calls ONLY AFTER successfully
--        persisting the adopted japam_id as `currentJapamId:<uid>`. Validates
--        the caller against `p_user_id`, then removes that specific marker.
--
--   Client contract (lib/japamsRepository.ts#ensureDefaultJapamInternal):
--     1. PEEK the pending marker via `get_pending_japam_adoption`.
--     2. Verify the returned japam_id is in the merged active Japam list.
--     3. Persist that japam_id as `currentJapamId:<uid>`.
--     4. Only then ACKNOWLEDGE / delete the marker via
--        `acknowledge_pending_japam_adoption(p_user_id, marker_id)`.
--     5. If ANY step 1-4 fails, the marker is LEFT server-side for the next
--        refresh to retry the same exact sequence. The persisted pointer becomes
--        the source of truth only after adoption completes durably.
--
--   Why peek + ack instead of consume-and-delete:
--     A consume-and-delete RPC deletes the marker at peek time, so any client
--     crash or persist failure between peek and persistence silently abandons
--     the adoption — the user stays on the wrong workspace forever and a fresh
--     restore would be required. The two-phase model keeps the marker alive
--     until persistence is durably committed; the retry loop converges from
--     any failure point, including the brief window between persist and ack.
--
--   The adoption ID is NEVER inferred from History rows, group counts, names,
--   or display order — it comes exclusively from the marker written by
--   `restore_owned_japam` (or the staging-only backfill).
--
-- Deployment order (STAGING ONLY):
--   1. db/get_owned_japam_usage_rpc.sql                      (already on staging)
--   2. db/pending_japam_adoption.sql                         (THIS FILE)
--   3. db/restore_owned_japam_rpc.sql                        (updated to insert marker)
--   4. db/backfill_pending_japam_adoption_staging.sql        (one-off backfill)
--   5. web/client deploy (lib/japamsRepository.ts peek+ack)
--
-- Never run on production without an explicit release management step. This
-- file is intentionally idempotent: each statement uses IF NOT EXISTS / OR
-- REPLACE so re-running it is safe. Teardown (drop table + drop functions) is
-- only needed if the feature is being rolled back.
-- =============================================================================

-- 1. Marker table. (user_id, japam_id) UNIQUE so a repeated restore for the
--    same Japam never produces duplicate markers; the client adopts one and the
--    constraint keeps the row count bounded. id is the per-row handle the
--    acknowledge RPC deletes by — it is opaque to the client.
create table if not exists public.pending_japam_adoption (
  id          uuid        primary key default gen_random_uuid(),
  user_id     text        not null,
  japam_id    uuid        not null,
  created_at  timestamptz not null default now(),
  constraint pending_japam_adoption_user_japam_key unique (user_id, japam_id)
);

alter table public.pending_japam_adoption enable row level security;

-- A user can SELECT only their own markers. (All writes happen inside the
-- SECURITY DEFINER `restore_owned_japam`, `get_pending_japam_adoption`, and
-- `acknowledge_pending_japam_adoption` functions, which bypass RLS; no
-- INSERT/UPDATE/DELETE policy is needed for the client.)
drop policy if exists pending_japam_adoption_select_own on public.pending_japam_adoption;
create policy pending_japam_adoption_select_own
  on public.pending_japam_adoption
  for select
  to authenticated
  using (
    user_id = auth.uid()::text
    or user_id = (auth.jwt()->'user_metadata'->>'sub')
  );

-- Drop the legacy consume function if a previous staging deployment created it.
-- The peek+ack model replaces it; failing to drop would leave a now-quirky RPC
-- on the public schema.
drop function if exists public.consume_pending_japam_adoption(text);

-- 2. Peek RPC. Validates the authenticated caller, then queries EXACTLY the
--    caller's own pending marker keyed by `p_user_id`. Returns the OLDEST
--    matching marker (id + japam_id) WITHOUT deleting it. The client peeks,
--    verifies the target Japam is present in its merged active list, persists
--    the target as currentJapamId, and ONLY THEN calls
--    `acknowledge_pending_japam_adoption(p_user_id, marker_id)` to delete the
--    marker. SELECT ... FOR UPDATE locks the chosen row so a concurrent
--    `acknowledge_pending_japam_adoption` call serializes against this peek; we
--    deliberately do NOT delete here so the marker survives any client failure
--    between peek and a durable persist + ack. Returns zero rows when the
--    caller has no pending marker.
--
--    Identity contract: the marker is keyed by the restored Japam's actual
--    user_id (see restore_owned_japam_rpc.sql), which is the value the client
--    stores as its userId (the AsyncStorage `currentJapamId:<uid>` key). The
--    client passes that SAME stored userId as `p_user_id`. `p_user_id` must
--    resolve to one of the authenticated caller's identities — `auth.uid()`
--    (`sub`) or the legacy stored `user_metadata.sub` — otherwise the call is
--    rejected. The query then filters on `user_id = p_user_id` EXACTLY, so a
--    marker written under a legacy userId is found even when auth.uid() is a
--    different UUID.
--
--    Column qualification + local variables (v_marker_id, v_japam_id) are
--    required because the function's OUT columns are named `marker_id` and
--    `japam_id`: an unqualified `select id, japam_id into marker_id, japam_id`
--    inside a `returns table(...)` function is ambiguous in PL/pgSQL.
create or replace function public.get_pending_japam_adoption(
  p_user_id text
)
returns table (
  marker_id uuid,
  japam_id uuid
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid             text;
  v_legacy_uid      text;
  v_marker_id       uuid;
  v_japam_id        uuid;
begin
  v_uid := auth.uid()::text;
  v_legacy_uid := auth.jwt()->'user_metadata'->>'sub';

  if v_uid is null and v_legacy_uid is null then
    raise exception 'authentication required';
  end if;

  -- Validate the caller first: p_user_id must be the authenticated caller's own
  -- id (auth.uid() sub or the legacy stored sub). Reject any other value — a
  -- stale client pointer claiming another user's id must not leak markers.
  if p_user_id is null then
    raise exception 'user id required';
  end if;

  if p_user_id <> v_uid and p_user_id <> v_legacy_uid then
    raise exception 'user id mismatch';
  end if;

  -- Query EXACTLY p_user_id. The marker's user_id is the restored Japam's
  -- actual user_id (the client's stored userId), which may differ from
  -- auth.uid() for legacy identities — hence the explicit p_user_id filter
  -- rather than a v_uid/v_effective_uid guess.
  select pjad.id, pjad.japam_id
    into v_marker_id, v_japam_id
  from public.pending_japam_adoption pjad
  where pjad.user_id = p_user_id
  order by pjad.created_at
  limit 1
  for update;

  if v_marker_id is null then
    -- No pending marker for this caller; emit zero rows so the client falls back
    -- to the persisted-pointer path.
    return;
  end if;

  marker_id := v_marker_id;
  japam_id  := v_japam_id;
  return next;
end;
$$;

revoke all on function public.get_pending_japam_adoption(text) from public;
revoke all on function public.get_pending_japam_adoption(text) from anon;
grant execute on function public.get_pending_japam_adoption(text) to authenticated;

-- 3. Acknowledge RPC. Validates the authenticated caller, then deletes a
--    specific pending marker by (p_user_id, p_marker_id). Only deletes the
--    caller's OWN marker (matched on id AND user_id = p_user_id), so no client
--    can ack another user's marker. `p_user_id` must resolve to one of the
--    authenticated caller's identities — `auth.uid()` (`sub`) or the legacy
--    stored `user_metadata.sub` — otherwise the call is rejected. This mirrors
--    `get_pending_japam_adoption`: the client passes its stored userId (the
--    value the marker is keyed by) to both peek and ack.
--
--    The client calls this ONLY AFTER successfully persisting the adopted
--    japam_id as currentJapamId; if the call never arrives (client crash before
--    ack, network outage, etc.) the marker remains server-side and the next
--    refresh retries peek → verify → persist → ack. Returns the number of rows
--    deleted (1 = ack'd, 0 = marker already gone or not owned by caller).
create or replace function public.acknowledge_pending_japam_adoption(
  p_user_id text,
  p_marker_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid             text;
  v_legacy_uid      text;
  v_deleted         integer := 0;
begin
  v_uid := auth.uid()::text;
  v_legacy_uid := auth.jwt()->'user_metadata'->>'sub';

  if v_uid is null and v_legacy_uid is null then
    raise exception 'authentication required';
  end if;

  -- Validate the caller first: p_user_id must be the authenticated caller's own
  -- id. Reject any other value.
  if p_user_id is null then
    raise exception 'user id required';
  end if;

  if p_user_id <> v_uid and p_user_id <> v_legacy_uid then
    raise exception 'user id mismatch';
  end if;

  if p_marker_id is null then
    return 0;
  end if;

  -- Delete only the caller's own marker. The CTE + count(*) returns a stable
  -- integer (1 on a successful ack, 0 if the marker was already gone or is not
  -- owned by the caller). No client can ack another user's marker.
  with deleted as (
    delete from public.pending_japam_adoption pjad
    where pjad.id = p_marker_id
      and pjad.user_id = p_user_id
    returning 1
  )
  select count(*) into v_deleted from deleted;

  return v_deleted;
end;
$$;

revoke all on function public.acknowledge_pending_japam_adoption(text, uuid) from public;
revoke all on function public.acknowledge_pending_japam_adoption(text, uuid) from anon;
grant execute on function public.acknowledge_pending_japam_adoption(text, uuid) to authenticated;