-- Local-Supabase-only runtime test for Japam tombstones and normalized-name uniqueness.
-- Run against the LOCAL dockerized Supabase only:
--   docker exec -i supabase_db_JapamApp psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
--     -f db/__tests__/japam_tombstones.local.sql

\set ON_ERROR_STOP 1
begin;

set local row_security = on;

do $$
declare v_duplicates int;
begin
  select count(*) into v_duplicates
  from (
    select user_id, lower(btrim(regexp_replace(name, '\\s+'::text, ' '::text, 'g'::text))) as normalized_name
    from public.japams
    where archived_at is null
    group by user_id, normalized_name
    having count(*) > 1
  ) dupes;

  assert v_duplicates = 0, 'existing active duplicate Japam names would make the unique-index migration fail';
end $$;

insert into public.japams (id, user_id, name, created_at, updated_at, archived_at) values
  ('11111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111', 'My Japam', now(), now(), null),
  ('22222222-2222-4222-8222-222222222222', '22222222-2222-4222-8222-222222222222', 'Govinda', now(), now(), null),
  ('33333333-3333-4333-8333-333333333333', '33333333-3333-4333-8333-333333333333', 'Gayatri', now(), now(), null);

insert into public.japam_history (user_id, malas, count, completion_id, japam_name, japam_id, created_at)
values ('11111111-1111-4111-8111-111111111111', 1, 108, '44444444-4444-4444-8444-444444444444', 'My Japam', '11111111-1111-4111-8111-111111111111', now());

set role authenticated;
set request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';

select * from public.delete_owned_japam('11111111-1111-4111-8111-111111111111');

do $$
declare v_count int;
declare v_japam_id uuid;
begin
  select count(*) into v_count
  from public.deleted_japams
  where japam_id = '11111111-1111-4111-8111-111111111111';
  assert v_count = 1, 'tombstone insert must succeed exactly once';

  select japam_id into v_japam_id
  from public.japam_history
  where completion_id = '44444444-4444-4444-8444-444444444444';
  assert v_japam_id = '11111111-1111-4111-8111-111111111111', 'history rows and japam_id must remain unchanged';
end $$;

select * from public.delete_owned_japam('11111111-1111-4111-8111-111111111111');

do $$
declare v_count int;
begin
  select count(*) into v_count
  from public.deleted_japams
  where japam_id = '11111111-1111-4111-8111-111111111111';
  assert v_count = 1, 'repeated delete must be idempotent';
end $$;

set request.jwt.claim.sub = '22222222-2222-4222-8222-222222222222';

do $$
begin
  begin
    perform 1 from public.deleted_japams where japam_id = '11111111-1111-4111-8111-111111111111';
    if found then
      raise exception 'wrong user unexpectedly read another user''s tombstone';
    end if;
  exception when others then
    if sqlerrm like '%permission denied%' or sqlerrm like '%row-level security%' then
      null;
    else
      raise;
    end if;
  end;
end $$;

do $$
begin
  begin
    perform public.delete_owned_japam('11111111-1111-4111-8111-111111111111');
    raise exception 'wrong user unexpectedly deleted another user''s Japam';
  exception when others then
    if sqlerrm like '%failed to delete exactly one owned Japam%' then
      null;
    else
      raise;
    end if;
  end;
end $$;

set request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';

do $$
begin
  begin
    insert into public.japams (id, user_id, name, created_at, updated_at, archived_at)
    values ('11111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111', 'My Japam', now(), now(), null)
    on conflict (id) do update
      set name = excluded.name,
          updated_at = excluded.updated_at;
    raise exception 'stale upsert with tombstoned ID unexpectedly succeeded';
  exception when others then
    if sqlerrm like '%violates row-level security policy%' or sqlerrm like '%violates check option%' then
      null;
    else
      raise;
    end if;
  end;
end $$;

set request.jwt.claim.sub = '33333333-3333-4333-8333-333333333333';

do $$
begin
  insert into public.japams (id, user_id, name, created_at, updated_at, archived_at)
  values ('55555555-5555-4555-8555-555555555555', '33333333-3333-4333-8333-333333333333', 'My Japam', now(), now(), null);

  begin
    insert into public.japams (id, user_id, name, created_at, updated_at, archived_at)
    values ('66666666-6666-4666-8666-666666666666', '33333333-3333-4333-8333-333333333333', 'my   japam', now(), now(), null);
    raise exception 'duplicate active My Japam rows unexpectedly succeeded';
  exception when others then
    if sqlerrm not like '%duplicate key value violates unique constraint%' then
      raise;
    end if;
  end;

  insert into public.japams (id, user_id, name, created_at, updated_at, archived_at)
  values ('77777777-7777-4777-8777-777777777777', '33333333-3333-4333-8333-333333333333', 'Govinda', now(), now(), null);
end $$;

do $$
declare v_count int;
begin
  select count(*) into v_count
  from public.japams
  where user_id = '33333333-3333-4333-8333-333333333333'
    and archived_at is null;
  assert v_count = 3, 'differently named active Japams must still work';
end $$;

rollback;
