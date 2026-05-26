# Android Google Sign-In Setup Guide

Mantra Japam uses `expo-auth-session` with `Google.useAuthRequest` for Google OAuth.
This guide covers everything required to make sign-in work on a real Android APK/AAB.

---

## Current code state

`androidClientId` has been added to `useAuthRequest` in `app/(tabs)/index.tsx`.

**Exact location: `app/(tabs)/index.tsx` — look for `Google.useAuthRequest`:**

```ts
const [request, response, promptAsync] = Google.useAuthRequest({
  clientId: process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID,           // web / Expo Go
  androidClientId: process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID,  // ✅ added — native Android APK
  scopes: ['profile', 'email'],
  redirectUri: googleRedirectUri,  // undefined on native (expo-auth-session auto-manages)
});
```

The web login flow is unchanged. Web builds continue to use `EXPO_PUBLIC_GOOGLE_CLIENT_ID`
and `window.location.origin` as the redirect URI.

**Still required before sign-in works on a real APK:** you must register an Android OAuth
client in Google Cloud Console (Step 2 below) and set the env variable (Step 3).

---

## Step 1 — Get your SHA-1 fingerprint

The Android OAuth client in Google Cloud Console requires your app's signing certificate
SHA-1. You need the **release** SHA-1, not the debug one.

**Via EAS (recommended for production builds):**

```bash
eas credentials --platform android
```

Select your app profile → view the release keystore → copy the SHA-1 fingerprint shown.

If you haven't run an EAS build yet, EAS will generate the keystore on first build.
Run a preview or production build first:

```bash
eas build --platform android --profile preview
```

Then re-run `eas credentials` to retrieve the SHA-1.

**Alternatively, from a local keystore file:**

```bash
keytool -list -v -keystore your-release-key.jks -alias your-key-alias
```

Copy the `SHA1:` line from the output.

---

## Step 2 — Create an Android OAuth client in Google Cloud Console

1. Go to console.cloud.google.com → APIs & Services → Credentials
2. Click **+ Create Credentials** → **OAuth 2.0 Client ID**
3. Choose application type: **Android**
4. Fill in:
   - **Name:** `Mantra Japam Android`
   - **Package name:** `com.japamapp.mantrajapam`  ← must match `app.json` exactly
   - **SHA-1 certificate fingerprint:** paste the fingerprint from Step 1
5. Click **Create**
6. Copy the **Client ID** shown (format: `xxxxxxxxxx.apps.googleusercontent.com`)

> The Android client does not need a redirect URI — it validates by package name + SHA-1.
> The redirect back to the app is handled by expo-auth-session automatically.

---

## Step 3 — Add the env variable

Add to `.env` (local dev) and EAS secrets (CI/builds):

**`.env`:**
```
EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID=<your-android-client-id>.apps.googleusercontent.com
```

**EAS secrets (required for `eas build` to pick it up):**
```bash
eas secret:create --scope project \
  --name EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID \
  --value "<your-android-client-id>.apps.googleusercontent.com"
```

Verify it is set in EAS:
```bash
eas secret:list
```

---

## Step 4 — Verify package name matches everywhere

| Location | Required value | Status |
|---|---|---|
| `app.json` → `android.package` | `com.japamapp.mantrajapam` | ✅ set |
| `app.json` → `scheme` | `japamapp` | ✅ set |
| Google Cloud Console Android client → Package name | `com.japamapp.mantrajapam` | verify when creating |
| Google Cloud Console Android client → SHA-1 | from EAS release keystore | set in Step 1 |

Any mismatch causes silent sign-in failure (browser closes immediately without error).

---

## Step 5 — Test sign-in on a real APK

1. Build a preview APK (uses release keystore, not Expo Go):

   ```bash
   eas build --platform android --profile preview
   ```

2. Download the APK from the EAS build link and install it:

   ```bash
   adb install japamapp-preview.apk
   ```

3. Open the app → tap "Continue with Google"

