-- Local-Supabase-only behavioral test for db/consolidate_duplicate_my_japam_rpc.sql.
-- Production-shaped fixture: canonical 506/602/65016, duplicate 2/2/216, canonical
-- group refs 2, duplicate group refs 0. Every scenario runs inside ONE transaction
-- that ROLLS BACK on completion, so a failure anywhere leaves local Supabase
-- untouched.
--
-- Run against the LOCAL dockerized Supabase only:
--   docker exec -i supabase_db_JapamApp psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
--     -f db/__tests__/consolidate_duplicate_my_japam.local.sql
--
-- The RPC must be deployed to local first:
--   docker exec -i supabase_db_JapamApp psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
--     -f db/consolidate_duplicate_my_japam_rpc.sql

\set ON_ERROR_STOP 1

-- Clear any leftover fixture rows from a previously crashed run (autocommit, then the
-- test transaction below rolls back all of its own work).
delete from public.pending_japam_adoption where user_id = 'a1111111-1111-4111-8111-111111111111';
delete from public.group_members where user_id = 'a1111111-1111-4111-8111-111111111111';
delete from public.groups where created_by = 'a1111111-1111-4111-8111-111111111111';
delete from public.deleted_japams where user_id = 'a1111111-1111-4111-8111-111111111111';
delete from public.japam_history where user_id = 'a1111111-1111-4111-8111-111111111111';
delete from public.japams where user_id = 'a1111111-1111-4111-8111-111111111111';

begin;

set local row_security = on;

-- =============================================================================
-- SECTION 0: PRODUCTION-SHAPED FIXTURE
-- =============================================================================
insert into public.japams (id, user_id, name, created_at, updated_at, archived_at) values
  ('b2222222-2222-4222-8222-222222222222', 'a1111111-1111-4111-8111-111111111111', 'My Japam', now(), now(), now()),
  ('c3333333-3333-4333-8333-333333333333', 'a1111111-1111-4111-8111-111111111111', 'My Japam', now(), now(), null);

insert into public.deleted_japams (japam_id, user_id, deleted_at) values
  ('b2222222-2222-4222-8222-222222222222', 'a1111111-1111-4111-8111-111111111111', now());

-- canonical: 506 rows -> 410 x malas=1/count=108 + 96 x malas=2/count=216
--   SUM(malas)=410+192=602 ; SUM(count)=44280+20736=65016
do $$
declare
  i int;
  v_malas int;
  v_count int;
  v_slot smallint;
begin
  for i in 1..506 loop
    v_malas := case when i > 410 then 2 else 1 end;
    v_count := v_malas * 108;
    v_slot := (i % 10)::smallint;
    insert into public.japam_history
      (user_id, malas, count, completion_id, japam_name, japam_id, created_at, japam_slot)
    values
      ('a1111111-1111-4111-8111-111111111111', v_malas, v_count,
       'canon-fixture-' || lpad(i::text, 6, '0'),
       'My Japam', 'b2222222-2222-4222-8222-222222222222',
       now() - (6000 - i) * interval '1 minute', v_slot);
  end loop;
end $$;

-- duplicate: 2 real rows -> SUM(malas)=2 ; SUM(count)=216
insert into public.japam_history
  (user_id, malas, count, completion_id, japam_name, japam_id, created_at, japam_slot)
values
  ('a1111111-1111-4111-8111-111111111111', 1, 108, 'dup-fixture-000001', 'My Japam',
   'c3333333-3333-4333-8333-333333333333', now() - interval '90 minutes', 0),
  ('a1111111-1111-4111-8111-111111111111', 1, 108, 'dup-fixture-000002', 'My Japam',
   'c3333333-3333-4333-8333-333333333333', now() - interval '80 minutes', 1);

-- canonical group refs: 2 (Family-style + Gayatri-style). duplicate group refs: 0.
insert into public.groups (id, name, invite_code, created_by, created_at, is_active) values
  ('11111111-2222-4333-8444-555555555555', 'Family  japam', 'FIXTURE1', 'a1111111-1111-4111-8111-111111111111', now(), true),
  ('22222222-3333-4444-8555-666666666666', 'Gayatri matha', 'FIXTURE2', 'a1111111-1111-4111-8111-111111111111', now(), true);

