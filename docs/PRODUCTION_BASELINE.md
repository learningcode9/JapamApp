# Production Baseline

This is the single source of truth for the currently verified JapamApp production state.

Update this file only after production has been deployed and verified. Do not update it during normal development, staging validation, or release preparation.

If this file and `docs/production-manifest.json` disagree, stop immediately and report the inconsistency. Do not infer production state.

## Current Production

| Field | Value |
| --- | --- |
| Current production commit | `bf2dc345e1381d78bf1dbd114618f3fbc0aafeba` |
| Previous production commit | `ab1c9191bd3708fe6d41da2e6a4ac89756607810` |
| Repository remote | `https://github.com/learningcode9/JapamApp.git` |
| Android OTA update ID | `019f6cf5-c20d-71c2-9bc1-7f7dc40e75a2` |
| Android runtime | `1.0.0` |
| Android package | `com.japamapp.mantrajapam` |
| Android versionCode | `5` |
| Web deployment ID | `dpl_A8jogwWteA4rwi8NxoxAMu2fXbYj` |
| Production URL | `https://mantra-japam.vercel.app` |
| Production Supabase project | `rftlqybgnbixotnpanec` |
| Staging Supabase project | `nhacglvxdypevrbvvkhn` |
| Production branch | `release/prod-2026-07-16-0e2fea2` |
| Verified | `true` |
| Verification date | `2026-07-16` |
| Release owner | `Sravani` |

## Release Invariants

- Production releases must use a clean release worktree.
- Production releases must not run from `/Users/sravani/Desktop/JapamApp`.
- Production releases must not run from detached HEAD.
- Production releases must not run from feature, fix, hotfix, staging, or integration branches.
- Production release branches must use `release/prod-YYYY-MM-DD-<short-sha>`.
- Staging release branches must use `release/staging-<slug>-<short-sha>` or `integration/<slug>`.
- Every production release must have exactly one release PR.
- Every production release must have a release record under `docs/releases/`.
- Every production release must have an annotated Git tag.
- Database changes must be isolated, approved, verified, and documented separately from app/web deployment.

## Protected Paths

Changes to these paths are release-sensitive and must be explicitly reviewed before release:

- `app.json`
- `eas.json`
- `vercel.json`
- `package.json`
- `package-lock.json`
- `android-native/**`
- `plugins/**`
- `db/**`
- `supabase/**`
- `.env*`
- `scripts/**`
- `public/manifest*.json`

## Required Session Rule

Every future Codex session must read these files before suggesting any branch, merge, release, deployment, or rollback:

- `docs/PRODUCTION_BASELINE.md`
- `docs/RELEASE_PLAYBOOK.md`
- `docs/production-manifest.json`

If production lineage, deployment state, branch ancestry, OTA state, or web deployment cannot be proven from evidence, report:

`UNKNOWN`

Never guess.
