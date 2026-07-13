-- Phase 1 — dormant canonical current-display-profile foundation.
--
-- This file is additive. It does not alter existing user_profiles, group_members,
-- history, totals, memberships, or any existing row. Do not apply it until the
-- separate staging database rollout is approved.

-- SECTION 1 — READ-ONLY PRECHECK
-- Expected: no existing canonical table and no conflicting RPC overload.
select to_regclass('public.user_display_profiles') as existing_profile_table;

select p.oid::regprocedure as signature
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('upsert_my_display_profile', 'reset_my_display_profile_to_provider')
order by signature;

-- Refuse to adopt or overwrite an unexpected existing object. The read-only
-- precheck above is for operator visibility; this guard makes the apply step
-- safe even if the database changes between precheck and execution.
do $$
begin
  if to_regclass('public.user_display_profiles') is not null then
    raise exception 'public.user_display_profiles already exists; stop and review before applying this foundation';
  end if;

  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('upsert_my_display_profile', 'reset_my_display_profile_to_provider')
  ) then
    raise exception 'a user display-profile RPC already exists; stop and review before applying this foundation';
  end if;
end;
$$;

create table public.user_display_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  name_source text not null,
  updated_at timestamptz not null default now(),
  constraint user_display_profiles_display_name_not_blank
    check (char_length(btrim(display_name)) between 1 and 80),
  constraint user_display_profiles_name_source_valid
    check (name_source in ('provider', 'manual'))
);

alter table public.user_display_profiles enable row level security;

-- Direct writes are deliberately revoked: application clients must use the
-- self-scoped RPC below. Phase 1 permits a signed-in person to read only their
-- own dormant profile; future cross-profile display must use a separately
-- reviewed resolver rather than weakening this foundation policy.
revoke all on table public.user_display_profiles from anon, authenticated;
grant select on table public.user_display_profiles to authenticated;

drop policy if exists "authenticated read display profiles" on public.user_display_profiles;
create policy "authenticated read display profiles"
  on public.user_display_profiles
  for select
  to authenticated
  using (auth.uid() = user_id);