insert into public.group_members (id, group_id, user_id, user_name, role, joined_at, japam_id) values
  ('33333333-4444-4555-8666-777777777777', '11111111-2222-4333-8444-555555555555',
   'a1111111-1111-4111-8111-111111111111', 'Fixture Owner', 'member', now(), 'b2222222-2222-4222-8222-222222222222'),
  ('44444444-5555-4666-8777-888888888888', '22222222-3333-4444-8555-666666666666',
   'a1111111-1111-4111-8111-111111111111', 'Fixture Owner', 'admin', now(), 'b2222222-2222-4222-8222-222222222222');

-- Capture the two duplicate rows' original field values BEFORE consolidation.
create temp table dup_history_before as
select id, created_at, malas, count, completion_id, user_name, japam_name
from public.japam_history
where user_id = 'a1111111-1111-4111-8111-111111111111'
  and japam_id = 'c3333333-3333-4333-8333-333333333333'
order by completion_id;

-- =============================================================================
-- SECTION 1: PRODUCTION-SHAPED WRITE-GUARDS (scoped to the fixture ids)
-- Mirrors db/workspace_consolidation.sql guard semantics so the RPC must already
-- respect the unarchive-before-move ordering on the real database.
-- =============================================================================
create or replace function public._test_guard_history_archived_japam()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if NEW.user_id = 'a1111111-1111-4111-8111-111111111111' and NEW.japam_id is null then
    raise exception 'JAPAM_HISTORY_NULL_BLOCKED: legacy null-japam history is not allowed for the migrated Family members';
  end if;
  if NEW.japam_id is not null and exists (
    select 1 from public.japams j
    where j.id = NEW.japam_id and j.archived_at is not null
  ) then
    raise exception 'JAPAM_ARCHIVED_WRITE_BLOCKED: cannot write japam_history referencing archived japam %', NEW.japam_id;
  end if;
  return NEW;
end;
$$;

drop trigger if exists _test_no_history_to_archived_japam on public.japam_history;
create trigger _test_no_history_to_archived_japam
  before insert or update on public.japam_history
  for each row execute function public._test_guard_history_archived_japam();

create or replace function public._test_guard_no_unarchive()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if TG_OP = 'UPDATE'
    and OLD.id = 'c3333333-3333-4333-8333-333333333333'
    and OLD.archived_at is not null and NEW.archived_at is null then
    raise exception 'JAPAM_UNARCHIVE_BLOCKED: archived japam % cannot be re-activated; create a new Japam instead', NEW.id;
  end if;
  return NEW;
end;
$$;

drop trigger if exists _test_no_unarchive on public.japams;
create trigger _test_no_unarchive
  before update on public.japams
  for each row execute function public._test_guard_no_unarchive();

-- =============================================================================
-- SECTION 2: ERROR PATHS
-- Each scenario runs its setup as postgres, then switches to the `authenticated`
-- identity for the failing RPC call. An explicit psql-level SAVEPOINT + ROLLBACK TO
-- discards the scenario (setup + call), so the fixture stays pristine for the next
-- scenario and for the success test. SET ROLE is transactional, so the ROLLBACK TO
-- also reverts the role.
-- =============================================================================

-- 2a. WRONG OWNER BLOCKS (auth.uid() = a different user, no legacy identity)
set role authenticated;
set request.jwt.claim.sub = 'd4444444-4444-4444-8444-444444444444';
set request.jwt.claims = '{"sub":"d4444444-4444-4444-8444-444444444444"}';

do $$
begin
  begin
    perform public.consolidate_duplicate_my_japam(
      'b2222222-2222-4222-8222-222222222222',
      'c3333333-3333-4333-8333-333333333333');
    raise exception '2a wrong owner unexpectedly succeeded';
  exception when others then
    if sqlerrm not like '%not owned by the caller%' then raise; end if;
  end;
end $$;

reset role;

-- 2b. DUPLICATE GROUP REFERENCE BLOCKS
savepoint sp_2b;

insert into public.groups (id, name, invite_code, created_by, created_at, is_active) values
  ('99999999-6666-4777-8888-999999999999', 'Other group', 'FIXTURE3', 'a1111111-1111-4111-8111-111111111111', now(), true);
