# First Android Preview Build — Step-by-Step Guide

This guide walks through every step to generate the first native Android APK
for Mantra Japam using EAS Build, from a clean machine with no prior EAS setup.

Run all terminal commands from the project root: `/Users/sravani/Desktop/JapamApp`

---

## Pre-build audit results (as of 2026-05-24)

| Item | Status | Notes |
|---|---|---|
| `app.json` package name | ✅ | `com.japamapp.mantrajapam` |
| `app.json` versionCode | ✅ | `1` |
| `app.json` scheme | ✅ | `japamapp` — needed for OAuth redirect |
| `app.json` orientation | ✅ | `portrait` |
| `app.json` permissions | ✅ | VIBRATE, POST_NOTIFICATIONS, RECEIVE_BOOT_COMPLETED |
| `eas.json` preview profile | ✅ | `buildType: apk` — produces installable APK |
| `eas.json` production profile | ✅ | `buildType: app-bundle` — for Play Store |
| Icon — `icon.png` | ✅ | 1024×1024 PNG |
| Adaptive icon foreground | ✅ | 1024×1024 PNG |
| Adaptive icon background | ✅ | 1024×1024 PNG |
| Monochrome icon (Android 13+) | ✅ | 1024×1024 PNG |
| Splash screen | ✅ | 1024×1024 PNG, `#f5fafa` background |
| expo-notifications plugin | ✅ | icon, color, androidMode configured |
| `.env` excluded from git | ✅ | in `.gitignore` |
| EAS project ID in app.json | ⚠️ | Set automatically on first `eas build` — OK |
| EAS secrets configured | ⚠️ | **Must do before build** — see Step 4 |
| `EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID` | ⚠️ | **Must do before build** — see Step 3 |

---

## Phase A — One-time machine setup

### A1 — Install EAS CLI

```bash
npm install -g eas-cli
```

Verify:
```bash
eas --version
```

### A2 — Log in to your Expo/EAS account

```bash
eas login
```

This opens a browser for authentication. Use the same account as your Expo dashboard.

Verify you are logged in:
```bash
eas whoami
```

### A3 — Link project to EAS (first time only)

```bash
eas init
```

This adds a `projectId` to `app.json` under `expo.extra.eas`. Commit the change:

```bash
git add app.json
git commit -m "Link project to EAS"
```

---

## Phase B — Android signing key and SHA-1

EAS manages the signing keystore automatically. The SHA-1 is needed to register the
Android OAuth client in Google Cloud Console.

### B1 — Trigger keystore generation

The keystore is created on first EAS build. Either run a preview build now (see Phase D)
and come back, or use credentials to check if one already exists:

```bash
eas credentials --platform android
```

If no keystore exists yet, run a preview build first (Phase D), then return here.

### B2 — Get the SHA-1 fingerprint

```bash
eas credentials --platform android
```

Navigate: select your build profile → **Keystore** → **Android Keystore**

Look for the line:
```
SHA1 Fingerprint: XX:XX:XX:XX:...
```

Copy the full SHA-1 string (colon-separated hex pairs).

---

## Phase C — Google Cloud Console: Android OAuth client

> Skip this phase if you already have an Android OAuth client. Check
> console.cloud.google.com → APIs & Services → Credentials.

### C1 — Create the Android OAuth client

1. Go to console.cloud.google.com → APIs & Services → Credentials
2. Click **+ Create Credentials** → **OAuth 2.0 Client ID**
3. Application type: **Android**
4. Fill in:
   - **Name:** `Mantra Japam Android`
   - **Package name:** `com.japamapp.mantrajapam`
   - **SHA-1 certificate fingerprint:** (paste from B2)
5. Click **Create**
6. Copy the Client ID (format: `XXXXXXXXXX-XXXXXXXX.apps.googleusercontent.com`)

### C2 — Verify redirect URI on the Web client

Google Sign-In on native Android uses a custom URI scheme, not a web redirect URI.
When `androidClientId` is provided, expo-auth-session handles the redirect internally
via the `japamapp://` scheme. **No manual redirect URI registration is needed** for the
Android client itself.

However, verify your **Web** OAuth client has `https://auth.expo.io/@your-username/JapamApp`
or `http://localhost` under authorized redirect URIs if you use Expo Go for dev testing.

---

## Phase D — EAS secrets

All `EXPO_PUBLIC_*` variables in `.env` must also be set as EAS secrets.
The `.env` file is NOT uploaded to EAS build servers — only EAS secrets are.

### D1 — Upload all required secrets

Run each of these, replacing `<value>` with the actual value from your `.env`:

```bash
eas secret:create --scope project \
  --name EXPO_PUBLIC_SUPABASE_URL \
  --value "https://rftlqybgnbixotnpanec.supabase.co"

eas secret:create --scope project \
  --name EXPO_PUBLIC_SUPABASE_ANON_KEY \
  --value "<your anon key from .env>"

eas secret:create --scope project \
  --name EXPO_PUBLIC_GOOGLE_CLIENT_ID \
  --value "475929514423-sujd0s7bb3jd46s5a0ck493f3p8phdji.apps.googleusercontent.com"

eas secret:create --scope project \
  --name EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID \
  --value "<android client ID from Phase C>"
```

