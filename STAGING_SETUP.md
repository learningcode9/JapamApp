# Japam App — Staging Environment Setup

Lets you run the app locally against the `japam-staging` Supabase project instead of
production, without ever touching production's env files.

## How it works

Production config lives in `.env` / `.env.local` exactly as before — **untouched**.
Staging config lives in a separate `.env.staging` file (gitignored, never committed).
A small dependency-free script (`scripts/run-with-env.js`) loads `.env.staging` and
layers it on top of the environment before launching Expo, so staging values take
precedence without editing or deleting anything production uses.

```
.env                  ← production (existing, untouched)
.env.local             ← production local overrides (existing, untouched)
.env.example            ← production template (existing, untouched)
.env.staging            ← staging config (gitignored — you already have this)
.env.staging.example     ← staging template (tracked, no real secrets)
scripts/run-with-env.js  ← loads an arbitrary .env file before spawning a command
```

## EAS Cloud Builds & OTA Channel for Staging

Everything above covers **local** dev (`expo start`/`expo run:android`). This section covers
**cloud builds** (`eas build`) and **OTA updates** (`eas update`) for staging.

### Architecture

```
eas.json "staging" build profile
  → channel: "staging"                (dedicated OTA channel, created via `eas channel:create staging`)
  → environment: "preview"            (pulls Supabase URL/keys from the EAS "preview" Environment)
```

### Important: the built-in "preview" EAS Environment now holds staging's values

EAS Environments (the server-side env-var store `eas build`/`eas update` pull from — separate
from `eas.json` itself) only support **custom names on paid EAS plans**. This project's current
plan doesn't support a custom `"staging"` Environment (`eas env:create staging ...` fails with
*"Custom environments are supported on Production and Enterprise plans"*).

Given that, and given the audit below found `preview` fully redundant with the new `staging`
profile for its original purpose, we deliberately **repurposed the built-in `"preview"`
Environment to hold staging's Supabase values** rather than hardcoding them into the git-tracked
`eas.json` file. The new `staging` build profile explicitly declares `"environment": "preview"`
so `eas build --profile staging` correctly pulls from it.

**What changed, exactly** (2026-07-02):
- `EXPO_PUBLIC_SUPABASE_URL`: `https://rftlqybgnbixotnpanec.supabase.co` (production) →
  `https://nhacglvxdypevrbvvkhn.supabase.co` (staging)
- `EXPO_PUBLIC_SUPABASE_ANON_KEY`: production publishable key → staging publishable key
- `EXPO_PUBLIC_GOOGLE_CLIENT_ID` / `EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID`: **unchanged** — reused
  as-is, same reasoning as the local setup above (native Google Sign-In isn't tied to a Supabase
  project).
- The **`production`** Environment was not touched at all.

**Consequence — read this before running any preview build**: `eas build --profile preview`
now produces a build wired to the **staging** backend, not production. This is intentional
(see deprecation notice below) but is a real behavior change from what `preview` builds did
before this date. Existing devices already running an installed preview build are unaffected —
env vars are baked in at build time, not changed by OTA — this only affects **new** preview
builds going forward.

### `preview` OTA channel — deprecated

- `preview` (channel + build profile) is **not removed**, but is deprecated as of 2026-07-02.
- `staging` is now the **only** pre-production OTA channel going forward.
- Do not publish new OTA updates to `preview`. Use `eas update --branch staging --channel staging
  --platform android` instead.
- See "Preview deprecation" below for the full audit and migration plan.

### Commands (not yet run — for when you're ready)

```bash
# Cloud build, shareable APK, wired to staging backend:
eas build --profile staging --platform android

# OTA update to staging channel (after a staging build is installed on a device):
eas update --branch staging --channel staging --platform android
```

## Files

- **`.env.staging`** (gitignored, already created with real values):
  ```
  EXPO_PUBLIC_SUPABASE_URL=https://nhacglvxdypevrbvvkhn.supabase.co
  EXPO_PUBLIC_SUPABASE_ANON_KEY=sb_publishable_...  (staging publishable key)
  EXPO_PUBLIC_GOOGLE_CLIENT_ID=...            (same as production)
  EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID=...    (same as production)
  EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID=...        (same as production)
  ```
  Google OAuth client IDs are reused from production. See **Google OAuth Setup for
  Staging** below for exactly why that's correct and what still needs to happen on
  the Supabase side before sign-in will actually work.

## Google OAuth Setup for Staging

### Audit: how Google Sign-In actually works in this app

Confirmed by reading every call site (`app/(tabs)/index.tsx`, `tap-japam.tsx`,
`timer.tsx`, `lib/anonymousAuth.ts`):

