#!/usr/bin/env bash

set -euo pipefail

SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE_SHA="ab1c9191bd3708fe6d41da2e6a4ac89756607810"
EXPECTED_REMOTE="https://github.com/learningcode9/JapamApp.git"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/japam-release-safety-tests.XXXXXX")"
ALLOWLIST="$TEST_ROOT/approved-protected-paths.txt"

cleanup() {
  if [ -d "$TEST_ROOT/repo" ]; then
    git -C "$TEST_ROOT/repo" worktree prune >/dev/null 2>&1 || true
  fi
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT

fail_test() {
  echo "FAIL: $*" >&2
  exit 1
}

pass_test() {
  echo "PASS: $*"
}

copy_release_safety_files() {
  local target="$1"
  mkdir -p "$target/docs" "$target/scripts"
  cp "$SOURCE_ROOT/docs/PRODUCTION_BASELINE.md" "$target/docs/PRODUCTION_BASELINE.md"
  cp "$SOURCE_ROOT/docs/production-manifest.json" "$target/docs/production-manifest.json"
  cp "$SOURCE_ROOT/docs/RELEASE_PLAYBOOK.md" "$target/docs/RELEASE_PLAYBOOK.md"
  cp "$SOURCE_ROOT/docs/RELEASE_TEMPLATE.md" "$target/docs/RELEASE_TEMPLATE.md"
  cp "$SOURCE_ROOT/docs/RELEASE_CHECKLIST.md" "$target/docs/RELEASE_CHECKLIST.md"
  cp "$SOURCE_ROOT/scripts/release-lib.sh" "$target/scripts/release-lib.sh"
  cp "$SOURCE_ROOT/scripts/release-preflight.sh" "$target/scripts/release-preflight.sh"
  cp "$SOURCE_ROOT/scripts/start-release.sh" "$target/scripts/start-release.sh"
  cp "$SOURCE_ROOT/scripts/post-release.sh" "$target/scripts/post-release.sh"
  cp "$SOURCE_ROOT/scripts/check-environment.sh" "$target/scripts/check-environment.sh"
  cp "$SOURCE_ROOT/scripts/check-release-diff.sh" "$target/scripts/check-release-diff.sh"
  cp "$SOURCE_ROOT/scripts/check-production-state.sh" "$target/scripts/check-production-state.sh"
  chmod +x "$target"/scripts/*.sh
}

set_truth_remote() {
  local repo="$1"
  local remote="$2"
  node - "$repo/docs/production-manifest.json" "$remote" <<'NODE'
const fs = require("fs");
const file = process.argv[2];
const remote = process.argv[3];
const json = JSON.parse(fs.readFileSync(file, "utf8"));
json.repository_remote = remote;
fs.writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
NODE
  node - "$repo/docs/PRODUCTION_BASELINE.md" "$remote" <<'NODE'
const fs = require("fs");
const file = process.argv[2];
const remote = process.argv[3];
let text = fs.readFileSync(file, "utf8");
text = text.replace(/\| Repository remote \| `[^`]+` \|/, `| Repository remote | \`${remote}\` |`);
fs.writeFileSync(file, text);
NODE
}

git clone --no-hardlinks "$SOURCE_ROOT" "$TEST_ROOT/repo" >/dev/null 2>&1
cd "$TEST_ROOT/repo"
git checkout -b release/prod-regression "$BASE_SHA" >/dev/null 2>&1
copy_release_safety_files "$PWD"
mkdir -p docs/releases
cp docs/RELEASE_TEMPLATE.md docs/releases/regression-release.md
git add docs scripts
git -c user.name="Release Safety Test" -c user.email="release-safety@example.invalid" commit -m "test: release safety fixtures" >/dev/null
RELEASE_SHA="$(git rev-parse HEAD)"

cat > "$ALLOWLIST" <<'EOF'
scripts/check-environment.sh
scripts/check-production-state.sh
scripts/check-release-diff.sh
scripts/post-release.sh
scripts/release-lib.sh
scripts/release-preflight.sh
scripts/release-safety-regression-tests.sh
scripts/start-release.sh
EOF

git remote set-url origin "$EXPECTED_REMOTE"

before_status="$(git status --short)"
before_manifest="$(cat docs/production-manifest.json)"
git tag -a existing-regression-tag -m "existing regression tag" "$RELEASE_SHA"
if TAG_NAME=existing-regression-tag \
  RELEASE_SHA="$RELEASE_SHA" \
  ANDROID_OTA_ID=regression-ota \
  ANDROID_OTA_COMMIT="$RELEASE_SHA" \
  WEB_DEPLOYMENT_ID=regression-web \
  WEB_DEPLOYMENT_COMMIT="$RELEASE_SHA" \
  PRODUCTION_URL=https://mantra-japam.vercel.app \
  RELEASE_RECORD_PATH=docs/releases/should-not-exist.md \
  scripts/post-release.sh >/tmp/japam-post-release-existing-tag.out 2>&1; then
  fail_test "post-release accepted an existing tag"
fi
[ "$(git status --short)" = "$before_status" ] || fail_test "existing tag failure modified files"
[ "$(cat docs/production-manifest.json)" = "$before_manifest" ] || fail_test "verified state changed after post-release failure"
[ ! -e docs/releases/should-not-exist.md ] || fail_test "failed post-release created a release record"
pass_test "existing tag failure leaves files, verified state, and release record unchanged"

if EXPO_OTA_ID=019f697b-2e1a-7fa5-8d00-ffb6c13a95a8 \
  EXPO_OTA_COMMIT="$BASE_SHA" \
  VERCEL_DEPLOYMENT_ID=dpl_4R4BfrLm2hvRnBhyBQMbyxXDBF9C \
  VERCEL_DEPLOYMENT_COMMIT="$BASE_SHA" \
  PRODUCTION_URL=https://mantra-japam.vercel.app \
  scripts/check-production-state.sh >/tmp/japam-production-state-missing-git.out 2>&1; then
  fail_test "check-production-state accepted missing Git evidence"
fi
grep -q "Git production commit: UNKNOWN" /tmp/japam-production-state-missing-git.out || fail_test "missing Git evidence did not report UNKNOWN"
pass_test "missing Git evidence returns UNKNOWN and fails"

if TARGET_ENV=production \
  EXPO_PUBLIC_APP_ENV=production \
  EXPO_PUBLIC_SUPABASE_URL=https://rftlqybgnbixotnpanec.supabase.co \
  PRODUCTION_URL=https://mantra-japam.vercel.app \
  scripts/check-environment.sh >/tmp/japam-env-missing-vercel.out 2>&1; then
  fail_test "check-environment accepted missing Vercel project evidence"
fi
grep -q "VERCEL_PROJECT evidence is required" /tmp/japam-env-missing-vercel.out || fail_test "missing Vercel evidence produced the wrong failure"
pass_test "missing Vercel evidence fails"

git remote set-url origin /tmp/wrong-release-safety-origin
if scripts/start-release.sh "$RELEASE_SHA" >/tmp/japam-start-wrong-remote.out 2>&1; then
  fail_test "start-release accepted wrong remote"
fi
grep -q "wrong origin remote before fetch" /tmp/japam-start-wrong-remote.out || fail_test "wrong remote did not fail before fetch"
pass_test "wrong remote fails before fetch"

local_origin="$TEST_ROOT/origin.git"
git init --bare "$local_origin" >/dev/null
git remote set-url origin "$local_origin"
set_truth_remote "$PWD" "$local_origin"
git add docs/PRODUCTION_BASELINE.md docs/production-manifest.json
git -c user.name="Release Safety Test" -c user.email="release-safety@example.invalid" commit -m "test: local origin truth" >/dev/null
STAGING_RELEASE_SHA="$(git rev-parse HEAD)"
STAGING_SLUG="review-slug"
TARGET_ENV=staging STAGING_SLUG="$STAGING_SLUG" scripts/start-release.sh "$STAGING_RELEASE_SHA" > "$TEST_ROOT/start-staging.out"
expected_branch="release/staging-$STAGING_SLUG-$(git rev-parse --short=7 "$STAGING_RELEASE_SHA")"
grep -q "Branch:        $expected_branch" "$TEST_ROOT/start-staging.out" || fail_test "staging branch name did not include slug and SHA"
if grep -q "docs/releases/" "$TEST_ROOT/start-staging.out"; then
  fail_test "staging start-release printed a production release record path"
fi
pass_test "staging branch naming and output are correct"

scripts/check-release-diff.sh "$BASE_SHA" "$STAGING_RELEASE_SHA" "$ALLOWLIST" >/tmp/japam-diff-allowlist.out
grep -q "== Approved Protected Files ==" /tmp/japam-diff-allowlist.out || fail_test "diff checker did not print approved protected files"
grep -q "== Unapproved Protected Files ==" /tmp/japam-diff-allowlist.out || fail_test "diff checker did not print unapproved protected files"
pass_test "protected allowlist works"

node -e 'const fs=require("fs"); const p="docs/production-manifest.json"; const j=JSON.parse(fs.readFileSync(p,"utf8")); j.android_ota="mismatch"; fs.writeFileSync(p, JSON.stringify(j,null,2)+"\n");'
if TARGET_ENV=production \
  EXPO_PUBLIC_APP_ENV=production \
  EXPO_PUBLIC_SUPABASE_URL=https://rftlqybgnbixotnpanec.supabase.co \
  VERCEL_PROJECT=mantra-japam \
  PRODUCTION_URL=https://mantra-japam.vercel.app \
  scripts/check-environment.sh >/tmp/japam-baseline-mismatch.out 2>&1; then
  fail_test "baseline/manifest mismatch passed"
fi
grep -q "baseline and manifest disagree" /tmp/japam-baseline-mismatch.out || fail_test "baseline/manifest mismatch produced wrong failure"
pass_test "baseline/manifest mismatch fails"

echo "All release safety regression tests passed."
