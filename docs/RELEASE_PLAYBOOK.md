# Release Playbook

This playbook is mandatory for every JapamApp staging or production release.

No app behavior, UI, timer, history, groups, authentication, database, OTA, or production change is allowed merely because this playbook exists. It defines release controls only.

## Required First Read

Before suggesting any branch, merge, release, deployment, or rollback, read:

- `docs/PRODUCTION_BASELINE.md`
- `docs/RELEASE_PLAYBOOK.md`
- `docs/production-manifest.json`

If those files disagree, stop immediately and report the inconsistency.

If production lineage, deployment state, branch ancestry, OTA state, or web deployment cannot be proven from evidence, report:

`UNKNOWN`

Never guess.

## Non-Negotiable Rules

- One feature = one branch.
- One issue = one PR.
- One release = one PR.
- No production deploy from the normal development checkout.
- No production deploy from a dirty worktree.
- No production deploy from detached HEAD.
- No production deploy from development, feature, fix, hotfix, staging, or integration branches.
- No force-push to `main`, `production`, or `release/*`.
- Every production release gets an annotated Git tag.
- Database changes are always isolated, approved, verified, and documented separately.
- Nothing deploys until the release checklist is complete.

## Branch Policy

### `main`

- PR only.
- No force-push.
- Must not be treated as production unless proven by `docs/PRODUCTION_BASELINE.md` and `docs/production-manifest.json`.

### `production`

- Protected pointer to the latest verified production commit when configured.
- No direct commits.
- No force-push.

### `feature/*`, `fix/*`, `hotfix/*`

- One issue only.
- One PR only.
- May not deploy production.

### `integration/*`

- Staging aggregation only.
- May publish to staging after preflight.
- May not deploy production.

### `release/staging-*`

- Staging release branch only.
- Must run `scripts/release-preflight.sh` with `TARGET_ENV=staging`.
- May not deploy production.

### `release/prod-*`

- Production release branch only.
- Must be created by `scripts/start-release.sh`.
- Must run `scripts/release-preflight.sh` with `TARGET_ENV=production`.
- Must have a release record before deploy.
- Must have an annotated tag after deploy.

## Standard Flow

1. Create or select one GitHub Issue.
2. Create one feature/fix/hotfix branch.
3. Open one PR.
4. Review and validate the PR.
5. Create a staging worktree and staging release branch.
6. Run staging preflight.
7. Publish Android staging OTA to the `preview` channel.
8. Deploy web staging/preview only.
9. Validate on a physical Android device and web.
10. Merge through the approved PR path.
11. Create a production release worktree with `scripts/start-release.sh`.
12. Create or fill the release record from `docs/RELEASE_TEMPLATE.md`.
13. Run production preflight.
14. Publish Android production OTA.
15. Deploy web production manually.
16. Smoke test production.
17. Run `scripts/post-release.sh`.
18. Confirm the Git tag, baseline doc, manifest, and release record are updated.

## Clean Release Worktree

The only supported production release entry point is:

```sh
scripts/start-release.sh <release-sha>
```

The release worktree must be outside `/Users/sravani/Desktop/JapamApp`.

Do not copy uncommitted files into a release worktree. Do not release from old detached worktrees. Do not reuse old stashes as release input.

## Preflight

Production:

```sh
TARGET_ENV=production \
EXPECTED_RELEASE_SHA=<release-sha> \
RELEASE_RECORD_PATH=docs/releases/YYYY-MM-DD-production-<short-sha>.md \
scripts/release-preflight.sh
```

Staging:

```sh
TARGET_ENV=staging \
EXPECTED_RELEASE_SHA=<release-sha> \
scripts/release-preflight.sh
```

## Environment Checks

Run before every deployment:

```sh
TARGET_ENV=production scripts/check-environment.sh
```

or:

```sh
TARGET_ENV=staging scripts/check-environment.sh
```

The check must prove:

- Android channel is correct.
- Runtime is correct.
- Package name is correct.
- Expo project is correct.
- App environment is correct.
- Web deploy target is correct.
- Supabase credentials match the target environment only.

## Diff Checks

Before release, compare the previous production commit to the release commit:

```sh
scripts/check-release-diff.sh <previous-production-sha> <release-sha>
```

Protected changes must be either absent or explicitly listed in the release record.

## Post-Release

After deployment:

```sh
scripts/post-release.sh
```

This verifies the provided OTA and web commit evidence, creates the tag, updates the baseline, updates the manifest, and generates or updates the release record.

## Rollback Procedure

1. Stop new deployment activity.
2. Read the baseline, playbook, manifest, and release record.
3. Identify the last verified production commit, OTA, and web deployment.
4. If evidence is incomplete, report `UNKNOWN` and do not guess.
5. Create a rollback release branch from the last verified production commit.
6. Run preflight.
7. Roll back Android OTA only after confirming channel/runtime/commit.
8. Roll back web only after confirming deployment ID/source commit.
9. Do not run database rollback unless a specific migration rollback plan was approved.
10. Smoke test and update the release record.

## Emergency Hotfix Procedure

Emergency hotfixes still follow the safety system:

1. Create one hotfix branch for one issue.
2. Keep the diff as small as possible.
3. Validate on staging unless production is completely unavailable and the owner explicitly accepts the risk.
4. Use `scripts/start-release.sh` for production.
5. Run preflight.
6. Deploy only the approved target.
7. Run post-release.
8. Document the emergency reason and follow-up issue.

## GitHub Branch Protection Recommendation

`main`:

- Require PR.
- Require status checks.
- Disallow force-push.
- Disallow direct pushes.

`production`:

- Require PR or admin-controlled pointer update.
- Disallow force-push.
- Disallow direct pushes.

`release/*`:

- Require PR.
- Disallow force-push.
- Restrict who can push.

`feature/*`, `fix/*`, `hotfix/*`:

- Unrestricted unless repository policy requires checks.

## Release Checklist

Nothing deploys until every applicable item is checked in the release record generated from `docs/RELEASE_TEMPLATE.md`.
