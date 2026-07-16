#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$script_dir/release-lib.sh"

require_repo
cd "$(repo_root)"
assert_baseline_manifest_agree

baseline_commit="$(manifest_value production_commit)"
baseline_ota="$(manifest_value android_ota)"
baseline_web="$(manifest_value web_deployment)"
baseline_url="$(manifest_value production_url)"

git cat-file -e "$baseline_commit^{commit}" || fail "production commit missing from local Git: $baseline_commit"

drift=0

compare_or_unknown() {
  local label="$1"
  local expected="$2"
  local actual="$3"
  if [ -z "$actual" ]; then
    echo "$label: UNKNOWN"
    drift=1
  elif [ "$actual" = "$expected" ]; then
    echo "$label: PASS ($actual)"
  else
    echo "$label: DRIFT expected=$expected actual=$actual"
    drift=1
  fi
}

compare_or_unknown "Git production commit" "$baseline_commit" "${GIT_PRODUCTION_COMMIT:-}"
compare_or_unknown "Expo OTA ID" "$baseline_ota" "${EXPO_OTA_ID:-}"
compare_or_unknown "Expo OTA commit" "$baseline_commit" "${EXPO_OTA_COMMIT:-}"
compare_or_unknown "Vercel deployment ID" "$baseline_web" "${VERCEL_DEPLOYMENT_ID:-}"
compare_or_unknown "Vercel deployment commit" "$baseline_commit" "${VERCEL_DEPLOYMENT_COMMIT:-}"
compare_or_unknown "Production URL" "$baseline_url" "${PRODUCTION_URL:-}"

if [ "$drift" -ne 0 ]; then
  fail "production state is drifted or UNKNOWN"
fi

info "production state matches baseline"
