# Production Release: YYYY-MM-DD

## Summary

- Issue:
- PR:
- Release branch:
- Release tag:
- Release owner:
- Reviewer:
- Date/time:

## Source

- Previous production commit:
- Release commit:
- Git tree clean before deploy:
- Release worktree:
- Preflight command:
- Preflight result:

## Android

- Expo project:
- Channel:
- Runtime:
- Package:
- versionCode:
- OTA update ID:
- Update group:
- Update commit:
- Physical device:
- Verification result:

## Web

- Vercel project:
- Production URL:
- Deployment ID:
- Deployment commit:
- Verification result:

## Environment

- Target environment:
- Supabase project:
- Confirmed no staging credentials in production:
- Confirmed no production credentials in staging:

## Protected Files

List protected files changed, or write `none`.

-

## Database

- DB changes included:
- Migration file:
- Staging applied:
- Production applied:
- Rollback plan:
- Verification:

## Pre-Deploy Checklist

- [ ] `docs/PRODUCTION_BASELINE.md` read.
- [ ] `docs/RELEASE_PLAYBOOK.md` read.
- [ ] `docs/production-manifest.json` read.
- [ ] Baseline and manifest agree.
- [ ] One feature = one branch.
- [ ] One issue = one PR.
- [ ] One release = one PR.
- [ ] Clean release worktree.
- [ ] Not normal development checkout.
- [ ] Not detached HEAD.
- [ ] Correct release branch.
- [ ] Correct release SHA.
- [ ] Correct branch lineage.
- [ ] Correct remote.
- [ ] Correct environment credentials.
- [ ] Runtime verified.
- [ ] versionCode verified.
- [ ] Package name verified.
- [ ] Protected paths reviewed.
- [ ] Staging validation passed.
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
- [ ] PR linked.
- [ ] Regressions documented.

## Rollback

- Rollback source commit:
- Android rollback action:
- Web rollback action:
- Database rollback action:
- Verification:

## Notes
