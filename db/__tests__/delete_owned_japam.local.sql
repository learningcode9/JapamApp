-- Local-Supabase-only runtime test for delete_owned_japam compatibility.
-- Run against the LOCAL dockerized Supabase only:
--   docker exec -i supabase_db_JapamApp psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
--     -f db/__tests__/delete_owned_japam.local.sql

\set ON_ERROR_STOP 1
begin;

set local row_security = on;
set role authenticated;

do $$
begin
  assert pg_get_function_result('public.delete_owned_japam(uuid)'::regprocedure) =
    'TABLE(deleted_japam_id uuid, scoped_history_deleted bigint, legacy_history_deleted bigint, tombstones_written bigint, ambiguous_legacy_count bigint)',
    'delete_owned_japam signature must remain five columns';
end $$;

set request.jwt.claim.sub = 'a1111111-1111-4111-8111-111111111111';

insert into public.japams (id, user_id, name, created_at, updated_at, archived_at)
values ('a1111111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111', 'My Japam', now(), now(), null);

insert into public.japam_history (user_id, malas, count, completion_id, japam_name, japam_id, created_at)
values ('a1111111-1111-4111-8111-111111111111', 2, 216, 'h1111111-1111-4111-8111-111111111111', 'My Japam', 'a1111111-1111-4111-8111-111111111111', now());

do $$
declare v_first record;
declare v_second record;
declare v_japam_id uuid;
declare v_history_count int;
declare v_tombstone_count int;
begin
  select * into v_first from public.delete_owned_japam('a1111111-1111-4111-8111-111111111111');
  select * into v_second from public.delete_owned_japam('a1111111-1111-4111-8111-111111111111');

  assert v_first.deleted_japam_id = 'a1111111-1111-4111-8111-111111111111', 'first delete returns the deleted id';
  assert v_first.scoped_history_deleted = 0, 'scoped history delete count stays zero';
  assert v_first.legacy_history_deleted = 0, 'legacy history delete count stays zero';
  assert v_first.tombstones_written = 1, 'first delete writes one tombstone';
  assert v_first.ambiguous_legacy_count = 0, 'ambiguous legacy count stays zero';
  assert v_second.deleted_japam_id = 'a1111111-1111-4111-8111-111111111111', 'repeat delete returns same id';
  assert v_second.tombstones_written = 0, 'repeat delete writes zero tombstones';

  select japam_id into v_japam_id
  from public.japam_history
  where completion_id = 'h1111111-1111-4111-8111-111111111111';
  assert v_japam_id = 'a1111111-1111-4111-8111-111111111111', 'history rows and japam_id must remain unchanged';

  select count(*) into v_history_count
  from public.japam_history
  where japam_id = 'a1111111-1111-4111-8111-111111111111';
  assert v_history_count = 1, 'history row count must remain unchanged';

  select count(*) into v_tombstone_count
  from public.deleted_japams
  where japam_id = 'a1111111-1111-4111-8111-111111111111';
  assert v_tombstone_count = 1, 'tombstone insert must succeed exactly once';
end $$;

set request.jwt.claim.sub = 'b2222222-2222-4222-8222-222222222222';

do $$
begin
  begin
    perform 1 from public.deleted_japams where japam_id = 'a1111111-1111-4111-8111-111111111111';
    assert not found, 'wrong user must not read another user''s tombstone';
  exception when others then
    if sqlerrm not like '%permission denied%' and sqlerrm not like '%row-level security%' then
      raise;
    end if;
  end;
end $$;

do $$
begin
  begin
    perform public.delete_owned_japam('a1111111-1111-4111-8111-111111111111');
    raise exception 'wrong user unexpectedly deleted another user''s Japam';
  exception when others then
    if sqlerrm not like '%delete exactly one owned Japam%' then
      raise;
    end if;
  end;
end $$;

set request.jwt.claim.sub = 'a1111111-1111-4111-8111-111111111111';

do $$
begin
  begin
    insert into public.japams (id, user_id, name, created_at, updated_at, archived_at)
    values ('a1111111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111', 'My Japam', now(), now(), null)
    on conflict (id) do update
      set name = excluded.name,
          updated_at = excluded.updated_at;
    raise exception 'stale upsert with tombstoned ID unexpectedly succeeded';
  exception when others then
    if sqlerrm not like '%row-level security%' and sqlerrm not like '%check option%' then
      raise;
    end if;
  end;
end $$;

rollback;
