# Bugfix: Duplicate loop completion records from process-restart races

**Branch:** `fix/duplicate-completion-id` (based on `ea1a3f0`, the timer-restore-stale-session fix).
**Status:** investigated, fix implemented and validated, not yet committed — awaiting approval.

## Reported symptom

A real user's Timer dashboard showed stats inconsistent with a plausible real day
(13 malas / 1404 count / 25-day streak, while the account was only 15 days old).

## Root cause (proven)

Three duplicate-save guards in `contexts/timer-context.tsx` and `lib/timerState.ts` —
`processedCompletionLoopsRef`, `lastSavedSessionRef`, and the module-level `state` singleton
— are all **in-memory only**, never persisted to `AsyncStorage`. All three reset to their
initial values on every JS process restart (force-kill, OS memory-pressure kill, crash).

If a process restart occurs between a loop's native completion and its JS-side
reconciliation, `claimCompletionLoop()`'s guard incorrectly allows the same real loop to be
re-claimed on the fresh process, and `saveSession()` runs a second time — generating a
**new**, `Date.now()`-based `completionId` (since the old scheme derived it from the save
timestamp) with a **new** `date` (the reconciliation moment, not the true completion
moment, potentially a different calendar day). Neither `dedupeByCompletionId` nor
`mergeHistories` can detect this as a duplicate, since the two records have genuinely
different ids by design of the old scheme.

Mathematically proven via exhaustive simulation (see conversation record): the real
database data for the affected account could not produce the reported numbers under any
real-world timezone, given only 15 real distinct days of activity — proving the excess
data originated from local-only duplicate records invisible to the server.

Reproduced directly: an executable test using the exact guard-reset semantics produces two
records with different `completionId`s and different `date`s (different calendar days) for
one real loop.

Ruled out as the mechanism: the Google-ID→Supabase-UUID migration artifact present in 94%
of production rows (14 of 20 users) — traced precisely and found to cause under-counting
when triggered (a stale local record with an unmigrated `userId` wins the merge and gets
filtered out), not the over-counting observed. This is a separate, real data-hygiene issue,
not part of this fix's root cause.

## The fix

1. **`lib/historyStore.ts`**: new `makeLoopCompletionId(userId, sessionId, loopNumber)` —
   deterministic, based on stable session/loop identity instead of wall-clock save time.
   `appendCompletion()` accepts an optional caller-supplied `completionId` (using it instead
   of the date-based fallback when present) and gained a guard: if a record with the
   resulting id already exists in the array, skip appending instead of duplicating.
2. **`contexts/timer-context.tsx`**: `saveSession()` computes and passes
   `makeLoopCompletionId(uid, timerSessionIdRef.current, completedLoopsRef.current)` when a
   session id is available, falling back to the original date-based scheme otherwise.

Tap Japam (`app/(tabs)/tap-japam.tsx`) and Add Japam (`app/(tabs)/manual.tsx`) — which have
no session/loop concept — are untouched; they keep using the original date-based
`makeCompletionId` fallback via `appendCompletion`'s default behavior.

## Collision-freedom proof (summary)

`sessionId` (`timer-${Date.now()}-${8 random base36 chars}`, ~41 bits of entropy) is
unique-in-practice per timer run, already relied upon elsewhere in the app for
JS/native session matching. `loopNumber` is a monotonic counter, never reused within a
session. The composite `(userId, sessionId, loopNumber)` is therefore unique per real
completion — the only case where two `saveSession()` calls produce an identical id is when
both refer to the same real loop, which is exactly the intended collapsing behavior.

Verified: guest→Google migration re-tags only `userId` (`app/(tabs)/index.tsx`'s
`migrateGuestHistoryToGoogle`), never touches `completionId` — unaffected by this change.
Edit/delete (`planHistoryDayAdjustment`, `markSynced`) never regenerate or parse
`completionId` — unaffected. No code anywhere splits/parses the id's internal structure.

## Validation

- Unit tests: `lib/__tests__/historyStore.test.ts` — new tests directly reproduce the
  restart-duplicate scenario against the real, patched `appendCompletion`/
  `makeLoopCompletionId`, confirming collapse to one record with the true completion date
  preserved; plus tests confirming distinct loops, distinct sessions, and the unaffected
  date-based fallback all remain correct.
- On-device (staging): single mala, 2-3 loop sessions, two separate same-day sessions, and
  the full Auto-Repeat matrix (1×2, 2×2, 5×2 — ten total completions across five separate
  sessions) all produced fully distinct `completionId`s with zero collisions, verified both
  on-device and via live server-side query (0 duplicate `completion_id`s).
  Timer/History/Groups dashboards matched exactly at every checkpoint (26/2808, then
  17/1836 after the full matrix).
- Edit and delete re-validated end-to-end (partial edit 17→5, then full delete to 0),
  confirmed consistent across Timer, History, and Groups including the day streak
  correctly dropping to 0.
- Offline sync re-validated: offline completion saved `pending` with the deterministic id,
  synced successfully on reconnect, confirmed server-side.
- `npx tsc --noEmit`: clean. `npm test`: all new and existing tests passing (same one
  pre-existing, unrelated failure as the session baseline).

## Not fixed by this change (remediation is separate)

This fix only prevents **new** duplicates going forward. It does not retroactively detect
or repair duplicate records already written to a device's local storage before the
upgrade — those records have old-style, date-based ids with no shared session/loop
metadata, so there is no safe way to algorithmically identify and collapse them without
risking deletion of a legitimate record. Affected existing users need manual, per-case
correction using the app's existing Edit feature, identified via read-only diagnostic
queries (e.g., an implausible day-streak relative to account age) — not an automated bulk
fix.

## Risks

Two files changed with a narrow, well-tested surface: one new pure function, one new guard
clause in an existing function, one call-site change. No native/Kotlin, DB/RLS, or
History/Groups UI changes. No change to force-kill/wall-clock restore semantics.

## Rollback plan

Not yet committed. To discard: `git checkout -- lib/historyStore.ts contexts/timer-context.tsx lib/__tests__/historyStore.test.ts`
on this branch. If already merged, a clean single-purpose `git revert` with no
schema/data dependencies.
