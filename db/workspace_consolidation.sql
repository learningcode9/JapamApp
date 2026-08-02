-- =============================================================================
-- Family Japam — one-workspace consolidation migration (HARDENED, apply only).
-- =============================================================================
-- Scope: the five members of the "Family  japam" group
--   c469d784-1ce9-4094-aa97-b26ed2865acb.
--
-- PROBLEM: after db/groups_workspace_isolation.sql, the dashboard aggregates per
-- membership with `h.user_id = gm.user_id AND h.japam_id = gm.japam_id`, and rows with
-- japam_id IS NULL are NEVER counted. Several Family members had memberships whose
-- japam_id was NULL, or MULTIPLE active Japams (duplicate workspaces), or History
-- stranded under a duplicate Japam — so Group Dashboard totals disagreed with History.
--
-- GOAL (product invariant, restored for every Family member):
--   * exactly ONE active Japam (workspace) per member,
--   * every Family membership linked to that one workspace,
--   * every member's History attributable to that workspace,
--   * Groups lifetime/today totals == History lifetime/today totals (tombstone-excluded).
--
-- HARDENING (PARTIAL-PASS fix): this version
--   (A) asserts an EXPLICIT expected mapping (exact group id, exact 5 user_ids, exact
--       canonical/duplicate/pre-archived Japam inventory, exact membership links) and
--       ABORTS if any user/member/Japam shape differs;
--   (B) runs EVERY parity validation INSIDE the same transaction and COMMITs only when
--       every assertion passes (any failure RAISEs -> the whole transaction aborts);
--   (C) backs up into a PRIVATE schema `migration_backup` with access revoked from
--       PUBLIC/anon/authenticated/service_role, using migration-specific table names,
--       and records row counts + md5 checksums in a manifest;
--   (E) locks the exact affected rows (SELECT ... FOR UPDATE) so concurrent FK inserts
--       into japam_history cannot interleave, installs two STALE-CLIENT WRITE GUARD
--       triggers that REJECT new history written to an archived Japam and REJECT
--       re-activating an archived Japam, and relies on the rollback file to REFUSE when
--       unexpected post-migration writes exist.
--
-- DELIBERATELY NOT INCLUDED HERE:
--   * rollback  -> db/workspace_consolidation_rollback.sql  (restores the migration)
--   * cleanup   -> db/workspace_consolidation_cleanup.sql   (removes backup artifacts
--                 ONLY after final approval; rollback and cleanup are distinct and this
--                 file never describes rollback as cleanup)
--
-- ENVIRONMENT: validated against STAGING (nhacglvxdypevrbvvkhn). Applying to
-- PRODUCTION (rftlqybgnbixotnpanec) is a separate, operator-only decision. This file is
-- one atomic transaction: BEGIN ... COMMIT. No production SQL was or will be run by tooling.
-- =============================================================================

begin;

