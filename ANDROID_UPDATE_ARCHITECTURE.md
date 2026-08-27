# Android update architecture

Status: corrected locally for preview validation. No Supabase schema/data
change, deployment, OTA publish, Play Console action, device test, or AAB
upload is included.

## Existing production contract

The app uses the existing public read-only RPC:

```text
get_android_latest_version_code() -> integer
```

The RPC reads the protected singleton table
`android_app_update_config`, whose production fields are only:

```text
singleton boolean primary key
latest_version_code integer not null
```

The client does not query the table directly and does not require additional
server fields. The Play Store URL and update message remain client-side
constants.

## Runtime behavior

The permanent updater reads `Application.nativeBuildVersion` through a guarded
dynamic require. If the native module is absent, it falls back to
`Constants.androidManifest?.versionCode`. Invalid or missing values fail
closed without affecting startup.

The root layout runs both paths during migration. The permanent RPC-backed
result takes priority. If it is unavailable, the legacy `<42` rule remains
reachable as a fallback. A single resolved banner config is rendered, so the
two paths cannot create duplicate update UI. VersionCode `42` is hidden when
the server RPC returns `42`; a later RPC value such as `43` shows the banner
for installed version `42`.

Already-installed old binaries retain the legacy JavaScript they already have
unless they receive a later OTA. The guarded module load prevents an OTA from
assuming that `expo-application` exists in an older native binary.

## Native dependency

`expo-application` remains a direct dependency for the next native build, but
the runtime import is defensive for OTA compatibility. A new native AAB is
still recommended before relying on `nativeBuildVersion` as the primary source.

Google Play In-App Updates remains deferred. The direct Play Store listing is
the lower-risk, non-blocking UX for this release.
