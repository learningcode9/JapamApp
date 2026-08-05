-- Local-Supabase-only reproduction for Issue 3: "Groups are not workspace-isolated".
--
-- Run against the LOCAL dockerized Supabase only:
--   docker exec -i supabase_db_JapamApp psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
--     -f db/__tests__/groups_workspace_isolation.repro.local.sql
--
-- Never run against staging or production. The whole script is one transaction that ROLLS BACK,
-- so it never leaves test data behind.
--
-- Scenario (per the issue): a "workspace" in this app IS a Japam (lib/japams.ts: "A Japam is the
-- primary entity of this app: a user-created, user-named workspace"). So:
--   Workspace A  = Japam "Gayatri"  (WS-A)
--   Workspace B  = Japam "Govinda"  (WS-B)
--   Group A      = created via create_group while the user has WS-A selected
--   Group B      = created via create_group while the user has WS-B selected
--   Activity     = japam_history rows uploaded with japam_id = WS-A.id (what the Timer/Tap/Manual
--                  upload paths send today)
\set ON_ERROR_STOP 1
begin;

-- Impersonate an authenticated user exactly as the PostgREST layer does (same pattern as
-- db/__tests__/delete_owned_japam.local.sql).
set request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000001';

-- ---------------------------------------------------------------------------------------------
-- 1) SCHEMA EVIDENCE: there is no workspace/japam column on groups, group_members, and no
--    workspaces table at all; create_group accepts no workspace parameter.
-- ---------------------------------------------------------------------------------------------
select 'SCHEMA' as section;
select c.table_name, c.column_name
from information_schema.columns c
where c.table_schema = 'public'
  and c.table_name in ('groups', 'group_members')
  and (c.column_name ilike '%workspace%' or c.column_name ilike '%japam%');

select table_name from information_schema.tables
where table_schema = 'public' and table_name = 'workspaces';

select p.proname, pg_get_function_arguments(p.oid) as args
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'create_group';

-- ---------------------------------------------------------------------------------------------
-- 2) SETUP: two workspaces (japams), two groups (created via the same create_group RPC the app
--    calls — the RPC has no way to know which workspace is "selected"), then activity in WS-A.
-- ---------------------------------------------------------------------------------------------
select 'SETUP' as section;
insert into public.japams (id, user_id, name, created_at, updated_at, archived_at) values
  ('b0000000-0000-0000-0000-0000000000a1', 'a0000000-0000-0000-0000-000000000001', 'Gayatri', now(), now(), null),
  ('b0000000-0000-0000-0000-0000000000b2', 'a0000000-0000-0000-0000-000000000001', 'Govinda', now(), now(), null);

select * from public.create_group('Family Gayatri Circle', 'a0000000-0000-0000-0000-000000000001', 'Anand') as g;
select * from public.create_group('Govinda Sangha',          'a0000000-0000-0000-0000-000000000001', 'Anand') as g;

-- Activity recorded while Workspace A ("Gayatri") is selected: 3 completions, japam_id = WS-A.
-- One more completion under WS-B to demonstrate the dashboard aggregation leak both directions.
insert into public.japam_history (user_id, malas, count, completion_id, japam_name, japam_id, created_at) values
  ('a0000000-0000-0000-0000-000000000001', 1, 108, 'c0000000-0000-0000-0000-00000000a1', 'Gayatri', 'b0000000-0000-0000-0000-0000000000a1', now()),
  ('a0000000-0000-0000-0000-000000000001', 2, 216, 'c0000000-0000-0000-0000-00000000a2', 'Gayatri', 'b0000000-0000-0000-0000-0000000000a1', now() - interval '1 hour'),
  ('a0000000-0000-0000-0000-000000000001', 1, 108, 'c0000000-0000-0000-0000-00000000a3', 'Gayatri', 'b0000000-0000-0000-0000-0000000000a1', now() - interval '2 hours'),
  ('a0000000-0000-0000-0000-000000000001', 3, 324, 'c0000000-0000-0000-0000-00000000b1', 'Govinda', 'b0000000-0000-0000-0000-0000000000b2', now() - interval '30 minutes');

select g.id, g.name, gm.role
from public.group_members gm join public.groups g on g.id = gm.group_id
where gm.user_id = 'a0000000-0000-0000-0000-000000000001'
order by g.name;

-- ---------------------------------------------------------------------------------------------
-- 3) READ EVIDENCE 1: get_my_groups — the Groups tab list. It returns BOTH groups no matter which
--    workspace is selected. There is no workspace parameter, so "switch to Workspace B and view my
--    groups" shows Group A too. Group A (created under Workspace A) leaks into the Workspace B view.
-- ---------------------------------------------------------------------------------------------
select 'READ-1: get_my_groups (Groups tab list) is user-scoped, not workspace-scoped' as evidence;
select * from public.get_my_groups('a0000000-0000-0000-0000-000000000001') order by name;

-- ---------------------------------------------------------------------------------------------
-- 4) READ EVIDENCE 2: get_group_dashboard — Group A's totals aggregate japam_history by user_id
--    ONLY (no japam_id/workspace filter). Activity recorded in Workspace B appears in Group A's
--    dashboard; activity in Workspace A appears in Group B's dashboard. The member's totals are
--    a single user-wide number regardless of which group/workspace you look at it from.
-- ---------------------------------------------------------------------------------------------
select 'READ-2: get_group_dashboard for Group A — member totals include WS-B activity' as evidence;
select gm.user_id,
       coalesce(today.today_malas, 0) as today_malas,
       coalesce(lifetime.total_malas, 0) as total_malas,
       coalesce(lifetime.total_count, 0) as total_count
from public.group_members gm
left join (
  select h.user_id, sum(h.malas) as total_malas, sum(h.count) as total_count
  from public.japam_history h
  where not exists (select 1 from public.deleted_completions dc where dc.completion_id = h.completion_id)
  group by h.user_id
) lifetime on lifetime.user_id = gm.user_id
left join (
  select h.user_id, sum(h.malas) as today_malas
  from public.japam_history h
  where h.created_at >= date_trunc('day', now()) and h.created_at < date_trunc('day', now()) + interval '1 day'
    and not exists (select 1 from public.deleted_completions dc where dc.completion_id = h.completion_id)
  group by h.user_id
) today on today.user_id = gm.user_id
where gm.group_id = (select id from public.groups where name = 'Family Gayatri Circle');

select 'READ-2b: the same member view filtered to WS-A only (what an isolated dashboard would show)' as evidence;
select h.user_id,
       sum(case when h.japam_id = 'b0000000-0000-0000-0000-0000000000a1' then h.malas else 0 end) as ws_a_malas,
       sum(case when h.japam_id = 'b0000000-0000-0000-0000-0000000000b2' then h.malas else 0 end) as ws_b_malas
from public.japam_history h
where h.user_id = 'a0000000-0000-0000-0000-000000000001'
  and not exists (select 1 from public.deleted_completions dc where dc.completion_id = h.completion_id)
group by h.user_id;

-- ---------------------------------------------------------------------------------------------
-- 5) CLIENT-STATE EVIDENCE (structural, read-only): the Groups tab has no AsyncStorage cache and
--    never reads currentJapamId; the dashboard polls get_group_dashboard. Nothing client-side can
--    scope groups to a workspace because the RPC contract has no workspace parameter to send.
-- ---------------------------------------------------------------------------------------------
select 'CLIENT: groupsRepository.ts RPC calls carry no workspace/japam argument (verified by code read; see report)' as evidence;

rollback;
