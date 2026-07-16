# Production Release: 2026-07-16

## Summary

- Issue: PENDING
- PR: #35
- Release branch: `release/prod-2026-07-16-0e2fea2`
- Release tag: PENDING
- Release owner: Sravani
- Reviewer: PENDING
- Date/time: 2026-07-16 / PENDING

## Source

- Previous production commit: `ab1c9191bd3708fe6d41da2e6a4ac89756607810`
- Candidate source commit: `0e2fea2ea08a39bb8ce824fb3e729153333241ca`
- Final release commit: PENDING
- Git tree clean before deploy: PENDING final preflight
- Release worktree: `/private/tmp/japam-release-0e2fea2`
- Preflight command: `TARGET_ENV=production EXPECTED_RELEASE_SHA=<final-release-sha> EXPECTED_BASE_SHA=ab1c9191bd3708fe6d41da2e6a4ac89756607810 RELEASE_RECORD_PATH=docs/releases/2026-07-16-production-0e2fea2.md ALLOWED_PROTECTED_PATHS_FILE=/private/tmp/japam-release-0e2fea2.allowlist scripts/release-preflight.sh`
- Preflight result: PENDING

## Android

- Expo project: `17d71629-9516-49b8-8c90-863cc7e47027`
- Channel: `production`
- Runtime: `1.0.0`
- Package: `com.japamapp.mantrajapam`
- versionCode: `5`
- OTA update ID: PENDING
- Update group: PENDING
- Update commit: PENDING
- Physical device: PENDING
- Verification result: PENDING

## Web

- Vercel project: `mantra-japam`
- Production URL: `https://mantra-japam.vercel.app`
- Deployment ID: PENDING
- Deployment commit: PENDING
- Verification result: PENDING

## Environment

- Target environment: production
- Supabase project: `rftlqybgnbixotnpanec`
- Confirmed no staging credentials in production: PASS
- Confirmed no production credentials in staging: Not applicable to production release

## Protected Files

The following reviewed release-safety scripts are explicitly approved for this release:

- `scripts/check-environment.sh`
- `scripts/check-production-state.sh`
- `scripts/check-release-diff.sh`
- `scripts/post-release.sh`
- `scripts/release-lib.sh`
- `scripts/release-preflight.sh`
- `scripts/release-safety-regression-tests.sh`
- `scripts/start-release.sh`

## Database

- DB changes included: none
- Migration file: none
- Staging applied: Not applicable
- Production applied: Not applicable
- Rollback plan: none required
- Verification: No database files changed in the release diff

## Pre-Deploy Checklist

- [x] `docs/PRODUCTION_BASELINE.md` read.
- [x] `docs/RELEASE_PLAYBOOK.md` read.
- [x] `docs/production-manifest.json` read.
- [x] Baseline and manifest agree.
- [ ] One feature = one branch.
- [ ] One issue = one PR.
- [ ] One release = one PR.
- [x] Clean release worktree.
- [x] Not normal development checkout.
- [x] Not detached HEAD.
- [x] Correct release branch.
- [ ] Correct final release SHA.
- [x] Correct branch lineage.
- [x] Correct remote.
- [x] Correct environment credentials.
- [x] Runtime verified.
- [x] versionCode verified.
- [x] Package name verified.
- [x] Protected paths reviewed.
- [x] Staging validation passed.
- [ ] Production approval received.

## Post-Deploy Checklist

- [ ] Android production OTA verified.
- [ ] Android OTA commit matches release commit.
- [ ] Web production deployment verified.
- [ ] Web deployment commit matches release commit.
- [ ] Production URL verified.
- [ ] Smoke test passed.
- [ ] Git tag created.
- [ ] `docs/PRODUCTION_BASELINE.md` updated.
- [ ] `docs/production-manifest.json` updated.
- [ ] Issue closed or updated.
- [x] PR linked.
- [ ] Regressions documented.

## Rollback

- Rollback source commit: `ab1c9191bd3708fe6d41da2e6a4ac89756607810`
- Android rollback action: PENDING
- Web rollback action: PENDING
- Database rollback action: none
- Verification: PENDING

## Notes

- TypeScript: PASS
- Tests: 179/179 PASS
- Release-safety regression tests: PASS
- Android OTA: PENDING
- Web deployment: PENDING
- Production verification: PENDING

## Post-Release Verification Evidence

- Release SHA: `bf2dc345e1381d78bf1dbd114618f3fbc0aafeba`
- Previous production commit: `ab1c9191bd3708fe6d41da2e6a4ac89756607810`
- Android OTA ID: `019f6cf5-c20d-71c2-9bc1-7f7dc40e75a2`
- Android OTA commit: `bf2dc345e1381d78bf1dbd114618f3fbc0aafeba`
- Web deployment ID: `dpl_A8jogwWteA4rwi8NxoxAMu2fXbYj`
- Web deployment commit: `bf2dc345e1381d78bf1dbd114618f3fbc0aafeba`
- Production URL: `https://mantra-japam.vercel.app`
- Git tag: `prod-2026-07-16-bf2dc34`
- Verified at: `2026-07-16`
- Release owner: `Sravani`
