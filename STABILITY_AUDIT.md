# Release Stability Audit — Mantra Japam

Reviewed: May 2026  
Branch: `playstore-prep`  
Scope: Android production readiness (no code changes in this document)

---

## Summary

| Area | Risk | Status |
|---|---|---|
| Timer persistence | Low | Solid — wall-clock elapsed math |
| Tap persistence | Low | AsyncStorage + Supabase, deduped |
| Background timer | Low | AppState listener saves on background |
| Timer completion guard | Low | Dual refs prevent duplicates |
| Auth restore (cold start) | Low | Reads AsyncStorage on mount |
| Auth restore (mid-OAuth kill) | Low | `isAuthPending()` timeout guard |
| History sync | Low | Remote-wins merge with local fallback |
| Sign-in modal | Low | Only opens on explicit tap or failed auth |
| App resume behavior | Low | `timerStartedAtRef` recalculates elapsed |
| Notifications (foreground) | Medium | Handler in root layout — timer notifs suppressed, completion shown ✓ |
| Notifications (background) | Medium | Works; see Android 13 note below |
| Google OAuth — native Android | **High** | SHA-1 fingerprint must be registered before build |
| Safe area / bottom nav overlap | Low | Fixed — `useSafeAreaInsets` in _layout.tsx |
| Two separate timer systems | Low | Intentional; Home tab and Timer tab are independent |
| `expo-updates` channel | Low | `"channel": "production"` set in eas.json |

---

## Detailed findings

### 1. Timer persistence — LOW risk

**How it works:**  
`timerStartedAtRef.current` stores the wall-clock time when the timer started. Every tick computes `Math.floor((Date.now() - startAt) / 1000)` instead of incrementing a counter. This means even if the interval fires late (device throttle, background) the displayed time stays accurate.

On `AppState → background`, the current elapsed seconds are written to AsyncStorage and Supabase. On resume, the listener recalculates elapsed from `timerStartedAtRef.current` and updates `seconds` state, which triggers the completion `useEffect` if the timer finished while backgrounded.

**Verdict:** Correct and battle-tested. No changes needed.

---

### 2. Timer completion deduplication — LOW risk

Two guards prevent a mala from being counted twice:

- `isCompletingRef.current` — set to `true` at the start of `completeTimerSession`, prevents re-entry.
- `lastCompletedCycleRef.current` — records the timestamp; a second completion within 2 seconds is ignored.

The `useEffect` that watches `seconds >= targetSeconds` also checks `Date.now() - lastCompletedCycleRef.current < 2000` before calling `completeTimerSession`.

**Verdict:** Safe. No changes needed.

---

### 3. Tap persistence — LOW risk

Each tap calls `setCountersFromTotal` which:
1. Immediately updates React state (malas, count, total)
2. Writes to AsyncStorage synchronously (fire-and-forget)
3. On mala completion: calls `saveSession` which writes to AsyncStorage, emits `japam-history-updated`, then posts to Supabase

`saveSession` has a signature-based dedup guard (`lastSavedSessionRef`) and a mutex (`isSavingSessionRef`).

**Verdict:** Safe. No changes needed.

---

### 4. Background timer notification — MEDIUM risk

On Android, `expo-notifications` uses the `japam-timer` channel (importance: DEFAULT, no vibration) for the periodic status notification, and `japam-complete` (importance: HIGH, vibration) for completion.

The `showTimerNotification` function schedules a new notification every 15 seconds to update the time display in the status bar. This works in foreground and recent-apps background.

**Risk:** On Android 13+ (API 33), `POST_NOTIFICATIONS` runtime permission is required. This is now declared in `app.json`. However, `requestNotificationPermissionOnce()` is only called after Google Sign-In. Users who start the timer before signing in will not have been asked for permission, so notifications will silently fail.

**Recommendation (no code change needed now):** This is acceptable for v1.0 since the timer only works for signed-in users. Verify the permission prompt appears at first login on a physical Android 13 device.

---

### 5. Google OAuth on native Android — HIGH risk (pre-build action required)

`expo-auth-session` with Google uses the `scheme: "japamapp"` as the redirect URI on native. For this to work, **the Android package name and SHA-1 signing certificate fingerprint must be registered in Google Cloud Console**.

**Steps required before production build:**

1. Create a production keystore (or use EAS managed credentials — recommended).
2. After `eas credentials --platform android`, obtain the SHA-1 from EAS.
3. In Google Cloud Console → OAuth 2.0 Clients → Android:
   - Package name: `com.japamapp.mantrajapam`
   - SHA-1: (from step 2)
4. Download the updated `google-services.json` if using Firebase, or just ensure the client ID in `.env` matches the registered client.

**Without this, Google Sign-In will fail on production builds with an "app not authorized" error.**

---

### 6. Two separate timer systems — LOW risk (by design)

The app has two independent timer implementations:
- **Home tab (`index.tsx`)**: Simple tap-driven timer. Uses `setInterval` + `timerStartedAtRef`. Stores state in AsyncStorage keys: `timerSeconds`, `timerRunning`, `timerTarget`, `timerMinutes`, `timerLoop`.
- **Timer tab (`timer-context.tsx`)**: Dedicated timer with `expo-keep-awake`, loop counts up to 10, finer granularity. Uses separate AsyncStorage keys: `timerTab_duration`, `timerTab_loops`, `timerStartedAt`, etc.

