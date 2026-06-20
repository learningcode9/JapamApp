# Japam App Architecture Vision

Status: planning document only. No schema, Supabase, app code, migration, deploy, or release action is implied by this file.

## 1. Executive Summary

Mantra Japam is moving from a single-user practice tracker into a multi-mode, social, offline-first spiritual practice platform. The current app already has the hard parts of a serious product: offline history, timer/tap/manual completion paths, Supabase sync, Google sign-in, guest/anonymous identity planning, groups, invite codes, and group dashboards.

The architecture can support near-term growth, but several decisions should be made before the app grows from tens of users to thousands:

- Identity must become the spine of the system. Today `user_id` is an opaque text value that can be a Google numeric id, anonymous UUID, email, or test id. This has been pragmatic, but true secure group authorization and durable account migration will eventually require an auth-owned canonical user id.
- History should become a practice-event ledger. Current `japam_history` is close to this, but future Gayatri/Rama Nama/Vishnu Sahasranamam/custom japas need explicit `practice_id` or `mantra_id` before reporting becomes complex.
- Groups need lifecycle RPCs before they grow: admin management, member removal, leave group, ownership transfer, archive/delete, invite rotation, and auditability.
- Reporting should move from repeated client-side aggregation to indexed server-side summary tables or materialized views once usage grows.
- Offline-first must remain local-source-first: local pending records should never be overwritten by remote restore.

Recommended direction: protect existing user data by treating current tables as compatibility tables, then add small forward-compatible columns/tables in phases instead of rewriting everything at once.

## 2. Current State

### App Features

Current major features:

- Timer Japam
- Tap Japam
- Manual Entry
- Japam History
- Malas Today / Today Count / Day Streak / total statistics
- Google Sign-In
- Guest Mode / Anonymous Auth migration work
- Groups
- Invite Codes
- Group Dashboard
- Supabase backend
- Offline-first local history storage
- Completion deduplication by `completion_id`
- Tombstone-based delete model in planning/migration SQL

### Known Code Sources Reviewed

- `lib/historyStore.ts`
- `lib/groupsRepository.ts`
- `lib/anonymousAuth.ts`
- `lib/groupsTypes.ts`
- `db/groups_migration.sql`
- `db/groups_invite_code_rpc.sql`
- `db/deleted_completions_migration.sql`
- `GUEST_TO_ANON_AUTH_MIGRATION.md`
- Current tab screens and Supabase usage paths found via repository search

## 3. Current Database Review

### Current Tables Inferred From Repo

The repository references these Supabase tables:

| Table | Current purpose | Notes |
|---|---|---|
| `japam_history` | Completion/session history for timer, tap, manual | Main event source for daily stats and history. |
| `japam_user_totals` | Lifetime totals per user | Used by group dashboard and some total display paths. |
| `japam_timer_state` | Timer state persistence | Older timer-state sync table; should stay separate from completion history. |
| `user_profiles` | User profile / japam name legacy data | Known inconsistency: rows may be keyed by email or other ids. |
| `deleted_completions` | Tombstones for deleted history rows | Good model for offline delete propagation. |
| `groups` | Group metadata | Has `name`, `invite_code`, `created_by`, `is_active`. |
| `group_members` | Group membership and roles | Has `group_id`, `user_id`, `user_name`, `role`. |

### Current Relationships

Current logical relationships:

- `japam_history.user_id` -> app user identity, but not enforced as FK.
- `japam_user_totals.user_id` -> app user identity, but not enforced as FK.
- `group_members.group_id` -> `groups.id`, enforced with `on delete cascade`.
- `group_members.user_id` -> app user identity, not enforced as FK.
- `deleted_completions.completion_id` -> logical `japam_history.completion_id`, not enforced as FK.

This design is flexible and compatible with legacy data, but it shifts correctness into app/RPC code.

### Naming Consistency

Current naming is mostly understandable, but inconsistent across app layers:

