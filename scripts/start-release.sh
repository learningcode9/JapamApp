#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$script_dir/release-lib.sh"

require_repo
cd "$(repo_root)"
assert_baseline_manifest_agree

RELEASE_SHA="${1:-}"
TARGET_ENV="${TARGET_ENV:-production}"
STAGING_SLUG="${STAGING_SLUG:-}"

[ -n "$RELEASE_SHA" ] || fail "usage: scripts/start-release.sh <release-sha>"
[ "$TARGET_ENV" = "production" ] || [ "$TARGET_ENV" = "staging" ] || fail "TARGET_ENV must be production or staging"

expected_remote="$(manifest_value repository_remote)"
actual_remote="$(git config --get remote.origin.url || true)"
[ "$actual_remote" = "$expected_remote" ] || fail "wrong origin remote before fetch: $actual_remote"

git fetch origin --prune --tags
git cat-file -e "$RELEASE_SHA^{commit}" || fail "release SHA is not a commit: $RELEASE_SHA"

BASE_SHA="${EXPECTED_BASE_SHA:-$(manifest_value production_commit)}"
git cat-file -e "$BASE_SHA^{commit}" || fail "missing production baseline commit: $BASE_SHA"
git merge-base --is-ancestor "$BASE_SHA" "$RELEASE_SHA" || fail "release SHA does not descend from baseline $BASE_SHA"

short_sha="$(git rev-parse --short=7 "$RELEASE_SHA")"
today="$(date +%Y-%m-%d)"

case "$TARGET_ENV" in
  production)
    branch="release/prod-$today-$short_sha"
    worktree="/private/tmp/japam-release-$short_sha"
    ;;
  staging)
    [ -n "$STAGING_SLUG" ] || fail "STAGING_SLUG is required for staging releases"
    [[ "$STAGING_SLUG" =~ ^[a-z0-9][a-z0-9-]*$ ]] || fail "STAGING_SLUG must use lowercase letters, numbers, and hyphens"
    branch="release/staging-$STAGING_SLUG-$short_sha"
    worktree="/private/tmp/japam-staging-$STAGING_SLUG-$short_sha"
    ;;
esac

if git show-ref --verify --quiet "refs/heads/$branch"; then
  fail "release branch already exists: $branch"
fi

if [ -e "$worktree" ]; then
  fail "release worktree path already exists: $worktree"
fi

git worktree add "$worktree" -b "$branch" "$RELEASE_SHA"

cat <<SUMMARY
Release worktree created.

Target:        $TARGET_ENV
Branch:        $branch
Worktree:      $worktree
Release SHA:   $(git rev-parse "$RELEASE_SHA")
Baseline SHA:  $BASE_SHA

Next:
  cd "$worktree"
SUMMARY

case "$TARGET_ENV" in
  production)
    cat <<SUMMARY
  cp docs/RELEASE_TEMPLATE.md docs/releases/$today-production-$short_sha.md
  TARGET_ENV=$TARGET_ENV EXPECTED_RELEASE_SHA=$(git rev-parse "$RELEASE_SHA") RELEASE_RECORD_PATH=docs/releases/$today-production-$short_sha.md scripts/release-preflight.sh
SUMMARY
    ;;
  staging)
    cat <<SUMMARY
  TARGET_ENV=$TARGET_ENV EXPECTED_RELEASE_SHA=$(git rev-parse "$RELEASE_SHA") scripts/release-preflight.sh
SUMMARY
    ;;
esac