insert into public.group_members (id, group_id, user_id, user_name, role, joined_at, japam_id) values
  ('88888888-7777-4888-8999-aaaaaaaaaaaa', '99999999-6666-4777-8888-999999999999',
   'a1111111-1111-4111-8111-111111111111', 'Fixture Owner', 'member', now(), 'c3333333-3333-4333-8333-333333333333');

set role authenticated;
set request.jwt.claim.sub = 'a1111111-1111-4111-8111-111111111111';
set request.jwt.claims = '{"sub":"a1111111-1111-4111-8111-111111111111"}';

do $$
begin
  begin
    perform public.consolidate_duplicate_my_japam(
      'b2222222-2222-4222-8222-222222222222',
      'c3333333-3333-4333-8333-333333333333');
    raise exception '2b duplicate group reference unexpectedly succeeded';
  exception when others then
    if sqlerrm not like '%has group membership%' then raise; end if;
  end;
end $$;

rollback to savepoint sp_2b;

-- 2c. UNEXPECTED REFERENCE: DUPLICATE ALREADY TOMBSTONED BLOCKS
savepoint sp_2c;

insert into public.deleted_japams (japam_id, user_id, deleted_at) values
  ('c3333333-3333-4333-8333-333333333333', 'a1111111-1111-4111-8111-111111111111', now());

set role authenticated;
set request.jwt.claim.sub = 'a1111111-1111-4111-8111-111111111111';
set request.jwt.claims = '{"sub":"a1111111-1111-4111-8111-111111111111"}';

do $$
begin
  begin
    perform public.consolidate_duplicate_my_japam(
      'b2222222-2222-4222-8222-222222222222',
      'c3333333-3333-4333-8333-333333333333');
    raise exception '2c duplicate tombstone unexpectedly succeeded';
  exception when others then
    if sqlerrm not like '%already tombstoned%' then raise; end if;
  end;
end $$;

rollback to savepoint sp_2c;

-- 2d. TOTALS MISMATCH: COMPLETION_ID COLLISION ROLLS BACK
-- The global unique INDEX on completion_id makes a genuine collision unreachable,
-- so we drop the index inside the savepoint (DDL is transactional) to simulate the
-- corrupt legacy state the RPC's guard is defending against, then verify the RPC
-- detects the colliding pair and aborts before moving any History. The colliding
-- row is inserted on the ACTIVE duplicate japam (canonical is archived, so the
-- fixture guard blocks canonical-side writes).
savepoint sp_2d;

drop index public.japam_history_completion_id_unique;

insert into public.japam_history
  (user_id, malas, count, completion_id, japam_name, japam_id, created_at, japam_slot)
values
  ('a1111111-1111-4111-8111-111111111111', 1, 108, 'canon-fixture-000001', 'My Japam',
   'c3333333-3333-4333-8333-333333333333', now() - interval '69 minutes', 2);

set role authenticated;
set request.jwt.claim.sub = 'a1111111-1111-4111-8111-111111111111';
set request.jwt.claims = '{"sub":"a1111111-1111-4111-8111-111111111111"}';

do $$
begin
  begin
    perform public.consolidate_duplicate_my_japam(
      'b2222222-2222-4222-8222-222222222222',
      'c3333333-3333-4333-8333-333333333333');
    raise exception '2d completion_id collision unexpectedly succeeded';
  exception when others then
    if sqlerrm not like '%completion_id collision%' then raise; end if;
  end;
end $$;

rollback to savepoint sp_2d;

-- 2e. UNEXPECTED REFERENCE: PENDING MARKER ON DUPLICATE BLOCKS
savepoint sp_2e;

insert into public.pending_japam_adoption (id, user_id, japam_id, created_at) values
  (gen_random_uuid(), 'a1111111-1111-4111-8111-111111111111', 'c3333333-3333-4333-8333-333333333333', now());

set role authenticated;
set request.jwt.claim.sub = 'a1111111-1111-4111-8111-111111111111';
set request.jwt.claims = '{"sub":"a1111111-1111-4111-8111-111111111111"}';

do $$
begin
  begin
    perform public.consolidate_duplicate_my_japam(
      'b2222222-2222-4222-8222-222222222222',
      'c3333333-3333-4333-8333-333333333333');
    raise exception '2e pending marker on duplicate unexpectedly succeeded';
  exception when others then
    if sqlerrm not like '%pending adoption marker%' then raise; end if;
  end;
