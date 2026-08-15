-- Local Supabase-only Android update configuration.
-- The seeded value matches the currently released Android build so existing users do not see
-- an update banner until an operator raises it.

create table if not exists public.android_app_update_config (
  singleton boolean primary key default true check (singleton),
  latest_version_code integer not null check (latest_version_code > 0)
);

insert into public.android_app_update_config (singleton, latest_version_code)
values (true, 15)
on conflict (singleton) do nothing;

alter table public.android_app_update_config enable row level security;
revoke all on table public.android_app_update_config from public, anon, authenticated;

create or replace function public.get_android_latest_version_code()
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select latest_version_code
    from public.android_app_update_config
   where singleton = true;
$$;

revoke all on function public.get_android_latest_version_code() from public;
grant execute on function public.get_android_latest_version_code() to anon, authenticated;