- **`signInWithOAuth` (Supabase's hosted-redirect OAuth flow) is never used anywhere
  in this codebase.** Every platform uses `supabase.auth.signInWithIdToken()` (and
  `linkIdentity()` for the anonymous→Google upgrade path) instead.
- **Android (native)**: `@react-native-google-signin/google-signin`'s native SDK
  obtains a Google ID token directly (no browser redirect at all), configured via
  `GoogleSignin.configure({ webClientId: EXPO_PUBLIC_GOOGLE_CLIENT_ID })`. The
  Android OAuth client itself (`EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID`) is never
  passed in code — the native SDK resolves it automatically via the app's package
  name (`com.japamapp.mantrajapam`) + signing certificate SHA-1, registered once in
  Google Cloud Console. This is entirely independent of which Supabase project the
  app talks to.
- **Web**: `expo-auth-session`'s `Google.useAuthRequest()` also obtains an ID token
  directly via a browser popup (`redirectUri: window.location.origin`), then calls
  the same `signInWithIdToken()`. The redirect target is the web app's own origin
  (e.g. `http://localhost:8081` for local dev) — **not** a Supabase-hosted callback
  URL, because `signInWithOAuth` is never invoked.

**Consequence**: since neither platform ever hits Supabase's own
`https://<project-ref>.supabase.co/auth/v1/callback` redirect endpoint, **no new
Google Cloud Console redirect URI or JavaScript origin entries are needed for
staging** — reusing the exact same Web/Android OAuth clients as production is
correct and sufficient on the Google side. (This corrects an earlier, more
cautious note in this doc that assumed `signInWithOAuth` was in use.)

### What's actually required: Supabase Auth provider config (staging project only)

`signInWithIdToken` validates the incoming ID token's `aud` claim against the
Client ID(s) registered in **that specific Supabase project's** own Auth settings.
A brand-new Supabase project (like `japam-staging`) starts with Google auth
**disabled** — this is the one real gap, and it's a Dashboard setting, not
something reachable through the REST API keys used elsewhere in this project, so
it has to be done manually:

1. Open the **staging** project → **Authentication → Providers → Google**.
2. Toggle it **on**.
3. **Client IDs** (Supabase supports a comma-separated list here): add the same
   values already in `.env.staging` —
   `EXPO_PUBLIC_GOOGLE_CLIENT_ID` (= `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`) and
   `EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID`.
4. **Client Secret**: the Supabase dashboard form typically requires this field to
   be filled to save the provider even though `signInWithIdToken` itself doesn't
   use it (only `signInWithOAuth` would). Use the **same secret** as production's
   Google provider — find it in Google Cloud Console → APIs & Services →
   Credentials → (the Web OAuth client) → it's safe to reuse, a Client Secret isn't
   tied to how many different backends verify tokens issued to that client.
5. Save.
6. Also check **Authentication → Providers → Anonymous** (used by the guest-mode →
   Google-linking flow in `lib/anonymousAuth.ts`'s `signInAnonymously()`) — this is
   also disabled by default on a new project and needs enabling if you plan to test
   the guest-to-Google-sign-in collision/link path on staging, not just a direct
   sign-in.

No Google Cloud Console changes, no code changes, and no new environment variables
are required beyond what's already in `.env.staging` (committed in `025d866`).

## Switching between production and staging

| | Production (default) | Staging |
|---|---|---|
| Start dev server | `npm start` | `npm run start:staging` |
| Android | `npm run android` | `npm run android:staging` |
| Web | `npm run web` | `npm run web:staging` |

No flags to remember, no env file to manually swap — just use the `:staging` script
variant. Production commands are completely unchanged.

## Local testing steps

1. `npm run start:staging`
   - Confirm the console prints `[run-with-env] Loaded 5 var(s) from .env.staging`
     listing all five `EXPO_PUBLIC_*` keys — this confirms staging values are being
     injected before Expo starts.
2. Open the app (simulator/device/web) from that dev server.
3. **Sign in** with Google — confirms staging Supabase Auth is reachable and the
   reused OAuth client IDs work against the staging project. If this fails with an
   auth/provider-not-enabled error, the staging project's Google provider hasn't
   been configured yet — see **Google OAuth Setup for Staging** above.
4. **Add Japam** (both Malas and Total Count modes) — writes to the staging
   `japam_history` table only; production is never touched by a staging-launched app.
5. **Edit** an entry, **Delete** an entry, then **relaunch staging** to confirm
   **Restore** (local persistence) and that the delete didn't reappear.
6. **Groups Dashboard** — create/join a group on staging and confirm totals render
   (staging's RPCs were copied byte-for-byte from production's schema export, so
   this exercises `get_group_dashboard`, `create_group`, etc. against staging).
7. **Offline sync** — toggle airplane mode, add a Japam entry, reconnect, and confirm
   it syncs to the *staging* project (verify via the staging Supabase dashboard's
   Table Editor, not production).
8. When done, `npm start` (no `:staging` suffix) returns you to production — confirm
   by checking the console no longer prints the `run-with-env` staging-loading line.

## Known limitations / follow-ups (not done in this step)

- Staging RLS policies and function grants are an **exact copy** of production's,
  including the permissive `anon`-wide-open policies and grants flagged during the
  schema review (`"anon manage deleted_completions"`, `allow_japam_history_select`,
  etc.) — tracked separately as a dedicated hardening task, not fixed here.
- Google provider must still be manually enabled in the staging Supabase project's
  dashboard (Client IDs + Secret) before Google Sign-In will work at all — see
  **Google OAuth Setup for Staging** above. Not something I can do from here; no
  code or Google Cloud Console change is needed, only that one Dashboard step.
- Anonymous sign-in must also be enabled in staging if testing the guest-mode →
  Google-linking collision path specifically (not needed for a direct Google sign-in).
- Staging EAS build profile + OTA channel now exist (see above) but have not yet been
  used — no `eas build --profile staging` or `eas update --channel staging` has been
  run. First real use of that pipeline is still pending.

## Preview profile — audit and deprecation plan (2026-07-02)

### Audit findings

- **Is `preview` still providing unique value?** Historically yes — it's been the
  project's "build an installable APK for on-device QA" pipeline since early in the
  project (see `FIRST_BUILD.md`, `NATIVE_TEST_CHECKLIST.md`,
  `ANDROID_GOOGLE_SIGNIN_SETUP.md`, all of which reference it explicitly), with real,
  recent build and OTA-publish activity (multiple builds within the last day at the
  time of this audit). It has never been described in any doc as production-adjacent
  or customer-facing.
- **Is it now redundant after introducing `staging`?** Yes, for its original purpose.
  `staging` does everything `preview` did (installable internal APK, its own OTA
  channel) while additionally providing an isolated backend — something `preview`
  never had (it always pointed at production Supabase, meaning every "preview" test
  historically ran against real production data).
- **Any production dependency on `preview`?** None found structurally — `eas.json`'s
  `production` profile never references `preview`, no CI/CD automation exists in this
  repo referencing either build profile, and the `production` EAS Environment/channel
  were untouched by this work. One **unconfirmed, unresolved item**: whether the
  Android signing keystore currently used by `production` builds was originally
  generated via a `preview` build (`FIRST_BUILD.md` describes generating the keystore
  via a preview build if none exists yet) and whether EAS's credential management
  ties that keystore to the `preview` profile specifically or manages it at the
  project level (the more common default). **This must be verified via `eas
  credentials` before `preview` is ever fully removed** — not done here as it wasn't
  needed for today's change (we only repurposed environment variables, not
  credentials).
- **Has `preview` historically been used only as internal QA?** Yes, confirmed by
  build history and every doc reference — never anything else.

### Migration plan (do not execute yet — `preview` is deprecated, not removed)

**Safe to do now (already done, 2026-07-02):**
- Repurpose the `preview` EAS Environment's Supabase values to staging's (done).
- Stop publishing new OTA updates to the `preview` channel (documented above).
- Treat `staging` as the sole pre-production channel going forward.

**Must remain temporarily:**
- The `preview` build profile and channel themselves — not deleted. Any device
  currently running an installed preview build still needs `preview` to exist as a
  concept (even if no new updates are published to it) until those devices are
  migrated or retired.
- The `eas.json` `preview` block — unchanged, still valid, still buildable if ever
  needed as a fallback.

**Risks:**
- Android signing-credential entanglement with `preview` — unverified (see audit
  above). Removing `preview` before checking this could, in the worst case, affect
  credential resolution for `production` builds if EAS ever ties them together
  (uncommon, but unverified here — treat as a hard blocker on full removal until
  checked).
- `preview` channel currently supports **iOS** (`android, ios` per `eas
  channel:list`); the new `staging` channel/profile in this change is **Android
  only**. If iOS internal testing is ever needed again, `staging` doesn't yet cover
  it — would need an explicit iOS section added to the `staging` build profile
  first.
- Anyone with muscle memory for `eas build --profile preview` will now get a
  staging-wired build instead of a production-wired one — a behavior change that
  needs to be communicated, not just documented here.

**Rollback plan:**
- If repurposing `preview`'s Environment causes a problem, its original (production-
  mirroring) values are recorded above under "What changed, exactly" and can be
  restored with the same `eas env:create preview --name ... --value ... --force`
  commands, swapped back to the original values.
- No git changes are needed to roll back the Environment-variable change — it's
  entirely server-side EAS state, independent of this branch/commit.

**Recommended timeline:**
1. Now → next few weeks: `staging` becomes the default for all new pre-production
   testing; `preview` stays available but unused, purely as a safety net.
2. Before any full removal: verify the Android credentials question via `eas
   credentials`, and confirm whether iOS staging coverage is needed.
3. Once both are resolved and `staging` has proven itself in real use: remove the
   `preview` block from `eas.json` and `eas channel:delete preview` in a dedicated,
   explicitly-approved follow-up — not part of this change.
