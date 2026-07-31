-- Local-Supabase-only integration test for Issue 3 (Groups workspace isolation):
-- db/groups_workspace_isolation.sql.
--
-- Run against the LOCAL dockerized Supabase only:
--   docker exec -i supabase_db_JapamApp psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
--     -f db/__tests__/groups_workspace_isolation.local.sql
--
-- Never run against staging or production. The whole script is one transaction that ROLLs BACK,
-- so it never leaves test data behind (the rollback is verified externally after the run).
--
-- Scenario (per the issue):
--   User A owns Workspaces A1 + A2; User B owns Workspaces B1 + B2; User C owns C1 (legacy
--   unassigned membership); User D owns D1 (non-member); User E owns E1 (legacy-wrapper checks).
--   A creates Group X from A1; B joins Group X from B1. A records activity in A1 and A2;
--   B records activity in B1 and B2. Group X's dashboard must count only A1 + B1.
\set ON_ERROR_STOP 1
begin;

-- Runtime values that need to reach plpgsql DO blocks (psql does not interpolate :vars inside
-- dollar-quoted bodies) are captured here and read back with `from ctx where k = ...`.
create temp table ctx (k text primary key, v text);

-- ─────────────────────────────────────────────────────────────────────────────
-- PART 0: conservative backfill behavior on pre-migration state.
-- A "legacy" group with memberships that carry no japam_id, exactly as rows created
-- before Japams exist would look. Backfill must assign only where the member owns exactly
-- ONE active Japam, and must report backfilled/ambiguous/no-active counts.
-- ─────────────────────────────────────────────────────────────────────────────
insert into public.japams (id, user_id, name, created_at, updated_at, archived_at) values
  ('b0000000-0000-0000-0000-0000000000a1', 'a0000000-0000-0000-0000-000000000001', 'A1', now(), now(), null),
  ('b0000000-0000-0000-0000-0000000000a2', 'a0000000-0000-0000-0000-000000000001', 'A2', now(), now(), null),
  ('b0000000-0000-0000-0000-0000000000b1', 'a0000000-0000-0000-0000-000000000002', 'B1', now(), now(), null),
  ('b0000000-0000-0000-0000-0000000000b2', 'a0000000-0000-0000-0000-000000000002', 'B2', now(), now(), null),
  ('b0000000-0000-0000-0000-0000000000c1', 'a0000000-0000-0000-0000-000000000003', 'C1', now(), now(), null),
  ('b0000000-0000-0000-0000-0000000000d1', 'a0000000-0000-0000-0000-000000000004', 'D1', now(), now(), null),
  ('b0000000-0000-0000-0000-0000000000e1', 'a0000000-0000-0000-0000-000000000005', 'E1', now(), now(), null);

insert into public.groups (id, name, invite_code, created_by, created_at, is_active) values
  ('90000000-0000-0000-0000-0000000000f1', 'Legacy Backfill Group', 'LBF1CODE', 'a0000000-0000-0000-0000-000000000001', now(), true);

insert into public.group_members (id, group_id, user_id, user_name, role, joined_at, japam_id) values
  ('91000000-0000-0000-0000-0000000000a1', '90000000-0000-0000-0000-0000000000f1', 'a0000000-0000-0000-0000-000000000001', 'Anand',   'admin',  now(), null),
  ('91000000-0000-0000-0000-0000000000a2', '90000000-0000-0000-0000-0000000000f1', 'a0000000-0000-0000-0000-000000000005', 'Esha',    'member', now(), null),
  ('91000000-0000-0000-0000-0000000000a3', '90000000-0000-0000-0000-0000000000f1', 'a0000000-0000-0000-0000-000000000003', 'Chandra', 'member', now(), null);

select 'PART 0: backfill report' as section;
select * from public._groups_backfill_unassigned_memberships();

do $$
declare v_j uuid; v_n bigint;
begin
  select japam_id into v_j from public.group_members where id = '91000000-0000-0000-0000-0000000000a1';
  assert v_j is null, 'A owns two active Japams -> membership must stay unassigned (ambiguous)';

  select japam_id into v_j from public.group_members where id = '91000000-0000-0000-0000-0000000000a2';
  assert v_j = 'b0000000-0000-0000-0000-0000000000e1', 'E owns exactly one active Japam -> backfilled to E1';

  select japam_id into v_j from public.group_members where id = '91000000-0000-0000-0000-0000000000a3';
  assert v_j = 'b0000000-0000-0000-0000-0000000000c1', 'C owns exactly one active Japam -> backfilled to C1';

  select count(*) into v_n from public.group_members where id = '91000000-0000-0000-0000-0000000000a1' and japam_id is null;
  assert v_n = 1, 'ambiguity must leave the membership null';
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- PART 1: main isolation scenario (the required checks).
-- ─────────────────────────────────────────────────────────────────────────────
set request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000001';
select * from public.create_group('Group X', 'a0000000-0000-0000-0000-000000000001', 'Anand', 'b0000000-0000-0000-0000-0000000000a1') \gset groupx_