-- ─── SECTION 0: OPERATOR-CONFIGURED CONSTANTS (the explicit expected mapping) ───
-- The entire migration is driven by these hardcoded expectations. If the live data does
-- not match them exactly, SECTION 1 aborts. Update the today-boundary constants for the
-- apply day ONLY (the app's local-day window for the viewer timezone).

-- 0a. The one target group (exact production id).
create temp table _ws_family on commit drop as
  select 'c469d784-1ce9-4094-aa97-b26ed2865acb'::uuid as group_id;

-- 0b. The exact five members (production user_ids).
create temp table _ws_members on commit drop as
select u.user_id
from (values
  ('3c313835-e391-4607-853f-e23a108d9c2b'::text),
  ('6829d5ea-285c-458c-9577-7bce4422c45c'::text),
  ('d25472a6-741a-48ee-8c6e-fcb8ea8394f5'::text),
  ('f1887c24-5728-4246-9912-699de2ea2f05'::text),
  ('87f50692-bdf2-49ad-97cf-0e79da8788fa'::text)
) as u(user_id);

-- 0c. Exact Japam inventory per member. kind: canonical | duplicate | pre_archived |
--     created. 'created' = the deterministic default Japam the migration itself creates
--     (bellam currently has ZERO Japams). 'pre_archived' = the already-archived
--     "Test Japam" that must remain archived and untouched.
create temp table _ws_expected_japams on commit drop as
select e.user_id, e.japam_id, e.kind, e.expected_archived
from (values
  ('3c313835-e391-4607-853f-e23a108d9c2b'::text, 'cd811356-5954-4b75-aed3-f9e9cf5b3ffd'::uuid, 'canonical'::text,     false),
  ('3c313835-e391-4607-853f-e23a108d9c2b'::text, '19748f34-124d-4b78-8580-321bf82a1063'::uuid, 'duplicate'::text,     false),
  ('6829d5ea-285c-458c-9577-7bce4422c45c'::text, '82876810-f2e3-4943-82ac-d9be0e3309d9'::uuid, 'canonical'::text,     false),
  ('d25472a6-741a-48ee-8c6e-fcb8ea8394f5'::text, 'b91c31a4-9c36-45a1-a2ce-53b5b3cbbb14'::uuid, 'canonical'::text,     false),
  ('d25472a6-741a-48ee-8c6e-fcb8ea8394f5'::text, '0c4773b3-d9d0-431e-bbff-6a0774573636'::uuid, 'duplicate'::text,     false),
  ('87f50692-bdf2-49ad-97cf-0e79da8788fa'::text, '51356d77-5981-4b45-9bc9-0ae657a5fa2b'::uuid, 'canonical'::text,     false),
  ('87f50692-bdf2-49ad-97cf-0e79da8788fa'::text, 'fdc2961b-4512-4308-afc9-9da36522d10b'::uuid, 'duplicate'::text,     false),
  ('87f50692-bdf2-49ad-97cf-0e79da8788fa'::text, '69ebd607-d755-4272-aabc-09041c1f94c3'::uuid, 'duplicate'::text,     false),
  ('87f50692-bdf2-49ad-97cf-0e79da8788fa'::text, '69c01af2-578b-4a7c-85ef-4a839277d8cd'::uuid, 'duplicate'::text,     false),
  ('87f50692-bdf2-49ad-97cf-0e79da8788fa'::text, '64b10996-e692-43e0-9706-6006c2c21e62'::uuid, 'duplicate'::text,     false),
  ('87f50692-bdf2-49ad-97cf-0e79da8788fa'::text, '2f58d18b-f4ce-44f8-963b-257277df5f99'::uuid, 'pre_archived'::text, true),
  ('f1887c24-5728-4246-9912-699de2ea2f05'::text, 'a1b78928-6d21-5dca-8fed-b023e97edfa2'::uuid, 'created'::text,       false)
) as e(user_id, japam_id, kind, expected_archived);

-- 0d. Exact Family memberships: (membership_id, user_id, japam_id). japam_id NULL means
--     the membership is currently UNASSIGNED and must be linked by the migration.
create temp table _ws_expected_memberships on commit drop as
select e.membership_id, e.user_id, e.japam_id
from (values
  ('2c6b36f5-c16e-41b4-9c5b-7345006852b7'::uuid, '3c313835-e391-4607-853f-e23a108d9c2b'::text, null::uuid),
  ('f5acc279-3815-460b-bc2d-8bb8fa2962ea'::uuid, '6829d5ea-285c-458c-9577-7bce4422c45c'::text, '82876810-f2e3-4943-82ac-d9be0e3309d9'::uuid),
  ('d36e4ff8-d2e6-4cbe-a269-714d35bfeebc'::uuid, 'd25472a6-741a-48ee-8c6e-fcb8ea8394f5'::text, null::uuid),
  ('12e65d86-c2cf-46af-8cd8-f86a838179f1'::uuid, 'f1887c24-5728-4246-9912-699de2ea2f05'::text, null::uuid),
  ('041645f7-e49f-4212-8a73-2aefef087575'::uuid, '87f50692-bdf2-49ad-97cf-0e79da8788fa'::text, '51356d77-5981-4b45-9bc9-0ae657a5fa2b'::uuid)
) as e(membership_id, user_id, japam_id);

-- 0e. Today parity window (SUPPLIED local-day boundaries). OPERATOR: for the apply day,
--     set these to the app's local-day window for the viewer timezone (e.g. a UTC+7
--     device on 2026-08-02 uses [2026-08-02T07:00Z, 2026-08-03T07:00Z)). The staging
--     fixture and the RPC verification use these same constants.
create temp table _ws_today_bounds on commit drop as
  select '2026-08-02T07:00:00Z'::timestamptz as start_ts,
         '2026-08-03T07:00:00Z'::timestamptz as end_ts;


