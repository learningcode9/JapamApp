#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$script_dir/release-lib.sh"

require_repo
cd "$(repo_root)"
assert_baseline_manifest_agree

TARGET_ENV="${TARGET_ENV:-production}"
[ "$TARGET_ENV" = "production" ] || fail "post-release is production-only"

RELEASE_SHA="${RELEASE_SHA:-$(git rev-parse HEAD)}"
ANDROID_OTA_ID="${ANDROID_OTA_ID:-}"
ANDROID_OTA_COMMIT="${ANDROID_OTA_COMMIT:-}"
WEB_DEPLOYMENT_ID="${WEB_DEPLOYMENT_ID:-}"
WEB_DEPLOYMENT_COMMIT="${WEB_DEPLOYMENT_COMMIT:-}"
PRODUCTION_URL="${PRODUCTION_URL:-}"
RELEASE_RECORD_PATH="${RELEASE_RECORD_PATH:-}"
RELEASE_OWNER="${RELEASE_OWNER:-$(manifest_value release_owner)}"
TAG_NAME="${TAG_NAME:-prod-$(date +%Y-%m-%d)-$(git rev-parse --short=7 "$RELEASE_SHA")}"

[ -n "$ANDROID_OTA_ID" ] || fail "ANDROID_OTA_ID is required"
[ -n "$ANDROID_OTA_COMMIT" ] || fail "ANDROID_OTA_COMMIT is required"
[ -n "$WEB_DEPLOYMENT_ID" ] || fail "WEB_DEPLOYMENT_ID is required"
[ -n "$WEB_DEPLOYMENT_COMMIT" ] || fail "WEB_DEPLOYMENT_COMMIT is required"
[ -n "$PRODUCTION_URL" ] || fail "PRODUCTION_URL evidence is required"
git cat-file -e "$RELEASE_SHA^{commit}" || fail "RELEASE_SHA is not a commit: $RELEASE_SHA"
[ "$ANDROID_OTA_COMMIT" = "$RELEASE_SHA" ] || fail "OTA commit mismatch: $ANDROID_OTA_COMMIT != $RELEASE_SHA"
[ "$WEB_DEPLOYMENT_COMMIT" = "$RELEASE_SHA" ] || fail "web commit mismatch: $WEB_DEPLOYMENT_COMMIT != $RELEASE_SHA"
[ "$PRODUCTION_URL" = "$(manifest_value production_url)" ] || fail "production URL mismatch: $PRODUCTION_URL"

if git rev-parse "$TAG_NAME" >/dev/null 2>&1; then
  fail "tag already exists: $TAG_NAME"
fi

if [ -z "$RELEASE_RECORD_PATH" ]; then
  RELEASE_RECORD_PATH="docs/releases/$(date +%Y-%m-%d)-production-$(git rev-parse --short=7 "$RELEASE_SHA").md"
fi

release_record_dir="$(dirname "$RELEASE_RECORD_PATH")"
[ -d "$release_record_dir" ] || fail "release record directory does not exist: $release_record_dir"
[ -f docs/RELEASE_TEMPLATE.md ] || fail "missing docs/RELEASE_TEMPLATE.md"

previous_commit="$(manifest_value production_commit)"
runtime="$(expected_runtime_from_app)"
version="$(app_value 'app.expo.version')"
version_code="$(app_value 'app.expo.android.versionCode')"
package_name="$(app_value 'app.expo.android.package')"
repository_remote="$(manifest_value repository_remote)"
production_supabase="$(manifest_value production_supabase_project)"
staging_supabase="$(manifest_value staging_supabase_project)"
release_branch="$(git branch --show-current)"
verified_at="$(date +%Y-%m-%d)"

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/japam-post-release.XXXXXX")"
tmp_manifest="$tmp_dir/production-manifest.json"
tmp_baseline="$tmp_dir/PRODUCTION_BASELINE.md"
tmp_record="$tmp_dir/release-record.md"

node - "$(manifest_path)" "$tmp_manifest" \
  "previous_production_commit=$previous_commit" \
  "production_commit=$RELEASE_SHA" \
  "repository_remote=$repository_remote" \
  "android_ota=$ANDROID_OTA_ID" \
  "android_runtime=$runtime" \
  "android_package=$package_name" \
  "android_version_code=$version_code" \
  "web_deployment=$WEB_DEPLOYMENT_ID" \
  "version=$version" \
  "verified=true" \
  "verified_at=$verified_at" \
  "release_owner=$RELEASE_OWNER" <<'NODE'
const fs = require("fs");
const input = process.argv[2];
const output = process.argv[3];
const pairs = process.argv.slice(4);
const json = JSON.parse(fs.readFileSync(input, "utf8"));
for (const pair of pairs) {
  const index = pair.indexOf("=");
  const key = pair.slice(0, index);
  const raw = pair.slice(index + 1);
  if (raw === "true") json[key] = true;
  else if (raw === "false") json[key] = false;
  else if (/^-?\d+$/.test(raw)) json[key] = Number(raw);
  else json[key] = raw;
}
fs.writeFileSync(output, JSON.stringify(json, null, 2) + "\n");
NODE

cat > "$tmp_baseline" <<BASELINE
# Production Baseline

This is the single source of truth for the currently verified JapamApp production state.

Update this file only after production has been deployed and verified. Do not update it during normal development, staging validation, or release preparation.