insert into ctx values
  ('groupx_group_id', :'groupx_group_id'),
  ('groupx_invite_code', :'groupx_invite_code');

select 'PART 1: created Group X' as section;
select :'groupx_group_id' as group_id, :'groupx_invite_code' as invite_code;

-- User B joins Group X from B1.
set request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000002';
select * from public.join_group_by_invite_code(:'groupx_invite_code', 'Bala', 'b0000000-0000-0000-0000-0000000000b1') \gset joinx_

insert into ctx values ('joinx_id', :'joinx_id'), ('joinx_already_member', :'joinx_already_member');

do $$
declare v_id uuid; v_am boolean;
begin
  select v::uuid into v_id from ctx where k = 'joinx_id';
  select v::boolean into v_am from ctx where k = 'joinx_already_member';
  assert v_id is not null, 'join must return the group';
  assert not v_am, 'B is a new member';
end $$;

-- Activity: A in A1 (2+1 malas) and A2 (4 malas); B in B1 (5 malas) and B2 (6 malas).
insert into public.japam_history (user_id, malas, count, completion_id, japam_name, japam_id, created_at) values
  ('a0000000-0000-0000-0000-000000000001', 2, 216, 'c0000000-0000-0000-0000-00000000a1', 'A1', 'b0000000-0000-0000-0000-0000000000a1', now() - interval '2 hours'),
  ('a0000000-0000-0000-0000-000000000001', 1, 108, 'c0000000-0000-0000-0000-00000000a2', 'A1', 'b0000000-0000-0000-0000-0000000000a1', now() - interval '1 hours'),
  ('a0000000-0000-0000-0000-000000000001', 4, 432, 'c0000000-0000-0000-0000-00000000a3', 'A2', 'b0000000-0000-0000-0000-0000000000a2', now() - interval '3 hours'),
  ('a0000000-0000-0000-0000-000000000002', 5, 540, 'c0000000-0000-0000-0000-00000000b1', 'B1', 'b0000000-0000-0000-0000-0000000000b1', now() - interval '30 minutes'),
  ('a0000000-0000-0000-0000-000000000002', 6, 648, 'c0000000-0000-0000-0000-00000000b2', 'B2', 'b0000000-0000-0000-0000-0000000000b2', now() - interval '4 hours');

-- An "unassigned" (legacy, japam_id null) membership for User C in Group X — simulates a member
-- who joined before Japams existed (or whose Japam was deleted). It must never contribute.
insert into public.group_members (group_id, user_id, user_name, role, joined_at, japam_id) values
  (:'groupx_group_id', 'a0000000-0000-0000-0000-000000000003', 'Chandra', 'member', now(), null);

-- ── Check 1 + 2 (dashboard counts only A1 + B1) ─────────────────────────────
set request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000001';
select 'CHECK 1/2: Group X dashboard counts only A1 + B1 (A2/B2 excluded, C ignored)' as section;

do $$
declare
  v_grp uuid;
  v_a_total int; v_a_count int; v_b_total int; v_b_count int; v_rows int;
begin
  select v::uuid into v_grp from ctx where k = 'groupx_group_id';

  select total_malas, total_count into v_a_total, v_a_count
  from public.get_group_dashboard(
    v_grp, 'a0000000-0000-0000-0000-000000000001',
    date_trunc('day', now()), date_trunc('day', now()) + interval '1 day',
    'b0000000-0000-0000-0000-0000000000a1')
  where user_id = 'a0000000-0000-0000-0000-000000000001';
  assert v_a_total = 3, 'A dashboard total must be A1 only (3 malas)';
  assert v_a_count = 324, 'A dashboard count must be A1 only (324)';

  select total_malas, total_count into v_b_total, v_b_count
  from public.get_group_dashboard(
    v_grp, 'a0000000-0000-0000-0000-000000000001',
    date_trunc('day', now()), date_trunc('day', now()) + interval '1 day',
    'b0000000-0000-0000-0000-0000000000a1')
  where user_id = 'a0000000-0000-0000-0000-000000000002';
  assert v_b_total = 5, 'B dashboard total must be B1 only (5 malas)';
  assert v_b_count = 540, 'B dashboard count must be B1 only (540)';

  select count(*) into v_rows
  from public.get_group_dashboard(
    v_grp, 'a0000000-0000-0000-0000-000000000001',
    date_trunc('day', now()), date_trunc('day', now()) + interval '1 day',
    'b0000000-0000-0000-0000-0000000000a1');
  assert v_rows = 2, 'dashboard rows must be exactly A and B (unassigned C ignored)';