end $$;

rollback to savepoint sp_2e;

-- 2f. UNEXPECTED OWNERSHIP: FOREIGN-OWNED HISTORY ON DUPLICATE BLOCKS
savepoint sp_2f;

insert into public.japam_history
  (user_id, malas, count, completion_id, japam_name, japam_id, created_at, japam_slot)
values
  ('d4444444-4444-4444-8444-444444444444', 1, 108, 'foreign-fixture-000001', 'My Japam',
   'c3333333-3333-4333-8333-333333333333', now() - interval '60 minutes', 3);

set role authenticated;
set request.jwt.claim.sub = 'a1111111-1111-4111-8111-111111111111';
set request.jwt.claims = '{"sub":"a1111111-1111-4111-8111-111111111111"}';

do $$
begin
  begin
    perform public.consolidate_duplicate_my_japam(
      'b2222222-2222-4222-8222-222222222222',
      'c3333333-3333-4333-8333-333333333333');
    raise exception '2f foreign history unexpectedly succeeded';
  exception when others then
    if sqlerrm not like '%owned by another user%' then raise; end if;
  end;
end $$;

rollback to savepoint sp_2f;

-- All error paths rolled back: fixture must be back to the pristine shape.
do $$
declare
  v int;
begin
  select count(*) into v from public.japam_history
    where user_id = 'a1111111-1111-4111-8111-111111111111';
  assert v = 508, 'error paths must leave the fixture untouched';

  select count(*) into v from public.japam_history
    where user_id = 'a1111111-1111-4111-8111-111111111111' and japam_id = 'c3333333-3333-4333-8333-333333333333';
  assert v = 2, 'duplicate history must still be 2 rows';

  select count(*) into v from public.deleted_japams where japam_id = 'c3333333-3333-4333-8333-333333333333';
  assert v = 0, 'duplicate tombstone from 2c must have rolled back';

  select count(*) into v from public.group_members where japam_id = 'c3333333-3333-4333-8333-333333333333';
  assert v = 0, 'duplicate group ref from 2b must have rolled back';

  select count(*) into v from public.pending_japam_adoption where japam_id = 'c3333333-3333-4333-8333-333333333333';
  assert v = 0, 'duplicate marker from 2e must have rolled back';
end $$;

-- =============================================================================
-- SECTION 3: SUCCESSFUL CONSOLIDATION (LEGACY auth.jwt user_metadata.sub identity)
-- auth.uid() resolves to a DIFFERENT uuid than the stored japams.user_id; only the
-- legacy jwt user_metadata.sub matches, proving the RPC scopes every write by the
-- Japam rows' actual user_id (same identity-consistency fix as restore_owned_japam).
-- =============================================================================
set role authenticated;
set request.jwt.claim.sub = 'e5555555-5555-4555-8555-555555555555';
set request.jwt.claims =
  '{"sub":"e5555555-5555-4555-8555-555555555555","user_metadata":{"sub":"a1111111-1111-4111-8111-111111111111"}}';

create temp table rpc_result as
select * from public.consolidate_duplicate_my_japam(
  'b2222222-2222-4222-8222-222222222222',
  'c3333333-3333-4333-8333-333333333333');

reset role;

do $$
declare
  v bigint;
begin
  select before_canonical_history into v from rpc_result;
  assert v = 506, 'before_canonical_history must be 506';
  select before_canonical_malas into v from rpc_result;
  assert v = 602, 'before_canonical_malas must be 602';
  select before_canonical_count into v from rpc_result;
  assert v = 65016, 'before_canonical_count must be 65016';

  select before_duplicate_history into v from rpc_result;
  assert v = 2, 'before_duplicate_history must be 2';
  select before_duplicate_malas into v from rpc_result;
  assert v = 2, 'before_duplicate_malas must be 2';
  select before_duplicate_count into v from rpc_result;
  assert v = 216, 'before_duplicate_count must be 216';

  select moved_history into v from rpc_result;
  assert v = 2, 'moved_history must be 2';

  select after_canonical_history into v from rpc_result;
  assert v = 508, 'after_canonical_history must be 508';
  select after_canonical_malas into v from rpc_result;
  assert v = 604, 'after_canonical_malas must be 604';
  select after_canonical_count into v from rpc_result;
  assert v = 65232, 'after_canonical_count must be 65232';

  select after_duplicate_history into v from rpc_result;
  assert v = 0, 'after_duplicate_history must be 0';

  select active_normalized_my_japam into v from rpc_result;
  assert v = 1, 'exactly one active normalized My Japam';

  select adoption_markers into v from rpc_result;
  assert v = 1, 'exactly one adoption marker';
