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
- No staging EAS build/OTA channel exists — this setup is for **local development
  only** (`expo start` / `expo run:android`), not for building or publishing.
