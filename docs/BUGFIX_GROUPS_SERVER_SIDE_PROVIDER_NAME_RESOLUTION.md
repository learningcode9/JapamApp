# Groups Dashboard — Server-side Provider Name Resolution

**Date:** 2026-07-13
**Production execution:** `2026-07-13T19:07:21Z`
**Function:** `public.get_group_dashboard(uuid, text, timestamptz, timestamptz)`
**Fingerprint before → after:** `cf6b9d521a8f82928c6bcf969cbf67d2` → `1b8498d09e680284ed5198138c11b0dc`

---

## Executive Summary

A production user signed in with the Google account "Subbarao Bellam" and consistently saw the Groups dashboard display "bellam" instead of "Subbarao." The cause was that the dashboard's display name came from `group_members.user_name`, a write-once snapshot captured at join time, whenever no canonical `user_display_profiles` row existed for that user — and no client-side synchronization mechanism could be made to reliably guarantee that row's existence. The permanent fix moves display-name resolution into `get_group_dashboard` itself: on every call, it derives the name directly from `auth.users` provider metadata (already present on the server, no client write required) with a documented precedence order, falling back to the canonical profile row and then the legacy snapshot only if live resolution isn't possible. The fix was executed directly against production as a guarded, self-verifying SQL migration and confirmed live: a direct call to the function for the affected user's group now returns `Subbarao`.

---

## Problem

- Google account: "Subbarao Bellam" (`given_name` absent from provider metadata, `name` = "Subbarao Bellam")
- Groups dashboard displayed: `bellam`
- Expected: `Subbarao`

The dashboard's `user_name` column was sourced from `group_members.user_name`, a snapshot written once when the member joined the group. This snapshot is only overridden when a canonical `public.user_display_profiles` row exists for that user (`coalesce(udp.display_name, gm.user_name, 'Unknown')`, live in production prior to this fix). For this user, no canonical row existed, so the dashboard fell through to the stale join-time snapshot — literally the Google account's local-part/username-like fragment ("bellam"), not the actual display name.

## Investigation Timeline

