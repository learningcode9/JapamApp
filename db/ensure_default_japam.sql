-- Server-side idempotency for the active default Japam.
--
-- This deliberately does not delete or merge existing duplicate rows. Every app default-creation
-- path calls this function, which serializes concurrent requests for one user in PostgreSQL and
-- returns the existing canonical row when one is already present.

create index if not exists japams_active_default_lookup_idx
  on public.japams (user_id, created_at, id)
  where name = 'My Japam' and archived_at is null;

create or replace function public.prevent_duplicate_default_japam()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.name = 'My Japam' and new.archived_at is null then
    perform pg_advisory_xact_lock(hashtextextended('default-japam:' || new.user_id, 0));
    if exists (
      select 1
        from public.japams
       where user_id = new.user_id
         and name = 'My Japam'
         and archived_at is null
         and id <> new.id
    ) then
      raise exception 'active default Japam already exists for this user'
        using errcode = '23505';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists prevent_duplicate_default_japam on public.japams;
create trigger prevent_duplicate_default_japam
  before insert or update of user_id, name, archived_at on public.japams
  for each row execute function public.prevent_duplicate_default_japam();

create or replace function public.ensure_default_japam(p_user_id text)
returns setof public.japams
language plpgsql
security invoker
set search_path = public
as $$
declare
  existing public.japams%rowtype;
begin
  if p_user_id is null
     or not (
       auth.uid()::text = p_user_id
       or (auth.jwt() -> 'user_metadata' ->> 'sub') = p_user_id
     ) then
    raise exception 'not authorized to ensure this user''s default Japam'
      using errcode = '42501';
  end if;

  -- Transaction-scoped and deterministic: concurrent devices for this user share this lock,
  -- while different users proceed independently.
  perform pg_advisory_xact_lock(hashtextextended('default-japam:' || p_user_id, 0));

  select *
    into existing
    from public.japams
   where user_id = p_user_id
     and name = 'My Japam'
     and archived_at is null
   order by created_at asc, id asc
   limit 1;

  if found then
    return next existing;
    return;
  end if;

  insert into public.japams (user_id, name)
  values (p_user_id, 'My Japam')
  returning * into existing;

  return next existing;
end;
$$;

revoke all on function public.ensure_default_japam(text) from public;
grant execute on function public.ensure_default_japam(text) to authenticated;
revoke all on function public.prevent_duplicate_default_japam() from public;