end $$;

-- ── Check 3 + 4 (Group X appears under A1/B1 only, never A2/B2) ──────────────
select 'CHECK 3/4: get_my_groups is workspace-scoped' as section;

do $$
declare v_c int;
begin
  select count(*) into v_c from public.get_my_groups('a0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-0000000000a1') g where g.name = 'Group X';
  assert v_c = 1, 'A sees Group X under A1';
  select count(*) into v_c from public.get_my_groups('a0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-0000000000a2') g where g.name = 'Group X';
  assert v_c = 0, 'A must NOT see Group X under A2';
end $$;

set request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000002';
do $$
declare v_c int;
begin
  select count(*) into v_c from public.get_my_groups('a0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-0000000000b1') g where g.name = 'Group X';
  assert v_c = 1, 'B sees Group X under B1';
  select count(*) into v_c from public.get_my_groups('a0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-0000000000b2') g where g.name = 'Group X';
  assert v_c = 0, 'B must NOT see Group X under B2';
end $$;

-- ── Check 5 (wrong-workspace dashboard request is rejected) ─────────────────
select 'CHECK 5: wrong-workspace dashboard requests are rejected' as section;

set request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000001';
do $$
declare v_grp uuid;
begin
  select v::uuid into v_grp from ctx where k = 'groupx_group_id';
  begin
    perform 1 from public.get_group_dashboard(
      v_grp, 'a0000000-0000-0000-0000-000000000001',
      date_trunc('day', now()), date_trunc('day', now()) + interval '1 day',
      'b0000000-0000-0000-0000-0000000000a2');
    raise exception 'expected workspace-mismatch rejection (A2)';
  exception when others then
    if sqlerrm like '%selected workspace does not match this group membership%' then
      raise notice 'PASS: A2 dashboard rejected (A is attached to A1)';
    else raise; end if;
  end;
end $$;

do $$
declare v_grp uuid;
begin
  select v::uuid into v_grp from ctx where k = 'groupx_group_id';
  begin
    perform 1 from public.get_group_dashboard(
      v_grp, 'a0000000-0000-0000-0000-000000000001',
      date_trunc('day', now()), date_trunc('day', now()) + interval '1 day',
      'b0000000-0000-0000-0000-0000000000b1');
    raise exception 'expected workspace-mismatch rejection (B1 is not A''s mapping)';
  exception when others then
    if sqlerrm like '%selected workspace does not match this group membership%' then
      raise notice 'PASS: B1 dashboard rejected for A';
    else raise; end if;
  end;
end $$;

do $$
declare v_grp uuid;
begin
  select v::uuid into v_grp from ctx where k = 'groupx_group_id';
  begin
    perform 1 from public.get_group_dashboard(
      v_grp, 'a0000000-0000-0000-0000-000000000001',
      date_trunc('day', now()), date_trunc('day', now()) + interval '1 day',
      'b0000000-0000-0000-0000-0000000000d1');
    raise exception 'expected ownership rejection (D1 is not owned by A)';
  exception when others then
    if sqlerrm like '%selected workspace does not match this group membership%' or sqlerrm like '%does not belong to your account%' then
      raise notice 'PASS: unowned workspace rejected';
    else raise; end if;
  end;
end $$;

-- ── Check 6 (unassigned memberships do not contribute; listed as unassigned) ─
select 'CHECK 6: unassigned memberships' as section;

set request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000003';
do $$
declare v_c int;
begin
  select count(*) into v_c from public.get_my_unassigned_groups() g where g.name = 'Group X';
  assert v_c = 1, 'C sees Group X under Unassigned';
  select count(*) into v_c from public.get_my_unassigned_groups() g where g.name = 'Legacy Backfill Group';
  assert v_c = 0, 'C''s backfill-group membership was attached to C1, not unassigned';
end $$;

-- ── Check 7 + 8 (attach works once and only for its owner) ──────────────────
select 'CHECK 7/8: attach_group_membership_to_japam' as section;