create function public.upsert_my_display_profile(
  p_display_name text,
  p_name_source text
)
returns table (
  user_id uuid,
  display_name text,
  name_source text,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_display_name text := btrim(p_display_name);
  v_name_source text := lower(btrim(p_name_source));
begin
  if v_user_id is null then
    raise exception 'authentication required to update display profile'
      using errcode = '42501';
  end if;

  if v_display_name is null or char_length(v_display_name) = 0 then
    raise exception 'display name must not be empty'
      using errcode = '22023';
  end if;

  if char_length(v_display_name) > 80 then
    raise exception 'display name must be 80 characters or fewer'
      using errcode = '22023';
  end if;

  if v_name_source not in ('provider', 'manual') then
    raise exception 'invalid display name source'
      using errcode = '22023';
  end if;

  -- A provider refresh may seed or refresh provider-owned names, but can never
  -- overwrite an explicit manual name. A manual update always wins. Explicit
  -- reset-to-provider is deliberately a separate RPC below so a background
  -- provider refresh can never be mistaken for a user choice.
  return query
  insert into public.user_display_profiles as profile (
    user_id,
    display_name,
    name_source,
    updated_at
  )
  values (v_user_id, v_display_name, v_name_source, now())
  on conflict on constraint user_display_profiles_pkey do update
  set
    display_name = case
      when profile.name_source = 'manual' and excluded.name_source = 'provider'
        then profile.display_name
      else excluded.display_name
    end,
    name_source = case
      when profile.name_source = 'manual' and excluded.name_source = 'provider'
        then profile.name_source
      else excluded.name_source
    end,
    updated_at = case
      when profile.name_source = 'manual' and excluded.name_source = 'provider'
        then profile.updated_at
      else now()
    end
  returning profile.user_id, profile.display_name, profile.name_source, profile.updated_at;
end;
$$;

create function public.reset_my_display_profile_to_provider(
  p_display_name text
)
returns table (
  user_id uuid,
  display_name text,
  name_source text,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_display_name text := btrim(p_display_name);
begin
  if v_user_id is null then
    raise exception 'authentication required to reset display profile'
      using errcode = '42501';
  end if;

  if v_display_name is null or char_length(v_display_name) = 0 then
    raise exception 'display name must not be empty'
      using errcode = '22023';
  end if;

  if char_length(v_display_name) > 80 then
    raise exception 'display name must be 80 characters or fewer'
      using errcode = '22023';
  end if;

  -- This RPC is the sole explicit user choice to resume provider ownership.
  return query
  insert into public.user_display_profiles as profile (
    user_id,
    display_name,
    name_source,
    updated_at
  )
  values (v_user_id, v_display_name, 'provider', now())
  on conflict on constraint user_display_profiles_pkey do update
  set
    display_name = excluded.display_name,
    name_source = 'provider',
    updated_at = now()
  returning profile.user_id, profile.display_name, profile.name_source, profile.updated_at;
end;
$$;

revoke all on function public.upsert_my_display_profile(text, text) from public;
revoke execute on function public.upsert_my_display_profile(text, text) from anon;
grant execute on function public.upsert_my_display_profile(text, text) to authenticated;

revoke all on function public.reset_my_display_profile_to_provider(text) from public;
revoke execute on function public.reset_my_display_profile_to_provider(text) from anon;
grant execute on function public.reset_my_display_profile_to_provider(text) to authenticated;

-- SECTION 3 — READ-ONLY POST-VERIFY
select
  c.relname,
  c.relrowsecurity,
  c.relforcerowsecurity
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname = 'user_display_profiles';

select
  p.oid::regprocedure as signature,
  p.prosecdef as security_definer,
  p.proconfig
from pg_proc p
where p.oid = 'public.upsert_my_display_profile(text,text)'::regprocedure;

select
  p.oid::regprocedure as signature,
  p.prosecdef as security_definer,
  p.proconfig
from pg_proc p
where p.oid = 'public.reset_my_display_profile_to_provider(text)'::regprocedure;

select
  has_function_privilege('authenticated', 'public.upsert_my_display_profile(text,text)', 'EXECUTE')
    as authenticated_execute,
  has_function_privilege('anon', 'public.upsert_my_display_profile(text,text)', 'EXECUTE')
    as anon_execute,
  has_function_privilege('public', 'public.upsert_my_display_profile(text,text)', 'EXECUTE')
    as public_execute;

select
  has_function_privilege('authenticated', 'public.reset_my_display_profile_to_provider(text)', 'EXECUTE')
    as authenticated_execute,
  has_function_privilege('anon', 'public.reset_my_display_profile_to_provider(text)', 'EXECUTE')
    as anon_execute,
  has_function_privilege('public', 'public.reset_my_display_profile_to_provider(text)', 'EXECUTE')
    as public_execute;

select
  policyname,
  roles,
  cmd,
  qual,
  with_check
from pg_policies
where schemaname = 'public'
  and tablename = 'user_display_profiles'
order by policyname;

select count(*) as profile_rows_after_foundation
from public.user_display_profiles;

-- SECTION 4 — STAGING-ONLY CONTRACT VALIDATION (RUN SEPARATELY, THEN ROLLBACK)
--
-- This validates the database semantics—not just the client strings—without
-- retaining a profile row. Substitute a UUID-backed disposable staging auth
-- user. Do not run this block in production.
--
-- begin;
-- select set_config('request.jwt.claim.role', 'authenticated', true);
-- select set_config('request.jwt.claim.sub', '<staging-auth-user-uuid>', true);
-- set local role authenticated;
--
-- -- provider seed
-- select * from public.upsert_my_display_profile('Bellam', 'provider');
-- select 1 / case when exists (
--   select 1 from public.user_display_profiles
--   where user_id = auth.uid() and display_name = 'Bellam' and name_source = 'provider'
-- ) then 1 else 0 end as provider_seed_pass;
--
-- -- provider refresh
-- select * from public.upsert_my_display_profile('Bellam Reddy', 'provider');
-- select 1 / case when exists (
--   select 1 from public.user_display_profiles
--   where user_id = auth.uid() and display_name = 'Bellam Reddy' and name_source = 'provider'
-- ) then 1 else 0 end as provider_refresh_pass;
--
-- -- manual precedence
-- select * from public.upsert_my_display_profile('Subbarao', 'manual');
-- select * from public.upsert_my_display_profile('Provider Must Not Win', 'provider');
-- select 1 / case when exists (
--   select 1 from public.user_display_profiles
--   where user_id = auth.uid() and display_name = 'Subbarao' and name_source = 'manual'
-- ) then 1 else 0 end as manual_precedence_pass;
--
-- -- explicit reset-to-provider (a separate RPC, never a provider refresh)
-- select * from public.reset_my_display_profile_to_provider('Provider After Reset');
-- select 1 / case when exists (
--   select 1 from public.user_display_profiles
--   where user_id = auth.uid()
--     and display_name = 'Provider After Reset'
--     and name_source = 'provider'
-- ) then 1 else 0 end as reset_to_provider_pass;
--
-- -- The function accepts no caller-supplied user ID, and every result must be
-- -- for auth.uid(). This is the cross-user-mutation guard.
-- select p.proargnames
-- from pg_proc p
-- where p.oid = 'public.upsert_my_display_profile(text,text)'::regprocedure;
-- rollback;

-- SECTION 5 — MANUAL ROLLBACK (DO NOT RUN AS PART OF THE APPLY SCRIPT)
--
-- Use only if Phase 1 must be fully removed before any later phase consumes it.
-- This affects only the new, dormant foundation objects; it does not touch any
-- existing app table or historical snapshot. Run separately in a transaction:
--
-- begin;
-- drop function if exists public.reset_my_display_profile_to_provider(text);
-- drop function if exists public.upsert_my_display_profile(text, text);
-- drop table if exists public.user_display_profiles;
-- commit;
