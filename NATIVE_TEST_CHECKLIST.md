# Native Android Test Checklist

Use this checklist when testing the Mantra Japam APK/AAB on a physical Android device
before Play Store submission. Build with `eas build --platform android --profile preview`.

---

## Device setup

- [ ] Install APK via `adb install <file>.apk` or download from EAS build link
- [ ] Fresh install — no previous version on device
- [ ] Use a physical device (not an emulator) for reliable notification and vibration testing
- [ ] Test on at least two device types:
  - A small phone (≤5.5", ~360dp wide, e.g., Samsung Galaxy A series)
  - A modern flagship (6.1"–6.7", e.g., Pixel 7, Samsung S24)
- [ ] Disable battery optimization for the app: Settings → Apps → Mantra Japam → Battery → Unrestricted

---

## 1 — Install and launch

- [ ] APK installs without error
- [ ] App launches and splash screen displays correctly (centered icon, `#f5fafa` background)
- [ ] Tab bar is visible and not hidden behind navigation area (gesture nav or 3-button nav)
- [ ] No crash on cold launch

---

## 2 — Google Sign-In

- [ ] Tap "Continue with Google" — Google account picker opens in browser
- [ ] Select a Google account — returns to app and signs in
- [ ] User name appears in Settings tab
- [ ] Sign-in fails gracefully if network is offline (no crash)

> If sign-in fails with `redirect_uri_mismatch`: see `ANDROID_GOOGLE_SIGNIN_SETUP.md`
> The Android OAuth client and SHA-1 fingerprint must be configured first.

---

## 3 — Notification permission (Android 13+)

- [ ] First time starting a timer: system notification permission dialog appears
- [ ] Tapping "Allow" — permission granted, timer notification appears
- [ ] Tapping "Deny" — timer still works, no notification (no crash)
- [ ] Permission dialog only appears once (not on every timer start)

> On Android 12 and below, the permission dialog does not appear — notifications are
> auto-granted. Test the dialog on an Android 13+ device specifically.

---

## 4 — Timer — foreground

- [ ] Timer starts and counts down correctly
- [ ] Timer running notification appears in the notification shade
  - Shows "Timer running" or similar, on the `japam-timer` channel
- [ ] Timer can be paused and resumed
- [ ] Timer completes: sound + vibration fires (if enabled in Settings)
- [ ] Completion notification appears (high-priority, on `japam-complete` channel)
- [ ] Loop timer repeats automatically for selected number of loops
- [ ] "Timer complete" UI shows after final loop

---

## 5 — Timer — screen off / background

- [ ] Start timer → press power button (screen off)
- [ ] Timer notification remains in notification shade while screen is off
- [ ] When timer completes with screen off: completion notification fires
- [ ] Unlock phone → app shows timer as completed (or correct remaining time)
- [ ] Start timer → switch to another app (background)
- [ ] Timer completion notification fires while app is backgrounded

> **Known limitation — Doze mode / aggressive OEMs:**
> On Xiaomi, Oppo, Realme, and some Samsung devices, background notifications may
> be delayed or suppressed unless battery optimization is disabled for the app (see
> Device setup above). This is a system-level restriction, not an app bug.
> Expo's scheduled notifications use Android `AlarmManager` and are generally
> reliable when battery optimization is disabled.

---

## 6 — Timer persistence (app kill and restore)

- [ ] Start a 5-minute timer (timer running)
- [ ] Force-quit the app (swipe away from recents)
- [ ] Reopen app — timer resumes from approximately where it left off
  - Timer seconds are restored from AsyncStorage + `timerStartedAt` reference
- [ ] Timer that completes while app is killed fires the completion notification
- [ ] Reopen app after completion — shows completed state, not running

---

## 7 — Tap Japam

- [ ] Tap button increments count each tap
- [ ] Vibration fires on each tap (if enabled)
- [ ] At 108 taps: mala completes, count resets, sound + vibration fires
- [ ] Multi-mala count accumulates correctly across malas
- [ ] Count survives app backgrounding (no loss)

---

## 8 — Vibration behavior

- [ ] Settings → Vibration toggle OFF → tap produces no vibration
- [ ] Settings → Vibration toggle ON → tap vibrates
- [ ] Timer completion vibrates with distinct double pattern [0, 200, 80, 200]
- [ ] Mala completion vibrates correctly
- [ ] Test on a device where vibration is audible and confirm pattern

---

## 9 — History sync

- [ ] Complete a timer session while signed in
- [ ] Check History tab — session appears with correct date, duration, malas
- [ ] Sign out → sign back in with the same Google account
- [ ] History tab restores all previous sessions from Supabase
- [ ] History is sorted newest-first

---

## 10 — Logout and re-login

- [ ] Settings → Logout → confirmation modal appears
- [ ] Confirm logout → counters reset, user name clears, History empties
- [ ] Sign in again → history and stats restore from Supabase
- [ ] Multiple logout/login cycles — no data bleed between accounts

---

## 11 — Offline behavior

- [ ] Disable WiFi and mobile data
- [ ] App launches — works in offline mode (no crash)
- [ ] Timer works offline
- [ ] Tap Japam works offline
- [ ] History loads from local AsyncStorage while offline
- [ ] Sign-in attempt while offline — graceful error (no crash)
- [ ] Re-enable network → history syncs on next interaction

---

## 12 — Reinstall behavior

- [ ] Uninstall app completely
- [ ] Reinstall clean APK
- [ ] App launches fresh — no stale data from previous install
- [ ] Sign in — history restores from Supabase

> **Note:** AsyncStorage is cleared on uninstall. Supabase remains the source of truth
> for history and total counts after uninstall/reinstall.

---

## 13 — Layout — small phone

Test on a device with ~360dp width (5"–5.5" screen):

- [ ] Timer screen — no text clipping or overlap
- [ ] Tap Japam — tap button fully visible and tappable
- [ ] Settings — all cards visible, switches accessible
- [ ] History — list items not clipped
- [ ] Tab bar — all 4 tabs visible, labels not truncated
- [ ] No content hidden behind notch or punch-hole camera

---

## 14 — Layout — gesture navigation

- [ ] Tab bar is positioned above the gesture navigation area (not overlapping)
- [ ] Swipe-up gesture to go home does not conflict with tab bar
- [ ] Bottom content (e.g., footer text) is not hidden behind gesture strip

---

## 15 — Layout — 3-button navigation

- [ ] Tab bar is visible above the 3-button nav bar
- [ ] Bottom content is not hidden behind the nav bar

---

## 16 — Android back button

- [ ] Pressing Android back button from main tab — exits app (expected)
- [ ] Pressing Android back button on Settings logout modal — closes modal
- [ ] No unhandled navigation errors in logcat

---

## 17 — Settings persistence

- [ ] Toggle Sound OFF → restart app → Sound is still OFF
- [ ] Toggle Vibration OFF → restart app → Vibration is still OFF
- [ ] Settings survive app kill and restore

---

## Notification channels reference

| Channel ID | Name | Importance | Vibration | Purpose |
|---|---|---|---|---|
| `japam-timer` | Timer | DEFAULT | None | Shows while timer is running |
| `japam-complete` | Completion | HIGH | [0, 250ms] | Fires when timer finishes |

Android 8+ users can override these in system notification settings per channel.
If a user reports "no sound on completion" — check if they muted the `Completion` channel.

---

## Production risks summary

| Risk | Severity | Notes |
|---|---|---|
| Google Sign-In fails on APK | High | Android OAuth client + SHA-1 must be configured — see `ANDROID_GOOGLE_SIGNIN_SETUP.md` |
| Completion notification blocked in deep sleep | Medium | Affects Xiaomi/Oppo/Realme with battery optimization on; user must grant exemption |
| `<div>` in logout modal (was line 248 of settings.tsx) | Fixed | Replaced with `<View>` — would have crashed native build |
| Notification permission not requested | Low | Android 13+ only; already handled by `requestNotificationPermissionOnce` on first timer use |
| Tab bar hidden behind nav area | Low | Already handled by `useSafeAreaInsets` in `_layout.tsx` |