do $$
declare v_grp uuid;
begin
  select v::uuid into v_grp from ctx where k = 'groupx_group_id';
  perform public.attach_group_membership_to_japam(v_grp, 'b0000000-0000-0000-0000-0000000000c1');
  raise notice 'PASS: C attached Group X membership to C1';
end $$;

do $$
declare v_grp uuid;
begin
  select v::uuid into v_grp from ctx where k = 'groupx_group_id';
  begin
    perform public.attach_group_membership_to_japam(v_grp, 'b0000000-0000-0000-0000-0000000000c1');
    raise exception 'expected already-attached rejection';
  exception when others then
    if sqlerrm like '%already attached%' then
      raise notice 'PASS: second attach rejected (already attached)';
    else raise; end if;
  end;
end $$;

-- Another user (B) cannot change C's mapping; B's own is already attached and stays B1.
set request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000002';
do $$
declare v_grp uuid;
begin
  select v::uuid into v_grp from ctx where k = 'groupx_group_id';
  begin
    perform public.attach_group_membership_to_japam(v_grp, 'b0000000-0000-0000-0000-0000000000b1');
    raise exception 'expected already-attached rejection for B';
  exception when others then
    if sqlerrm like '%already attached%' then
      raise notice 'PASS: B cannot re-map an already-attached membership';
    else raise; end if;
  end;
end $$;

set request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000001';
do $$
declare v_grp uuid; v_j uuid;
begin
  select v::uuid into v_grp from ctx where k = 'groupx_group_id';
  select japam_id into v_j from public.group_members
   where group_id = v_grp and user_id = 'a0000000-0000-0000-0000-000000000001';
  assert v_j = 'b0000000-0000-0000-0000-0000000000a1', 'A''s mapping must be untouched by B''s attempts';
end $$;

-- ── Legacy wrappers: sole-active-japam auto-bind and clear errors ────────────
-- (Runs before A1 is deleted so A still owns two active Japams for the failure checks.)
select 'LEGACY WRAPPERS' as section;

-- E owns exactly one active Japam (E1): legacy create binds to it.
set request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000005';
select * from public.create_group('Legacy E Group', 'a0000000-0000-0000-0000-000000000005', 'Esha') \gset legacye_

insert into ctx values ('legacye_group_id', :'legacye_group_id');

do $$
declare v_grp uuid; v_j uuid;
begin
  select v::uuid into v_grp from ctx where k = 'legacye_group_id';
  select japam_id into v_j from public.group_members
   where group_id = v_grp and user_id = 'a0000000-0000-0000-0000-000000000005';
  assert v_j = 'b0000000-0000-0000-0000-0000000000e1', 'legacy create must auto-bind to the sole active Japam';
end $$;

-- E's legacy 1-arg get_my_groups returns the group (scoped to E1).
do $$
declare v_c int;
begin
  select count(*) into v_c from public.get_my_groups('a0000000-0000-0000-0000-000000000005') g where g.name = 'Legacy E Group';
  assert v_c = 1, 'legacy get_my_groups returns the sole-scope list';
end $$;

-- A owns two active Japams (A1 + A2 at this point): legacy calls must fail clearly, never cross-scope.
set request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000001';
do $$
begin
  begin
    perform * from public.get_my_groups('a0000000-0000-0000-0000-000000000001');
    raise exception 'expected multiple-japams rejection';
  exception when others then
    if sqlerrm like '%multiple active Japams%' then
      raise notice 'PASS: legacy list fails clearly for multi-japam A';
    else raise; end if;
  end;
end $$;

do $$
begin
  begin
    perform * from public.create_group('Should Fail', 'a0000000-0000-0000-0000-000000000001', 'Anand');
    raise exception 'expected multiple-japams rejection';
  exception when others then
    if sqlerrm like '%multiple active Japams%' then
      raise notice 'PASS: legacy create fails clearly for multi-japam A';
    else raise; end if;
  end;
end $$;

-- ── Check 9 + 10 (permanent delete of A1 unassigns only A; group + B survive) ─
select 'CHECK 9/10: permanent Japam deletion interaction' as section;

set request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000001';
do $$
declare v_row record;
begin
  select * into v_row from public.delete_owned_japam('b0000000-0000-0000-0000-0000000000a1');
  assert v_row.deleted_japam_id = 'b0000000-0000-0000-0000-0000000000a1', 'A1 deleted';
end $$;