These systems are intentionally independent and do not share state. Each saves to its own namespace. This is not a bug.

**Verdict:** No action needed. Worth noting in QA that these are two different features.

---

### 7. Auth restore on cold start — LOW risk

On mount, `loadData` reads `USER_NAME_KEY` and `USER_ID_KEY` from AsyncStorage. If both exist, it restores the user session, calls `restoreTodayTotal()` (which fetches from Supabase with local fallback), and restores timer state.

The `isAuthPending()` helper prevents the UI from showing "sign in" if an OAuth flow was interrupted (e.g., app killed during browser redirect). It uses a 2-minute timeout after which the pending state is cleared automatically.

**Verdict:** Solid. No changes needed.

---

### 8. History sync — LOW risk

`restoreTodayTotal` fetches `japam_history` from Supabase filtered to today, merges with local history (preserving other-user sessions), and uses the remote total as the authoritative source. If Supabase is unreachable, local history is used as fallback.

The `dedupeHistoryForStats` function in `timer.tsx` deduplicates sessions by exact key and within 30-second windows for timer sessions. This prevents double-counting from retries or network issues.

**Verdict:** Correct. No changes needed.

---

### 9. App resume behavior — LOW risk

When the app comes to foreground from background/inactive:

1. If `ref.isRunning && timerStartedAtRef.current !== null`: recalculate elapsed via wall clock.
2. If elapsed ≥ target: set `seconds` to trigger the completion `useEffect`.
3. If still mid-cycle: update `seconds` and ensure interval is alive.
4. Always: call `restoreTodayTotal()` to refresh stats.

**Edge case:** If the device clock is changed while the app is backgrounded, `timerStartedAtRef.current` would produce an incorrect elapsed time. This is an acceptable edge case for a meditation app.

**Verdict:** No changes needed.

---

### 10. Sign-in modal reopening — LOW risk

`showUserModal` is set to `true` only in these conditions:
- User explicitly taps "Sign in" button (account button when `!userName`)
- Google OAuth flow returns a non-success result
- `accessToken` is missing after OAuth
- `googleUserId` is empty after parsing the profile response

It is **not** set on timer start or tap — those call `requireLogin()` which returns `false` and sets `showUserModal(true)` only if `!userName`.

The `isSigningIn` flag prevents the modal from showing while OAuth is in progress.

**Verdict:** Safe. No phantom modal reopening.

---

### 11. Safe area and bottom nav overlap — FIXED

The tab bar previously used a hardcoded `bottom: 12` on native, which could be obscured by Android 3-button navigation (typically 48dp) or gesture navigation handles.

**Fixed in this branch:** `useSafeAreaInsets()` is now used to compute `bottom: Math.max(12, insets.bottom + 8)`. On phones with navigation bars, the tab bar will float above them.

The screen content `scrollBottomPadding` in `index.tsx` is set to `125` (native) which accommodates the tab bar height (74) plus safe area margin. This remains correct.

---

### 12. `expo-keep-awake` — LOW risk

`timer-context.tsx` imports `activateKeepAwakeAsync` and `deactivateKeepAwake`. This keeps the screen on while a Timer tab session is active. The Home tab timer does **not** use keep-awake — screen may turn off during a Home tab timer session, but the wall-clock math on resume handles this correctly.

**Recommendation:** This behaviour difference is acceptable for v1.0. Home tab timer is designed for background use; Timer tab is for active practice.

---

## Pre-build checklist (action items only)

| # | Action | Owner | Blocker? |
|---|---|---|---|
| 1 | Register Android package + SHA-1 in Google Cloud Console | Dev | **Yes** |
| 2 | Run `eas credentials --platform android` to generate/upload keystore | Dev | **Yes** |
| 3 | Set `EXPO_PUBLIC_GOOGLE_CLIENT_ID` in EAS environment secrets | Dev | **Yes** |
| 4 | Set `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY` in EAS secrets | Dev | **Yes** |
| 5 | Test notification permission prompt on Android 13 physical device | QA | No |
| 6 | Verify timer persists across app kill (close from recents, reopen) | QA | No |
| 7 | Verify Google Sign-In works on production APK before AAB submission | QA | No |
| 8 | Host privacy policy at a public URL and add to Play Console | Dev | **Yes** |

---

## EAS build command (when ready)

```bash
# Install EAS CLI if not present
npm install -g eas-cli

# Login
eas login

# Configure credentials (keystore generation)
eas credentials --platform android

# Production AAB build
eas build --platform android --profile production

# Submit to Play Console internal testing track
eas submit --platform android --profile production
```

> **Note:** `eas submit` requires `google-service-account.json` (a Play Console service account key). See [EAS Submit docs](https://docs.expo.dev/submit/android/) for setup.

---

## What is NOT a risk

- ✅ No raw SQL or injection vectors (all data access is via Supabase REST with parameterized URLs)
- ✅ No sensitive keys in source code (all via `EXPO_PUBLIC_*` env vars)
- ✅ No user-generated content rendered as HTML
- ✅ No third-party analytics or advertising SDKs
- ✅ Logout fully clears local storage (verified in `performLogout`)
