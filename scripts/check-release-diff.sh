#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$script_dir/release-lib.sh"

require_repo
cd "$(repo_root)"
assert_baseline_manifest_agree

BASE_SHA="${1:-}"
RELEASE_SHA="${2:-}"
ALLOWED_PROTECTED_PATHS_FILE="${3:-${ALLOWED_PROTECTED_PATHS_FILE:-}}"

[ -n "$BASE_SHA" ] || fail "usage: scripts/check-release-diff.sh <base-sha> <release-sha>"
[ -n "$RELEASE_SHA" ] || fail "usage: scripts/check-release-diff.sh <base-sha> <release-sha>"

git cat-file -e "$BASE_SHA^{commit}" || fail "base SHA is not a commit: $BASE_SHA"
git cat-file -e "$RELEASE_SHA^{commit}" || fail "release SHA is not a commit: $RELEASE_SHA"

echo "== Commits =="
git log --oneline --decorate "$BASE_SHA..$RELEASE_SHA" || true

echo
echo "== Files =="
git diff --name-status "$BASE_SHA..$RELEASE_SHA" || true

protected_count=0
config_count=0
db_count=0
native_count=0
approved_protected=""
unapproved_protected=""

echo
echo "== Protected Files =="
while IFS= read -r file; do
  [ -n "$file" ] || continue
  if is_protected_path "$file"; then
    echo "$file"
    protected_count=$((protected_count + 1))
    if [ -n "$ALLOWED_PROTECTED_PATHS_FILE" ] && [ -f "$ALLOWED_PROTECTED_PATHS_FILE" ] && grep -Fxq "$file" "$ALLOWED_PROTECTED_PATHS_FILE"; then
      approved_protected="${approved_protected}${file}"$'\n'
    else
      unapproved_protected="${unapproved_protected}${file}"$'\n'
    fi
  fi
  case "$file" in
    app.json|eas.json|vercel.json|package.json|package-lock.json|.env*) config_count=$((config_count + 1)) ;;
    db/*|supabase/*) db_count=$((db_count + 1)) ;;
    android-native/*|plugins/*) native_count=$((native_count + 1)) ;;
  esac
done < <(git diff --name-only "$BASE_SHA..$RELEASE_SHA")

echo
echo "== Approved Protected Files =="
if [ -n "$approved_protected" ]; then
  printf "%s" "$approved_protected"
else
  echo "none"
fi

echo
echo "== Unapproved Protected Files =="
if [ -n "$unapproved_protected" ]; then
  printf "%s" "$unapproved_protected"
else
  echo "none"
fi

echo
echo "== Summary =="
echo "protected_files=$protected_count"
echo "config_changes=$config_count"
echo "db_changes=$db_count"
echo "native_changes=$native_count"

if [ -n "$unapproved_protected" ]; then
  fail "unapproved protected files changed"
fi

info "release diff passed"
