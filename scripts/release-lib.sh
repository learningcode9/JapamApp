#!/usr/bin/env bash

set -euo pipefail

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

info() {
  echo "INFO: $*"
}

repo_root() {
  git rev-parse --show-toplevel
}

manifest_path() {
  echo "$(repo_root)/docs/production-manifest.json"
}

baseline_path() {
  echo "$(repo_root)/docs/PRODUCTION_BASELINE.md"
}

require_repo() {
  git rev-parse --show-toplevel >/dev/null 2>&1 || fail "not inside a git repository"
}

require_file() {
  [ -f "$1" ] || fail "missing required file: $1"
}

manifest_value() {
  local key="$1"
  node -e '
    const fs = require("fs");
    const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const value = manifest[process.argv[2]];
    if (value === undefined || value === null || value === "") process.exit(2);
    if (typeof value === "object") console.log(JSON.stringify(value));
    else console.log(String(value));
  ' "$(manifest_path)" "$key" || fail "missing manifest key: $key"
}

baseline_value() {
  local field="$1"
  node -e '
    const fs = require("fs");
    const field = process.argv[2];
    const text = fs.readFileSync(process.argv[1], "utf8");
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\|\s*([^|]+?)\s*\|\s*`?([^|`]+?)`?\s*\|$/);
      if (match && match[1].trim() === field) {
        console.log(match[2].trim());
        process.exit(0);
      }
    }
    process.exit(2);
  ' "$(baseline_path)" "$field" || fail "missing baseline field: $field"
}

app_value() {
  local expression="$1"
  node -e '
    const fs = require("fs");
    const app = JSON.parse(fs.readFileSync("app.json", "utf8"));
    const value = Function("app", `return ${process.argv[1]}`)(app);
    if (value === undefined || value === null || value === "") process.exit(2);
    if (typeof value === "object") console.log(JSON.stringify(value));
    else console.log(String(value));
  ' "$expression" || fail "missing app.json value: $expression"
}

eas_value() {
  local expression="$1"
  node -e '
    const fs = require("fs");
    const eas = JSON.parse(fs.readFileSync("eas.json", "utf8"));
    const value = Function("eas", `return ${process.argv[1]}`)(eas);
    if (value === undefined || value === null || value === "") process.exit(2);
    if (typeof value === "object") console.log(JSON.stringify(value));
    else console.log(String(value));
  ' "$expression" || fail "missing eas.json value: $expression"
}

json_set_file() {
  local file="$1"
  shift
  node - "$file" "$@" <<'NODE'
const fs = require("fs");
const file = process.argv[2];
const pairs = process.argv.slice(3);
const json = JSON.parse(fs.readFileSync(file, "utf8"));
for (const pair of pairs) {
  const index = pair.indexOf("=");
  const key = pair.slice(0, index);
  const raw = pair.slice(index + 1);
  if (raw === "true") json[key] = true;
  else if (raw === "false") json[key] = false;
  else if (/^-?\d+$/.test(raw)) json[key] = Number(raw);
  else json[key] = raw;
}
fs.writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
NODE
}

expected_runtime_from_app() {
  local runtime_policy
  runtime_policy="$(app_value 'app.expo.runtimeVersion && app.expo.runtimeVersion.policy')"
  if [ "$runtime_policy" = "appVersion" ]; then
    app_value 'app.expo.version'
  else
    app_value 'app.expo.runtimeVersion'
  fi
}

assert_baseline_manifest_agree() {
  local baseline manifest
  local manifest_verified baseline_verified
  baseline="$(baseline_path)"
  manifest="$(manifest_path)"
  require_file "$baseline"
  require_file "$manifest"

  [ "$(manifest_value production_commit)" = "$(baseline_value "Current production commit")" ] || fail "baseline and manifest disagree on production commit"
  [ "$(manifest_value previous_production_commit)" = "$(baseline_value "Previous production commit")" ] || fail "baseline and manifest disagree on previous production commit"
  [ "$(manifest_value repository_remote)" = "$(baseline_value "Repository remote")" ] || fail "baseline and manifest disagree on repository remote"
  [ "$(manifest_value android_ota)" = "$(baseline_value "Android OTA update ID")" ] || fail "baseline and manifest disagree on Android OTA"
  [ "$(manifest_value web_deployment)" = "$(baseline_value "Web deployment ID")" ] || fail "baseline and manifest disagree on web deployment"
  [ "$(manifest_value android_runtime)" = "$(baseline_value "Android runtime")" ] || fail "baseline and manifest disagree on Android runtime"
  [ "$(manifest_value production_supabase_project)" = "$(baseline_value "Production Supabase project")" ] || fail "baseline and manifest disagree on production Supabase project"
  [ "$(manifest_value staging_supabase_project)" = "$(baseline_value "Staging Supabase project")" ] || fail "baseline and manifest disagree on staging Supabase project"
  manifest_verified="$(manifest_value verified)"
  baseline_verified="$(baseline_value "Verified")"
  [ "$manifest_verified" = "$baseline_verified" ] || fail "baseline and manifest disagree on verified state"
  [ "$(manifest_value verified_at)" = "$(baseline_value "Verification date")" ] || fail "baseline and manifest disagree on verification date"
}

protected_path_regex='^(app\.json|eas\.json|vercel\.json|package\.json|package-lock\.json|android-native/|plugins/|db/|supabase/|\.env|scripts/|public/manifest.*\.json$)'

is_protected_path() {
  [[ "$1" =~ $protected_path_regex ]]
}