If this file and \`docs/production-manifest.json\` disagree, stop immediately and report the inconsistency. Do not infer production state.

## Current Production

| Field | Value |
| --- | --- |
| Current production commit | \`$RELEASE_SHA\` |
| Previous production commit | \`$previous_commit\` |
| Repository remote | \`$repository_remote\` |
| Android OTA update ID | \`$ANDROID_OTA_ID\` |
| Android runtime | \`$runtime\` |
| Android package | \`$package_name\` |
| Android versionCode | \`$version_code\` |
| Web deployment ID | \`$WEB_DEPLOYMENT_ID\` |
| Production URL | \`$PRODUCTION_URL\` |
| Production Supabase project | \`$production_supabase\` |
| Staging Supabase project | \`$staging_supabase\` |
| Production branch | \`$release_branch\` |
| Verified | \`true\` |
| Verification date | \`$verified_at\` |
| Release owner | \`$RELEASE_OWNER\` |

## Release Invariants

- Production releases must use a clean release worktree.
- Production releases must not run from \`/Users/sravani/Desktop/JapamApp\`.
- Production releases must not run from detached HEAD.
- Production releases must not run from feature, fix, hotfix, staging, or integration branches.
- Production release branches must use \`release/prod-YYYY-MM-DD-<short-sha>\`.
- Staging release branches must use \`release/staging-<slug>-<short-sha>\` or \`integration/<slug>\`.
- Every production release must have exactly one release PR.
- Every production release must have a release record under \`docs/releases/\`.
- Every production release must have an annotated Git tag.
- Database changes must be isolated, approved, verified, and documented separately from app/web deployment.

## Protected Paths

Changes to these paths are release-sensitive and must be explicitly reviewed before release:

- \`app.json\`
- \`eas.json\`
- \`vercel.json\`
- \`package.json\`
- \`package-lock.json\`
- \`android-native/**\`
- \`plugins/**\`
- \`db/**\`
- \`supabase/**\`
- \`.env*\`
- \`scripts/**\`
- \`public/manifest*.json\`

## Required Session Rule

Every future Codex session must read these files before suggesting any branch, merge, release, deployment, or rollback:

- \`docs/PRODUCTION_BASELINE.md\`
- \`docs/RELEASE_PLAYBOOK.md\`
- \`docs/production-manifest.json\`

If production lineage, deployment state, branch ancestry, OTA state, or web deployment cannot be proven from evidence, report:

\`UNKNOWN\`

Never guess.
BASELINE

if [ -f "$RELEASE_RECORD_PATH" ]; then
  cp "$RELEASE_RECORD_PATH" "$tmp_record"
else
  cp docs/RELEASE_TEMPLATE.md "$tmp_record"
fi

cat >> "$tmp_record" <<RECORD

## Post-Release Verification Evidence

- Release SHA: \`$RELEASE_SHA\`
- Previous production commit: \`$previous_commit\`
- Android OTA ID: \`$ANDROID_OTA_ID\`
- Android OTA commit: \`$ANDROID_OTA_COMMIT\`
- Web deployment ID: \`$WEB_DEPLOYMENT_ID\`
- Web deployment commit: \`$WEB_DEPLOYMENT_COMMIT\`
- Production URL: \`$PRODUCTION_URL\`
- Git tag: \`$TAG_NAME\`
- Verified at: \`$verified_at\`
- Release owner: \`$RELEASE_OWNER\`
RECORD

node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$tmp_manifest"
[ -s "$tmp_baseline" ] || fail "temporary baseline content is empty"
[ -s "$tmp_record" ] || fail "temporary release record content is empty"

backup_manifest="$tmp_dir/production-manifest.backup.json"
backup_baseline="$tmp_dir/PRODUCTION_BASELINE.backup.md"
backup_record="$tmp_dir/release-record.backup.md"
record_existed=false

cp "$(manifest_path)" "$backup_manifest"
cp "$(baseline_path)" "$backup_baseline"
if [ -f "$RELEASE_RECORD_PATH" ]; then
  record_existed=true
  cp "$RELEASE_RECORD_PATH" "$backup_record"
fi

rollback_after_write_failure() {
  cp "$backup_manifest" "$(manifest_path)" || true
  cp "$backup_baseline" "$(baseline_path)" || true
  if [ "$record_existed" = "true" ]; then
    cp "$backup_record" "$RELEASE_RECORD_PATH" || true
  else
    rm -f "$RELEASE_RECORD_PATH" || true
  fi
  if git rev-parse "$TAG_NAME" >/dev/null 2>&1; then
    git tag -d "$TAG_NAME" >/dev/null 2>&1 || true
  fi
}

trap rollback_after_write_failure ERR

cp "$tmp_manifest" "$(manifest_path)"
cp "$tmp_baseline" "$(baseline_path)"
cp "$tmp_record" "$RELEASE_RECORD_PATH"

git tag -a "$TAG_NAME" "$RELEASE_SHA" -m "Production release $TAG_NAME

Commit: $RELEASE_SHA
Android OTA: $ANDROID_OTA_ID
Web deployment: $WEB_DEPLOYMENT_ID
Release record: $RELEASE_RECORD_PATH
Production URL: $PRODUCTION_URL"

trap - ERR

cat <<SUMMARY
Post-release update completed.

Release SHA:     $RELEASE_SHA
Android OTA:     $ANDROID_OTA_ID
Web deployment:  $WEB_DEPLOYMENT_ID
Production URL:  $PRODUCTION_URL
Tag:             $TAG_NAME
Release record:  $RELEASE_RECORD_PATH

Review, commit, and push these release metadata changes after verification.
SUMMARY
