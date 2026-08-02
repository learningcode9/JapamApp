-- =============================================================================
-- STAGING-ONLY FIXTURE: Family Japam one-workspace consolidation test data.
-- =============================================================================
-- Synthetic / rollback-only. Replicates the EXACT PRODUCTION shape of the five members of
-- the "Family  japam" group (c469d784-1ce9-4094-aa97-b26ed2865acb) using the REAL
-- production ids, so db/workspace_consolidation.sql can be validated against the true
-- scenario (its expected-mapping assertions match byte-for-byte). NEVER run against
-- production. Target project: STAGING (nhacglvxdypevrbvvkhn).
--
-- STAGING-ONLY PREREQUISITE (restored to staging in the schema-restore step): staging
-- carries the unique index japams_user_id_normalized_name_key, which does NOT exist in
-- production (verified via pg_indexes) or any repo migration. Production legitimately
-- contains duplicate same-name Japams, so the fixture DROPS that index in its APPLY
-- section and RE-CREATES it with the exact prior definition in its TEARDOWN section.
--
-- Workflow (each step is a separate management-API call):
--   1. APPLY (SECTION 2)  -> loads the synthetic shape.
--   2. Run db/workspace_consolidation.sql (apply) -> assertions -> COMMIT.
--   3. Run db/workspace_consolidation_rollback.sql  and/or cleanup, and the RPC checks.
--   4. TEARDOWN (SECTION 4) -> removes every fixture row + migration artifacts and
--      restores the index, returning staging to its exact pre-test schema.
--
-- History ids use the 1,000,000..1,999,999 band (staging's pre-existing max is 756), and
-- every row carries completion_id 'fixture-*' so teardown is surgical. The today-parity
-- window (Sita/learn) matches the apply file's _ws_today_bounds:
--   [2026-08-02T07:00:00Z, 2026-08-03T07:00:00Z).
-- =============================================================================


-- ─── SECTION 1: PRE-CHECK (refuse if the synthetic group already exists) ─────
do $$
begin
  if exists (select 1 from public.groups where id = 'c469d784-1ce9-4094-aa97-b26ed2865acb') then
    raise exception 'fixture already applied: Family group exists; run SECTION 4 teardown first';
  end if;
  if exists (
    select 1 from public.japam_history h
    where h.completion_id like 'fixture-%' or h.completion_id like 'guard-%'
  ) then
    raise exception 'fixture history already present; run SECTION 4 teardown first';
  end if;
end $$;


-- ─── SECTION 2: APPLY (one transaction; atomic load) ─────────────────────────
begin;

-- Staging-only prerequisite: drop the unique normalized-name index that blocks the
-- duplicate same-name Japams production legitimately has. Teardown re-creates it.
drop index if exists public.japams_user_id_normalized_name_key;

-- 1. The Family group (real production id, synthetic in this project).
insert into public.groups (id, name, invite_code, created_by, is_active)
values (
  'c469d784-1ce9-4094-aa97-b26ed2865acb',
  'Family  japam',
  '7A4EDC7',
  '3c313835-e391-4607-853f-e23a108d9c2b',
  true
);

-- 2. Japams — exact production inventory (ids + archived flags identical to production).
insert into public.japams (id, user_id, name, display_order, created_at, updated_at, archived_at) values
-- Sita: first = empty duplicate; second = canonical (holds the history)
('19748f34-124d-4b78-8580-321bf82a1063', '3c313835-e391-4607-853f-e23a108d9c2b', 'My Japam', null, '2026-07-21T14:54:55.328Z', '2026-07-21T14:54:55.328Z', null),
('cd811356-5954-4b75-aed3-f9e9cf5b3ffd', '3c313835-e391-4607-853f-e23a108d9c2b', 'My Japam', null, '2026-07-21T14:54:58.544Z', '2026-07-21T14:54:58.544Z', null),
-- Komali: sole japam (canonical)
('82876810-f2e3-4943-82ac-d9be0e3309d9', '6829d5ea-285c-458c-9577-7bce4422c45c', 'My Japam', null, '2026-07-21T01:41:32.352Z', '2026-07-21T01:41:32.352Z', null),
-- Sarada: earliest = canonical; later = same-name duplicate (both empty pre-migration)
('b91c31a4-9c36-45a1-a2ce-53b5b3cbbb14', 'd25472a6-741a-48ee-8c6e-fcb8ea8394f5', 'My Japam', null, '2026-07-29T02:22:09.229Z', '2026-07-29T02:22:09.229Z', null),
('0c4773b3-d9d0-431e-bbff-6a0774573636', 'd25472a6-741a-48ee-8c6e-fcb8ea8394f5', 'My Japam', null, '2026-07-29T02:22:09.527Z', '2026-07-29T02:22:09.527Z', null),
-- bellam: NO japam rows (migration STEP D must create the deterministic default)
-- learn: canonical is earliest + membership-linked; 4 empty duplicates; 1 already-archived Test Japam
('51356d77-5981-4b45-9bc9-0ae657a5fa2b', '87f50692-bdf2-49ad-97cf-0e79da8788fa', 'My Japam',    null, '2026-07-21T00:04:34.432Z', '2026-07-21T00:04:34.432Z', null),
('fdc2961b-4512-4308-afc9-9da36522d10b', '87f50692-bdf2-49ad-97cf-0e79da8788fa', 'My Japam',    null, '2026-07-25T06:22:37.193Z', '2026-07-25T06:22:37.193Z', null),
('69ebd607-d755-4272-aabc-09041c1f94c3', '87f50692-bdf2-49ad-97cf-0e79da8788fa', 'My Japam',    null, '2026-07-28T23:41:16.049Z', '2026-07-28T23:41:16.049Z', null),
('69c01af2-578b-4a7c-85ef-4a839277d8cd', '87f50692-bdf2-49ad-97cf-0e79da8788fa', 'My Japam',    null, '2026-07-29T00:15:58.414Z', '2026-07-29T00:15:58.414Z', null),
('64b10996-e692-43e0-9706-6006c2c21e62', '87f50692-bdf2-49ad-97cf-0e79da8788fa', 'My Japam',    null, '2026-07-29T04:22:15.582Z', '2026-07-29T04:22:15.582Z', null),
('2f58d18b-f4ce-44f8-963b-257277df5f99', '87f50692-bdf2-49ad-97cf-0e79da8788fa', 'Test Japam',  null, '2026-07-21T05:06:25.451Z', '2026-07-21T05:06:25.451Z', '2026-07-22T15:28:09.746Z');

-- 3. Memberships — exact production ids + links (Sita/Sarada/bellam unassigned).
insert into public.group_members (id, group_id, user_id, user_name, role, joined_at, japam_id) values
('2c6b36f5-c16e-41b4-9c5b-7345006852b7', 'c469d784-1ce9-4094-aa97-b26ed2865acb', '3c313835-e391-4607-853f-e23a108d9c2b', 'Sita',   'admin',   '2026-06-21T16:39:44.987Z', null),
('f5acc279-3815-460b-bc2d-8bb8fa2962ea', 'c469d784-1ce9-4094-aa97-b26ed2865acb', '6829d5ea-285c-458c-9577-7bce4422c45c', 'Komali', 'member',  '2026-06-21T16:49:35.586Z', '82876810-f2e3-4943-82ac-d9be0e3309d9'),
('d36e4ff8-d2e6-4cbe-a269-714d35bfeebc', 'c469d784-1ce9-4094-aa97-b26ed2865acb', 'd25472a6-741a-48ee-8c6e-fcb8ea8394f5', 'Sarada', 'member',  '2026-06-23T03:51:28.379Z', null),
('12e65d86-c2cf-46af-8cd8-f86a838179f1', 'c469d784-1ce9-4094-aa97-b26ed2865acb', 'f1887c24-5728-4246-9912-699de2ea2f05', 'bellam', 'member',  '2026-06-25T16:08:19.756Z', null),
('041645f7-e49f-4212-8a73-2aefef087575', 'c469d784-1ce9-4094-aa97-b26ed2865acb', '87f50692-bdf2-49ad-97cf-0e79da8788fa', 'learn',  'member',  '2026-07-13T00:56:45.740Z', '51356d77-5981-4b45-9bc9-0ae657a5fa2b');

-- 4. History — synthetic rows replicating the production attribution SHAPE (which japam
--    holds rows vs null-japam legacy; nothing under duplicates or the pre-archived Test
--    Japam). count = malas * 108. Ids in the 1,000,000 band; japam_history.id is identity
--    GENERATED ALWAYS on both projects, hence OVERRIDING SYSTEM VALUE.

-- Sita — assigned to canonical cd811356 (non-today): 30 rows / 30 malas / 3240
insert into public.japam_history (id, created_at, user_name, malas, count, user_id, completion_id, japam_name, japam_slot, japam_id) overriding system value
select
  (1000001 + seq)::bigint,
  ('2026-07-20T00:00:00Z'::timestamptz + (seq % 12) * interval '1 day'),
  'Sita', 1, 108,
  '3c313835-e391-4607-853f-e23a108d9c2b', 'fixture-sita-a-' || seq, 'My Japam', null,
  'cd811356-5954-4b75-aed3-f9e9cf5b3ffd'
from generate_series(1, 30) as seq;

-- Sita — assigned to canonical cd811356 (TODAY 2026-08-02 local day): 15 rows / 15 malas / 1620
insert into public.japam_history (id, created_at, user_name, malas, count, user_id, completion_id, japam_name, japam_slot, japam_id) overriding system value
select
  (1000031 + seq)::bigint,
  ('2026-08-02T07:00:00Z'::timestamptz + seq * interval '1 minute'),
  'Sita', 1, 108,
  '3c313835-e391-4607-853f-e23a108d9c2b', 'fixture-sita-b-' || seq, 'My Japam', null,
  'cd811356-5954-4b75-aed3-f9e9cf5b3ffd'
from generate_series(1, 15) as seq;

-- Sita — blank null legacy: 40 rows / 40 malas / 4320
insert into public.japam_history (id, created_at, user_name, malas, count, user_id, completion_id, japam_name, japam_slot, japam_id) overriding system value
select
  (1000046 + seq)::bigint,
  ('2026-06-25T00:00:00Z'::timestamptz + (seq % 25) * interval '1 day'),
  'Sita', 1, 108,
  '3c313835-e391-4607-853f-e23a108d9c2b', 'fixture-sita-c-' || seq, null, null, null
from generate_series(1, 40) as seq;

-- Komali — assigned to canonical 82876810 (non-today): 30 rows / 30 malas / 3240
insert into public.japam_history (id, created_at, user_name, malas, count, user_id, completion_id, japam_name, japam_slot, japam_id) overriding system value
select
  (1000101 + seq)::bigint,
  ('2026-07-15T00:00:00Z'::timestamptz + (seq % 16) * interval '1 day'),
  'Komali', 1, 108,
  '6829d5ea-285c-458c-9577-7bce4422c45c', 'fixture-komali-a-' || seq, 'My Japam', null,
  '82876810-f2e3-4943-82ac-d9be0e3309d9'
from generate_series(1, 30) as seq;

-- Komali — blank null legacy: 20 rows / 20 malas / 2160
insert into public.japam_history (id, created_at, user_name, malas, count, user_id, completion_id, japam_name, japam_slot, japam_id) overriding system value
select
  (1000131 + seq)::bigint,
  ('2026-06-20T00:00:00Z'::timestamptz + (seq % 24) * interval '1 day'),
  'Komali', 1, 108,
  '6829d5ea-285c-458c-9577-7bce4422c45c', 'fixture-komali-c-' || seq, null, null, null
from generate_series(1, 20) as seq;

-- Sarada — NAMED null legacy ('My Japam'): 25 rows / 25 malas / 2700 (both japams empty)
insert into public.japam_history (id, created_at, user_name, malas, count, user_id, completion_id, japam_name, japam_slot, japam_id) overriding system value
select
  (1000201 + seq)::bigint,
  ('2026-05-05T00:00:00Z'::timestamptz + (seq % 30) * interval '1 day'),
  'Sarada', 1, 108,
  'd25472a6-741a-48ee-8c6e-fcb8ea8394f5', 'fixture-sarada-c-' || seq, 'My Japam', null, null
from generate_series(1, 25) as seq;

-- bellam — blank null legacy: 15 rows / 15 malas / 1620 (no japam rows)
insert into public.japam_history (id, created_at, user_name, malas, count, user_id, completion_id, japam_name, japam_slot, japam_id) overriding system value
select
  (1000301 + seq)::bigint,
  ('2026-06-18T00:00:00Z'::timestamptz + (seq % 36) * interval '1 day'),
  'bellam', 1, 108,
  'f1887c24-5728-4246-9912-699de2ea2f05', 'fixture-bellam-c-' || seq, null, null, null
from generate_series(1, 15) as seq;

-- learn — assigned to canonical 51356d77 (non-today): 30 rows / 30 malas / 3240
insert into public.japam_history (id, created_at, user_name, malas, count, user_id, completion_id, japam_name, japam_slot, japam_id) overriding system value
select
  (1000401 + seq)::bigint,
  ('2026-07-10T00:00:00Z'::timestamptz + (seq % 15) * interval '1 day'),
  'learn', 1, 108,
  '87f50692-bdf2-49ad-97cf-0e79da8788fa', 'fixture-learn-a-' || seq, 'My Japam', null,
  '51356d77-5981-4b45-9bc9-0ae657a5fa2b'
from generate_series(1, 30) as seq;

-- learn — assigned to canonical 51356d77 (TODAY): 2 rows / 2 malas / 216
insert into public.japam_history (id, created_at, user_name, malas, count, user_id, completion_id, japam_name, japam_slot, japam_id) overriding system value
select
  (1000431 + seq)::bigint,
  ('2026-08-02T07:00:00Z'::timestamptz + seq * interval '1 minute'),
  'learn', 1, 108,
  '87f50692-bdf2-49ad-97cf-0e79da8788fa', 'fixture-learn-b-' || seq, 'My Japam', null,
  '51356d77-5981-4b45-9bc9-0ae657a5fa2b'
from generate_series(1, 2) as seq;

-- learn — null legacy, mixed blank + named: 10 rows / 10 malas / 1080
insert into public.japam_history (id, created_at, user_name, malas, count, user_id, completion_id, japam_name, japam_slot, japam_id) overriding system value
select
  (1000433 + seq)::bigint,
  ('2026-06-10T00:00:00Z'::timestamptz + (seq % 20) * interval '1 day'),
  'learn', 1, 108,
  '87f50692-bdf2-49ad-97cf-0e79da8788fa',
  'fixture-learn-c-' || seq,
  case when seq <= 5 then null else 'My Japam' end,
  null,
  null
from generate_series(1, 10) as seq;

commit;

-- ─── SECTION 3: POST-LOAD VERIFICATION (read-only; expected pre-apply shape) ──
select
  m.user_id,
  count(*) filter (where j.id is not null and j.archived_at is null) as active_japams,
  count(*) filter (where j.id is not null and j.archived_at is not null) as archived_japams,
  min(gm.japam_id::text) as membership_japam
from (select distinct user_id from public.group_members where group_id = 'c469d784-1ce9-4094-aa97-b26ed2865acb') m
left join public.japams j on j.user_id = m.user_id
left join public.group_members gm on gm.group_id = 'c469d784-1ce9-4094-aa97-b26ed2865acb' and gm.user_id = m.user_id
group by m.user_id
order by m.user_id;


-- ─── SECTION 4: TEARDOWN (restore staging to its exact pre-test state) ───────
-- Deletes every fixture row (FK-safe order), drops the migration artifacts the apply left
-- behind (write-guard triggers + migration_backup schema), and re-creates the staging-only
-- unique normalized-name index with its exact prior definition.
--
-- begin;
--
-- -- 1. Fixture + guard-test History rows.
-- delete from public.japam_history where completion_id like 'fixture-%' or completion_id like 'guard-%';
--
-- -- 2. Family memberships.
-- delete from public.group_members where group_id = 'c469d784-1ce9-4094-aa97-b26ed2865acb';
--
-- -- 3. Family members' Japams (fixture japams + the bellam default the migration created).
-- delete from public.japams
-- where user_id in (
--   '3c313835-e391-4607-853f-e23a108d9c2b',
--   '6829d5ea-285c-458c-9577-7bce4422c45c',
--   'd25472a6-741a-48ee-8c6e-fcb8ea8394f5',
--   'f1887c24-5728-4246-9912-699de2ea2f05',
--   '87f50692-bdf2-49ad-97cf-0e79da8788fa'
-- );
--
-- -- 4. The Family group.
-- delete from public.groups where id = 'c469d784-1ce9-4094-aa97-b26ed2865acb';
--
-- -- 5. Migration artifacts (idempotent: present only after the apply ran).
-- drop trigger if exists _ws_no_history_to_archived_japam on public.japam_history;
-- drop function if exists public._ws_guard_history_archived_japam();
-- drop trigger if exists _ws_no_unarchive on public.japams;
-- drop function if exists public._ws_guard_no_unarchive();
-- drop schema if exists migration_backup cascade;
--
-- -- 6. Re-create the staging-only unique normalized-name index (exact prior definition).
-- create unique index if not exists japams_user_id_normalized_name_key
--   on public.japams (user_id, lower(btrim(regexp_replace(name, '\s+', ' ', 'g'))));
--
-- commit;
-- =============================================================================