do $$
declare v_grp uuid; v_j uuid; v_g int;
begin
  select v::uuid into v_grp from ctx where k = 'groupx_group_id';

  select japam_id into v_j from public.group_members
   where group_id = v_grp and user_id = 'a0000000-0000-0000-0000-000000000001';
  assert v_j is null, 'A''s Group X membership unassigned after A1 deletion';

  select count(*) into v_g from public.groups where id = v_grp;
  assert v_g = 1, 'Group X survives Japam deletion';

  select japam_id into v_j from public.group_members
   where group_id = v_grp and user_id = 'a0000000-0000-0000-0000-000000000002';
  assert v_j = 'b0000000-0000-0000-0000-0000000000b1', 'B''s B1 mapping survives';
end $$;

-- A now sees Group X only under Unassigned.
do $$
declare v_c int;
begin
  select count(*) into v_c from public.get_my_unassigned_groups() g where g.name = 'Group X';
  assert v_c = 1, 'A sees Group X under Unassigned after deletion';
end $$;

-- Dashboard (as B, B1) no longer counts deleted A1 history; A excluded as unassigned. C's
-- membership was attached to C1 earlier, so C still appears as a zero-total member row.
set request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000002';
do $$
declare v_grp uuid; v_b_total int; v_a_rows int; v_c_rows int;
begin
  select v::uuid into v_grp from ctx where k = 'groupx_group_id';

  select total_malas into v_b_total
  from public.get_group_dashboard(
    v_grp, 'a0000000-0000-0000-0000-000000000002',
    date_trunc('day', now()), date_trunc('day', now()) + interval '1 day',
    'b0000000-0000-0000-0000-0000000000b1')
  where user_id = 'a0000000-0000-0000-0000-000000000002';
  assert v_b_total = 5, 'B still sees only B1 (5 malas)';

  select count(*) into v_a_rows
  from public.get_group_dashboard(
    v_grp, 'a0000000-0000-0000-0000-000000000002',
    date_trunc('day', now()), date_trunc('day', now()) + interval '1 day',
    'b0000000-0000-0000-0000-0000000000b1')
  where user_id = 'a0000000-0000-0000-0000-000000000001';
  assert v_a_rows = 0, 'unassigned A contributes no row and no deleted history contributes';

  select count(*) into v_c_rows
  from public.get_group_dashboard(
    v_grp, 'a0000000-0000-0000-0000-000000000002',
    date_trunc('day', now()), date_trunc('day', now()) + interval '1 day',
    'b0000000-0000-0000-0000-0000000000b1')
  where user_id = 'a0000000-0000-0000-0000-000000000003';
  assert v_c_rows = 1, 'attached C still shows as a zero-total member';
end $$;

-- ── Check 11 (non-member access rejected everywhere) ─────────────────────────
select 'CHECK 11: non-member access rejected' as section;

set request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000004';
do $$
declare v_grp uuid;
begin
  select v::uuid into v_grp from ctx where k = 'groupx_group_id';
  begin
    perform 1 from public.get_group_dashboard(
      v_grp, 'a0000000-0000-0000-0000-000000000004',
      date_trunc('day', now()), date_trunc('day', now()) + interval '1 day',
      'b0000000-0000-0000-0000-0000000000d1');
    raise exception 'expected non-member rejection';
  exception when others then
    if sqlerrm like '%not a member of this group%' then
      raise notice 'PASS: non-member dashboard rejected';
    else raise; end if;
  end;
end $$;

do $$
declare v_grp uuid;
begin
  select v::uuid into v_grp from ctx where k = 'groupx_group_id';
  begin
    perform public.attach_group_membership_to_japam(v_grp, 'b0000000-0000-0000-0000-0000000000d1');
    raise exception 'expected non-member attach rejection';
  exception when others then
    if sqlerrm like '%not a member of this group%' then
      raise notice 'PASS: non-member attach rejected';
    else raise; end if;
  end;
end $$;

do $$
declare v_c int;
begin
  select count(*) into v_c from public.get_my_groups('a0000000-0000-0000-0000-000000000004', 'b0000000-0000-0000-0000-0000000000d1');
  assert v_c = 0, 'non-member has no workspace-scoped groups';
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Sanity: data exists before rollback; the rollback below leaves the DB clean.
-- ─────────────────────────────────────────────────────────────────────────────
select 'SANITY: pre-rollback counts' as section;
select
  (select count(*) from public.groups) as groups,
  (select count(*) from public.group_members) as memberships,
  (select count(*) from public.japam_history) as history;

rollback;