-- ─── SECTION 1: PRE-APPLY SHAPE ASSERTIONS (abort on ANY mismatch) ────────────
do $$
declare
  v_msgs text := '';
  v_group_name text;
  v_count int;
  r record;
begin
  -- 1a. The family group exists with its exact identity and is active.
  select g.name into v_group_name
  from public.groups g
  where g.id = (select group_id from _ws_family);
  if v_group_name is null then
    v_msgs := v_msgs || E'\n- family group ' || (select group_id::text from _ws_family) || ' does not exist';
  elsif v_group_name <> 'Family  japam' then
    v_msgs := v_msgs || format(E'\n- family group name is %L (expected ''Family  japam'')', v_group_name);
  end if;
  if not exists (
    select 1 from public.groups g
    where g.id = (select group_id from _ws_family) and g.is_active
  ) then
    v_msgs := v_msgs || E'\n- family group is not active';
  end if;

  -- 1b. Membership set matches the expected mapping exactly (5 memberships, no extras,
  --     no missing, identical user_id and japam_id links).
  select count(*) into v_count
  from public.group_members gm
  where gm.group_id = (select group_id from _ws_family);
  if v_count <> (select count(*) from _ws_expected_memberships) then
    v_msgs := v_msgs || format(E'\n- family membership count is %s, expected %s', v_count, (select count(*) from _ws_expected_memberships));
  end if;
  for r in
    select gm.user_id, gm.japam_id
    from public.group_members gm
    where gm.group_id = (select group_id from _ws_family)
  loop
    if not exists (
      select 1 from _ws_expected_memberships e
      where e.user_id = r.user_id and e.japam_id is not distinct from r.japam_id
    ) then
      v_msgs := v_msgs || format(E'\n- unexpected membership user=%s japam=%s', r.user_id, r.japam_id);
    end if;
  end loop;
  for r in
    select e.user_id, e.japam_id
    from _ws_expected_memberships e
  loop
    if not exists (
      select 1 from public.group_members gm
      where gm.group_id = (select group_id from _ws_family)
        and gm.user_id = r.user_id
        and gm.japam_id is not distinct from r.japam_id
    ) then
      v_msgs := v_msgs || format(E'\n- missing expected membership user=%s japam=%s', r.user_id, r.japam_id);
    end if;
  end loop;

  -- 1c. Japam inventory matches exactly (excluding the migration-created 'created' row).
  for r in
    select e.user_id, e.japam_id, e.expected_archived
    from _ws_expected_japams e
    where e.kind <> 'created'
  loop
    if not exists (
      select 1 from public.japams j
      where j.user_id = r.user_id
        and j.id = r.japam_id
        and (j.archived_at is not null) = r.expected_archived
    ) then
      v_msgs := v_msgs || format(E'\n- japam %s (user %s) missing or archived-state mismatch', r.japam_id, r.user_id);
    end if;
  end loop;
  -- No member may own a Japam outside the expected inventory (incl. bellam who must
  -- currently have ZERO Japams).
  for r in
    select u.user_id from _ws_members u
  loop
    select count(*) into v_count
    from public.japams j
    where j.user_id = r.user_id
      and not exists (
        select 1 from _ws_expected_japams e
        where e.user_id = r.user_id and e.japam_id = j.id and e.kind <> 'created'
      );
    if v_count > 0 then
      v_msgs := v_msgs || format(E'\n- user %s owns %s japam(s) outside the expected inventory', r.user_id, v_count);
    end if;
  end loop;

  if v_msgs <> '' then
    raise exception 'WS_SHAPE_MISMATCH (SECTION 1): the live user/member/Japam shape differs from the expected mapping:%', v_msgs;
  end if;
end $$;


-- ─── SECTION 2: CONCURRENCY LOCKS (lock the exact affected rows) ──────────────
-- FOR UPDATE on the japams rows makes a concurrent FK INSERT into japam_history that
-- references one of these Japams wait (FK key-share conflicts with FOR UPDATE), so no new
-- History can interleave while we reassign/archive. The japam_history and group_members
-- locks serialize concurrent edits to exactly the rows we transform.
select id from public.japams
  where user_id in (select user_id from _ws_members)
  order by id
  for update;