- Database uses snake_case: `user_id`, `user_name`, `created_at`, `completion_id`.
- App models use camelCase: `userId`, `userName`, `completionId`.
- `count` in Supabase maps to `totalCount` in app.
- `malas` means completed malas, while `count` means repetitions. This is workable but easy to misuse.
- `manual` is a boolean in local records; `source` exists in local model but is not clearly represented in the Supabase payload type.

Recommended future naming:

- Keep existing columns for compatibility.
- Add explicit columns rather than overloading:
  - `source`: `timer | tap | manual | import | adjustment`
  - `practice_id`
  - `repetition_count`
  - `mala_count`
  - `completed_at`
- Avoid using `count` in new schema; prefer `repetition_count`.

### Potential Weaknesses

1. Identity is not cryptographically enforced

   Current group RPCs accept `p_current_user_id` as a client-supplied string. This is documented in `db/groups_migration.sql` as a known limitation. A malicious client that knows another user's id could potentially query as that user under the current anon-key model.

2. History table is both event ledger and reporting source

   This is fine at small scale, but repeated daily/lifetime aggregation from raw history becomes expensive as history grows.

3. `completion_id` generation is timestamp-based

   It is good enough for deduping current completion flows, but should eventually include source/session entropy or use a true UUID generated at event creation. Timestamp-only ids can collide if the same user creates multiple records at the same millisecond.

4. Local day vs UTC day complexity

   The app correctly treats local day as user-facing truth, but Supabase stores UTC `created_at`. This is correct, but all reporting queries must explicitly convert or receive local day boundaries.

5. No canonical practice/mantra dimension

   Today all completions are generic "Japam." Multi-japa support will be painful if this is not designed before adding new mantra types.

6. Duplicate auth logic and legacy identity drift

   The migration plan notes duplicate sign-in/guest logic across multiple screens and mixed identity formats in live data.

### Missing or Future Indexes

Likely useful indexes:

- `japam_history(user_id, created_at)` for daily history and dashboard ranges.
- `japam_history(user_id, completion_id)` or unique `completion_id` if global uniqueness is trusted.
- `japam_history(completion_id)` if not already unique/indexed.
- `japam_history(user_id, source, created_at)` if source-specific reporting grows.
- `japam_history(user_id, practice_id, created_at)` once multi-japa exists.
- `japam_user_totals(user_id)` should be unique/indexed.
- `deleted_completions(user_id)` already exists in migration.
- `group_members(user_id)` exists in migration.
- `group_members(group_id, role)` for admin/member queries at scale.
- `groups(created_by)` for owner/admin management.

Classification:

- Can do now: verify/index `japam_history(user_id, created_at)` and `completion_id` uniqueness/indexing, after measuring current table size and checking existing indexes.
- Can wait: source/practice indexes until the columns exist.
- Avoid entirely: indexing every column preemptively.

## 4. Groups Architecture Review

### Current Groups Design

Current model:

- `groups`
  - `id`
  - `name`
  - `invite_code`
  - `created_by`
  - `created_at`
  - `is_active`
- `group_members`
  - `id`
  - `group_id`
  - `user_id`
  - `user_name`
  - `role`: `admin | member`
  - `joined_at`
  - unique `(group_id, user_id)`

Current RPC approach is good:

- `create_group` is atomic.
- `find_group_by_invite_code` limits invite lookup exposure.
- `get_my_groups` scopes group list by user id.
- `get_group_dashboard` gates by membership.
- Admin invite-code retrieval has a dedicated RPC.

### Can It Support Future Group Types?

Target group types:

- Family Groups
- Gayatri Groups
- Rama Nama Groups
- Temple Groups
- Challenge Groups

Current `groups.name` can represent these informally, but the system will need structured metadata.

Recommended future columns/table:

- `group_type`: `family | mantra | temple | challenge | custom`
- `practice_id` nullable: for Gayatri/Rama Nama-specific groups.
- `description`
- `visibility`: `private | invite_only | public`
- `timezone` optional for group-local reports.
- `challenge_start_at`, `challenge_end_at`, `challenge_goal_count` if challenge groups are real.

