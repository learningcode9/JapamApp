# release-data-integrity-v1

**Date:** 2026-07-01
**Commit:** `e229f2e3c426db2210d9a34bb2f4c706d8268725`
**Git tag:** `release-data-integrity-v1`

This milestone follows [release-history-stable-v1](RELEASE_HISTORY_STABLE_V1.md) and closes out the data-integrity work that milestone left open: Groups restore, the japam_history/Group Dashboard total mismatch, and its root cause.

## Problems that existed

1. **Groups not restoring for signed-in users.** `groups.created_by` and `group_members.user_id` were still keyed by the legacy Google numeric "sub" id for every existing row, but the app's identity-repair logic (`repairLegacyStoredUserId`) upgrades a signed-in user's locally-stored id to their Supabase Auth UUID. Every Groups RPC's exact-match filter (`gm.user_id = p_user_id`) then searched for a UUID the rows didn't have, so existing groups/memberships silently disappeared for anyone who had signed in since that change shipped — even though the membership row still existed.
2. **Group Dashboard totals didn't match the History screen** for the same user (e.g. bsravani89: History showed 36 malas/3888 count, Group Dashboard showed 38/4104). Root cause: 15 "zombie" `japam_history` rows existed system-wide — tombstoned in `deleted_completions` but never actually deleted from `japam_history`. History filters tombstoned rows client-side before summing (so it was correct); the dashboard summed `japam_history` directly with no tombstone awareness (so it wasn't).
3. **The zombie rows themselves had a permanent root cause**, not just historical drift: the delete flow wrote a tombstone and deleted the `japam_history` row as two independent REST calls. Any interruption between them left a zombie. Worse, the background retry path (`syncPendingHistory` in `contexts/timer-context.tsx`) performed its `DELETE` using only the anon key — `japam_history` has never had an anon DELETE RLS policy — so that path's delete was silently rejected by RLS every single time, guaranteeing a zombie row whenever a delete completed through background sync rather than immediately.

## Root causes

