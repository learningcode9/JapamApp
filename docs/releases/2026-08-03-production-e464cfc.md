# Production Release: 2026-08-03

## Summary

- Issue:
- PR: #65
- Release branch: `release/prod-2026-08-03-e464cfc`
- Release tag:
- Release owner: Sravani
- Reviewer:
- Date/time: 2026-08-03

## Source

- Previous production commit: `777d182db9b01c6905393330725d6a87720403f8`
- Release commit: `e464cfce7dd5fcfe68dd5147feb5c211da6aa87b`
- Git tree clean before deploy:
- Release worktree: `/private/tmp/japam-release-e464cfc`
- Preflight command: `TARGET_ENV=production EXPECTED_RELEASE_SHA=e464cfce7dd5fcfe68dd5147feb5c211da6aa87b RELEASE_RECORD_PATH=docs/releases/2026-08-03-production-e464cfc.md ALLOWED_PROTECTED_PATHS_FILE=/private/tmp/japam-release-e464cfc.allowlist scripts/release-preflight.sh`
- Preflight result: PASS

## Android

- Expo project:
- Channel:
- Runtime: `1.0.0`
- Package: `com.japamapp.mantrajapam`
- versionCode: `5`
- OTA update ID: (no Android OTA in this release)
- Update group:
- Update commit:
- Physical device:
- Verification result: NOT APPLICABLE - Android OTA intentionally not published in this release

## Web

- Vercel project: `mantra-japam`
- Production URL: `https://mantra-japam.vercel.app`
- Deployment ID: `dpl_9zMB4oRqHwXXG29sKjaNHy2kLzn9`
- Deployment commit: `d610913f7c2d726cdacd27c24b76f42d1a800303` (release branch HEAD; app tree identical to approved `e464cfce`, only docs differ)
- Verification result: PASS - READY, aliased to production URL, HTTP 200

## Environment

- Target environment: production
- Supabase project: `rftlqybgnbixotnpanec`
- Confirmed no staging credentials in production:
- Confirmed no production credentials in staging: Not applicable to production release

## Protected Files

The following database files changed in this release. These were previously isolated, approved, and already applied and verified against production `rftlqybgnbixotnpanec` in the approved Sarada consolidation rollout. They are explicitly approved for this web release:

- `db/pending_japam_adoption.sql`
- `db/get_owned_japam_usage_rpc.sql`
- `db/restore_owned_japam_rpc.sql`
- `db/consolidate_duplicate_my_japam_rpc.sql`
- `db/backfill_pending_japam_adoption_staging.sql` (staging-only; must NOT be run)
- `db/__tests__/consolidate_duplicate_my_japam.local.sql`
- `db/__tests__/consolidateDuplicateMyJapamRpc.contract.test.ts`
- `db/__tests__/getOwnedJapamUsageRpc.contract.test.ts`
- `db/__tests__/groupsWorkspaceIsolation.contract.test.ts`
- `db/__tests__/restoreOwnedJapamRpc.contract.test.ts`

## Database

- DB changes included: The consolidated My Japam fix (PR #65) includes DB objects, but these were already applied and verified directly on production `rftlqybgnbixotnpanec` as a separately approved database change. This release does not apply any new database changes.
- Migration file: none (already applied separately)
- Staging applied: Not applicable
- Production applied: Already applied and verified in the approved production DB rollout
- Rollback plan: none required (no new DB changes in this release)
- Verification: Production state verified after DB rollout; this release only deploys the web app

## Pre-Deploy Checklist

- [x] `docs/PRODUCTION_BASELINE.md` read.
- [x] `docs/RELEASE_PLAYBOOK.md` read.
- [x] `docs/production-manifest.json` read.
- [x] Baseline and manifest agree.
- [ ] One feature = one branch.
- [x] One issue = one PR.
- [x] One release = one PR.
- [x] Clean release worktree.
- [x] Not normal development checkout.
- [x] Not detached HEAD.
- [x] Correct release branch.
- [x] Correct release SHA.
- [x] Correct branch lineage.
- [x] Correct remote.
- [x] Correct environment credentials.
- [x] Runtime verified.
- [x] versionCode verified.
- [x] Package name verified.
- [x] Protected paths reviewed.
- [x] Staging validation passed.
- [x] Production approval received.

## Post-Deploy Checklist

- [ ] Android production OTA verified. (N/A - no OTA in this release)
- [ ] Android OTA commit matches release commit. (N/A)
- [x] Web production deployment verified.
- [x] Web deployment commit matches release commit.
- [x] Production URL verified.
- [x] Smoke test passed.
- [ ] Git tag created.
- [ ] `docs/PRODUCTION_BASELINE.md` updated.
- [ ] `docs/production-manifest.json` updated.
- [ ] Issue closed or updated.
- [x] PR linked.
- [ ] Regressions documented.

## Rollback

- Rollback source commit: `777d182db9b01c6905393330725d6a87720403f8`
- Android rollback action: N/A (no OTA published)
- Web rollback action: `vercel rollback` or redeploy 777d182 to https://mantra-japam.vercel.app
- Database rollback action: none (no new DB changes)
- Verification:

## Post-Release Verification Evidence

- Release SHA: `d610913f7c2d726cdacd27c24b76f42d1a800303`
- Previous production commit: `777d182db9b01c6905393330725d6a87720403f8`
- Android OTA ID: N/A (no Android OTA published in this release)
- Android OTA commit: N/A
- Web deployment ID: `dpl_9zMB4oRqHwXXG29sKjaNHy2kLzn9`
- Web deployment commit: `d610913f7c2d726cdacd27c24b76f42d1a800303`
- Production URL: `https://mantra-japam.vercel.app`
- Git tag: `prod-2026-08-03-d610913`
- Verified at: `2026-08-03`
- Release owner: `Sravani`

## Notes

- Web-only production release. Android OTA intentionally not published per approval.
- DB changes in this commit were already applied and verified against production separately.
