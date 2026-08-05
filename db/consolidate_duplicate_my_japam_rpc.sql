-- Consolidate one user's duplicate "My Japam" into their canonical "My Japam" atomically.
--
-- Purpose:
--   A dedicated, explicit consolidation for the known production shape where the
--   canonical "My Japam" is archived + tombstoned while a duplicate "My Japam" is
--   active and has since collected real History rows. The generic
--   restore_owned_japam RPC deliberately FAILS CLOSED on any conflict that has
--   History (it must never silently move data), so it cannot be used here. This
--   RPC is the explicit, reviewed exception: it moves the duplicate's History
--   rows to the canonical Japam in ONE transaction, archives + tombstones the
--   duplicate, removes the canonical tombstone, unarchives the canonical, and
--   leaves exactly one active normalized "My Japam".
--
-- Safety contract (each check RAISES, rolling the whole transaction back):
--   - caller must be authenticated (auth.uid() or legacy auth.jwt()
--     user_metadata.sub)
--   - both Japam rows must exist, be owned by the SAME caller, and their stored
--     user_id must resolve to one of the caller's identities
--   - both names must normalize to "my japam"
--   - canonical must be archived AND tombstoned (deleted_japams)
--   - duplicate must be active AND not tombstoned
--   - duplicate must have ZERO group_members references (groups are never moved)
--   - duplicate must have NO pending adoption marker
--   - every History row referencing either Japam must belong to the owner
--   - no completion_id collision between the two History sets
--   - post-conditions are re-verified inside the transaction: exactly one active
--     normalized "My Japam", exactly one adoption marker, and after-totals equal
--     the before-totals summed; any drift raises and rolls back
--
-- Mutation order matters for production constraints and the write-guards installed
-- by db/workspace_consolidation.sql:
--   the duplicate is ARCHIVED FIRST so the partial unique index
--   japams_user_id_normalized_name_key (active rows only) allows the canonical
--   unarchive — otherwise unarchiving the canonical would collide with the still
--   active duplicate "my japam";
--   the canonical is UNARCHIVED before its History move because
--   _ws_no_history_to_archived_japam blocks History rows whose japam_id points at
--   an archived Japam (it only inspects NEW.japam_id, so moving rows OFF the now
--   archived duplicate is unaffected);
--   _ws_no_unarchive only blocks the six migration duplicate ids, so the canonical
--   unarchive is unaffected.
--
-- Data preservation: History rows are updated in place (only japam_id changes;
-- id, created_at, user_name, malas, count, completion_id and japam_name are
-- untouched). No History row is inserted, deleted, or duplicated. Group
-- memberships and groups are never modified. The duplicate's own tombstone
-- write and the canonical tombstone removal only touch deleted_japams.
--
-- Deployment order:
--   1. db/pending_japam_adoption.sql    (creates the marker table this RPC writes)
--   2. db/consolidate_duplicate_my_japam_rpc.sql   (THIS FILE)
--   3. Call consolidate_duplicate_my_japam(canonical_id, duplicate_id) as the
--      authenticated user, then deploy the client that consumes the marker.
--
-- This file intentionally does NOT modify db/restore_owned_japam_rpc.sql; that
-- RPC keeps its fail-closed behavior untouched.