Classification:

- Can do now: reserve a roadmap item for `group_type` and `practice_id`; do not rush unless UI is imminent.
- Can wait: challenge fields until challenge feature is designed.
- Avoid entirely: making a separate table per group type.

### Multiple Groups Per User

Current `group_members` supports multiple groups per user already because uniqueness is `(group_id, user_id)`.

Needs:

- UI must avoid assuming one group.
- Dashboard queries should be paginated or scoped per group.
- Group stats should be cached once group membership grows.

Classification: already supported; no schema change needed now.

### Multiple Admins

Current `role` supports multiple admins because many members can have `role='admin'`.

Missing:

- RPC to promote admin.
- RPC to demote admin.
- Guard preventing last admin from being demoted/removed.
- Audit record for admin changes.

Classification:

- Can do now if group administration UI is coming.
- Can wait if groups are still invite/dashboard only.

### Group Ownership Transfer

Current `groups.created_by` identifies creator but does not fully model ownership.

Options:

1. Treat any `admin` as owner-level authority.
2. Add `owner_user_id`.
3. Add `group_roles` with permissions.

Recommendation:

- Add `owner_user_id` when transfer is needed.
- Keep `created_by` as historical creator.
- Do not overload `created_by` as mutable ownership.

Classification: can wait until ownership transfer UI exists, but design should be accepted now.

### Member Removal and Leave Group

Current DB comments already identify this as future RPC work. Direct table updates/deletes should remain blocked under RLS; use SECURITY DEFINER RPCs.

Needed RPCs:

- `leave_group(group_id, current_user_id)`
- `remove_group_member(group_id, acting_admin_user_id, target_user_id)`
- `promote_group_admin(...)`
- `demote_group_admin(...)`
- `rename_group(...)`
- `regenerate_invite_code(...)`
- `archive_group(...)`

Rules:

- Member can leave self.
- Admin can remove member.
- Admin cannot remove/demote last admin.
- Owner transfer required before owner leaves, if owner model exists.

Classification: can wait, but RPC shape should be planned before UI.

### Group Deletion

Use soft delete/archive first:

- `is_active = false`
- optional `archived_at`
- optional `archived_by`

Hard delete should be avoided early because:

- It can erase social context.
- It complicates audit/history.
- It may surprise members.

Classification:

- Can do now: continue using `is_active`.
- Can wait: archive RPC.
- Avoid entirely: immediate hard delete from client UI.

## 5. Multi-Japa Future

Future practice types:

- Gayatri
- Rama Nama
- Vishnu Sahasranamam
- Lalitha Sahasranamam
- Custom Japas

### Current History Schema Fit

Current history records capture:

- user
- timestamp
- malas
- repetitions/count
- duration
- manual boolean/source locally
- completion id

Missing for multi-japa:

- Which practice/mantra was completed.
- Target count per mala or unit.
- Whether a completion is a mala, verse-set, parayana, timer session, or custom unit.
- Practice display name independent of user-entered labels.

### Recommended Future Schema

Add a practice dimension instead of adding columns for each mantra.

Recommended tables:

```text
practices
- id uuid primary key
- key text unique
- display_name text
- default_unit text
- default_repetition_target integer
- is_system boolean
- created_by_user_id text nullable
- created_at timestamptz
- is_active boolean

user_practices
- user_id text
- practice_id uuid
- display_name_override text nullable
- default_duration_sec integer nullable
- default_loop_count integer nullable
- sort_order integer
- is_active boolean
- created_at timestamptz
```

Then add to history:

```text
japam_history.practice_id uuid nullable
japam_history.source text nullable
japam_history.unit text nullable
```

Compatibility:

- Existing rows with null `practice_id` mean "default Mantra Japam."
- Backfill later if needed with a default practice id.
- App can read null as default forever.

Classification:

- Can do now: design and document the default practice concept.
- Can wait: actual schema until multi-japa feature is scheduled.
- Avoid entirely: separate history tables per japa; that will fragment reporting.

