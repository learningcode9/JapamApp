-- Local-Supabase-only runtime test for get_home_stats.
-- Run only after the local database contains the app's existing japams, japam_history, and
-- deleted_completions tables plus this migration:
--   docker exec -i supabase_db_JapamApp psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
--     -f db/__tests__/get_home_stats.local.sql

\set ON_ERROR_STOP 1
begin;
set local row_security = on;

-- The production table normally enforces this key. Temporarily remove the local fixture's
-- uniqueness guard so the RPC's deterministic duplicate-completion behavior is exercised.
drop index if exists public.japam_history_completion_id_unique;
alter table public.japam_history drop constraint if exists japam_history_completion_id_key;
alter table public.japam_history alter column completion_id drop not null;

insert into auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values
  ('a1111111-1111-4111-8111-111111111111', 'authenticated', 'authenticated', 'home-a@local.test', '', now(), '{}', '{}', now(), now()),
  ('b2222222-2222-4222-8222-222222222222', 'authenticated', 'authenticated', 'home-b@local.test', '', now(), '{}', '{}', now(), now())
on conflict (id) do nothing;

insert into private.legacy_user_id_map (legacy_user_id, user_id, source)
values ('legacy-home-a', 'a1111111-1111-4111-8111-111111111111', 'local verified fixture');

insert into public.japams (id, user_id, name, display_order, created_at, updated_at, archived_at)
values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a1111111-1111-4111-8111-111111111111', 'Main', 1, '2026-01-01T00:00:00Z', now(), null),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'a1111111-1111-4111-8111-111111111111', 'Other', 2, '2026-01-02T00:00:00Z', now(), null),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'a1111111-1111-4111-8111-111111111111', 'Shared', 3, '2026-01-03T00:00:00Z', now(), null),
  ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'a1111111-1111-4111-8111-111111111111', 'Shared', 4, '2026-01-04T00:00:00Z', now(), null),
  ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'a1111111-1111-4111-8111-111111111111', 'Archived', 5, '2026-01-05T00:00:00Z', now(), now()),
  ('ffffffff-ffff-4fff-8fff-ffffffffffff', 'b2222222-2222-4222-8222-222222222222', 'Other user', 1, '2026-01-01T00:00:00Z', now(), null),
  ('99999999-9999-4999-8999-999999999999', 'a1111111-1111-4111-8111-111111111111', 'Long', 6, '2026-01-06T00:00:00Z', now(), null);