create or replace function public.consolidate_duplicate_my_japam(
  p_canonical_id uuid,
  p_duplicate_id uuid
)
returns table (
  before_canonical_history bigint,
  before_canonical_malas bigint,
  before_canonical_count bigint,
  before_duplicate_history bigint,
  before_duplicate_malas bigint,
  before_duplicate_count bigint,
  moved_history bigint,
  after_canonical_history bigint,
  after_canonical_malas bigint,
  after_canonical_count bigint,
  after_duplicate_history bigint,
  active_normalized_my_japam bigint,
  adoption_markers bigint
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid text;
  v_legacy_uid text;
  v_owner text;
  v_dup_owner text;
  v_canonical_name text;
  v_canonical_archived timestamptz;
  v_duplicate_name text;
  v_duplicate_archived timestamptz;
  v_canonical_tombstones bigint;
  v_duplicate_tombstones bigint;
  v_duplicate_groups bigint;
  v_duplicate_markers bigint;
  v_foreign_duplicate_history bigint;
  v_foreign_canonical_history bigint;
  v_completion_collisions bigint;
  v_canonical_history bigint;
  v_canonical_malas bigint;
  v_canonical_count bigint;
  v_duplicate_history bigint;
  v_duplicate_malas bigint;
  v_duplicate_count bigint;
  v_moved bigint;
begin
  v_uid := auth.uid()::text;
  v_legacy_uid := auth.jwt()->'user_metadata'->>'sub';

  if v_uid is null and v_legacy_uid is null then
    raise exception 'authentication required';
  end if;

  if p_canonical_id is null or p_duplicate_id is null then
    raise exception 'consolidate_duplicate_my_japam failed: canonical and duplicate Japam ids are required';
  end if;

  if p_canonical_id = p_duplicate_id then
    raise exception 'consolidate_duplicate_my_japam failed: canonical and duplicate Japam ids must differ';
  end if;

  -- Lock BOTH Japam rows (canonical then duplicate) so a concurrent consolidate,
  -- restore, or delete on the same pair serializes on the same two rows.
  select j.user_id, j.name, j.archived_at
    into v_owner, v_canonical_name, v_canonical_archived
  from public.japams j
  where j.id = p_canonical_id
  for update;

  if v_owner is null then
    raise exception 'consolidate_duplicate_my_japam failed: canonical Japam not found';
  end if;

  select j.user_id, j.name, j.archived_at
    into v_dup_owner, v_duplicate_name, v_duplicate_archived
  from public.japams j
  where j.id = p_duplicate_id
  for update;

  if v_dup_owner is null then
    raise exception 'consolidate_duplicate_my_japam failed: duplicate Japam not found';
  end if;

  -- Ownership: every data write below is scoped by the Japam rows' ACTUAL stored
  -- user_id (v_owner), which for legacy Google sign-in differs from auth.uid().
  -- Both Japams must be owned by the same caller identity. IS DISTINCT FROM is
  -- required: a plain <> against a NULL identity evaluates to NULL (not TRUE) and
  -- would silently skip the check.
  if v_owner is distinct from v_uid
     and v_owner is distinct from v_legacy_uid then
    raise exception 'consolidate_duplicate_my_japam failed: canonical Japam is not owned by the caller';
  end if;

  if v_dup_owner is distinct from v_uid
     and v_dup_owner is distinct from v_legacy_uid then
    raise exception 'consolidate_duplicate_my_japam failed: duplicate Japam is not owned by the caller';
  end if;

  if v_dup_owner is distinct from v_owner then
    raise exception 'consolidate_duplicate_my_japam failed: canonical and duplicate Japams have different owners';
  end if;

  -- Both names must normalize to "my japam".
  if lower(btrim(regexp_replace(v_canonical_name, '\s+'::text, ' '::text, 'g'::text))) <> 'my japam' then
    raise exception 'consolidate_duplicate_my_japam failed: canonical Japam is not named My Japam';
  end if;

  if lower(btrim(regexp_replace(v_duplicate_name, '\s+'::text, ' '::text, 'g'::text))) <> 'my japam' then
    raise exception 'consolidate_duplicate_my_japam failed: duplicate Japam is not named My Japam';
  end if;

  -- State contract: canonical archived + tombstoned; duplicate active + not tombstoned.
  if v_canonical_archived is null then
    raise exception 'consolidate_duplicate_my_japam failed: canonical Japam must be archived';
  end if;

  if v_duplicate_archived is not null then
    raise exception 'consolidate_duplicate_my_japam failed: duplicate Japam must be active';
  end if;

  select count(*) into v_canonical_tombstones
  from public.deleted_japams
  where japam_id = p_canonical_id and user_id = v_owner;

  if v_canonical_tombstones <> 1 then
    raise exception 'consolidate_duplicate_my_japam failed: canonical Japam tombstone is missing';
  end if;

  select count(*) into v_duplicate_tombstones
  from public.deleted_japams
  where japam_id = p_duplicate_id;

  if v_duplicate_tombstones > 0 then
    raise exception 'consolidate_duplicate_my_japam failed: duplicate Japam is already tombstoned';
  end if;

  -- Group references on the duplicate are NOT supported: fail closed rather than
  -- silently re-pointing (or orphaning) a group membership.
  select count(*) into v_duplicate_groups
  from public.group_members
  where japam_id = p_duplicate_id;

  if v_duplicate_groups > 0 then
    raise exception 'consolidate_duplicate_my_japam failed: duplicate Japam has group membership';
  end if;

  -- A pending adoption marker for the duplicate is an unsupported reference.
  select count(*) into v_duplicate_markers
  from public.pending_japam_adoption
  where japam_id = p_duplicate_id;

  if v_duplicate_markers > 0 then
    raise exception 'consolidate_duplicate_my_japam failed: duplicate Japam has a pending adoption marker';
  end if;

  -- Ownership integrity on History: every row referencing either Japam must be
  -- owned by the single consolidated owner, otherwise the move would orphan data.
  select count(*) into v_foreign_duplicate_history
  from public.japam_history
  where japam_id = p_duplicate_id and user_id <> v_owner;

  if v_foreign_duplicate_history > 0 then
    raise exception 'consolidate_duplicate_my_japam failed: duplicate Japam has History rows owned by another user';
  end if;

  select count(*) into v_foreign_canonical_history
  from public.japam_history
  where japam_id = p_canonical_id and user_id <> v_owner;

  if v_foreign_canonical_history > 0 then
    raise exception 'consolidate_duplicate_my_japam failed: canonical Japam has History rows owned by another user';
  end if;

  -- completion_id is globally unique (japam_history_completion_id_unique); a
  -- collision between the two sets would abort the move mid-way, so fail up front.
  select count(*) into v_completion_collisions
  from public.japam_history d
  where d.user_id = v_owner and d.japam_id = p_duplicate_id
    and exists (
      select 1
      from public.japam_history c
      where c.user_id = v_owner
        and c.japam_id = p_canonical_id
        and c.completion_id = d.completion_id
    );

  if v_completion_collisions > 0 then
    raise exception 'consolidate_duplicate_my_japam failed: completion_id collision between canonical and duplicate History';
  end if;

  -- Before-totals.
  select count(*), coalesce(sum(malas), 0), coalesce(sum(count), 0)
    into v_canonical_history, v_canonical_malas, v_canonical_count
  from public.japam_history
  where user_id = v_owner and japam_id = p_canonical_id;

  select count(*), coalesce(sum(malas), 0), coalesce(sum(count), 0)
    into v_duplicate_history, v_duplicate_malas, v_duplicate_count
  from public.japam_history
  where user_id = v_owner and japam_id = p_duplicate_id;

  -- ===== Mutation (single transaction) =====
  -- Archive the duplicate FIRST so the partial unique index
  -- japams_user_id_normalized_name_key (active rows only) permits the canonical
  -- unarchive that follows.
  update public.japams
  set archived_at = now(),
      updated_at = now()
  where id = p_duplicate_id
    and user_id = v_owner;

  -- Unarchive the canonical BEFORE re-pointing History so the production
  -- _ws_no_history_to_archived_japam guard never observes a moved row whose
  -- japam_id points at an archived Japam.
  update public.japams
  set archived_at = null,
      updated_at = now()
  where id = p_canonical_id
    and user_id = v_owner;

  delete from public.deleted_japams
  where japam_id = p_canonical_id
    and user_id = v_owner;

  -- Preserve every History field; only japam_id changes.
  update public.japam_history
  set japam_id = p_canonical_id
  where user_id = v_owner
    and japam_id = p_duplicate_id;

  get diagnostics v_moved = row_count;

  insert into public.deleted_japams (japam_id, user_id, deleted_at)
  values (p_duplicate_id, v_owner, now())
  on conflict (japam_id) do nothing;

  insert into public.pending_japam_adoption (id, user_id, japam_id, created_at)
  values (
    gen_random_uuid(),
    v_owner,
    p_canonical_id,
    now()
  )
  on conflict (user_id, japam_id) do update
  set created_at = now();

  -- ===== Post-conditions (any drift RAISES and rolls the transaction back) =====
  select count(*) into active_normalized_my_japam
  from public.japams
  where user_id = v_owner
    and archived_at is null
    and lower(btrim(regexp_replace(name, '\s+'::text, ' '::text, 'g'::text))) = 'my japam';

  if active_normalized_my_japam <> 1 then
    raise exception 'consolidate_duplicate_my_japam failed: expected exactly one active normalized My Japam, found %', active_normalized_my_japam;
  end if;

  select count(*) into adoption_markers
  from public.pending_japam_adoption
  where user_id = v_owner and japam_id = p_canonical_id;

  if adoption_markers <> 1 then
    raise exception 'consolidate_duplicate_my_japam failed: expected exactly one adoption marker, found %', adoption_markers;
  end if;

  select count(*), coalesce(sum(malas), 0), coalesce(sum(count), 0)
    into after_canonical_history, after_canonical_malas, after_canonical_count
  from public.japam_history
  where user_id = v_owner and japam_id = p_canonical_id;

  select count(*) into after_duplicate_history
  from public.japam_history
  where user_id = v_owner and japam_id = p_duplicate_id;

  if after_canonical_history <> v_canonical_history + v_duplicate_history then
    raise exception 'consolidate_duplicate_my_japam failed: History row totals did not consolidate';
  end if;

  if after_canonical_malas <> v_canonical_malas + v_duplicate_malas then
    raise exception 'consolidate_duplicate_my_japam failed: malas totals did not consolidate';
  end if;

  if after_canonical_count <> v_canonical_count + v_duplicate_count then
    raise exception 'consolidate_duplicate_my_japam failed: count totals did not consolidate';
  end if;

  if after_duplicate_history <> 0 then
    raise exception 'consolidate_duplicate_my_japam failed: duplicate Japam still has History rows';
  end if;

  before_canonical_history := v_canonical_history;
  before_canonical_malas := v_canonical_malas;
  before_canonical_count := v_canonical_count;
  before_duplicate_history := v_duplicate_history;
  before_duplicate_malas := v_duplicate_malas;
  before_duplicate_count := v_duplicate_count;
  moved_history := v_moved;

  return next;
end;
$$;

revoke all on function public.consolidate_duplicate_my_japam(uuid, uuid) from public;
revoke all on function public.consolidate_duplicate_my_japam(uuid, uuid) from anon;
revoke all on function public.consolidate_duplicate_my_japam(uuid, uuid) from authenticated;
grant execute on function public.consolidate_duplicate_my_japam(uuid, uuid) to authenticated;