## 6. Identity Architecture Review

### Current State

Identity is in transition:

- Google Sign-In exists.
- Guest Mode exists.
- Anonymous Auth migration is in progress/planned.
- `user_id` is text and intentionally opaque.
- Some historical data may have Google numeric ids, anonymous UUIDs, email-like ids, or test ids.
- Supabase client exists, but many app paths use manual REST fetch with anon key.

### Strengths

- Text `user_id` protected the app from painful immediate UUID migration.
- Anonymous Auth plan is the correct long-term direction.
- Guest-to-Google linking can preserve `auth.uid()` if implemented consistently.

### Risks

1. Decision drift

   The migration document says Option A is approved: anonymous users sync immediately. But `lib/anonymousAuth.ts` still exposes `shouldSkipRemoteSync(userId, isAnonymous)` that returns true for anonymous users. This does not prove the app is currently wrong, but it is a dangerous conceptual mismatch.

2. Duplicate auth flows

   The migration document notes auth logic duplicated across Timer, Tap, and older Main screens. Duplicate auth flows create iOS/browser-specific bugs and inconsistent session hydration.

3. Client-supplied identity

   Group RPCs accept user id strings. This is not secure enough for large social/group features.

4. Multiple Google accounts

   A user could create history under one Google account, then sign into another. Without explicit account switch UX, data can appear lost.

5. Guest/anonymous migration

   If guest local history and anonymous remote history coexist, merge rules must be explicit and tested.

### Recommended Identity Future State

Canonical model:

- Supabase Auth `auth.users.id` is the canonical user id.
- App stores `USER_ID_KEY = auth.uid()`.
- Google identity is attached to the same auth user through Supabase identity linking.
- Anonymous users also have real auth users.
- `profiles` table is keyed by `auth_user_id`.
- Legacy external ids are stored separately.

Recommended tables:

```text
profiles
- user_id uuid primary key references auth.users(id)
- display_name text
- email text
- avatar_url text nullable
- created_at timestamptz
- updated_at timestamptz

legacy_user_id_map
- legacy_user_id text primary key
- user_id uuid not null
- source text
- migrated_at timestamptz
```

Migration strategy:

- Do not convert existing `user_id text` columns to uuid in place.
- Add compatibility mapping first.
- New writes use `auth.uid()::text`.
- Old rows can be read via map until backfilled.

Classification:

- Can do now: centralize auth/session source and resolve Option A/skip-sync mismatch.
- Can wait: full legacy id mapping until anonymous migration is ready.
- Avoid entirely: hard type conversion of existing `user_id text` to `uuid`.

## 7. Reporting Architecture

### Future Reports

Potential reporting:

- Lifetime malas
- Per-mantra stats
- Family totals
- Group leaderboards
- Monthly reports
- Personal streaks
- Practice consistency calendars
- Admin group dashboard
- Challenge progress

### Current Support

Current reporting works for:

- Today's malas/count via local history.
- History rows grouped by local date.
- Group dashboard today's stats via RPC and caller-provided day boundaries.
- Lifetime totals via `japam_user_totals`.

### Reporting Risks

1. Raw history scans will become costly.

   At 10,000 users, if each user completes multiple sessions daily, `japam_history` grows quickly.

2. Local-day reports are timezone-sensitive.

   User-facing "today" must be local to the user/device. Group-level reports must decide whether "today" is viewer-local, group-local, or member-local.

3. Lifetime totals table can drift.

   `japam_user_totals` is a cache/summary. It must be updated consistently or periodically reconciled against history.

4. Group leaderboards need indexed aggregate paths.

   Joining group members to raw history every time will become slow for active groups.

### Recommended Reporting Future State

Keep raw history as source of truth, but add summary tables:

```text
user_daily_stats
- user_id
- local_day
- timezone
- practice_id nullable
- mala_count
- repetition_count
- duration_sec
- completion_count
- updated_at
- primary key (user_id, local_day, practice_id)

user_lifetime_stats
- user_id
- practice_id nullable
- mala_count
- repetition_count
- duration_sec
- completion_count
- updated_at

group_daily_stats
- group_id
- local_day
- practice_id nullable
- mala_count
- repetition_count
- member_count
- updated_at
```

