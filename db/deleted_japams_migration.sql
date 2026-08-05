-- Tombstone-based permanent delete for Japams.
--
-- Stores permanently deleted Japam ids so stale clients cannot resurrect them via sync.

begin;

create table if not exists public.deleted_japams (
  japam_id   uuid primary key,
  user_id    text not null,
  deleted_at timestamptz not null default now()
);

create index if not exists deleted_japams_user_id_idx
  on public.deleted_japams (user_id);

alter table public.deleted_japams enable row level security;

drop policy if exists "authenticated_select_own_deleted_japams" on public.deleted_japams;
create policy "authenticated_select_own_deleted_japams"
  on public.deleted_japams
  for select
  to authenticated
  using (
    auth.uid()::text = user_id
    or (auth.jwt() -> 'user_metadata' ->> 'sub') = user_id
  );

drop policy if exists "authenticated_insert_own_japams" on public.japams;
create policy "authenticated_insert_own_japams"
  on public.japams
  for insert
  to authenticated
  with check (
    (auth.uid()::text = user_id or (auth.jwt() -> 'user_metadata' ->> 'sub') = user_id)
    and not exists (
      select 1
      from public.deleted_japams dj
      where dj.user_id = user_id
        and dj.japam_id = id
    )
  );

drop policy if exists "authenticated_update_own_japams" on public.japams;
create policy "authenticated_update_own_japams"
  on public.japams
  for update
  to authenticated
  using (
    auth.uid()::text = user_id
    or (auth.jwt() -> 'user_metadata' ->> 'sub') = user_id
  )
  with check (
    (auth.uid()::text = user_id or (auth.jwt() -> 'user_metadata' ->> 'sub') = user_id)
    and not exists (
      select 1
      from public.deleted_japams dj
      where dj.user_id = user_id
        and dj.japam_id = id
    )
  );

revoke all on table public.deleted_japams from public;
revoke all on table public.deleted_japams from anon;
revoke all on table public.deleted_japams from authenticated;
revoke all on table public.deleted_japams from service_role;
grant select on table public.deleted_japams to authenticated;

commit;
