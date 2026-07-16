#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$script_dir/release-lib.sh"

require_repo
cd "$(repo_root)"
assert_baseline_manifest_agree

TARGET_ENV="${TARGET_ENV:-}"
[ "$TARGET_ENV" = "production" ] || [ "$TARGET_ENV" = "staging" ] || fail "TARGET_ENV must be production or staging"

manifest_runtime="$(manifest_value android_runtime)"
manifest_package="$(manifest_value android_package)"
manifest_version_code="$(manifest_value android_version_code)"
manifest_expo_project="$(manifest_value expo_project_id)"
production_supabase="$(manifest_value production_supabase_project)"
staging_supabase="$(manifest_value staging_supabase_project)"
production_url="$(manifest_value production_url)"
vercel_project="$(manifest_value vercel_project)"
staging_vercel_project="$(manifest_value staging_vercel_project)"

app_runtime="$(expected_runtime_from_app)"
app_package="$(app_value 'app.expo.android.package')"
app_version_code="$(app_value 'app.expo.android.versionCode')"
app_expo_project="$(app_value 'app.expo.extra.eas.projectId')"

[ "$app_runtime" = "$manifest_runtime" ] || fail "runtime mismatch: app=$app_runtime manifest=$manifest_runtime"
[ "$app_package" = "$manifest_package" ] || fail "package name mismatch: app=$app_package manifest=$manifest_package"
[ "$app_version_code" -ge "$manifest_version_code" ] || fail "versionCode regression: app=$app_version_code manifest=$manifest_version_code"
[ "$app_expo_project" = "$manifest_expo_project" ] || fail "Expo project mismatch: app=$app_expo_project manifest=$manifest_expo_project"

case "$TARGET_ENV" in
  production)
    [ -n "${VERCEL_PROJECT:-}" ] || fail "VERCEL_PROJECT evidence is required for production"
    [ -n "${PRODUCTION_URL:-}" ] || fail "PRODUCTION_URL evidence is required for production"
    channel="$(eas_value 'eas.build.production.channel')"
    app_env="$(eas_value 'eas.build.production.env.EXPO_PUBLIC_APP_ENV')"
    [ "$channel" = "$(manifest_value expo_production_channel)" ] || fail "production channel mismatch: $channel"
    [ "$app_env" = "production" ] || fail "production EAS env mismatch: $app_env"
    [ "${EXPO_PUBLIC_APP_ENV:-}" = "production" ] || fail "EXPO_PUBLIC_APP_ENV must be production"
    [[ "${EXPO_PUBLIC_SUPABASE_URL:-}" == *"$production_supabase"* ]] || fail "production Supabase URL missing production project"
    [[ "${EXPO_PUBLIC_SUPABASE_URL:-}" != *"$staging_supabase"* ]] || fail "staging credentials appear in production"
    [ "$VERCEL_PROJECT" = "$vercel_project" ] || fail "wrong Vercel project: $VERCEL_PROJECT"
    [ "$PRODUCTION_URL" = "$production_url" ] || fail "wrong production URL: $PRODUCTION_URL"
    ;;
  staging)
    [ -n "${VERCEL_PROJECT:-}" ] || fail "VERCEL_PROJECT evidence is required for staging"
    [ -n "${STAGING_URL:-}" ] || fail "STAGING_URL evidence is required for staging"
    channel="$(eas_value 'eas.build.preview.channel')"
    app_env="$(eas_value 'eas.build.preview.env.EXPO_PUBLIC_APP_ENV')"
    [ "$channel" = "$(manifest_value expo_staging_channel)" ] || fail "staging channel mismatch: $channel"
    [ "$app_env" = "preview" ] || fail "staging EAS env mismatch: $app_env"
    [ "${EXPO_PUBLIC_APP_ENV:-}" = "preview" ] || [ "${EXPO_PUBLIC_APP_ENV:-}" = "staging" ] || fail "EXPO_PUBLIC_APP_ENV must be preview or staging"
    [[ "${EXPO_PUBLIC_SUPABASE_URL:-}" == *"$staging_supabase"* ]] || fail "staging Supabase URL missing staging project"
    [[ "${EXPO_PUBLIC_SUPABASE_URL:-}" != *"$production_supabase"* ]] || fail "production credentials appear in staging"
    [ "$VERCEL_PROJECT" = "$staging_vercel_project" ] || fail "wrong staging Vercel project: $VERCEL_PROJECT"
    [ "$STAGING_URL" != "$production_url" ] || fail "staging URL must not equal production URL"
    ;;
esac

info "environment check passed for $TARGET_ENV"