Design rule:

- Raw `japam_history` remains immutable-ish event ledger.
- Summary tables are derived and can be rebuilt.
- Deletes use tombstones and decrement/rebuild summaries safely.

Classification:

- Can do now: document raw history as source of truth and totals as cache.
- Can wait: summary tables until query volume warrants them.
- Avoid entirely: using only `japam_user_totals` for all future reports.

## 8. Scalability Review

### 100 Users

Likely fine with current architecture.

Main risks:

- Product bugs, not infrastructure.
- Auth/session inconsistencies.
- Offline sync bugs.
- Date bucketing confusion.

Recommended focus:

- Stabilize identity and history dedup.
- Add observability/logging for sync failures.
- Keep unit tests around historyStore.

### 1,000 Users

Tables growing fastest:

1. `japam_history`
2. `deleted_completions`
3. `japam_timer_state`
4. `group_members`
5. `japam_user_totals`

Likely bottlenecks:

- Fetching full user history repeatedly.
- Dashboard RPC joining raw history for every member.
- Missing `japam_history(user_id, created_at)` index.
- Duplicate manual REST fetch logic.
- No centralized sync queue visibility.

Recommended focus:

- Add indexes based on actual query plans.
- Paginate history screen.
- Use date-range fetches instead of all-history fetches for today's stats.
- Move repeated Supabase fetch code into shared repository functions.

### 10,000 Users

At this point, raw event data could be large if daily practice is strong.

Likely bottlenecks:

- Group dashboard aggregations.
- Monthly/lifetime reports over raw rows.
- Offline sync conflict handling.
- RLS/security risk from client-supplied user ids.
- App startup if it loads full history.

Recommended focus:

- Auth.uid-based RLS.
- Summary tables/materialized views.
- Incremental sync by `updated_at` or cursor.
- History pagination.
- Server-side RPCs for reports.
- Background reconciliation jobs for totals.

## 9. Migration Safety Principles

Use these rules for every future schema change:

1. Additive first

   Add nullable columns or new tables before changing existing behavior.

2. Compatibility reads

   App must read both old and new rows during transition.

3. Backfill later

   Backfill in small batches. Do not block app release on a full migration unless required.

4. Raw history is sacred

   Do not rewrite or delete user history unless a user explicitly deletes account/data.

5. Local pending records are sacred

   Supabase restore must merge, never overwrite pending local records.

6. Summary tables are rebuildable

   If totals drift, rebuild from history rather than trusting cached values blindly.

7. Avoid hard identity conversions

   Do not convert text user ids to uuid in place until all legacy formats are resolved.

## 10. Suggested Improvements by Classification

### Can Do Now

These are low-risk, high-leverage design/cleanup items.

1. Document canonical identity decision

   Decide whether Option A anonymous sync is the product truth, then remove or quarantine helper logic that says anonymous should skip sync.

2. Centralize auth/session state

   Reduce duplicate Google/guest logic across screens. This prevents iPhone/Android/browser auth drift.

3. Verify current Supabase indexes

   Especially:

   - `japam_history(completion_id)`
   - `japam_history(user_id, created_at)`
   - `japam_user_totals(user_id)`

4. Keep all new history writes local-first

   Timer, Tap, Manual, and future Group/Challenge completions should all use one append/sync path.

5. Add a practice dimension design doc

   Even if schema waits, decide the shape of `practices` and `practice_id` now.

6. Plan group admin RPCs

   Define contracts for remove member, leave group, promote/demote admin, ownership transfer, rename, archive, invite regeneration.

7. Define date semantics

   State clearly:

   - User personal stats use user's local day.
   - Group dashboards use viewer-local day for now, or group-local day later if `groups.timezone` is added.

### Can Wait

These are useful but not urgent until product scope expands.