### D2 — Also add to local .env

For local development builds, add to `.env`:

```
EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID=<android-client-id>.apps.googleusercontent.com
```

### D3 — Verify all secrets are set

```bash
eas secret:list
```

Expected output — all four variables should appear:
```
EXPO_PUBLIC_SUPABASE_URL
EXPO_PUBLIC_SUPABASE_ANON_KEY
EXPO_PUBLIC_GOOGLE_CLIENT_ID
EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID
```

---

## Phase E — Run the preview build

```bash
eas build --platform android --profile preview
```

This runs in EAS cloud. The build takes 10–20 minutes on first run (dependency caching
not yet warm). Subsequent builds are faster (~5–10 minutes).

### What happens during the build:
1. EAS uploads your project source (excluding `.gitignore` entries)
2. EAS injects the secrets as env vars
3. Expo prebuild generates the native Android project
4. Gradle compiles the APK using the release keystore managed by EAS
5. APK is signed and uploaded to EAS

### Watch build progress:
```bash
eas build:list
```

Or open the EAS dashboard link printed at the start of the build.

---

## Phase F — Install and test on device

### F1 — Get the APK

When the build completes, EAS prints a download URL. Either:

- Open the URL on your phone (Chrome → tap APK → install)
- Or download to your machine and push via adb:

```bash
# Install adb: brew install android-platform-tools
adb install /path/to/japamapp-preview.apk
```

Enable "Install from unknown sources" on the device if prompted (Settings → Security).

### F2 — Testing checklist (run in order)

**Install and launch**
- [ ] App installs without error
- [ ] Splash screen shows (centered icon, teal background fades in)
- [ ] Tab bar visible, not hidden behind navigation area

**Google Sign-In**
- [ ] Tap "Continue with Google" → Google account picker opens
- [ ] Select account → returns to app, shows your first name
- [ ] Settings tab shows "Signed in" with name
- [ ] Check logcat: `adb logcat | grep "\[Auth\]"` → should show `response type: success`

**Timer — foreground**
- [ ] Start a 1-minute timer → timer counts down
- [ ] Running notification appears in notification bar
- [ ] Timer completes → vibration + notification fires
- [ ] Completion notification is HIGH priority (appears at top of shade)

**Timer — screen off**
- [ ] Start a 1-minute timer → press power button
- [ ] Wait for timer to complete
- [ ] Completion notification fires on the lock screen
- [ ] Unlock → app shows completed state

**Timer persistence (app kill)**
- [ ] Start a 5-minute timer
- [ ] Swipe away from recents (force quit)
- [ ] Reopen app → timer resumes from approximately where it left off

**Tap Japam**
- [ ] Each tap increments count
- [ ] Vibration on each tap (if enabled)
- [ ] At 108 → mala completes, count resets, double vibration fires

**History sync**
- [ ] Complete a session → check History tab → session listed
- [ ] Logout (Settings → Logout) → History clears
- [ ] Sign back in → History restores from Supabase

**Offline**
- [ ] Disable WiFi + mobile data → app still works
- [ ] Timer and tap work offline
- [ ] No crash on sign-in attempt while offline

**Layout**
- [ ] Tab bar not overlapping content (check on device with gesture nav AND 3-button nav)
- [ ] Text not clipped on smaller screens
- [ ] Logout modal: Android back button closes it (not crashes)

---

## Troubleshooting

| Problem | Likely cause | Fix |
|---|---|---|
| Build fails: "Missing required env variable" | EAS secret not set | Run `eas secret:list`; add missing one with `eas secret:create` |
| Build fails: Gradle error | New architecture compatibility issue | Check EAS build log; may need `npx expo install --fix` |
| Google Sign-In: browser closes immediately | SHA-1 mismatch | Re-run `eas credentials --platform android` after build; update Google Cloud Console |
| Google Sign-In: `response.type: cancel` | Wrong SHA-1 registered | Delete Android OAuth client, re-create with correct SHA-1 from EAS keystore |
| Google Sign-In: `Android client ID present: false` in logcat | EAS secret not uploaded | `eas secret:list` → add `EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID` |
| Notification not firing on screen off | Battery optimization active | Settings → Apps → Mantra Japam → Battery → Unrestricted |
| APK won't install: "App not installed" | Signed with different cert than existing install | Uninstall old version first, then install APK |
| Tab bar hidden behind navigation | Safe area insets not applied | Already fixed in `_layout.tsx`; verify device has gesture nav enabled |

---

## After successful testing

When the preview APK passes all tests above:

1. Bump `versionCode` in `app.json` (e.g., `1` → `2`) before any new build
2. Build production AAB for Play Store:
   ```bash
   eas build --platform android --profile production
   ```
3. Submit to Play Store internal testing:
   ```bash
   eas submit --platform android --profile production
   ```
   (Requires `google-service-account.json` — see Play Console → Setup → API access)
