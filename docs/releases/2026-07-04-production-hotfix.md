# Production Hotfix

Date: 2026-07-04
Repository: JapamApp
Branch: main
Commit: 82a3c30ffdf551afd9dc859c546f2b2bb2839bf5

## Summary

This release resolves the intermittent Android timer lifecycle corruption reported in GitHub Issues #19 and #20, where a Japam session could appear to reset to full duration after an interruption, or have its selected duration unexpectedly change mid-session (e.g. 10 minutes → 5 minutes).

---

## Root Cause

`TimerProvider` lived inside `app/(tabs)/_layout.tsx`. Expo Router's initial route resolution caused `TabLayout` to mount twice during app startup (once for the router's default entry pathname, once more when it settled on the configured anchor route) — with the first instance never unmounting. Because `TimerProvider` was nested inside that duplicated layout, it inherited the duplication:

- Two `TimerProvider` instances were created.
- Two `AppState` listeners remained active simultaneously.
- Both listeners independently wrote `persist_state` on every real app-state transition.
- Conflicting writes to shared `AsyncStorage` keys occasionally restored stale timer state, since whichever instance's write happened to land last silently overwrote the other's.

This could manifest as:
- the timer resetting after an interruption (e.g. an incoming phone call or backgrounding the app)
- the selected duration unexpectedly changing mid-session (10 → 5)

Extensive diagnostics proved this mechanism with hard evidence: `[TIMER_DIAG]` and `[LAYOUT_DIAG]` structured logging captured on a physical Samsung device showed `RootLayout` mounting exactly once per cold start, while `TabLayout` (and the `TimerProvider` nested inside it) mounted twice, with zero cleanup of the orphaned instance across a full session and multiple background/foreground cycles.

---

## Fix

- `TimerProvider` moved out of `app/(tabs)/_layout.tsx`.
- `TimerProvider` now lives in `app/_layout.tsx`, wrapping the root `<Stack>`.
- `RootLayout` mounts exactly once, so `TimerProvider` now mounts exactly once.
- Only one `AppState` listener exists.
- Only one `persist_state` writer exists.

No timer algorithm changed. No native Android code changed. No routing behavior changed.

---

## Validation

- Fix published to the `preview` (staging) OTA channel and validated on a physical Samsung device.
- Diagnostics confirmed exactly one `provider_mount` and one `appstate_listener_register` per cold start.
- No duplicate `persist_state` writes observed across two full background/foreground cycles.
- A 10-minute timer session remained correct throughout: `selectedDuration` stayed at 10, `remainingSeconds` decreased monotonically, and the timer never reset to 10:00 or jumped to 5:00.
- Issues #19 and #20 could not be reproduced after the fix.

---

## Production Release

**Android**

- Production OTA ID: `019f2f64-eca5-70e2-9b44-dd974aee6a7b`
- Update Group: `59e2038d-2e09-44f4-a010-de2f1dc1c017`
- Runtime: `1.0.0`

**Web**

https://mantra-japam.vercel.app

**Commit**

`82a3c30ffdf551afd9dc859c546f2b2bb2839bf5`

---

## Files Changed

- `app/_layout.tsx`
- `app/(tabs)/_layout.tsx`

---

## Related Issues

- #19
- #20

---

## Lessons Learned

- Global providers belong in `RootLayout`, not in a nested route-group layout.
- Never place long-lived providers inside a layout that can be duplicated by router-level route resolution.
- Always validate lifecycle bugs (mounts, listeners, background/foreground transitions) on a physical device — this class of bug does not reliably surface in logs or unit tests alone.
- Diagnostic-first investigation (structured logging before any fix) prevented an incorrect or premature fix, such as a singleton guard that would have masked the symptom rather than the cause.
- Small, focused PRs made root-cause analysis easier — each diagnostic PR isolated a single question, which made the eventual fix PR easy to review and verify as minimal.
- Staging validation before production prevented regressions from reaching real users.
