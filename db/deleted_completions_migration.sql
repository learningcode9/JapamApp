-- Tombstone-based delete sync — run ONCE in the Supabase SQL editor.
--
-- Why: the app is offline-first and uses the anon key. A delete is recorded as a TOMBSTONE
-- (the deleted completion_id) so it propagates to every device and is never resurrected by
-- self-heal — instead of inferring deletes from "row missing remotely" (which would wipe
-- un-uploaded offline malas). This migration adds the tombstone table + the policies the app
-- needs to (a) read/write tombstones and (b) actually DELETE rows from japam_history.

-- 1) Tombstone table: one row per deleted completion_id.
create table if not exists public.deleted_completions (
  completion_id text primary key,
  user_id       text not null,
  deleted_at    timestamptz not null default now()
);

create index if not exists deleted_completions_user_id_idx
  on public.deleted_completions (user_id);

-- 2) RLS + anon policy on the tombstone table (matches the app's anon-key model;
--    the app always scopes by user_id / completion_id in its queries).
alter table public.deleted_completions enable row level security;

drop policy if exists "anon manage deleted_completions" on public.deleted_completions;
create policy "anon manage deleted_completions"
  on public.deleted_completions
  for all
  to anon
  using (true)
  with check (true);

-- 3) Allow authenticated users to DELETE only their own rows from japam_history.
--    This mirrors the ownership-based UPDATE check and prevents authenticated app deletes from
--    silently affecting zero rows under RLS.
drop policy if exists "anon delete japam_history" on public.japam_history;
drop policy if exists "Users can delete their own history" on public.japam_history;
create policy "Users can delete their own history"
  on public.japam_history
  for delete
  to authenticated
  using (
    (auth.uid()::text = user_id)
    or ((auth.jwt() -> 'user_metadata' ->> 'sub') = user_id)
  );