select id from public.group_members
  where group_id = (select group_id from _ws_family)
  order by id
  for update;
select id from public.japam_history
  where user_id in (select user_id from _ws_members)
  order by id
  for update;


-- ─── SECTION 3: BACKUP (private schema, migration-specific names, checksums) ──
-- A dedicated private schema (never public), with every grant revoked. The backup tables
-- are only ever read by the rollback file, which runs as the schema owner (postgres).
create schema if not exists migration_backup;
revoke all on schema migration_backup from public;
revoke all on schema migration_backup from anon;
revoke all on schema migration_backup from authenticated;
revoke all on schema migration_backup from service_role;
revoke all on schema migration_backup from PUBLIC;

drop table if exists migration_backup.ws1_japam_history;
create table migration_backup.ws1_japam_history as
  select h.*
  from public.japam_history h
  where h.user_id in (select user_id from _ws_members);

drop table if exists migration_backup.ws1_group_members;
create table migration_backup.ws1_group_members as
  select gm.*
  from public.group_members gm
  where gm.group_id = (select group_id from _ws_family);

drop table if exists migration_backup.ws1_japams;
create table migration_backup.ws1_japams as
  select j.*
  from public.japams j
  where j.user_id in (select user_id from _ws_members);

revoke all on all tables in schema migration_backup from public, anon, authenticated, service_role;
alter default privileges in schema migration_backup revoke all on tables from public, anon, authenticated, service_role;

-- Manifest: pre-apply row counts + md5 checksums (checksums ordered by the table PK so
-- the rollback file can prove the current state is byte-identical to what we committed).
drop table if exists migration_backup.ws1_manifest;
create table migration_backup.ws1_manifest (
  backup_name   text primary key,
  source_table  text not null,
  filter        text not null,
  pre_row_count bigint not null,
  pre_checksum  text not null,
  post_row_count bigint,
  post_checksum  text,
  captured_at   timestamptz not null default now(),
  note          text
);

insert into migration_backup.ws1_manifest (backup_name, source_table, filter, pre_row_count, pre_checksum)
select
  'ws1_japam_history',
  'public.japam_history',
  'user_id in (5 family members)',
  count(*),
  md5(coalesce(string_agg(md5(row_to_json(t)::text), ',' order by t.id), ''))
from migration_backup.ws1_japam_history t;

insert into migration_backup.ws1_manifest (backup_name, source_table, filter, pre_row_count, pre_checksum)
select
  'ws1_group_members',
  'public.group_members',
  'group_id = family group',
  count(*),
  md5(coalesce(string_agg(md5(row_to_json(t)::text), ',' order by t.id), ''))
from migration_backup.ws1_group_members t;

insert into migration_backup.ws1_manifest (backup_name, source_table, filter, pre_row_count, pre_checksum)
select
  'ws1_japams',
  'public.japams',
  'user_id in (5 family members)',
  count(*),
  md5(coalesce(string_agg(md5(row_to_json(t)::text), ',' order by t.id), ''))
from migration_backup.ws1_japams t;

-- Pre-apply History totals (tombstone-excluded) for the P5 "totals unchanged" assertion.
create temp table _ws_pre_totals on commit drop as
  select
    h.user_id,
    count(*) as rows,
    coalesce(sum(h.malas), 0) as malas,
    coalesce(sum(h.count), 0) as sumcount
  from public.japam_history h
  where h.user_id in (select user_id from _ws_members)
    and not exists (select 1 from public.deleted_completions dc where dc.completion_id = h.completion_id)
  group by h.user_id;


-- ─── SECTION 4: STALE-CLIENT WRITE GUARDS (durable rejection of archived writes) ──
-- Investigation result (lib/japamsRepository.ts syncJapam, contexts/timer-context.tsx,
-- lib/tapSaveSession.ts, lib/timerPendingCompletions.ts): a stale client still holding a
-- duplicate as ACTIVE can, on its next completion write, (a) INSERT new japam_history
-- rows with that duplicate japam_id and (b) via syncJapam upsert, overwrite archived_at
-- back to NULL. Without DB-level rejection the consolidation would be undone by old
-- clients. These two triggers REJECT both vectors. They are durable (kept after apply);
-- rollback drops them; the staging fixture teardown drops them to restore the exact
-- pre-test schema.
create or replace function public._ws_guard_history_archived_japam()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if NEW.japam_id is not null and exists (
    select 1 from public.japams j
    where j.id = NEW.japam_id and j.archived_at is not null
  ) then
    raise exception 'JAPAM_ARCHIVED_WRITE_BLOCKED: cannot write japam_history referencing archived japam %', NEW.japam_id;
  end if;
  return NEW;
