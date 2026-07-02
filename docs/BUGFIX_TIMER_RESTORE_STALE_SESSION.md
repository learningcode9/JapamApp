# Bugfix: Timer restore shows a stale, already-completed session

**Branch:** `fix/timer-restore-stale-session` (based on production commit `44593af`)
**Status:** investigated, fix implemented, not yet committed — awaiting approval.

## Reported symptom

Two independent users, on different days, reported the same scenario:

- Timer Japam, 10-minute duration, 2 repetitions.
- Both repetitions completed successfully — total count/malas correctly added, History correct.
- User left the app; after some time, reopening it showed **2 minutes remaining, 2 / 2
  repetitions** — an already-finished session appearing to still be in progress.
- No additional mala was added by this stale display; History remained correct throughout.

## Root cause (proven, not speculative)

A race condition between the Android native foreground timer service's completion-sound
playback and the JS-side reconciliation logic that runs when the app returns to the
foreground.

### The exact sequence

1. The final mala's duration elapses while the app is **backgrounded**. Android's native
   `JapamTimerService.handleLoopComplete()` (`android-native/JapamTimerService.kt:397-405`)
   immediately updates its in-memory `completedLoops` and calls `saveState()`, which
   persists the final completed-loop count to `SharedPreferences` right away.
2. The service does **not** stop itself yet. It defers `stopForeground()`/`stopSelf()`
   until *after* playing the completion (Om) sound
   (`android-native/JapamTimerService.kt:420-431`) — which can take up to **6 seconds**
   (the hardcoded fallback timeout at line 491, in case the `MediaPlayer` completion
   listener never fires).
3. During this window, `JapamTimerModule.getState()` (the JS↔native bridge,
   `android-native/JapamTimerModule.kt:141-159`) still reports `isRunning: true` —
   because `JapamTimerService.isRunning` reflects the service *process* being alive, not
   whether the timer session has logically finished.
4. If the user reopens the app during this exact window, `reconcileNativeLoops()`
   (`contexts/timer-context.tsx:1634`) runs. It correctly catches up `completedLoops` and
   correctly calls `saveSession()` for the newly-detected loop — matching "History
   remained correct" in both reports. But its final cleanup step, meant to reset the
   stale countdown/running persistence once every loop is done, was gated by:
   ```js
   if (!moreToGo && !native.isRunning) {
   ```
   Since `native.isRunning` was still `true` at that moment, this condition evaluated
   `false` and the cleanup was **skipped**. `TIMER_SECONDS_KEY`, `TIMER_STARTED_AT_KEY`,
   and `TIMER_SESSION_ID_KEY` in `AsyncStorage` were left holding their pre-completion
   snapshot (e.g. "8 minutes elapsed, 2 minutes remaining" from mid-way through the final
   mala) — exactly reproducing the reported symptom when that stale snapshot is displayed.

This is inherently timing-dependent (only manifests if the user happens to reopen the app
within roughly 6 seconds of the final mala's natural completion time while it was
backgrounded), which explains why it hit two different users on different days rather
than reproducing every time.

### Why the fix is safe

`moreToGo` (`contexts/timer-context.tsx`, computed just above the changed line) is
`completedLoopsRef.current < selectedLoopsRef.current`. When `!moreToGo` is true, there is
by definition no legitimate in-progress loop left to preserve state for — the
`native.isRunning` check was only ever meant to double-confirm the native service had
fully stopped, but it conflates "still playing the completion sound" with "session still
active." The sibling branch just above it
(`if (moreToGo && native.isRunning && !native.isPaused && native.startedAt > 0)`), which
handles the genuinely-in-progress case, is untouched.

Checked git history (`git log -S "!moreToGo && !native.isRunning"`): this condition was
part of the original commit that introduced the whole native-foreground-service feature
(`d690f44`), not a deliberate fix for a separately-documented edge case — removing it does
not revert a known, intentional guard.

## Code paths audited (per the investigation requirements)

- `persistState` / `persistCompletedLoops` — how JS persists timer UI state; confirmed
  `persistCompletedLoops` is a narrower, separate write from the full `persistState`,
  which is why `TIMER_COMPLETED_LOOPS_KEY` can correctly update while the rest of the
  timer-state keys lag behind.
- `completeCycle` — the foreground completion handler. Not the cause here (requires the
  app to be active at the exact completion moment); left untouched.
- Mount-time hydration effect (`contexts/timer-context.tsx:~1310-1544`) — the cold-start
  restore path. Read in full; it does **not** call `reconcileNativeLoops` or query native
  state at all, only trusting `AsyncStorage`'s last JS-written snapshot. This is a
  **separate, theoretical gap** or a true cold start (app process killed by the OS, not
  just backgrounded) — see "Not fixed here" below.
- `restoreRunningTimerFromStorage` — the warm-resume "restore running timer" path,
  triggered after `reconcileNativeLoops`. Unaffected by this change; it only acts when
  `TIMER_RUNNING_KEY === 'true'`, which the fix now correctly prevents from being stale
  once the native reconciliation itself completes properly.
- `reconcileNativeLoops` — **the fix is here.**
- `japamTimerLoopComplete` `DeviceEventEmitter` listener (`contexts/timer-context.tsx:1372-1389`)
  — the live-broadcast path for when JS stays alive while backgrounded. Confirmed it also
  never touches the countdown/running persistence keys (only `completedLoops`/History) —
  consistent with, not a cause of, the bug; `reconcileNativeLoops` remains the sole place
  responsible for that cleanup.
- AppState background/foreground listeners — read in full; the background handler
  correctly snapshots JS's last-known progress and does not need to change.
- Session UUID handling (`timerSessionIdRef`, `claimCompletionLoop`'s dedup `Set`) —
  confirmed the fix only ever executes within the same session
  (`native.sessionId === timerSessionIdRef.current`, checked at the top of
  `reconcileNativeLoops`), so it cannot affect a different/newer session.

## Not fixed here (out of scope, no proof found)

The mount-time hydration effect's lack of any native-state cross-check on a true cold
start (app process killed by the OS while a foreground service was supposedly keeping it
alive) is a **theoretical**, not proven, gap — I found no concrete evidence this
contributed to the two reported instances, and reasoned that a running foreground service
specifically exists to prevent the OS from killing the process during an active session,
making a true cold-start mid-session comparatively unlikely versus the proven warm-resume
race above. Not touched, per the instruction not to make speculative changes. Worth
revisiting only if this exact symptom recurs after this fix ships.

## The fix

One condition changed, in `contexts/timer-context.tsx`'s `reconcileNativeLoops`:

```diff
-      if (!moreToGo && !native.isRunning) {
+      if (!moreToGo) {
```

No other line changed except an expanded comment. No native/Kotlin changes. No changes to
`completeCycle`, the mount-time hydration effect, `persistState`, AppState listeners, or
any other timer logic.

## Validation

See the on-device validation report below (staging environment, per instructions — this
bug is pure local timer/AsyncStorage state and is unaffected by which Supabase backend is
configured).