insert into public.japam_history (
  user_id, malas, count, completion_id, japam_name, japam_id, created_at
)
values
  ('a1111111-1111-4111-8111-111111111111', 2, 216, 'home-normal', 'Main', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-08-18T08:00:00Z'),
  ('a1111111-1111-4111-8111-111111111111', 1, 0, 'home-malas-fallback', 'Main', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-08-18T09:00:00Z'),
  ('a1111111-1111-4111-8111-111111111111', 1, 3, 'home-duplicate', 'Main', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-08-18T10:00:00Z'),
  ('a1111111-1111-4111-8111-111111111111', 1, 5, 'home-duplicate', 'Main', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-08-18T11:00:00Z'),
  ('a1111111-1111-4111-8111-111111111111', 1, 0, null, 'Main', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-08-18T12:00:00Z'),
  ('a1111111-1111-4111-8111-111111111111', 1, 0, null, 'Main', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-08-18T13:00:00Z'),
  ('legacy-home-a', 1, 10, 'home-named-legacy', ' Main ', null, '2026-08-18T14:00:00Z'),
  ('legacy-home-a', 1, 7, 'home-blank-legacy', '   ', null, '2026-08-18T15:00:00Z'),
  ('legacy-home-a', 1, 99, 'home-ambiguous-legacy', 'Shared', null, '2026-08-18T16:00:00Z'),
  ('legacy-home-a', 1, 999, 'home-tombstoned', 'Main', null, '2026-08-18T17:00:00Z'),
  ('a1111111-1111-4111-8111-111111111111', 1, 108, 'home-yesterday', 'Main', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-08-17T08:00:00Z'),
  ('a1111111-1111-4111-8111-111111111111', 1, 108, 'home-two-days-ago', 'Main', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-08-16T08:00:00Z'),
  ('a1111111-1111-4111-8111-111111111111', 1, 108, 'home-gap-after', 'Main', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-08-14T08:00:00Z'),
  ('b2222222-2222-4222-8222-222222222222', 1, 108, 'home-other-user', 'Other user', 'ffffffff-ffff-4fff-8fff-ffffffffffff', '2026-08-18T08:00:00Z'),
  ('a1111111-1111-4111-8111-111111111111', 1, 108, 'home-archived', 'Archived', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', '2026-08-18T08:00:00Z');

insert into public.deleted_completions (completion_id, user_id)
values ('home-tombstoned', 'legacy-home-a');

insert into public.japam_history (
  user_id, malas, count, completion_id, japam_name, japam_id, created_at
)
select
  'a1111111-1111-4111-8111-111111111111', 1, 108,
  'home-long-' || n::text, 'Long', '99999999-9999-4999-8999-999999999999',
  ('2026-08-18'::date - n)::timestamp + interval '8 hours'
from generate_series(0, 30) as days(n);

set role authenticated;
set request.jwt.claim.sub = 'a1111111-1111-4111-8111-111111111111';

do $$
declare v record; v_rows integer;
begin
  select * into v from public.get_home_stats(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '2026-08-18T07:00:00Z', '2026-08-19T07:00:00Z', 'America/Los_Angeles');
  assert v.today_count = 562, 'today_count must apply effective counts, attribution, dedupe, and tombstones';
  assert v.today_malas = 5, 'today_malas must floor today_count / 108';
  assert v.day_streak = 3, 'today anchor streak must be three days';

  select count(*) into v_rows from public.get_home_stats(
    '99999999-9999-4999-8999-999999999999',
    '2026-08-18T07:00:00Z', '2026-08-19T07:00:00Z', 'America/Los_Angeles');
  assert v_rows = 1, 'long streak still returns one summary row';

  select * into v from public.get_home_stats(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '2026-08-19T07:00:00Z', '2026-08-20T07:00:00Z', 'America/Los_Angeles');
  assert v.today_count = 0 and v.day_streak = 3, 'yesterday anchor preserves the streak';

  select * into v from public.get_home_stats(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '2026-08-20T07:00:00Z', '2026-08-21T07:00:00Z', 'America/Los_Angeles');
  assert v.day_streak = 0, 'a calendar gap stops the streak';
end $$;

do $$
begin
  begin
    perform * from public.get_home_stats(
      'ffffffff-ffff-4fff-8fff-ffffffffffff',
      '2026-08-18T07:00:00Z', '2026-08-19T07:00:00Z', 'America/Los_Angeles');
    raise exception 'wrong-user workspace unexpectedly succeeded';
  exception when others then
    if sqlerrm not like '%not owned%' then raise; end if;
  end;

  begin
    perform * from public.get_home_stats(
      'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      '2026-08-18T07:00:00Z', '2026-08-19T07:00:00Z', 'America/Los_Angeles');
    raise exception 'archived workspace unexpectedly succeeded';
  exception when others then
    if sqlerrm not like '%not owned%' then raise; end if;
  end;

  begin
    perform * from public.get_home_stats(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '2026-08-18T08:00:00Z', '2026-08-19T07:00:00Z', 'America/Los_Angeles');
    raise exception 'non-midnight bounds unexpectedly succeeded';
  exception when others then
    if sqlerrm not like '%consecutive local midnights%' then raise; end if;
  end;

  begin
    perform * from public.get_home_stats(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '2026-08-18T07:00:00Z', '2026-08-19T07:00:00Z', 'Not/A_Timezone');
    raise exception 'invalid timezone unexpectedly succeeded';
  exception when others then
    if sqlerrm not like '%invalid device timezone%' then raise; end if;
  end;

  begin
    perform * from public.get_home_stats(
      null,
      '2026-08-18T07:00:00Z', '2026-08-19T07:00:00Z', 'America/Los_Angeles');
    raise exception 'null workspace unexpectedly succeeded';
  exception when others then
    if sqlerrm not like '%p_japam_id is required%' then raise; end if;
  end;
end $$;

do $$
declare v record;
begin
  select * into v from public.get_home_stats(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '2026-11-01T07:00:00Z', '2026-11-02T08:00:00Z', 'America/Los_Angeles');
  assert v.today_count = 0 and v.today_malas = 0, 'DST local-midnight bounds must validate';
end $$;

rollback;
