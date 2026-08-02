-- Local-Supabase-only runtime test for the normalized-name index migration.
-- Run against the LOCAL dockerized Supabase only:
--   docker exec -i supabase_db_JapamApp psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
--     -f db/__tests__/japams_normalized_name_unique.local.sql

\set ON_ERROR_STOP 1
begin;

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

  assert v_duplicates = 0, 'existing duplicate active names would make the migration fail';
end $$;

create function pg_temp.run_japams_normalized_name_migration() returns void language plpgsql as $$
declare
  v_desired_def constant text := 'CREATE UNIQUE INDEX japams_user_id_normalized_name_key ON public.japams USING btree (user_id, lower(btrim(regexp_replace(name, ''\s+''::text, '' ''::text, ''g''::text)))) WHERE (archived_at IS NULL)';
  v_old_def constant text := 'CREATE UNIQUE INDEX japams_user_id_normalized_name_key ON public.japams USING btree (user_id, lower(btrim(regexp_replace(name, ''\s+''::text, '' ''::text, ''g''::text))))';
  v_idx record;
  v_has_old boolean := false;
  v_has_desired boolean := false;
begin
  for v_idx in
    select c.relname as index_name, pg_get_indexdef(i.indexrelid) as index_def
    from pg_index i
    join pg_class c on c.oid = i.indexrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and i.indrelid = 'public.japams'::regclass
      and i.indisunique
      and pg_get_indexdef(i.indexrelid) ilike '%lower(btrim(regexp_replace(name%'
      and pg_get_indexdef(i.indexrelid) ilike '%user_id%'
  loop
    if v_idx.index_def = v_desired_def then
      v_has_desired := true;
    elsif v_idx.index_def = v_old_def then
      v_has_old := true;
    else
      raise exception 'unsupported normalized-name index definition: %', v_idx.index_def;
    end if;
  end loop;

  if v_has_old then
    for v_idx in
      select c.relname as index_name
      from pg_index i
      join pg_class c on c.oid = i.indexrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and i.indrelid = 'public.japams'::regclass
        and i.indisunique
        and pg_get_indexdef(i.indexrelid) = v_old_def
    loop
      execute format('drop index if exists public.%I', v_idx.index_name);
    end loop;
    if not v_has_desired then
      execute v_desired_def;
    end if;
    return;
  end if;

  if v_has_desired then
    return;
  end if;

  execute v_desired_def;
end;
$$;

do $$
declare v_def text;
declare v_index_name text;
begin
  -- A. no index
  for v_index_name in
    select c.relname::text
    from pg_index i
    join pg_class c on c.oid = i.indexrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and i.indrelid = 'public.japams'::regclass
      and i.indisunique
      and pg_get_indexdef(i.indexrelid) ilike '%lower(btrim(regexp_replace(name%'
      and pg_get_indexdef(i.indexrelid) ilike '%user_id%'
  loop
    execute format('drop index if exists public.%I', v_index_name);
  end loop;

  perform pg_temp.run_japams_normalized_name_migration();

  select pg_get_indexdef(i.indexrelid) into v_def
  from pg_index i
  join pg_class c on c.oid = i.indexrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'japams_user_id_normalized_name_key';

  assert v_def = 'CREATE UNIQUE INDEX japams_user_id_normalized_name_key ON public.japams USING btree (user_id, lower(btrim(regexp_replace(name, ''\s+''::text, '' ''::text, ''g''::text)))) WHERE (archived_at IS NULL)', 'migration must create the partial index from no-index state';

  -- B. known old non-partial index
  execute 'drop index if exists public.japams_user_id_normalized_name_key';
  execute 'create unique index japams_user_id_normalized_name_key on public.japams using btree (user_id, lower(btrim(regexp_replace(name, ''\s+''::text, '' ''::text, ''g''::text))))';

  perform pg_temp.run_japams_normalized_name_migration();

  select pg_get_indexdef(i.indexrelid) into v_def
  from pg_index i
  join pg_class c on c.oid = i.indexrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'japams_user_id_normalized_name_key';

  assert v_def = 'CREATE UNIQUE INDEX japams_user_id_normalized_name_key ON public.japams USING btree (user_id, lower(btrim(regexp_replace(name, ''\s+''::text, '' ''::text, ''g''::text)))) WHERE (archived_at IS NULL)', 'migration must upgrade the old index to partial';

  -- C. desired partial already installed
  execute 'drop index if exists public.japams_user_id_normalized_name_key';
  execute 'create unique index japams_user_id_normalized_name_key on public.japams using btree (user_id, lower(btrim(regexp_replace(name, ''\s+''::text, '' ''::text, ''g''::text)))) where archived_at is null';

  perform pg_temp.run_japams_normalized_name_migration();

  select pg_get_indexdef(i.indexrelid) into v_def
  from pg_index i
  join pg_class c on c.oid = i.indexrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'japams_user_id_normalized_name_key';

  assert v_def = 'CREATE UNIQUE INDEX japams_user_id_normalized_name_key ON public.japams USING btree (user_id, lower(btrim(regexp_replace(name, ''\s+''::text, '' ''::text, ''g''::text)))) WHERE (archived_at IS NULL)', 'migration must preserve the desired partial index';
end $$;

rollback;
