#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$script_dir/release-lib.sh"

require_repo
cd "$(repo_root)"
assert_baseline_manifest_agree

TARGET_ENV="${TARGET_ENV:-}"
EXPECTED_RELEASE_SHA="${EXPECTED_RELEASE_SHA:-}"
EXPECTED_BASE_SHA="${EXPECTED_BASE_SHA:-$(manifest_value production_commit)}"
EXPECTED_REMOTE="${EXPECTED_REMOTE:-$(manifest_value repository_remote)}"
NORMAL_DEV_CHECKOUT="${NORMAL_DEV_CHECKOUT:-/Users/sravani/Desktop/JapamApp}"
RELEASE_RECORD_PATH="${RELEASE_RECORD_PATH:-}"
ALLOWED_PROTECTED_PATHS_FILE="${ALLOWED_PROTECTED_PATHS_FILE:-}"

[ "$TARGET_ENV" = "production" ] || [ "$TARGET_ENV" = "staging" ] || fail "TARGET_ENV must be production or staging"
[ -n "$EXPECTED_RELEASE_SHA" ] || fail "EXPECTED_RELEASE_SHA is required"

repo="$(repo_root)"
head_sha="$(git rev-parse HEAD)"
branch="$(git branch --show-current)"
remote="$(git config --get remote.origin.url || true)"
status="$(git status --porcelain=v1)"
dirty_marker="$(git describe --always --dirty --broken)"

info "repo=$repo"
info "branch=${branch:-DETACHED}"
info "head=$head_sha"
info "target=$TARGET_ENV"

[ "$repo" != "$NORMAL_DEV_CHECKOUT" ] || fail "release from development checkout is forbidden: $NORMAL_DEV_CHECKOUT"
[ -n "$branch" ] || fail "detached HEAD is forbidden"
[ "$head_sha" = "$EXPECTED_RELEASE_SHA" ] || fail "wrong SHA: HEAD=$head_sha expected=$EXPECTED_RELEASE_SHA"
[ -z "$status" ] || fail "dirty tree"
[[ "$dirty_marker" != *dirty* ]] || fail "commit metadata reports dirty tree: $dirty_marker"
[ "$remote" = "$EXPECTED_REMOTE" ] || fail "wrong remote: $remote"

git cat-file -e "$EXPECTED_BASE_SHA^{commit}" || fail "missing production baseline commit: $EXPECTED_BASE_SHA"
git merge-base --is-ancestor "$EXPECTED_BASE_SHA" HEAD || fail "wrong lineage: HEAD does not descend from $EXPECTED_BASE_SHA"

case "$TARGET_ENV" in
  production)
    [[ "$branch" == release/prod-* ]] || fail "wrong release branch for production: $branch"
    [ -n "$RELEASE_RECORD_PATH" ] || fail "RELEASE_RECORD_PATH is required for production"
    [ -f "$RELEASE_RECORD_PATH" ] || fail "missing release record: $RELEASE_RECORD_PATH"
    ;;
  staging)
    [[ "$branch" == release/staging-* || "$branch" == integration/* ]] || fail "wrong release branch for staging: $branch"
    ;;
esac

TARGET_ENV="$TARGET_ENV" "$script_dir/check-environment.sh"

changed_files="$(git diff --name-only "$EXPECTED_BASE_SHA"..HEAD)"
unexpected=""
while IFS= read -r file; do
  [ -n "$file" ] || continue
  if is_protected_path "$file"; then
    if [ -n "$ALLOWED_PROTECTED_PATHS_FILE" ] && [ -f "$ALLOWED_PROTECTED_PATHS_FILE" ] && grep -Fxq "$file" "$ALLOWED_PROTECTED_PATHS_FILE"; then
      continue
    fi
    unexpected="${unexpected}${file}"$'\n'
  fi
done <<< "$changed_files"

[ -z "$unexpected" ] || fail "unexpected native/config/database/protected files changed:
$unexpected"

info "release preflight passed"