- **Groups**: no migration had ever been run to move `groups`/`group_members` off legacy numeric ids, unlike `japam_history` (whose identity migration is referenced in code comments, run directly against production earlier in this project's history).
- **Zombie rows**: delete-operation non-atomicity. Tombstone-write and row-delete were two separate, independently-committing HTTP requests with no shared transaction.
- **Guaranteed zombies via background sync**: an RLS policy gap. `db/deleted_completions_migration.sql` explicitly drops `"anon delete japam_history"` in favor of an `authenticated`-only delete policy, but the background sync code path never accounted for that — it kept deleting with the anon key.

## Permanent fixes implemented

### 1. Groups identity migration
`groups.created_by` and `group_members.user_id` rewritten from legacy numeric ids to their corresponding Supabase Auth UUIDs, for 8 verified users across 4 groups / 9 memberships. Verified via a 7-point read-only check before migrating (unique mapping, zero duplicates, zero unmapped rows, no mixed-identity rows, no unique-constraint collisions, zero orphans) and a dry-run (`rollback`) before the real `commit`.

### 2. Zombie row cleanup
The 15 existing zombie rows (2 for bsravani89, 13 for Sita Bellam) were deleted from `japam_history` (their tombstones were already correct and untouched). Backed up first; dry-run validated before the real commit.

### 3. Atomic delete RPC (the permanent fix — prevents new zombies)
`db/atomic_delete_history_rpc.sql` adds `delete_history_completions(p_completion_ids text[])`: a `SECURITY DEFINER` function that writes the tombstone(s) and deletes the matching `japam_history` row(s) in one transaction. Authenticated-only (`auth.uid()` required, function raises if null; granted only to `authenticated`, no anon grant). No client-supplied `user_id` — identity comes solely from the caller's own JWT. Includes a narrow fallback matching the JWT's Google `sub` claim (mirrors the existing, already-approved `japam_history` RLS policy) so the small number of still-legacy-keyed `japam_history` rows (13, across 3 users — see "Remaining known work") can still be deleted by their rightful owner without creating a new zombie via identity mismatch.

Both call sites were updated to use this RPC instead of two independent REST calls:
- `app/(tabs)/history.tsx` — the immediate, user-initiated delete (requires an active session; skips the remote step and queues via tombstone if none).
- `contexts/timer-context.tsx` — the background retry path (`syncPendingHistory`), which previously used the anon key exclusively. It now checks for a real authenticated session first; if none exists, the remote push is skipped for that pass and retried automatically on a later sync (app foreground/reconnect/sign-in) rather than ever attempting an anon-key delete.

### 4. `get_group_dashboard` tombstone-awareness (defense-in-depth)
The live deployed function (confirmed via `pg_get_functiondef` — it had already drifted from `db/groups_migration.sql`'s on-disk version, which reads totals from a join to `japam_user_totals`; the live version instead sums `japam_history` directly) summed both its "today" and "lifetime total" subqueries directly from `japam_history` with no awareness of `deleted_completions`. `db/update_group_dashboard_tombstone_aware.sql` adds a `not exists (select 1 from public.deleted_completions dc where dc.completion_id = h.completion_id)` filter to both subqueries, so the dashboard can never overstate totals relative to History even if a future delete's remote step is delayed (e.g. an offline window before the atomic delete RPC completes remotely). Groups dashboard now excludes tombstoned/deleted completions, matching History's own client-side filtering exactly.

### 5. `japam_history` legacy-id cleanup (12 of 13 remaining rows)
Of the 13 `japam_history` rows still keyed by a legacy Google numeric sub, 12 mapped cleanly to an existing `auth.users` account and were migrated to UUID via `db/migrate_japam_history_legacy_ids_to_uuid.sql`: 2 rows for bsubbarao56@gmail.com and 10 rows for bellam.komali@gmail.com. The 13th row (id=952, legacy sub `113106083586126585402`) has no matching account anywhere in the project and was intentionally left untouched — it cannot be safely rewritten without knowing which account it belongs to. `japam_history` now has exactly **1 legacy-keyed row remaining system-wide**, and the atomic delete RPC's Google-sub fallback is provably dead code for every case except that single orphan row.

## Database migrations executed (production, via Supabase SQL Editor)

All run manually by the user after dry-run (`rollback`) verification, per this project's established migration discipline (backup first, transaction, post-verification before commit, rollback section retained).

1. **Groups UUID migration** — `db/migrate_groups_numeric_user_ids_to_uuid.sql`. Backup tables retained: `groups_backup_pre_uuid_migration`, `group_members_backup_pre_uuid_migration`.
2. **Zombie row cleanup** — `db/cleanup_zombie_history_rows.sql`. Backup table retained: `japam_history_zombie_backup`.
3. **Atomic delete RPC creation** — `db/atomic_delete_history_rpc.sql`. Additive (`create or replace function`), no data changes.
4. **`get_group_dashboard` tombstone-awareness** — `db/update_group_dashboard_tombstone_aware.sql`. Additive (`create or replace function`), no data changes. Applied directly via the SQL Editor; the migration file was written and committed afterward to capture it in source control.
5. **`japam_history` legacy-id cleanup** — `db/migrate_japam_history_legacy_ids_to_uuid.sql`. Backup table retained: `japam_history_legacy_id_backup`. Dry-run (`rollback`) validated before the real `commit`.

## Validation performed

- **Groups restore**: live device validation signed in as bsravani89 — "Gayatri matha" correctly visible (and only that group, matching the real membership data), dashboard opens cleanly, roles render correctly (Sarada shown as admin), no RPC/permission errors in logcat.
- **Zombie cleanup**: independent read-only re-verification via the REST API (outside the SQL Editor session) confirmed bsravani89 = 36/3888 and Sita = 382/41256 (her live total minus the fixed 25/2700 zombie offset — she had new legitimate activity during the investigation window), zero zombie rows remaining system-wide (1550 `japam_history` rows / 263 tombstones cross-referenced).
- **Atomic delete RPC**: `tsc --noEmit` and the Jest suite pass (only the pre-existing, out-of-scope `lib/__tests__/supabase.test.ts` failure remains, flagged since the start of this work and unrelated to it). Local Android build (`--rerun-tasks`, full rebuild, not incremental) installed and tested on-device:
  - Authenticated delete (`history.tsx`) correctly failed closed before the RPC existed (no partial state — zero remote tombstone, zero remote delete — proving the atomicity guarantee holds even on failure), then succeeded once the RPC was created.
  - Background sync path (`timer-context.tsx`) — the path that was previously guaranteed to create a zombie — completed the same delete correctly using a real authenticated session; both the tombstone insert and the row delete share the exact same DB timestamp, confirming one atomic transaction.
  - History screen total updated correctly after deletion (37/3996 → 31/3348, exactly the deleted day's contribution).
  - Post-test system-wide re-check: zero zombie rows.
- **`get_group_dashboard` tombstone-awareness**: confirmed via `pg_get_functiondef(...) like '%deleted_completions%'` → `true`. Direct RPC call and raw `japam_history` sum matched exactly (31/3348) for bsravani89. Validated end-to-end in the real app UI (not just direct SQL/RPC calls): History total = Groups Dashboard total = **31 malas / 3348 count** for bsravani89, with today's malas/count also matching between both screens (0/0). Zero RPC/permission/"not a member" errors observed in logcat during validation.
- **`japam_history` legacy-id cleanup**: dry-run (`rollback`) matched all expected values exactly before the real commit. Independently re-verified via the REST API after commit: 0 rows remain for the two migrated legacy ids, orphan id=952 unchanged, total `japam_history` row count unchanged at 1551, 0 duplicate `completion_id`s, Komali's rows = **186** (176 pre-existing + 10 migrated), bsubbarao56's rows = **75** (73 pre-existing + 2 migrated).

## Remaining known work

- **1 `japam_history` row still legacy-numeric-keyed**: the orphan, id=952 (legacy sub `113106083586126585402`), which has no matching `auth.users` account anywhere in the project. Left intentionally untouched; still coverable by the atomic delete RPC's Google-sub fallback if its owner is ever identified, but cannot be safely migrated to UUID without knowing which account it belongs to.
- **`japam_user_totals`** was found to be a dead/stale table for at least the accounts investigated (showing 0/0, unrelated to either History's or the dashboard's actual totals). Not touched by this milestone; worth a future decision on whether to fix or remove.
- Carried over from `release-history-stable-v1`: "Today's count investigation" and cleanup of the temporary `[LOCAL_FIX_BUILD_MARKER]` diagnostic log.

## Rollback references

- Groups migration: restore from `groups_backup_pre_uuid_migration` / `group_members_backup_pre_uuid_migration` (see the rollback section in `db/migrate_groups_numeric_user_ids_to_uuid.sql`).
- Zombie cleanup: restore from `japam_history_zombie_backup` (see the rollback section in `db/cleanup_zombie_history_rows.sql`).
- Atomic delete RPC: additive only; rollback is `drop function public.delete_history_completions(text[]);` if ever needed, though this would revert to the non-atomic, zombie-prone delete behavior in the app code as well.
- `get_group_dashboard` tombstone-awareness: additive only (`create or replace function`); rollback would mean re-applying the prior function body (recoverable via `pg_get_functiondef` if ever captured again, or by reverting to `db/groups_migration.sql`'s original definition, noting that one is stale relative to what was actually live before this fix).
- `japam_history` legacy-id cleanup: restore from `japam_history_legacy_id_backup` (see the rollback section in `db/migrate_japam_history_legacy_ids_to_uuid.sql`).
- Code: if a future release causes delete/history regressions, compare against this tag (`release-data-integrity-v1`) or, for anything predating this work, `release-history-stable-v1` first.

## Git reference

- **Commit:** `e229f2e3c426db2210d9a34bb2f4c706d8268725`
- **Tag:** `release-data-integrity-v1`
- **Not deployed / not OTA'd.** This tag marks a verified, releasable repository state only — deployment is a separate, explicitly-approved step.