end;
$$;

drop trigger if exists _ws_no_history_to_archived_japam on public.japam_history;
create trigger _ws_no_history_to_archived_japam
  before insert or update on public.japam_history
  for each row execute function public._ws_guard_history_archived_japam();

create or replace function public._ws_guard_no_unarchive()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if TG_OP = 'UPDATE' and OLD.archived_at is not null and NEW.archived_at is null then
    raise exception 'JAPAM_UNARCHIVE_BLOCKED: archived japam % cannot be re-activated; create a new Japam instead', NEW.id;
  end if;
  return NEW;
end;
$$;

drop trigger if exists _ws_no_unarchive on public.japams;
create trigger _ws_no_unarchive
  before update on public.japams
  for each row execute function public._ws_guard_no_unarchive();

revoke all on function public._ws_guard_history_archived_japam() from public, anon, authenticated;
revoke all on function public._ws_guard_no_unarchive() from public, anon, authenticated;

-- Cross-check: the hardcoded bellam deterministic default must equal the app's uuidV5
-- (namespace 62f5824e-58fd-5d39-9f87-1f761082d8e3, name "<user_id>:default-japam",
-- RFC 4122 v5, SHA-1 via extensions.digest). Abort on mismatch.
do $$
declare
  v_ns     bytea := '\x62f5824e58fd5d399f871f761082d8e3'::bytea;
  v_name   bytea := convert_to('f1887c24-5728-4246-9912-699de2ea2f05:default-japam', 'UTF8');
  v_dig    bytea;
  v_bytes  bytea;
  v_id     uuid;
begin
  v_dig := extensions.digest(v_ns || v_name, 'sha1'::text);
  v_bytes := substr(v_dig, 1, 16);
  v_bytes := set_byte(v_bytes, 6, (get_byte(v_bytes, 6) & 15) | 80);
  v_bytes := set_byte(v_bytes, 8, (get_byte(v_bytes, 8) & 63) | 128);
  v_id := (
    substr(encode(v_bytes, 'hex'), 1, 8) || '-' ||
    substr(encode(v_bytes, 'hex'), 9, 4) || '-' ||
    substr(encode(v_bytes, 'hex'), 13, 4) || '-' ||
    substr(encode(v_bytes, 'hex'), 17, 4) || '-' ||
    substr(encode(v_bytes, 'hex'), 21, 12)
  )::uuid;
  if v_id <> 'a1b78928-6d21-5dca-8fed-b023e97edfa2'::uuid then
    raise exception 'WS_UUIDV5_MISMATCH: expected a1b78928-6d21-5dca-8fed-b023e97edfa2, computed %', v_id;
  end if;
end $$;


-- ─── SECTION 5: APPLY (A-F) ───────────────────────────────────────────────────
-- A. Canonical Japam per member = the expected 'canonical' entry, plus the 'created'
--    deterministic default for a member with no Japams (bellam). 'created' is created in
--    STEP D before any History is reassigned to it, so the reassignment FKs cleanly.
create temp table _ws_canonical on commit drop as
  select user_id, japam_id as canonical_id
  from _ws_expected_japams
  where kind in ('canonical', 'created');

-- D. Create the deterministic default Japam(s) for members that have none (bellam), only
--    if absent (verified absent above). Must precede B/B' so reassignment targets exist.
insert into public.japams (id, user_id, name, display_order, created_at, updated_at, archived_at)
select e.japam_id, e.user_id, 'My Japam', null, now(), now(), null
from _ws_expected_japams e
where e.kind = 'created'
  and not exists (select 1 from public.japams j where j.id = e.japam_id);

-- B. Reassign every null-japam (legacy) History row onto the member's canonical.
update public.japam_history h
set japam_id = c.canonical_id
from _ws_canonical c
where h.user_id = c.user_id
  and h.japam_id is null;

