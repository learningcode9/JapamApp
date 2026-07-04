# Production Release

Date: 2026-07-03
Release type: Bug fix (timer completion correctness) + repository alignment
Repository: JapamApp
Branch: main
Commit: faff77ad07ccbe437d92411c3882073900d2a0e5
Production OTA Update ID: 019f2a76-2f58-749c-bcd6-a177d3f4922e
Production OTA Update Group: 4fb5918b-f745-4f83-accb-87d90cae1f3d
Runtime Version: 1.0.0
Web Production URL: https://mantra-japam.vercel.app

# Summary

This release reconciled GitHub's `main` branch with the code already running in Android production, then shipped two related timer-completion bug fixes: one that cleared a stale "Mala X/Y" label after background/native completion, and a follow-up fix for a save-race regression that surfaced during staging validation of the first fix. Both fixes were validated on a physical Android device before promotion, then published to Android production OTA and the web production site.

# Repository Alignment

- **PR #4** (`chore/reconcile-main-with-production`, merge commit `0c626dcda7ad1d8fd02d2de3afe4c8c3ccee53ad`): brought `main` up to date with the code already deployed to Android production.
- **Why `main` had to be reconciled:** `origin/main` had been frozen since June 10, while production code (the native foreground timer service's JS integration, groups, history sync hardening, guest/anonymous auth, and more) had been developed and deployed directly from local/unmerged branches for weeks. Any PR built on the real production lineage showed the entire ~132-commit gap as "new" changes, making normal review impossible.
- **Production lineage restored:** PR #4 was built from the confirmed deployed production commit (`71c2d5bbc7837a186bbe7e3afa621401bc603b0b`) and merged into `main`. Verified byte-for-byte: the PR's tree hash matched production's tree hash exactly (`c64c148e...`), and the Android production OTA's `gitCommitHash` matched the PR's source commit exactly.

# Bug Fixes

## PR #5
- completedLoops stale reset fix
- commit `9400f806d30bbc036b4edebd027b11950a004cd0`
- Fixed the Timer screen showing a stale "Mala 2/5", "3/5", or "4/5" label after a background/native loop completion, or after force-close + reopen. Root cause: the background completion listener updated an internal ref but never told React to re-render, and the reconcile cleanup never reset the persisted completed-loop count after a session fully finished.

## PR #6
- Final-loop save race fix
- commit `d3fa3a5177b30f6d9505550fd36a430441b72121`
- one-line guard using `isCompletingRef`
- Fixed a regression introduced by PR #5: the final loop's completion could be silently dropped from History if the app transitioned from background to foreground right at the tail of the final loop. `reconcileNativeLoops`'s cleanup could reset the completed-loop count to 0 while the final loop's own save was still in flight (deferred behind the Om completion sound), causing that save's dedup guard to incorrectly skip it. Fixed by gating the reset behind the existing `isCompletingRef` flag: `if (!moreToGo)` → `if (!moreToGo && !isCompletingRef.current)`.

# Validation

- TypeScript clean (`npx tsc --noEmit`) on both PR #5 and PR #6.
- Tests: 182/184 passing on both PRs — the 2 failures are pre-existing, unrelated `lib/__tests__/supabase.test.ts` failures (AsyncStorage native-module mocking gap in the Jest environment), independently confirmed present on `main` itself before either fix.
- Android staging validation: both fixes published to the `preview` channel and validated on a physical Samsung device before being considered for production.
- Physical device testing: foreground live progression, full background session completion, home-and-back mid-session, force-close + reopen, and press-Start-again all verified for PR #5.
- Root cause investigation: the PR #6 regression was independently reproduced live on staging (a 5-loop session where the final loop's save was skipped, confirmed missing from the database), with the exact race traced through logcat timestamps down to the responsible code paths.
- Final validation: after PR #6, two clean repro runs on staging — including one where `reconcileNativeLoops` ran concurrently with the final loop's completion — confirmed `STATS_SAVE_REQUEST` read the correct non-zero `completedLoops` value and all rows saved, verified against the database (unique, sequential `completion_id`s).
- Server-side production verification: confirmed via `eas channel:view`/`eas update:list` that the `production` channel correctly serves update `019f2a76-2f58-749c-bcd6-a177d3f4922e` with `runtimeVersion 1.0.0` and `gitCommitHash faff77ad07ccbe437d92411c3882073900d2a0e5`.

# Deployment

**Android OTA**

- Update ID: `019f2a76-2f58-749c-bcd6-a177d3f4922e`
- Update Group: `4fb5918b-f745-4f83-accb-87d90cae1f3d`
- Runtime: `1.0.0`

**Web**

https://mantra-japam.vercel.app

# GitHub

- Issues #7–#18 created as a resolved-bug knowledge base, covering this release's fixes plus other previously-resolved issues in the repository's history.
- PR descriptions for PR #4, PR #5, and PR #6 updated with a "Related Issues" section linking to Issues #7, #8, and #9 respectively.
- `docs/PRODUCTION_RELEASE_CHECKLIST.md` added as the standard checklist for all future releases.

# Lessons Learned

- Keeping `main` aligned with what's actually deployed is not optional — letting it drift for weeks turned a normal bug-fix PR into a 132-commit reconciliation project before any real review could happen.
- A fix for one bug can introduce another: PR #5's stale-label fix directly caused PR #6's save-race regression, both touching the same function. Any new reset/cleanup logic must be checked against everything else that reads or writes the same state.
- Race conditions are only caught by testing the specific timing window, not just the general scenario — the PR #6 bug required deliberately backgrounding/foregrounding at the exact tail of the final loop to reproduce.
- Staging-first validation, on a physical device, is what caught the PR #6 regression before it reached production — it would not have been caught by TypeScript or the unit test suite.
- OTA channel, branch, and runtimeVersion should always be verified server-side (`eas channel:view`, `eas update:list`) rather than assumed, especially when a device seems not to have received an expected update.

# Known Issues

- Pre-existing Jest AsyncStorage test failures: 2 failing tests in `lib/__tests__/supabase.test.ts` due to an AsyncStorage native-module mocking gap in the Jest environment. Confirmed present on `main` independent of this release's changes; not blocking.
- One-time Expo AV reload crash after OTA: a single startup crash was observed on the very first cold-launch after applying the staging OTA, traced to `expo-updates`' reload mechanism releasing an `expo-av` ExoPlayer instance on a background thread (`IllegalStateException: Player is accessed on the wrong thread`). Stack trace has no relation to timer/completedLoops code; the app was stable on every subsequent launch. Known, pre-existing `expo-av`-deprecation-related behavior, not introduced by this release.
