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
  Google OAuth client IDs are reused from production — native Google Sign-In
  (`signInWithIdToken`) isn't tied to a specific Supabase project, so this should
  work unchanged. If the **web** OAuth flow (`signInWithOAuth`) fails with a
  redirect-URI mismatch, that means Google Cloud Console needs the staging
  project's Supabase callback URL added as an authorized redirect — a follow-up
  step, not done here.

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
   reused OAuth client IDs work against the staging project.
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
- Web Google OAuth redirect URI for staging is not yet configured in Google Cloud
  Console (only relevant if you test the web sign-in flow specifically).
- No staging EAS build/OTA channel exists — this setup is for **local development
  only** (`expo start` / `expo run:android`), not for building or publishing.
