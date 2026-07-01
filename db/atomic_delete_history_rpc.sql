-- Atomic delete: write the tombstone and delete the japam_history row(s) in one transaction, so
-- a tombstone can never exist without the row actually being deleted (or vice versa).
--
-- Why: the previous delete flow did these as two separate REST calls (POST to
-- deleted_completions, then DELETE from japam_history). Any interruption between them left a
-- "zombie" row — tombstoned but still physically present in japam_history, causing
-- get_group_dashboard (and any other direct SUM(japam_history) reader) to overstate totals
-- relative to the History screen, which correctly filters tombstoned rows client-side.
-- Separately, the background sync path (contexts/timer-context.tsx) issued its DELETE using only
-- the anon key — japam_history has no anon DELETE policy (see db/deleted_completions_migration.sql),
-- so that DELETE was silently rejected by RLS every time, guaranteeing a zombie row whenever a
-- delete was retried through that path rather than completing immediately.
--
-- This RPC is authenticated-only: identity comes solely from auth.uid() / the caller's own JWT,
-- never from a client-supplied parameter. The fallback match against the JWT's Google "sub" claim
-- mirrors the existing, already-approved japam_history RLS policy exactly (see
-- db/deleted_completions_migration.sql), so the japam_history rows not yet migrated to UUID keys
-- can still be deleted by their rightful owner without silently creating a new zombie via
-- identity mismatch. Once the separate legacy-row cleanup migration lands (proposed, not yet
-- implemented), this fallback becomes provably dead code and can be simplified away.

create or replace function public.delete_history_completions(
  p_completion_ids text[]
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid text;
  v_sub text;
begin
  v_uid := auth.uid()::text;

  if v_uid is null then
    raise exception 'authentication required';
  end if;

  if p_completion_ids is null or array_length(p_completion_ids, 1) is null then
    return;
  end if;

  v_sub := auth.jwt() -> 'user_metadata' ->> 'sub';

  insert into public.deleted_completions (completion_id, user_id)
  select unnest(p_completion_ids), v_uid
  on conflict (completion_id) do nothing;

  delete from public.japam_history
  where completion_id = any(p_completion_ids)
    and (
      user_id = v_uid
      or (v_sub is not null and user_id = v_sub)
    );
end;
$$;

revoke all on function public.delete_history_completions(text[]) from public;
grant execute on function public.delete_history_completions(text[]) to authenticated;