end $$;

-- Every History ID still exists exactly once; the two moved rows keep every field.
do $$
declare
  v int;
begin
  -- No History row was inserted or deleted: total rows still 508.
  select count(*) into v from public.japam_history
    where user_id = 'a1111111-1111-4111-8111-111111111111';
  assert v = 508, 'total History rows must remain 508 (no insert/delete)';

  -- All 508 completion_ids still exist exactly once (no duplicates, no loss).
  select count(*) into v from (
    select completion_id from public.japam_history
    where user_id = 'a1111111-1111-4111-8111-111111111111'
    group by completion_id having count(*) > 1
  ) d;
  assert v = 0, 'no History completion_id may be duplicated';

  select count(*) into v from public.japam_history
    where user_id = 'a1111111-1111-4111-8111-111111111111'
      and completion_id like 'dup-fixture-%';
  assert v = 2, 'the two moved duplicate rows must still exist';
end $$;

-- The moved rows preserved id, created_at, malas, count, completion_id, user_name
-- and japam_name; only japam_id changed to the canonical.
do $$
declare
  r record;
begin
  for r in
    select b.id as orig_id, b.created_at as orig_created, b.malas as orig_malas,
           b.count as orig_count, b.completion_id as orig_completion,
           b.user_name as orig_uname, b.japam_name as orig_jname
    from dup_history_before b
  loop
    perform 1 from public.japam_history h
    where h.completion_id = r.orig_completion
      and h.user_id = 'a1111111-1111-4111-8111-111111111111'
      and h.id = r.orig_id
      and h.created_at = r.orig_created
      and h.malas = r.orig_malas
      and h.count = r.orig_count
      and h.user_name is not distinct from r.orig_uname
      and h.japam_name = r.orig_jname
      and h.japam_id = 'b2222222-2222-4222-8222-222222222222';
    if not found then
      raise exception 'moved History row % lost or altered during consolidation', r.orig_completion;
    end if;
  end loop;
end $$;

-- Canonical unarchived + tombstone removed; duplicate archived + tombstoned.
do $$
declare
  v_archived timestamptz;
  v int;
begin
  select archived_at into v_archived from public.japams where id = 'b2222222-2222-4222-8222-222222222222';
  assert v_archived is null, 'canonical must be unarchived';

  select count(*) into v from public.deleted_japams where japam_id = 'b2222222-2222-4222-8222-222222222222';
  assert v = 0, 'canonical tombstone must be removed';

  select archived_at into v_archived from public.japams where id = 'c3333333-3333-4333-8333-333333333333';
  assert v_archived is not null, 'duplicate must be archived';

  select count(*) into v from public.deleted_japams where japam_id = 'c3333333-3333-4333-8333-333333333333';
  assert v = 1, 'duplicate must be tombstoned exactly once';
end $$;

-- Group refs unchanged: canonical 2, duplicate 0. Groups never touched.
do $$
declare
  v int;
begin
  select count(*) into v from public.group_members where japam_id = 'b2222222-2222-4222-8222-222222222222';
  assert v = 2, 'canonical group refs must remain 2';

  select count(*) into v from public.group_members where japam_id = 'c3333333-3333-4333-8333-333333333333';
  assert v = 0, 'duplicate group refs must remain 0';

  select count(*) into v from public.groups where created_by = 'a1111111-1111-4111-8111-111111111111' and is_active;
  assert v = 2, 'groups must be untouched (2 fixture groups)';
end $$;

-- Exactly one active normalized My Japam, and it is the canonical.
do $$
declare
  v_count int;
  v_id uuid;