1. Add `practice_id` to history

   Wait until multi-japa is actively scheduled, but design now.

2. Add summary tables

   Wait until performance or reporting complexity requires it.

3. Add group ownership transfer

   Wait until groups have meaningful admin lifecycle.

4. Add challenge group fields

   Wait until challenges are product-designed.

5. Add materialized reports

   Wait until there is enough data to justify operational complexity.

6. Add audit log

   Useful for admin/group changes, but can wait until moderation/admin features grow.

### Avoid Entirely

These paths are likely to create painful migrations.

1. Separate history tables per mantra

   This will make reporting and groups much harder.

2. Hard converting `user_id text` to `uuid`

   Legacy Google numeric ids and email/test ids make this dangerous.

3. Using group name as group type

   Names are user-facing; type should be structured.

4. Permanent hard delete for groups

   Prefer archive/soft delete.

5. Client-side-only authorization for admin actions

   Admin actions should be RPC-enforced server-side.

6. Full-history fetch on every app launch forever

   It will not scale to years of daily use.

## 11. Recommended Roadmap

### Phase 0: Stabilize Product Truth

Priority: immediate.

- Confirm anonymous/guest sync model.
- Make auth/session source shared.
- Ensure every completion path uses the same history append/sync semantics.
- Preserve `completion_id` dedup and local-day bucketing.
- Verify indexes already present in Supabase.

### Phase 1: Secure Identity Foundation

Priority: before groups become widely used.

- Move toward Supabase Auth `auth.uid()` as canonical user id.
- Create or standardize `profiles`.
- Plan `legacy_user_id_map`.
- Start shifting RPCs/RLS from client-supplied user id to `auth.uid()`.

### Phase 2: Groups Lifecycle

Priority: before group growth.

- Add RPCs for:
  - leave group
  - remove member
  - promote/demote admin
  - rename group
  - regenerate invite
  - archive group
- Prevent last-admin removal.
- Consider `owner_user_id` if ownership transfer matters.

### Phase 3: Multi-Japa Foundation

Priority: before adding Gayatri/Rama Nama/etc.

- Add `practices` table.
- Add nullable `practice_id` to future history writes.
- Treat existing null practice rows as default Mantra Japam.
- Add UI only after data model is stable.

### Phase 4: Reporting Scale

Priority: when user base or report complexity grows.

- Add `user_daily_stats`.
- Add `user_lifetime_stats`.
- Add group summaries.
- Rebuild summaries from raw history as needed.
- Paginate history and report APIs.

### Phase 5: Operational Hardening

Priority: as active users approach thousands.

- Add sync diagnostics and admin-only health checks.
- Add reconciliation jobs for history vs totals.
- Add account deletion automation.
- Add privacy/export tooling.
- Add backup/restore runbooks.

## 12. Highest-Risk Areas

1. Identity and RLS

   This is the most important long-term risk. Groups make identity security more urgent because data is no longer only personal.

2. Multi-japa without `practice_id`

   If new mantra types are added by overloading names or sources, reporting will become fragile.

3. Offline sync edge cases

   Local pending data must never disappear. This must stay unit-tested.

4. Date bucketing

   Local day vs UTC day must be consistently handled for all personal and group reports.

5. Summary drift

   If `japam_user_totals` diverges from `japam_history`, group dashboards and lifetime stats lose trust.

## 13. Final Recommendation

Do not start new large user-facing features until the architecture decisions below are explicitly accepted:

1. Canonical identity model: Supabase Auth UUID as long-term identity, with legacy mapping.
2. History model: raw completion ledger remains source of truth.
3. Multi-japa model: one `practices` dimension, not separate tables.
4. Groups model: admin actions through SECURITY DEFINER RPCs, no direct client mutations.
5. Reporting model: summary tables are derived/cache, not source of truth.

The app does not need a big rewrite right now. The safest path is phased, additive evolution: keep the stable history behavior users rely on, add future columns/tables only when the product feature is ready, and avoid irreversible identity or history rewrites.
