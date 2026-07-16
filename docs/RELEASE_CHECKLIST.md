# Release Checklist

Nothing deploys until every applicable item is checked in the release record.

## Baseline

- [ ] `docs/PRODUCTION_BASELINE.md` read.
- [ ] `docs/RELEASE_PLAYBOOK.md` read.
- [ ] `docs/production-manifest.json` read.
- [ ] Baseline and manifest agree.
- [ ] Production state is proven, not inferred.

## Scope

- [ ] One feature = one branch.
- [ ] One issue = one PR.
- [ ] One release = one PR.
- [ ] No app behavior changes outside the release scope.
- [ ] DB changes are isolated or explicitly marked `none`.

## Worktree

- [ ] Release worktree created by `scripts/start-release.sh`.
- [ ] Worktree is not `/Users/sravani/Desktop/JapamApp`.
- [ ] Worktree is clean.
- [ ] Worktree is not detached.
- [ ] Branch name is valid for the target environment.

## Preflight

- [ ] Correct release SHA.
- [ ] Correct branch lineage.
- [ ] Correct remote.
- [ ] Correct environment credentials.
- [ ] Runtime matches baseline or approved release version.
- [ ] versionCode has not regressed.
- [ ] Package name matches production package.
- [ ] Protected files reviewed.
- [ ] Release record exists.
- [ ] `scripts/release-preflight.sh` passed.

## Staging

- [ ] Android staging OTA published to `preview`.
- [ ] Web staging/preview deployed.
- [ ] Physical Android validation passed.
- [ ] Web validation passed.
- [ ] Staging Supabase confirmed.
- [ ] No production credentials present.

## Production

- [ ] Production approval received.
- [ ] Android production OTA published.
- [ ] Web production deployed.
- [ ] Production Supabase confirmed.
- [ ] No staging credentials present.

## Post-Deploy

- [ ] Android OTA ID recorded.
- [ ] Android OTA commit verified.
- [ ] Web deployment ID recorded.
- [ ] Web deployment commit verified.
- [ ] Production URL verified.
- [ ] Smoke test passed.
- [ ] `scripts/post-release.sh` ran.
- [ ] Git tag created.
- [ ] Baseline updated.
- [ ] Manifest updated.
- [ ] Release record completed.
