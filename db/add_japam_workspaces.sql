-- Japam Workspaces — schema for the "Japam is the primary entity" architecture
--
-- Feature: the app's primary object is now a Japam (e.g. "Gayatri", "Govinda"), not a numbered
-- slot. A user can create an UNLIMITED number of Japams. Selecting one scopes the entire app
-- (Timer, Tap Japam, Manual Entry, History, Today's Total, Lifetime Total) to that Japam alone.
-- There is NO catalog, NO preset mantra list, and NO cap on how many a user can create — every
-- Japam's name is created by the user.
--
-- Identity model (do not conflate these two columns, same discipline as the earlier slot design):
--   - japam_history.japam_id     is the STABLE IDENTITY (references public.japams.id). It is the
--     ONLY column that determines which Japam a history row belongs to. It never changes.
--   - japam_history.japam_name   is a DENORMALIZED DISPLAY-NAME SNAPSHOT captured automatically at
--     completion time (never typed by the user per session). It exists so History/CSV/exports can
--     show a label without joining public.japams, and so legacy rows (saved before this feature, or
--     during the earlier short-lived slot-based design) still display a sensible fallback label.
--     NULL/blank always displays as "Japam" — unchanged from every prior design in this app.
--
-- display_order: present now so a future manual-reordering feature (drag-and-drop) never needs a
-- schema change — deliberately NOT wired to any UI yet. Nullable; a null value means "use
-- created_at order" until a user (or a future feature) explicitly sets an order.
--
-- archived_at: archiving, not deleting, is this app's primary way to retire a Japam a user no
-- longer practices. A non-null archived_at hides a Japam from the default "My Japams" list and its
-- stats WITHOUT touching a single row of its history. A true permanent delete is a separate,
-- deliberately harder-to-reach action (not part of this migration) and, if ever added, must not
-- cascade-delete history — see the `on delete set null` on japam_history.japam_id below.
--
-- This migration is additive only:
--   - public.japams is a brand new table; it does not touch any existing table's data.
--   - japam_history.japam_id and japam_history.japam_name are both new to japam_history in the
--     currently deployed schema (verified via schema.sql / schema_staging.sql — japam_name only
--     exists today on the unrelated public.user_profiles table, a different, pre-existing "global
--     rename" feature; japam_history itself has neither column yet). `add column if not exists`
--     still guards both, so this migration is safe to run more than once and safe to run against
--     an environment that may have picked up either column some other way.
--   - Existing/legacy japam_history rows keep working — they simply have no japam_id and fall back
--     to the "Japam" default label, exactly as documented in lib/historyStore.ts.
--
-- Capped at nothing: unlike the superseded slot design, there is no check constraint limiting how
-- many Japams a user may have.
--
-- DO NOT RUN until explicitly approved.
-- Run in: Supabase SQL editor (or `supabase db query --linked --file ...`) against the intended
-- target project only (staging or production — never assume "current linked project" without
-- verifying its ref first; see docs/PRODUCTION_RELEASE_CHECKLIST.md).
-- Run ONCE per target. Safe to re-run: every statement below is idempotent
-- (IF NOT EXISTS / DROP POLICY IF EXISTS).


-- ─── SECTION 1: PRE-APPLY VERIFICATION (read-only) ───────────────────────────
--
-- Run this first to confirm the current state before applying.
-- Expected before applying:
--   - public.japams: 0 rows (table does not exist yet)
--   - japam_history.japam_id / japam_name: 0 rows (neither column exists yet on japam_history)

select table_name
from information_schema.tables
where table_schema = 'public'
  and table_name = 'japams';

select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name = 'japam_history'
  and column_name in ('japam_id', 'japam_name');


-- ─── SECTION 2: APPLY ─────────────────────────────────────────────────────────

-- 2a. public.japams — the primary entity. One row per user-created Japam.
create table if not exists public.japams (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  name text not null,
  display_order integer,
  created_at timestamptz not null default timezone('utc'::text, now()),
  updated_at timestamptz not null default timezone('utc'::text, now()),
  archived_at timestamptz
);

alter table public.japams owner to postgres;

comment on table public.japams is
  'The primary entity of the app. Users create and name these themselves -- there is no preset/catalog of mantra names anywhere in this app, and no cap on how many a user may have. id is the stable identity referenced by japam_history.japam_id; name is the only thing that changes on rename.';
comment on column public.japams.id is
  'Stable identity, referenced by japam_history.japam_id. Never derived from name and never reused.';
comment on column public.japams.name is
  'User-chosen label for this Japam (e.g. "Gayatri"). Freely renameable -- renaming updates only this column, never id, so History grouped by japam_id is unaffected by a rename.';
comment on column public.japams.display_order is
  'Reserved for a future manual-reordering (drag-and-drop) feature. Not wired to any UI yet. NULL means "use created_at order" -- adding drag-and-drop later only means starting to write values here, not a schema change.';
comment on column public.japams.archived_at is
  'Non-null means this Japam is archived (hidden from the default My Japams list and its stats), NOT deleted -- its history rows are always left completely untouched. Archiving, not deleting, is this app''s primary way to retire a Japam.';

-- 2b. Indexes.
create index if not exists japams_user_id_idx
  on public.japams (user_id);

-- Supports the "My Japams" list query: active (non-archived) Japams for a user, in display order.
create index if not exists japams_user_id_archived_at_display_order_idx
  on public.japams (user_id, archived_at, display_order);

-- 2c. RLS -- authenticated-only, ownership-scoped on all four operations. Identity is derived
-- exclusively from auth.uid() (with a fallback to the JWT's user_metadata.sub claim for accounts
-- not yet migrated to a Supabase UUID id -- the same dual-check already used by japam_history's
-- own update/delete policies and standardized across the F15 (japam_history/deleted_completions),
-- F7 (japam_user_totals/japam_timer_state), and F14 (Groups RPCs) remediations). anon has zero
-- policies and zero grants on this table -- see Section 2d.
--
-- This corrects an earlier draft of this migration (never applied to any environment -- this
-- table does not exist anywhere yet) that gave INSERT/SELECT to `authenticated, anon` with
-- `USING/WITH CHECK (true)`, i.e. no ownership check and open to the unauthenticated anon key --
-- exactly the F15/F7/F14 vulnerability class. That draft's own justification ("this app
-- writes/reads via the anon key in flows that predate a live auth session") does not hold: as of
-- this migration, lib/japamsRepository.ts and lib/japamsStorage.ts persist Japams to
-- AsyncStorage only -- no client code anywhere makes a REST call to public.japams (Supabase sync
-- is explicitly future work, per japamsRepository.ts's own header comment). Tightening RLS here
-- requires zero client-code changes because there is currently zero client traffic to this table.
alter table public.japams enable row level security;

drop policy if exists "allow_japams_insert" on public.japams;
drop policy if exists "authenticated_insert_own_japams" on public.japams;
create policy "authenticated_insert_own_japams"
  on public.japams
  for insert
  to authenticated
  with check (
    (auth.uid()::text = user_id)
    or ((auth.jwt() -> 'user_metadata' ->> 'sub') = user_id)
  );

drop policy if exists "allow_japams_select" on public.japams;
drop policy if exists "authenticated_select_own_japams" on public.japams;
create policy "authenticated_select_own_japams"
  on public.japams
  for select
  to authenticated
  using (
    (auth.uid()::text = user_id)
    or ((auth.jwt() -> 'user_metadata' ->> 'sub') = user_id)
  );

drop policy if exists "Users can update their own japams" on public.japams;
drop policy if exists "authenticated_update_own_japams" on public.japams;
create policy "authenticated_update_own_japams"
  on public.japams
  for update
  to authenticated
  using (
    (auth.uid()::text = user_id)
    or ((auth.jwt() -> 'user_metadata' ->> 'sub') = user_id)
  )
  with check (
    (auth.uid()::text = user_id)
    or ((auth.jwt() -> 'user_metadata' ->> 'sub') = user_id)
  );

drop policy if exists "Users can delete their own japams" on public.japams;
drop policy if exists "authenticated_delete_own_japams" on public.japams;
create policy "authenticated_delete_own_japams"
  on public.japams
  for delete
  to authenticated
  using (
    (auth.uid()::text = user_id)
    or ((auth.jwt() -> 'user_metadata' ->> 'sub') = user_id)
  );

-- 2d. Grants -- defense in depth, same rationale as the F15/F7 hotfixes: with zero anon policies
-- left, RLS already blocks anon entirely, but a bare table-level grant with no matching policy is
-- still an unnecessary privilege. anon loses all access; authenticated is scoped to exactly the
-- four operations its policies above cover -- no TRUNCATE/REFERENCES/TRIGGER. service_role/
-- postgres (the table owner) are untouched.
revoke all on public.japams from anon;
revoke all on public.japams from authenticated;
grant select, insert, update, delete on public.japams to authenticated;

-- 2e. japam_history.japam_id -- stable identity. Nullable: null means "no Japam" (legacy row, or a
-- completion saved before the user ever created a Japam), which falls back to the "Japam" default
-- label in lib/historyStore.ts. `on delete set null` is deliberate: even a future permanent-delete
-- feature for a Japam must never cascade-delete its history -- archiving is the supported way to
-- retire a Japam, and even a true delete should only ever orphan history back to "legacy", never
-- erase it. Inline `references` inside `add column if not exists` means the whole clause (column +
-- FK) is skipped together if the column already exists, so this stays idempotent without a
-- separate constraint-existence check.
alter table public.japam_history
  add column if not exists japam_id uuid references public.japams(id) on delete set null;

-- 2f. japam_history.japam_name -- denormalized display-name snapshot (idempotent: may already
-- exist on some environments from an earlier, now-superseded design; safe either way).
alter table public.japam_history
  add column if not exists japam_name text;

comment on column public.japam_history.japam_id is
  'Stable identity referencing public.japams.id for the owning user. NULL = legacy/unassigned row; falls back to japam_name or the "Japam" default label.';
comment on column public.japam_history.japam_name is
  'Denormalized snapshot of the Japam''s name at completion time, for display/CSV without a join and for legacy-row fallback. Never typed by the user per session. NULL/blank displays as "Japam".';

-- 2g. Index supporting per-Japam history queries (History, Today's Total, Lifetime Total, CSV
-- export, future Dashboard/Statistics/Widgets -- see the architecture discussion on centralizing
-- Japam-scoped selectors around this exact access pattern).
create index if not exists japam_history_user_id_japam_id_created_at_idx
  on public.japam_history (user_id, japam_id, created_at);


-- ─── SECTION 3: POST-APPLY VERIFICATION (read-only) ──────────────────────────
--
-- Expected after applying:
--   - japams: exists, with the 4 policies below, all `to authenticated` only
--   - anon: zero policies and zero grants on japams (last two queries below both return 0 rows)
--   - japam_history.japam_id: data_type=uuid, is_nullable=YES
--   - japam_history.japam_name: data_type=text, is_nullable=YES

select table_name
from information_schema.tables
where table_schema = 'public'
  and table_name = 'japams';

select policyname, cmd, roles
from pg_policies
where schemaname = 'public'
  and tablename = 'japams'
order by cmd, policyname;

-- Expect exactly 4 rows above: authenticated_{select,insert,update,delete}_own_japams, each with
-- roles = {authenticated} -- if `anon` appears in any row's roles, or fewer/more than 4 rows come
-- back, this migration's RLS did not apply as intended and must not be treated as verified.

-- Expect ZERO rows: anon must have no policy left on japams.
select policyname, cmd, roles
from pg_policies
where schemaname = 'public'
  and tablename = 'japams'
  and 'anon' = any(roles);

-- Expect ZERO rows: anon must have no table-level grant left on japams either (defense in depth
-- -- RLS already blocks anon with zero policies, but a stray grant should not exist regardless).
select grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name = 'japams'
  and grantee = 'anon';

select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name = 'japam_history'
  and column_name in ('japam_id', 'japam_name')
order by column_name;

-- Confirm existing japam_history rows are unaffected (all japam_id null, no backfill performed by
-- this migration -- the one-time client-driven legacy backfill, per the approved architecture, is
-- a later, separate, app-side step, not part of this schema migration).
select count(*) as total_rows, count(japam_id) as rows_with_japam_id
from public.japam_history;

-- Confirm the foreign key rejects a japam_id that doesn't exist (expected: this INSERT fails).
-- insert into public.japam_history (created_at, user_id, malas, count, completion_id, japam_id)
--   values (now(), 'test', 1, 108, 'test-fk-check', '00000000-0000-0000-0000-000000000000');


-- ─── SECTION 4: ROLLBACK ──────────────────────────────────────────────────────
--
-- Run ONLY if this causes an unexpected problem.
-- Effect: drops the new table and the japam_id column; japam_name is left in place (dropping it
-- would also affect the earlier, independent snapshot behavior it already had on some
-- environments -- safe to leave either way since it is nullable and unused by anything if this
-- feature is rolled back).

-- drop index if exists public.japam_history_user_id_japam_id_created_at_idx;
-- alter table public.japam_history drop column if exists japam_id;
-- drop table if exists public.japams;