1. **Initial assumption — client-side synchronization gap.** The working theory was that `DisplayProfileSyncRunner` (the root-level, auth-event-driven sync mechanism that writes `user_display_profiles` on sign-in) had a timing gap that let this one user through without ever getting a canonical row written. Static tracing of that code path could not prove a defect.
2. **Canonical profile foundation (already live).** `user_display_profiles`, `upsert_my_display_profile`, `reset_my_display_profile_to_provider`, and the canonical-name join in `get_group_dashboard` (`coalesce(udp.display_name, gm.user_name, 'Unknown')`) were already deployed to production ahead of this investigation.
3. **Groups-entry safeguard (client-side, first attempted fix).** Commits `bf84f2d` and `9225b9a` on `fix/groups-entry-profile-sync` added a second, deterministic client-side sync point: read the session, derive the provider display name, and `await` a sync RPC before the Groups dashboard's non-silent fetch, with an in-memory session-level dedup cache to avoid redundant RPCs on repeat visits.
4. **Attempted staging validation.** The safeguard was cherry-picked onto the actual staging source (`release/staging-profile-sync-hotfix-safe`, verified via EAS update metadata rather than branch-name assumption) and published as an Android OTA update. A staging **web** preview deploy was also attempted but turned out to be non-functional for manual testing — the `Preview` Vercel environment tier was missing an `EXPO_PUBLIC_SUPABASE_URL` value entirely, an unrelated, pre-existing project configuration gap, not a defect in the safeguard itself.
5. **Production deploy and rollback of the safeguard.** The client-side safeguard (`9225b9a`) was deployed to production web and subsequently rolled back to the pre-fix production source (`3203716998b846c8c60d0833bfdfb299f21ac9a6`), confirmed via Vercel's deployment history.
6. **Pivot to direct production SQL investigation.** Rather than continue iterating on a client-side mechanism, the investigation moved to what the server could determine directly and deterministically, without depending on any client having run first.
7. **Discovery of the real root cause.** Read-only queries against production (function definition, table/RPC existence checks, and boolean-only checks against the affected user's row — no raw metadata exposed) confirmed: canonical row absent, `group_members.user_name = 'bellam'`, `given_name` absent, `name` present, and that the server already had everything needed to resolve the correct name from `auth.users` on every read — no client write was actually required.
8. **Final server-side solution.** `db/update_group_dashboard_provider_name_resolution.sql` (branch `fix/groups-dashboard-provider-name-resolution`) adds a direct `auth.users` join and a documented resolution precedence to `get_group_dashboard` itself. Iterated through commits `d28ad1c` (initial), `569aeff` (scope correction — an earlier draft incorrectly assumed a tombstone-exclusion fix was already live in production and bundled it in; a fresh precheck showed it wasn't, and the unrelated logic was removed), `e69ce04` (adversarial review fix — regex-based whitespace handling), and `952a1dc` (guard bug fix — see Production Execution below). Executed against production on `2026-07-13T19:07:21Z`.

## Root Cause

The Groups dashboard selected `group_members.user_name` because `user_display_profiles` did not contain a row for this user. The server already had sufficient provider metadata in `auth.users.raw_user_meta_data` to resolve the correct display name on every read. The bug was therefore in **server-side display-name resolution** — the dashboard function had no fallback to data the server already owned — not in missing or delayed client synchronization.

## Why the Client-side Approach Was Rejected

The Groups-entry safeguard (`bf84f2d` / `9225b9a`) was a reasonable second attempt, but it was ultimately abandoned in favor of the server-side fix because it:

- depended on a specific browser/app session actually running the sync code at the right time,
- depended on that client-side execution succeeding (network, auth state, timing),
- depended on a write (`user_display_profiles` row) landing before the read that needed it,
- could not help at all for a session that opened the dashboard while offline or before the sync had a chance to run,
- added a second synchronization point (with its own dedup/retry/caching logic) to reason about, on top of the existing root-level sync runner, for a problem the server could solve unconditionally on every read instead.

## Final Architecture

**Old (client-dependent) path:**

```
Google Sign-in
      ↓
Client sync
      ↓
Profile row
      ↓
Groups dashboard
```

**New (server-deterministic) path:**

```
Groups dashboard
      ↓
auth.users
      ↓
provider metadata
      ↓
display name
```

Display-name precedence, evaluated fresh on every `get_group_dashboard` call:

1. Manual canonical name (`user_display_profiles.name_source = 'manual'`) — explicit user choice, always wins
2. Provider `given_name` (from `auth.users`, normalized)
3. First word of provider `name` (from `auth.users`, normalized)
4. Canonical provider name (existing `user_display_profiles.display_name`, any source)
5. Legacy `group_members.user_name` snapshot
6. `'Unknown'`

## SQL Changes

`get_group_dashboard` gained a `LEFT JOIN auth.users au ON au.id::text = gm.user_id` (joined on `auth.users`' primary key — no row multiplication possible) and the `user_name` expression above. Whitespace handling uses Postgres regex (`regexp_replace(...,'^\s+|\s+$','','g')` and `regexp_match(...,'\S+')`) rather than plain `trim()`/`split_part()`, matching the Unicode/tab/newline-aware normalization already used client-side in `lib/displayProfileSync.ts`. Email is never used as a source; `full_name` is never used alone. Manual precedence and the legacy snapshot fallback are both preserved exactly as before. No other function behavior changed.

## Production Execution

- **Old fingerprint:** `cf6b9d521a8f82928c6bcf969cbf67d2`
- **New fingerprint:** `1b8498d09e680284ed5198138c11b0dc`
- **Execution timestamp:** `2026-07-13T19:07:21Z`

The first execution attempt (migration commit `e69ce04`) failed safely and rolled back automatically — not because of a defect in the migrated function, but because of a bug in the migration's own postcheck guard. The guard used `LIKE` with patterns containing literal `\s`/`\S` (checking that the new regex-based whitespace handling was present in the replaced function body). Postgres's `LIKE` treats backslash as its default escape character, so those backslashes were silently consumed during escape processing, and the checks searched for `^s+|s+$` / `S+` instead of the real text — a permanent false negative. Commit `952a1dc` replaced both checks with `position('...' in body) = 0` (plain substring search, no escape-character semantics), with the migrated function body itself left byte-identical. The corrected migration was re-run and committed successfully.

## Validation

- **Production read-only verification** (multiple rounds, before any write): live function fingerprint, owner, `SECURITY DEFINER`, `search_path`, grants, canonical-join/tombstone-exclusion/`auth.users`-reference presence, and existence of `user_display_profiles`/`upsert_my_display_profile`/`reset_my_display_profile_to_provider`, all confirmed directly against production rather than assumed from repository files (which, in the case of the tombstone-exclusion fix, turned out to be stale relative to actual production state).
- **Adversarial review** of the migration before execution, checking privilege/ownership, `SECURITY DEFINER` validity, `search_path`/schema-qualification safety, injection risk, row-multiplication risk, NULL/blank-string/deleted-auth-user handling, and precedence ordering — found and fixed a real whitespace-normalization gap (plain `trim()`/`split_part()` don't strip tabs/newlines, unlike the client-side JS `.trim()` this was meant to mirror), verified empirically against production with literal-constant, non-PII queries before and after the fix.
- **Staging validation:** the client-side safeguard predecessor was published as an Android OTA update to the verified staging channel/branch (confirmed via EAS update metadata, not branch-name inference) and its bundle verified to contain the expected code and point at the staging Supabase project. The staging **web** preview deploy did not reach a working state due to an unrelated, pre-existing Vercel environment configuration gap, so it did not serve as a functional validation for that attempt.
- **Rollback verification:** confirmed, both after the client-side safeguard's production web rollback (via Vercel deployment history) and after the first SQL migration attempt's automatic rollback (fingerprint re-queried and confirmed unchanged before proceeding).
- **Production execution:** confirmed via fingerprint change (`cf6b9d521a8f82928c6bcf969cbf67d2` → `1b8498d09e680284ed5198138c11b0dc`) and a full post-apply property check (owner, `SECURITY DEFINER`, `search_path`, grants, join presence, precedence expressions, exclusions).
- **Production SQL verification:** the live `get_group_dashboard` function was called directly, end-to-end, for the affected user's real group — the function returned `user_name: "Subbarao"` for that user, while `group_members.user_name` for the same row remains `"bellam"` (confirming the fix changes how the dashboard *reads* the name, not the underlying snapshot data).
- **Browser verification: not yet performed.** No automated agent in this investigation had the ability to sign in as the affected user's real Google account, and no such manual check has been confirmed back at the time of writing. This should be treated as the outstanding sign-off step before considering the user-facing symptom fully closed — see Future Guidance.

## Regression Checks

Confirmed unchanged, directly against the live post-execution function:

- Roles (verified: 1 admin + 4 members for the affected user's group, structurally sane)
- Membership authorization (verified: a non-member call still correctly raises `not a member of this group`)
- Member counts (verified: `get_group_dashboard` row count for the affected group exactly equals `group_members` row count for that group — no row multiplication or loss)
- Today totals and lifetime totals (subquery SQL text byte-identical to the pre-fix live function)
- `SECURITY DEFINER`, `search_path`, and grants (`anon`/`authenticated`/`postgres`/`service_role` EXECUTE) — all re-verified unchanged post-apply
- Invite join, duplicate join, and invalid-invite handling — out of scope for this function (implemented in separate RPCs, unreachable from `get_group_dashboard`); not affected by this change

## Lessons Learned

- Prefer server-side deterministic reads over client synchronization when the server already has the data needed to compute the correct answer on every request.
- Avoid client-maintained canonical caches (and the sync-timing problems they introduce) when the server already owns the source of truth.
- Run an adversarial review before any production migration — it found a real whitespace-normalization gap that unit tests against synthetic data alone did not surface.
- Production migrations should fail closed: the guard's own bug (not the migration's logic) caused the first attempt's rollback, and the transaction correctly aborted rather than applying a half-verified change.
- Always validate production fingerprints/state immediately before execution, not just at authoring time — this repository's own prior migration files disagreed with each other about what was actually live in production, and only a fresh read-only check resolved the discrepancy.
- Keep migrations narrowly scoped — an earlier draft of this migration incorrectly bundled in an unrelated tombstone-exclusion behavior change; catching and removing that kept the shipped change to exactly what was reviewed and approved.
- Avoid mixing unrelated fixes in one deployment; this migration touches only the `auth.users` join and the `user_name` expression, nothing else.

## Future Guidance

Any future feature that needs a user's display name should call into this same server-side resolution logic (`get_group_dashboard`'s precedence, or a shared helper built on the same `auth.users`/`user_display_profiles` join pattern) rather than introducing another client-side synchronization mechanism. The precedent this fix sets — manual override first, live provider metadata next, canonical cache as fallback, legacy snapshot last — should be the default pattern for any new surface that displays a user's name, in preference to writing a new sync-and-cache mechanism.