begin
  select count(*) into v_count from public.japams
    where user_id = 'a1111111-1111-4111-8111-111111111111'
      and archived_at is null
      and lower(btrim(regexp_replace(name, '\s+'::text, ' '::text, 'g'::text))) = 'my japam';
  assert v_count = 1, 'exactly one active normalized My Japam';
  select id into v_id from public.japams
    where user_id = 'a1111111-1111-4111-8111-111111111111'
      and archived_at is null
      and lower(btrim(regexp_replace(name, '\s+'::text, ' '::text, 'g'::text))) = 'my japam'
    limit 1;
  assert v_id = 'b2222222-2222-4222-8222-222222222222', 'the active one must be the canonical';
end $$;

-- Exactly one adoption marker for the canonical.
do $$
declare
  v_count int;
  v_japam_id uuid;
begin
  select count(*) into v_count from public.pending_japam_adoption
    where user_id = 'a1111111-1111-4111-8111-111111111111' and japam_id = 'b2222222-2222-4222-8222-222222222222';
  assert v_count = 1, 'exactly one adoption marker for canonical';
  select japam_id into v_japam_id from public.pending_japam_adoption
    where user_id = 'a1111111-1111-4111-8111-111111111111' and japam_id = 'b2222222-2222-4222-8222-222222222222'
    limit 1;
  assert v_japam_id = 'b2222222-2222-4222-8222-222222222222', 'marker must reference canonical';
end $$;

-- =============================================================================
-- SECTION 4: REPEATED CALL FAILS CLOSED (no duplication)
-- =============================================================================
set role authenticated;
set request.jwt.claim.sub = 'e5555555-5555-4555-8555-555555555555';
set request.jwt.claims =
  '{"sub":"e5555555-5555-4555-8555-555555555555","user_metadata":{"sub":"a1111111-1111-4111-8111-111111111111"}}';

do $$
begin
  begin
    perform public.consolidate_duplicate_my_japam(
      'b2222222-2222-4222-8222-222222222222',
      'c3333333-3333-4333-8333-333333333333');
    raise exception '4 repeated call unexpectedly succeeded';
  exception when others then
    if sqlerrm not like '%canonical Japam must be archived%' then raise; end if;
  end;
end $$;

reset role;

-- No duplication: totals unchanged after the rejected second call.
do $$
declare
  v int;
begin
  select count(*) into v from public.japam_history
    where user_id = 'a1111111-1111-4111-8111-111111111111';
  assert v = 508, 'repeated call must not duplicate History';

  select count(*) into v from public.pending_japam_adoption
    where user_id = 'a1111111-1111-4111-8111-111111111111' and japam_id = 'b2222222-2222-4222-8222-222222222222';
  assert v = 1, 'repeated call must not add a second marker';

  select count(*) into v from public.japams
    where user_id = 'a1111111-1111-4111-8111-111111111111' and archived_at is null;
  assert v = 1, 'repeated call must not resurrect or create active japams';
end $$;

-- =============================================================================
-- SECTION 5: FINAL ROLLBACK — the ENTIRE test (fixture + consolidation + guards)
-- is discarded, proving the RPC only ever commits inside the caller's transaction.
-- =============================================================================
rollback;

do $$
declare
  v int;
begin
  select count(*) into v from public.japams
    where id in ('b2222222-2222-4222-8222-222222222222', 'c3333333-3333-4333-8333-333333333333');
  assert v = 0, 'fixture japams must be gone after rollback';

  select count(*) into v from public.japam_history
    where user_id = 'a1111111-1111-4111-8111-111111111111';
  assert v = 0, 'fixture history must be gone after rollback';

  select count(*) into v from public.pending_japam_adoption
    where user_id = 'a1111111-1111-4111-8111-111111111111';
  assert v = 0, 'adoption markers must be gone after rollback';

  select count(*) into v from public.group_members
    where user_id = 'a1111111-1111-4111-8111-111111111111';
  assert v = 0, 'fixture memberships must be gone after rollback';

  select count(*) into v from public.groups
    where created_by = 'a1111111-1111-4111-8111-111111111111';
  assert v = 0, 'fixture groups must be gone after rollback';

  select count(*) into v from public.deleted_japams
    where user_id = 'a1111111-1111-4111-8111-111111111111';
  assert v = 0, 'fixture tombstones must be gone after rollback';
end $$;