-- B'. Defensive: move any History found under a 'duplicate' Japam onto the canonical
--     (production evidence: all duplicates carry 0 rows; if that ever changed before
--     apply, this keeps the archived-duplicate invariant true instead of failing it).
update public.japam_history h
set japam_id = c.canonical_id
from _ws_canonical c
where h.user_id = c.user_id
  and h.japam_id in (
    select e.japam_id from _ws_expected_japams e
    where e.user_id = c.user_id and e.kind = 'duplicate'
  );

-- C. Archive every duplicate Japam (empty by construction after B/B').
update public.japams j
set archived_at = now(), updated_at = now()
where j.id in (select e.japam_id from _ws_expected_japams e where e.kind = 'duplicate');

-- E. Link every Family membership to the member's canonical (the actual dashboard fix).
--    Komali and learn are already linked to their canonical; Sita, Sarada, bellam are set.
update public.group_members gm
set japam_id = c.canonical_id
from _ws_canonical c
where gm.group_id = (select group_id from _ws_family)
  and gm.user_id = c.user_id
  and gm.japam_id is distinct from c.canonical_id;

-- Post-apply History totals + checksums (recorded BEFORE the parity assertions so the
-- rollback file can refuse once real post-migration writes appear).
update migration_backup.ws1_manifest m
set post_row_count = x.cnt,
    post_checksum  = x.chk
from (
  select count(*) as cnt,
         md5(coalesce(string_agg(md5(row_to_json(t)::text), ',' order by t.id), '')) as chk
  from public.japam_history t
  where t.user_id in (select user_id from _ws_members)
) x
where m.backup_name = 'ws1_japam_history';

update migration_backup.ws1_manifest m
set post_row_count = x.cnt,
    post_checksum  = x.chk
from (
  select count(*) as cnt,
         md5(coalesce(string_agg(md5(row_to_json(t)::text), ',' order by t.id), '')) as chk
  from public.group_members t
  where t.group_id = (select group_id from _ws_family)
) x
where m.backup_name = 'ws1_group_members';

update migration_backup.ws1_manifest m
set post_row_count = x.cnt,
    post_checksum  = x.chk
from (
  select count(*) as cnt,
         md5(coalesce(string_agg(md5(row_to_json(t)::text), ',' order by t.id), '')) as chk
  from public.japams t
  where t.user_id in (select user_id from _ws_members)
) x
where m.backup_name = 'ws1_japams';


-- ─── SECTION 6: IN-TRANSACTION PARITY ASSERTIONS (COMMIT only when all pass) ──
do $$
declare
  v_msgs     text := '';
  v_count    int;
  v_start    timestamptz;
  v_end      timestamptz;
  v_pre_rows bigint; v_pre_malas bigint; v_pre_cnt bigint;
  v_post_rows bigint; v_post_malas bigint; v_post_cnt bigint;
  v_g_malas  bigint; v_g_cnt bigint;
  v_h_malas  bigint; v_h_cnt bigint;
  v_t_malas  bigint; v_t_cnt bigint;
  v_th_malas bigint; v_th_cnt bigint;
  r record;
begin
  select start_ts, end_ts into v_start, v_end from _ws_today_bounds;

  -- P1. exactly one active Japam per member.
  for r in select user_id from _ws_members loop
    select count(*) into v_count
    from public.japams j
    where j.user_id = r.user_id and j.archived_at is null;
    if v_count <> 1 then
      v_msgs := v_msgs || format(E'\n- P1 %s has %s active Japams', r.user_id, v_count);
    end if;
  end loop;

  -- P2. every Family membership linked.
  select count(*) into v_count
  from public.group_members gm
  where gm.group_id = (select group_id from _ws_family) and gm.japam_id is null;
  if v_count <> 0 then
    v_msgs := v_msgs || format(E'\n- P2 %s Family membership(s) still unassigned', v_count);
  end if;

  -- P3. no null-japam History for these users.
  select count(*) into v_count
  from public.japam_history h
  where h.user_id in (select user_id from _ws_members) and h.japam_id is null;
  if v_count <> 0 then
    v_msgs := v_msgs || format(E'\n- P3 %s null-japam History row(s) remain', v_count);
  end if;

  -- P4. no History under any archived Japam of these users (incl. the pre-archived Test Japam).
  select count(*) into v_count
  from public.japam_history h
  join public.japams j on j.id = h.japam_id
  where j.user_id in (select user_id from _ws_members)
    and j.archived_at is not null;
  if v_count <> 0 then
    v_msgs := v_msgs || format(E'\n- P4 %s History row(s) under archived Japams', v_count);
  end if;

  -- P5. History totals unchanged (rows / malas / count), tombstone-excluded.
  for r in select user_id from _ws_members loop
    select count(*), coalesce(sum(h.malas), 0), coalesce(sum(h.count), 0)
      into v_post_rows, v_post_malas, v_post_cnt
    from public.japam_history h
    where h.user_id = r.user_id
      and not exists (select 1 from public.deleted_completions dc where dc.completion_id = h.completion_id);
    select rows, malas, sumcount into v_pre_rows, v_pre_malas, v_pre_cnt
    from _ws_pre_totals pt where pt.user_id = r.user_id;
    if v_pre_rows <> v_post_rows or v_pre_malas <> v_post_malas or v_pre_cnt <> v_post_cnt then
      v_msgs := v_msgs || format(
        E'\n- P5 %s totals changed pre(%s,%s,%s) post(%s,%s,%s)',
        r.user_id, v_pre_rows, v_pre_malas, v_pre_cnt, v_post_rows, v_post_malas, v_post_cnt);
    end if;
  end loop;

  -- P6. Groups lifetime == History lifetime per member (RPC-style aggregation, tombstone-excluded).
  for r in select user_id from _ws_members loop
    select coalesce(sum(h.malas), 0), coalesce(sum(h.count), 0)
      into v_g_malas, v_g_cnt
    from public.japam_history h
    join public.group_members gm
      on gm.user_id = h.user_id and gm.japam_id = h.japam_id
     and gm.group_id = (select group_id from _ws_family)
    where h.user_id = r.user_id
      and not exists (select 1 from public.deleted_completions dc where dc.completion_id = h.completion_id);
    select coalesce(sum(h.malas), 0), coalesce(sum(h.count), 0)
      into v_h_malas, v_h_cnt
    from public.japam_history h
    where h.user_id = r.user_id
      and not exists (select 1 from public.deleted_completions dc where dc.completion_id = h.completion_id);
    if v_g_malas <> v_h_malas or v_g_cnt <> v_h_cnt then
      v_msgs := v_msgs || format(
        E'\n- P6 %s lifetime mismatch groups(%s,%s) history(%s,%s)',
        r.user_id, v_g_malas, v_g_cnt, v_h_malas, v_h_cnt);
    end if;
  end loop;

  -- P7. today parity within the supplied local-day boundaries.
  for r in select user_id from _ws_members loop
    select coalesce(sum(h.malas), 0), coalesce(sum(h.count), 0)
      into v_t_malas, v_t_cnt
    from public.japam_history h
    join public.group_members gm
      on gm.user_id = h.user_id and gm.japam_id = h.japam_id
     and gm.group_id = (select group_id from _ws_family)
    where h.user_id = r.user_id
      and h.created_at >= v_start and h.created_at < v_end
      and not exists (select 1 from public.deleted_completions dc where dc.completion_id = h.completion_id);
    select coalesce(sum(h.malas), 0), coalesce(sum(h.count), 0)
      into v_th_malas, v_th_cnt
    from public.japam_history h
    where h.user_id = r.user_id
      and h.created_at >= v_start and h.created_at < v_end
      and not exists (select 1 from public.deleted_completions dc where dc.completion_id = h.completion_id);
    if v_t_malas <> v_th_malas or v_t_cnt <> v_th_cnt then
      v_msgs := v_msgs || format(
        E'\n- P7 %s today mismatch groups(%s,%s) history(%s,%s)',
        r.user_id, v_t_malas, v_t_cnt, v_th_malas, v_th_cnt);
    end if;
  end loop;

  if v_msgs <> '' then
    raise exception 'WS_PARITY_FAILURE (SECTION 6): assertions failed:%', v_msgs;
  end if;
end $$;

commit;

-- ─── POST-COMMIT REPORT (read-only; only reached if every assertion passed) ──
select 'WS_APPLY_OK' as status,
       5 as members_consolidated,
       'COMMIT executed: every SECTION 1 shape assertion and every SECTION 6 parity assertion passed' as note;
