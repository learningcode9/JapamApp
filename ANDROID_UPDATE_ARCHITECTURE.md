# Android update architecture

Status: implemented locally for the next native Android build. No Supabase
migration, production data change, Play Console action, AAB build/upload, or
OTA publish is included in this change.

## Selected design

The app performs a best-effort read of a public Supabase REST resource named
`android_app_update_config`. The app sends only the publishable/anonymous key
and reads these public fields:

```text
latest_version_code
minimum_supported_version_code
play_store_url
message
force_update
```

The client validates the response and accepts only the Japam Google Play
listing URL. Missing credentials, a missing table, an offline request, a
non-OK response, or malformed values result in no banner and no startup delay.
The client does not write to Supabase. A future production table should allow
public `SELECT` only; updates must remain an admin-controlled operation.

`expo-application` supplies `Application.nativeBuildVersion`, which is the
native Android versionCode exposed at runtime. The old
`Constants.androidManifest.versionCode` read remains as a compatibility
fallback for older OTA-compatible binaries. The hard-coded `<42` helper is
still exported as `shouldShowLegacyAndroidUpdateBanner` and is not removed.

## UX and lifecycle

The reusable `AndroidUpdateBanner` is rendered from the root layout only on
Android. It is a calm, non-modal card with `Update Available` and an
`Update on Google Play` button. It never blocks normal use. Checks happen at
startup and when the app becomes active; in-flight checks are deduplicated and
the same availability state is not published repeatedly.

The server-controlled path and the legacy `<42` path should coexist during
migration. Existing installed versions can continue receiving the legacy
behavior through OTA-compatible JavaScript. The next native Play build embeds
the direct native version source and server-backed updater. After adoption is
high enough, remove the legacy helper and its fallback in a separate cleanup
release.

## Google Play In-App Updates audit

Google Play In-App Updates would require the native Play Core app-update
dependency (`com.google.android.play:app-update`) plus a React Native/Expo
native bridge. That bridge would require a custom native build and a new AAB;
it is not present in the current project. Flexible updates download in the
background and let the user continue using the app; immediate updates use a
full-screen flow and require the user to update before continuing.

For this release, the direct Play Store listing is safer: it adds no native
Play Core dependency, avoids an additional native bridge and update-state
machine, and matches the requested calm non-blocking UX. Revisit flexible
In-App Updates only after the server-backed banner has shipped and the app
has a tested custom native build path.

## Next release prerequisite

Before the next Play Store release, review and apply a production-safe
`android_app_update_config` table/RLS change, seed its Android row with the
currently live versionCode (`42`) and the exact Play URL, validate it in a
non-production Supabase project, then include this code and the direct
`expo-application` dependency in the next native AAB. Do not remove the
legacy `<42` path in that release.