4. **Expected successful sign-in flow:**
   - Browser or Google account sheet opens (system-level account picker)
   - User selects a Google account
   - Brief loading state ("Signing in...")
   - App returns to the main screen
   - User's first name appears in the top-right of the home screen
   - Settings tab shows the user's name under "Signed in"
   - Japam history loads from Supabase

5. Open logcat (with dev build) or check the EAS build logs and look for:
   ```
   [Auth] Google response type: success
   [Auth] Android client ID present: true
   ```

> **Do not test Google Sign-In in Expo Go for production verification.**
> Expo Go uses its own signing certificate; the SHA-1 registered with Google
> will not match the production APK's keystore.

---

## How to verify Android OAuth is working on a real APK

**In a dev/preview build with `adb logcat`:**
```bash
adb logcat | grep "\[Auth\]"
```

Expected output when sign-in succeeds:
```
[Auth] Google response type: success
[Auth] Redirect URI used: (native: managed by expo-auth-session)
[Auth] Android client ID present: true
```

Expected output when `androidClientId` is missing (will sign in as web flow, may fail):
```
[Auth] EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID is not set. Google Sign-In will fail on native Android APKs.
```

Expected output when sign-in is cancelled or fails:
```
[Auth] Google response type: cancel
# or
[Auth] Google response type: error
```

---

## Common sign-in failure causes and SHA-1 mismatch symptoms

| Symptom | Root cause | Fix |
|---|---|---|
| Browser opens and immediately closes, returns to app with no user | Redirect URI mismatch or wrong SHA-1 | Re-check SHA-1 from `eas credentials`; re-register in Google Cloud Console |
| `Error 400: redirect_uri_mismatch` shown in browser | Web client used, redirect URI not registered | Add `com.japamapp.mantrajapam:/` to authorized redirect URIs in web OAuth client |
| Sign-in completes in browser but `response.type` is `cancel` | SHA-1 mismatch — app signed with different keystore than registered | Confirm SHA-1 from `eas credentials`, not from local debug keystore |
| Sign-in works in Expo Go but not in APK | Debug keystore SHA-1 registered instead of release keystore | Run `eas build --profile preview` first, then `eas credentials` to get release SHA-1 |
| `userInfo.id` is empty after sign-in | Token scope issue or wrong client ID type | Confirm `androidClientId` is set and correct; check `[Auth]` logs |
| Sign-in works on one device, fails on another | Multiple keystores without all SHA-1s registered | Add both SHA-1s in Google Cloud Console, or verify EAS manages a single keystore |
| "Continue with Google" button is disabled (grayed out) | `request` is null — client ID not loading | Verify `.env` has `EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID`; rebuild after adding env var |
| logcat shows `Android client ID present: false` | Env var not set or not included in EAS build | Run `eas secret:list`; add via `eas secret:create` and trigger new build |

---

## Environment variables reference

| Variable | Required for | Where to set |
|---|---|---|
| `EXPO_PUBLIC_GOOGLE_CLIENT_ID` | Web builds, Expo Go | `.env` |
| `EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID` | Native Android APK/AAB | `.env` + EAS secrets |
| `EXPO_PUBLIC_SUPABASE_URL` | All builds | `.env` + EAS secrets |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | All builds | `.env` + EAS secrets |

See `.env.example` for the full template.

---

## Expo Go vs native build sign-in behavior

| Environment | Redirect scheme | Which client ID used |
|---|---|---|
| Expo Go (dev) | `exp://` | Web client only — `EXPO_PUBLIC_GOOGLE_CLIENT_ID` |
| Dev client (`eas build --profile development`) | `japamapp://` | Android client |
| Preview APK (`eas build --profile preview`) | `japamapp://` | Android client |
| Production AAB (Play Store) | `japamapp://` | Android client |

Both client IDs are now wired up. Web and Expo Go use the web client; native builds
use the Android client. No further code changes are needed — only the Google Cloud
Console registration and EAS secret (Steps 1–3 above).
