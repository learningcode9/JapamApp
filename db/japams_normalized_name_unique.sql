-- Enforce one active normalized Japam name per user.
--
-- This prevents stale clients from creating multiple active "My Japam" rows with different ids
-- while preserving intentional differently-named Japams.

begin;

do $$
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
end $$;

commit;
