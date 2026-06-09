# iPhone / iOS Screen-Awake — Japam Timer

Branch: `iphone-screen-awake`

## TL;DR
iOS screen-awake while the japam timer is running is **already implemented** by the existing
cross-platform wake-lock code. No new native module, no background service, and **no change to
Android behavior** are required. This branch documents that behavior and how to verify it on an
iPhone. (Investigated 2026-06; `expo-keep-awake@~15.0.8` already installed.)

## How it works today

All logic lives in `contexts/timer-context.tsx`:

| Function | Native (iOS + Android) | Web (incl. iOS Safari / PWA) |
|----------|------------------------|------------------------------|
| `acquireWakeLock()` | `activateKeepAwakeAsync()` → iOS sets `UIApplication.isIdleTimerDisabled = true` (screen stays awake) | `navigator.wakeLock.request('screen')` if supported (iOS Safari 16.4+) |
| `releaseWakeLock()` | `deactivateKeepAwake()` → idle timer restored (screen can sleep) | releases the `WakeLock` sentinel |

- **`acquireWakeLock()` is called when the timer starts** and when a running timer is restored on
  foreground.
- **`releaseWakeLock()` is called on stop, pause, completion, and when the app is backgrounded.**
- On the **web** path only, a `visibilitychange` handler **re-acquires** the wake lock when the page
  becomes visible again (iOS Safari auto-releases it when the tab is hidden).

The native branch (`Platform.OS !== 'web'`) covers **both iOS and Android with the identical call** —
so iOS gets the same behavior that was already verified working on Android, with nothing
iOS-specific to add.

### Why this satisfies the requirements
1. **Android unchanged** — this branch makes no code change; Android uses the same path as before. ✅
2. **iOS-safe screen awake while running** — `activateKeepAwakeAsync()` on iOS = `isIdleTimerDisabled`. ✅
3. **No complex native background service** — `expo-keep-awake` only toggles the idle timer. ✅
4. **Lightweight Expo-compatible** — `expo-keep-awake` is a first-party Expo module, auto-linked into
   the iOS build (no `Info.plist` / capability changes). ✅
5. **Awake during active session** — acquired on start / foreground-restore. ✅
6. **Sleeps when paused/stopped/completed** — `releaseWakeLock()` on each of those + on background. ✅
7. **Isolated / easy to revert** — nothing in the timer logic changed; delete this branch to revert. ✅

## Install (already done — for reference only)
`expo-keep-awake` is already in `package.json` (`~15.0.8`) and `node_modules`. If it were ever missing:
```
npx expo install expo-keep-awake
```
(Do **not** reinstall — it is present; this is only the recommended command.)

## ⚠️ A PHYSICAL iPhone is REQUIRED to verify this
The **iOS Simulator cannot test screen-awake.** The simulator never auto-locks or dims, so
`isIdleTimerDisabled` (what keep-awake toggles) produces no observable difference there. Likewise
there is no static/automated check that can prove "the screen stayed awake." This feature can **only**
be verified on a **real iPhone** (via a TestFlight / native build), exactly the way Android was
verified on a real device path — never on a simulator. Verification is therefore deferred until an
Apple Developer account is ready and an EAS iOS build can be installed on a physical device.

## How to test on an iPhone (real device only)
You need a native iOS build (the App Store / TestFlight build, not Safari, not the simulator) for the
reliable path:

1. Build for iOS: `eas build --platform ios --profile production` (or `--profile preview` for an
   internal/TestFlight build). Install via TestFlight.
2. Open the app → **Timer** tab → pick a duration → **Start**.
3. Leave the phone untouched. Confirm the screen **does not dim/lock** for the whole running session
   (test past the iOS Auto-Lock interval set in Settings ▸ Display & Brightness ▸ Auto-Lock, e.g. 30s).
4. **Pause** (or let it complete, or **Stop**) → within the Auto-Lock interval the screen should dim
   and lock normally again.
5. Background the app while running (Home/swipe up) → the timer pauses and the wake lock is released
   (by design — no background service). Reopen → it restores and re-acquires.

### Web / PWA on iPhone (Safari) — known limitation, not a regression
- iOS Safari **16.4+** supports the Wake Lock API, so the PWA path also keeps the screen awake while
  the tab is foreground (auto re-acquired on `visibilitychange`).
- **Older iOS Safari (<16.4)** has no Wake Lock API and **no reliable lightweight fallback** — the
  muted-/audio-session video hack was previously evaluated and rejected (it truncated the Om chime and
  was unreliable). For guaranteed iOS screen-awake, ship the **native** iOS build (above), which does
  not depend on Safari.

## Confirming Android is unchanged
This branch contains **no code changes** to `contexts/timer-context.tsx` or any runtime file — only
this doc. `npx tsc --noEmit` = 0 errors and `npm test` = 44/44, identical to `release/stable-v1`.
The Android-ready build (`08301bd`) is therefore completely unaffected.
