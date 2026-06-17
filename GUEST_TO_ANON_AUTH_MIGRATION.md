# Guest Mode → Supabase Anonymous Auth Migration Plan

Status: **Approved for implementation planning.** No app/runtime code, database, or Supabase settings have been changed as part of producing this document.

## 1. Decision Record (read this first)

**Approved: Option B — anonymous users remain local-only until Google linking.**

- "Continue as Guest" creates a **real Supabase anonymous user** (`supabase.auth.signInAnonymously()`), with a real `auth.uid()`.
- Anonymous guest **tap/timer/today-total history sync to Supabase remains suppressed** until the user links a Google identity.
- **Reason**: the app currently tells guests "Guest history is stored only on this phone." Syncing anonymous users immediately would silently break that promise, even though it wouldn't be visible in the UI. We preserve the existing promise now and treat "sync anonymous users immediately" (Option A) as a **separate, future, user-visible product change** — not something to bundle into this migration.
- Manual Entry: works for anonymous users (this is achieved for free — see Section 7) but **stores local-only until linking**, consistent with the rest of guest history. This is a deliberate decision to keep all guest data — tap/timer/manual — under one consistent rule rather than special-casing manual entry to sync while everything else stays local.
- Option A (sync anonymous users immediately) may be revisited later, but only as its own scoped change: update the in-app guest-mode copy first (so the promise being made matches reality), then remove the suppression gates described below.

## 2. Current Architecture

### Current guest flow
- Guest = `userName` set in AsyncStorage, no `userId`. No Supabase user exists for a guest today.
- Entry: "Continue as Guest" → name modal → `handleSaveGuestName()` (`app/(tabs)/index.tsx:1229-1240`) → `AsyncStorage.setItem(USER_NAME_KEY, name)`.
- Guest history is local-only; `lib/historyStore.ts` forces `syncStatus: 'synced'` for null-`userId` records (lines 83-139) — meaning "nothing to upload," not "already uploaded."
- Exit: `clearGuestData()` (`app/(tabs)/settings.tsx:184-206`) clears `userName`; history stays on device.

### Current Google sign-in flow
- Native (Android): `GoogleSignin.signIn()` → idToken → currently calls `supabase.auth.signInWithIdToken(...)` (`index.tsx:1268`) but discards the resulting session. Extracts Google's raw numeric `id` and stores it as `USER_ID_KEY`.
- Web: `expo-auth-session` → Google `access_token` → fetches `userinfo/v2/me` directly → same pattern.
- Guest→Google today: `migrateGuestHistoryToGoogle()` (`index.tsx:1242-1252`) rewrites local history rows' `userId: null` → `userId: googleId`.

### Current `user_id` usage
- Column type: `text`, storing Google's raw numeric account ID — not a Supabase auth UUID.
- Used in PostgREST query params (`user_id=eq.<id>`) across `index.tsx`, `tap-japam.tsx`, `timer.tsx`, `manual.tsx`, `history.tsx`, `settings.tsx`, and read in `contexts/timer-context.tsx`.
- `completionId` is `${userId || 'guest'}:${timestamp}` (`lib/historyStore.ts:71-75`).

### 2.1 Scope Correction — Auth Logic Is Duplicated Across Three Screens (discovered during Phase 2 planning)

Earlier sections of this document (and the original Change Impact Report) scoped Google Sign-In and Guest Mode changes to `index.tsx` alone. **That scope was incomplete.** A full inventory across the codebase found that the entire sign-in/guest implementation is **independently duplicated three times**, not shared via import:

```
handleNativeGoogleSignIn:        index.tsx:1254   tap-japam.tsx:1246   timer.tsx:320
handleGoogleLogin (web):         index.tsx:1335   tap-japam.tsx:1308   timer.tsx:378
handleSaveGuestName:             index.tsx:1229   tap-japam.tsx:1234   timer.tsx:146
migrateGuestHistoryToGoogle:     index.tsx:1242   tap-japam.tsx:1224   timer.tsx:136
```

Every one of these four functions exists as **three separate, independently-written copies** — one in the main tab screen (`index.tsx`), one in the dedicated Tap Japam screen (`tap-japam.tsx`), and one in the dedicated Timer Japam screen (`timer.tsx`). None of the three import from a shared module. This means **every Phase 2 code change to Google Sign-In or Guest Mode entry must be applied three times**, once per file, not once.

Additional scope findings:
- `contexts/timer-context.tsx` does **not** duplicate the sign-in handlers themselves, but maintains its own parallel guest-tracking state (`isGuestRef.current = !uid && !!guestName`) and its own `userId` convention — it defaults `userId` to an **empty string** (`useState('')`) rather than `null`/`undefined` as every other file does. This is a pre-existing inconsistency that any new `isAnonymous` logic must account for explicitly, not inherit blindly.
- `settings.tsx`, `manual.tsx`, and `history.tsx` do not duplicate the sign-in handlers, but each has its own independent `userId`-gated Supabase sync call site (see Section 4).
- A **fifth Supabase table**, `japam_user_totals`, was found in active use (`index.tsx:608`, `tap-japam.tsx:686`, `settings.tsx:146`) and was missing from this document's Database Plan (Section 5) — it follows the same `text`/`userId`-gated pattern as the other four tables and is now added there.

This correction changes the Phase 2 implementation estimate, file-impact table, risk assessment, and testing plan throughout the rest of this document (see Sections 4, 5, 8, and 9 below).

### Current Supabase usage
- `lib/supabase.ts` initializes `createClient()` with the anon key; the client's query builder is not used — all reads/writes are manual `fetch()` calls with the anon key as both `apikey` and `Authorization: Bearer`.
- RLS is enabled but permissive: `to anon using (true)` (see `db/deleted_completions_migration.sql`). No `auth.uid()` check exists today.

### The exact mechanism behind today's "guest = local-only" rule
This is the rule the migration must preserve. It is implemented as `Boolean(userId)` checks in several places, not as a single flag:
- `lib/historyStore.ts:136` — `syncStatus: completion.userId ? 'pending' : 'synced'`
- `lib/historyStore.ts:202` — `getPending` filters `Boolean(r.userId)`
- `app/(tabs)/index.tsx:1565` — `saveSession()`: `if (!userId) return;` before the Supabase POST
- Equivalent gates for timer-state sync (`index.tsx:939-963`) and today-total sync (`index.tsx:683-720, 1180-1210`)
- `app/(tabs)/manual.tsx:166` — `if (!userId) { Alert(...); return; }` (hard-blocks guests entirely today, rather than allowing local-only manual entries)

**Critical consequence for this migration**: once anonymous users have a real `userId` (the anonymous UUID), every one of the `Boolean(userId)` checks above will stop meaning "guest" and start meaning "any authenticated user, anonymous or not." Under the approved Option B decision, each of these needs an explicit "and not anonymous" condition added — they do not become safe automatically just by virtue of being `userId`-based.

## 3. Target Architecture (Option B)

### Anonymous Auth flow
- "Continue as Guest" → `supabase.auth.signInAnonymously()`. The resulting `session.user.id` (UUID) becomes the app's `userId` going forward.
- A new local flag — **`isAnonymous`** — is introduced and stored alongside the existing identity keys (e.g., a new `IS_ANONYMOUS_KEY` in AsyncStorage, following the same pattern as `USER_ID_KEY`/`USER_NAME_KEY`). This flag is what now distinguishes "guest" from "signed-in" for every place that used to check `!userId`.

### Google upgrade/link flow
- While an anonymous session is active, native Google Sign-In's idToken is passed to `supabase.auth.linkIdentity({ provider: 'google', token: idToken })` instead of `signInWithIdToken`. This attaches the Google identity to the existing anonymous user; `auth.uid()` does not change.
- On successful link, `IS_ANONYMOUS_KEY` flips to false/cleared, and the sync-suppression gates (Section 4) stop suppressing — history that was local-only as a guest now syncs going forward, same as today's Google-signed-in behavior.
- Direct Google sign-in with **no** prior anonymous session (a brand-new user skipping guest mode entirely) is unaffected — that path keeps using the existing sign-in mechanism unchanged.

### `auth.uid()` ownership model
- One UUID per session lifecycle, created at anonymous sign-in, preserved through Google linking. Rows created while anonymous remain valid and owned by the same ID after upgrade.

### RLS ownership model
- **Unchanged in this migration.** RLS stays anon-key-based (`to anon using(true)`) for now — no database or Supabase settings changes are part of this plan. Moving RLS to `auth.uid() = user_id` is a separate, later phase (tracked, not scheduled here).

## 4. Sync-Suppression Design (the core of Option B)

This section is the operative spec for "what must not change."

| Call site | Current gate | Required gate under Option B |
|---|---|---|
| `index.tsx:1565` `saveSession()` (tap/timer history) | `if (!userId) return;` | `if (!userId \|\| isAnonymous) return;` |
| `tap-japam.tsx:1523` `saveTodaySession()` (tap/timer history, duplicate of the above in the Tap Japam screen) | `if (!userId) return;` | same `isAnonymous` addition, applied independently in this file |
| `index.tsx:939-963` / `tap-japam.tsx:932-1006` (timer state sync — `saveTimerStateToSupabase`, `fetchTimerStateFromSupabase`) | equivalent `userId`-based skip, duplicated in both files | add `isAnonymous` to the same skip condition, in both files |
| `index.tsx:601-608` / `tap-japam.tsx:679-686` `saveUserTotalToSupabase()` (→ **`japam_user_totals`**, a table not previously listed in Section 5) | `if (!url \|\| !key \|\| !userId) return;` | add `isAnonymous` to the same skip condition, in both files |
| `settings.tsx:135-162` logout sync (→ `japam_timer_state`, `japam_user_totals`) | `if (currentUserId) { ... }` | add `isAnonymous` to the same condition |
| `contexts/timer-context.tsx:1065` pending-sync trigger (`if (uid && !prevUid) void syncPendingHistory();`) | fires whenever `uid` transitions from empty to non-empty | must not fire on the empty-string→anonymous-UUID transition; needs an `isAnonymous`-aware condition, with care taken around this file's pre-existing empty-string `userId` convention (see Section 2.1) |
| `timer.tsx:158-192` `migrateGuestToGoogle()`'s own remote-fetch gate | `if (userId) { ... }` | add `isAnonymous` to the same condition |
| `manual.tsx:166` (manual entry gate, in `onSave`) | `if (!userId) { Alert(...) }` | **Decision: keep as `if (!userId)` only** — anonymous users now pass this gate (since they have a `userId`), which is exactly how "Manual Entry works for anonymous users" is satisfied with no code change to this check. |
| `manual.tsx:266` (call site that invokes `syncManualEntryToSupabase(...)` after local save) | called unconditionally once `onSave`'s gate above is passed | add an `isAnonymous` check here (or at the top of `syncManualEntryToSupabase`) so the call is skipped entirely for anonymous users — the entry still saves locally (line 247, unaffected), only the network POST is suppressed |
| `manual.tsx:46-71` `backfillMissingUserNames()` — a second, separate Supabase write (a `PATCH` against `japam_history` to fill in missing `user_name` values) | called unconditionally at `manual.tsx:126`, **nested inside** `syncManualEntryToSupabase`, immediately after that function's own POST succeeds | **No separate gate needed** — `backfillMissingUserNames` is only reachable through `syncManualEntryToSupabase`'s own success path (line 126 executes only if the line-109 POST returns `response.ok`). Suppressing the call at `manual.tsx:266` (the row above) makes this entire nested path unreachable for anonymous users as a side effect. **This must not be given its own independent `isAnonymous` check** — doing so would be redundant and risks the two checks drifting out of sync later. The single suppression point is the call to `syncManualEntryToSupabase`. |
| `history.tsx:227` `fetchRemoteSessions()` | `if (!url \|\| !key \|\| !userId) return null;` | add `isAnonymous` to the same condition |
| Settings guest-mode UI (`settings.tsx:250-278`) | `!userId && !!userName` | switch to reading `isAnonymous` instead of `!userId`, since guests now have a `userId` |
| Guest-detection on load (`index.tsx:1048-1061`, duplicated in `tap-japam.tsx` and `timer.tsx`) | `savedUserName && !savedUserId` | switch to reading `isAnonymous`, **in all three files independently** |
| `clearGuestData()` (`settings.tsx:184-206`) | clears `USER_NAME_KEY` | also clear `IS_ANONYMOUS_KEY` (and the stored anonymous `USER_ID_KEY`) so "Exit Guest Mode" behaves identically to today |

`migrateGuestHistoryToGoogle()` exists as **three independent copies** (`index.tsx:1242-1252`, `tap-japam.tsx:1224-1231`, `timer.tsx:136-145`) and is **skipped, not deleted**, on the new link-success path in each one, since `auth.uid()` doesn't change and no row rewrite is needed. All three copies remain intact for any fallback/legacy path.

### 4.2 New Shared Helper — the One Justified Exception to "No New Abstractions"

The Google-identity-collision handling described in Section 4.1 must behave identically regardless of which of the three screens (`index.tsx`, `tap-japam.tsx`, `timer.tsx`) the user happens to be on when they link. Copy-pasting this dialog and its error-matching logic a third time risks the three screens drifting in behavior over time (e.g., one screen's copy missing an update the other two received). **A small, new, dialog-only shared helper (exact location TBD — likely `lib/` or `components/`) is recommended specifically for this one piece of logic**, as a narrow, explicit exception to the otherwise-standing "no new abstractions" constraint. Everything else in this migration remains additive, in-place, per-file changes.

### 4.1 Google Identity Collision — Approved Behavior

This is the failure mode where `supabase.auth.linkIdentity({ provider: 'google', token: idToken })` is called from an anonymous session, but the Google account is already linked to a **different**, pre-existing Supabase user. `linkIdentity` returns an error in this case rather than linking or merging anything.

**Approved UX — no merge, no silent failure:**

- On this specific error, show a dialog with:
  - Message: **"This Google account is already linked to another Japam account."**
  - Buttons: **"Sign In"** and **"Cancel"**.
- **"Sign In"**: proceeds with a direct Google sign-in into the *existing* linked account (the normal, unmodified direct-sign-in path already used today for users with no prior anonymous session). This abandons the current device's anonymous session and its local-only history — no merge is attempted.
- **"Cancel"**: dismisses the dialog and returns the user to their current anonymous guest session, unchanged. No identity change, no data loss, no partial state.
- **Explicitly out of scope for this migration**: any merge flow that would combine the anonymous device's local history with the existing linked account's history. If this is wanted later, it is a separate, scoped feature — not part of this migration.
- **Explicitly required**: the error must be caught and handled by name/code (not treated as a generic failure) so it never surfaces as an unhandled exception, a blank failure, or a misleading "something went wrong, try again" message. The user must always land in one of the two defined states above — never a silent no-op or a partially-linked session.

## 5. Database Plan

### Phase 1 Decision: NO-GO on database changes

**No database schema changes are required for the approved Option B architecture.** Phase 1 planning concluded with no SQL run, no schema changed, no RLS changed.

- **`user_id` remains `text` for now**, across `japam_history`, `japam_timer_state`, `user_profiles`, `deleted_completions`, **and `japam_user_totals`** (a fifth table, found during Phase 2 planning — see Section 2.1 — used by `index.tsx:608`, `tap-japam.tsx:686`, and `settings.tsx:146`; missing from this section in earlier drafts of this document). Confirmed from repo files that only `deleted_completions.user_id text` is defined in version control (`db/deleted_completions_migration.sql`); the other four tables have no schema-as-code in the repo and exist only in the live Supabase project — their `text` typing is inferred from consistent app-code usage (string-based `user_id=eq.<id>` queries, Google IDs always handled as strings), not provable from the repo alone. This gap is noted but out of scope to close here.
- **A UUID `auth.uid()` value can be stored as a plain string in the existing `text` `user_id` column** once Google linking writes data — no type change is needed for this to work correctly.
- **Anonymous users remain local-only until linking (per the approved Option B decision)**, so no anonymous-session writes ever reach Supabase in the meantime — this means there is no new write traffic creating schema pressure on these tables today.
- **Do NOT convert `user_id` from `text` to `uuid` now.** Existing Google-signed-in users' rows store Google's raw numeric account ID as a string (e.g. `"108234567890123456789"`), which is **not a valid UUID**. Converting the column type now would immediately break every currently-installed app build's Supabase REST calls for these tables (PostgREST rejects a non-UUID string against a `uuid`-typed column), directly violating the requirement that Google Sign-In must keep working exactly as today.
- **Do NOT add new `auth_user_id uuid` columns now.** This would be safe but currently purposeless — nothing in the plan yet defines how such a column would be populated or used, since a UUID string already fits the existing `user_id text` column with no new column required. Revisit only if a concrete future need defines itself.
- **Do NOT change RLS now.** Existing `to anon using(true)` policies continue to function unchanged, since the app still authenticates REST calls with the anon key, not a session JWT, in this phase.
- **Future RLS, if/when pursued, can use `auth.uid()::text = user_id`** against the existing `text` column — Postgres supports this cast directly in a policy expression, so a future move to identity-based RLS does not require a `uuid` column type change now, and may never require one at all.
- **No data migration needed** — no production guest users exist to preserve (testing-phase app).

## 6. Auth Plan

- **Supabase settings required — Phase 0 COMPLETE:**
  - "Allow anonymous sign-ins" — enabled and **functionally verified** via a disposable one-off Node script calling `supabase.auth.signInAnonymously()` directly against the live project (not just dashboard UI inspection, which initially disagreed with server behavior across several checks before a final dashboard "Save changes" click resolved it). Result: success, real session/JWT issued, returned user had `is_anonymous: true`, test session signed out cleanly afterward.
  - "Allow manual linking" — confirmed ON via dashboard UI.
- **Session handling**: anonymous and linked sessions both use `supabase-js`'s normal session storage/refresh. No additional handling required beyond what the SDK already provides.

### Phase 0 Completion Record

- Anonymous sign-ins: enabled and functionally verified (`signInAnonymously()` succeeded; `user.is_anonymous = true`; session/JWT issued; test session signed out cleanly).
- Manual linking: confirmed ON in Supabase dashboard.
- No app/runtime code changed.
- No database schema changes.
- No RLS changes.
- No deployment.
- **Phase 0 status: COMPLETE.** Phase 1 (database) has not been started.

## 7. Manual Entry — Why It Needs No Code Change to Work for Anonymous Users

Manual Entry's only gate today is `if (!userId)`. Once `signInAnonymously()` gives guests a real `userId`, this check passes naturally — fulfilling "Manual Entry works for anonymous users" as a side effect of the auth change alone, not as a Manual Entry feature change. The one piece of Manual Entry that **does** need a small addition is the upload step inside the save flow (`manual.tsx:109`), which must skip the network POST when `isAnonymous` is true, per the Section 4 decision to keep all guest data local-only until linking.

## 8. File Impact Summary (revised — file count nearly triples from the original estimate)

**Risk assessment headline: duplicated auth logic is the primary migration risk in Phase 2** — not any single complex function, but the fact that the same logic must be changed three times, in three independently-written files, with no shared module to change once. The probability of an inconsistency between screens (one screen handling the anonymous→Google transition correctly, another missing a case) is the dominant risk in this migration, greater than the risk of any individual function's logic being wrong.

| File | Why it changes | Risk | User-visible impact |
|---|---|---|---|
| `app/(tabs)/index.tsx` | New `isAnonymous` flag; `signInAnonymously()` in guest entry; guest-detection branch; `linkIdentity()` branch in `handleNativeGoogleSignIn`/`handleGoogleLogin`; sync-suppression gates (tap/timer/today-total/`japam_user_totals`) | **High** | None, if correct |
| `app/(tabs)/tap-japam.tsx` | **Identical set of changes to `index.tsx`, independently implemented** — its own copies of `handleNativeGoogleSignIn`, `handleGoogleLogin`, `handleSaveGuestName`, `migrateGuestHistoryToGoogle`, plus its own sync-suppression gates | **High** — same profile as `index.tsx`; doubles the chance of a cross-screen inconsistency |
| `app/(tabs)/timer.tsx` | Identical set of changes again, plus its own `migrateGuestToGoogle` variant | **High** — same profile a third time |
| `app/(tabs)/settings.tsx` | Guest-mode UI condition switches to `isAnonymous`; `clearGuestData()` also clears the new flag; logout's `japam_timer_state`/`japam_user_totals` sync gated by `isAnonymous` | Medium | None, if correct |
| `contexts/timer-context.tsx` | `isAnonymous`-aware suppression on the pending-sync trigger; must reconcile this file's pre-existing empty-string `userId` convention (Section 2.1) carefully | Medium — the convention mismatch makes this a closer read than the other gate-only files |
| `app/(tabs)/manual.tsx` | One additional `isAnonymous` check before the upload POST; no change to the entry gate itself | Low | None — entry now succeeds for guests where it used to block them (the one approved visible change) |
| `app/(tabs)/history.tsx` | One additional `isAnonymous` check in `fetchRemoteSessions()` | Low | None, if correct |
| New shared collision-dialog helper (Section 4.2) | New, small, dialog-only — used by all three Google-link branches to avoid a third copy of error-handling logic | Low (new code, but narrow and additive) | The one approved Google-collision UX (Section 4.1), consistent across all three screens |
| `lib/supabase.ts` | No change | None | None |
| `lib/historyStore.ts` | No change — suppression happens at call sites, not in this pure module | None | None |
| Database / RLS / Supabase settings | No change in this migration | None | None |

**Revised file count**: 7 files modified (`index.tsx`, `tap-japam.tsx`, `timer.tsx`, `settings.tsx`, `timer-context.tsx`, `manual.tsx`, `history.tsx`) + 1 new small shared helper file, versus the original estimate of 3 modified files (`index.tsx`, `settings.tsx`, `manual.tsx`) + 0 new files. **Change impact is roughly 3x the original estimate for the Google Sign-In/Guest Mode logic specifically** (3 independent implementations of the same 4 functions), while the simpler gate-only files (`manual.tsx`, `history.tsx`, `settings.tsx`) remain low-risk and roughly as originally scoped.

## 9. Testing Plan

### New requirement, discovered during Phase 2 planning: test on all three entry screens

Because Google Sign-In and Guest Mode entry are independently implemented three times (`index.tsx` / main tab, `tap-japam.tsx` / Tap Japam, `timer.tsx` / Timer Japam — see Section 2.1), **every test case below involving guest entry, Google linking, or sync-suppression must be executed once per screen, not once total.** Passing on one screen is not evidence the other two are correct — they are separate code, not shared code.

- Guest entry creates a real anonymous Supabase user (`auth.users`, `is_anonymous: true`); guest UX is pixel-identical to today, including offline guest entry. **Run from: main tab, Tap Japam, Timer Japam.**
- Settings screen still shows "Guest Mode" correctly for an anonymous session, regardless of which screen the anonymous session was created from.
- Guest tap/timer/manual completions do **not** appear in the Supabase `japam_history` table while anonymous (query directly to confirm) — this is the single most important regression check for Option B. **Run from: main tab, Tap Japam, Timer Japam.**
- Linking Google from a guest session preserves `auth.uid()` (no new row; same `id`, now with a Google identity attached); previously local-only history becomes eligible to sync going forward. **Run from: main tab, Tap Japam, Timer Japam.**
- Direct Google sign-in with no prior guest session is byte-for-byte identical to today's behavior. **Run from: main tab, Tap Japam, Timer Japam.**

### New test case: cross-screen linking scenario

- Start an anonymous guest session from one screen (e.g., the main tab). Navigate to a different screen (e.g., Tap Japam) **without restarting the app**, and complete the Google-link flow from that second screen. Confirm:
  - All three screens observe the same resulting state afterward (none of them still believes the session is anonymous).
  - History/timer state recorded before the link (from any screen) is preserved and becomes sync-eligible after the link, regardless of which screen recorded it or which screen performed the link.
  - No screen-specific stale `isAnonymous`/`userId` cache causes one screen to behave inconsistently with the other two after returning to it.
- This test exists specifically because the three screens do not share state through a common auth module — it is the most direct test of the primary risk identified in Section 8.

### Additional required test cases

- **App restart**: force-close and reopen the app while an anonymous guest session is active; confirm the same `userId`/`isAnonymous` state is restored (not re-prompted for a name, not silently upgraded), and local history is intact.
- **App reinstall**: uninstall and reinstall the app while an anonymous guest session exists; confirm a *new* anonymous user/session is created (expected behavior under Option B — prior local-only data is unrecoverable, same as today's guest mode) and the app does not error or get stuck in a broken state.
- **Identity collision**: from an anonymous session, link a Google account that is already linked to a different existing Supabase user; confirm the exact dialog from Section 4.1 appears ("This Google account is already linked to another Japam account." / Sign In / Cancel), confirm "Cancel" returns to the unchanged anonymous session, and confirm "Sign In" completes a normal direct sign-in into the existing account with no merge attempted and no unhandled error.
- **Logout**: from a Google-linked (post-link) session, exercise the existing sign-out flow in `settings.tsx`; confirm behavior is unchanged from today (the current flow clears identity keys but does not call `supabase.auth.signOut()` and does not clear local history) — verify this remains true and isn't accidentally altered by the new flag/session-handling code.
- **Tap Japam functional regression**: complete a mala via tap while anonymous; confirm tap counting, completion sound/vibration, and local history entry all behave identically to today, independent of the sync-suppression change.
- **Timer Japam functional regression**: run a full timer session (start/pause/resume/complete) while anonymous; confirm timer behavior, notifications, and completion handling are unaffected by the new auth/session code.
- **History regression**: view the History screen as an anonymous guest with a mix of tap/timer/manual entries; confirm all entries display correctly, in the correct order, with correct counts — independent of the fact that none of them are synced to Supabase.
- **Auto-Repeat Malas regression**: run an auto-repeat sequence while anonymous; confirm looping/repeat behavior, counts, and completion handling are unaffected.
- **Manual Entry local-only verification**: submit a manual entry while anonymous; confirm it appears immediately in local History, confirm (by querying Supabase directly) that neither the `syncManualEntryToSupabase` POST nor the `backfillMissingUserNames` PATCH occurs while anonymous, and confirm the same entry *does* sync after the session is later linked to Google.

Tap Japam, Timer Japam, Auto-Repeat Malas, History UI, notifications, Bhagavad Gita features, and app navigation are expected to be unaffected since none of their files are touched — but per this update, that expectation is now backed by explicit functional test cases above, not just file-touch inference.

## 10. Rollback Plan

- Each gate above is a small, additive, single-condition change — reverting any one is a one-line/one-function revert.
- No database or Supabase settings are touched in this migration, so there is nothing to roll back at that layer.
- If the migration is aborted mid-way, no production guest data exists to be lost or orphaned (testing-phase status).

## 11. Revisiting Option A (future, separate decision — not part of this migration)

Option A (sync anonymous users immediately) remains the architecturally simpler long-term default and is friendlier to future Family Groups / Multiple Japams features. It should only be adopted later, as its own explicit, scoped, user-visible change:
1. Update the in-app guest-mode messaging first (the current "stored only on this phone" copy must change before behavior does).
2. Then remove the sync-suppression gates added in this migration (Section 4) — at that point the change is a net simplification (deletion), not an addition.
Do not bundle this into the current migration.

## 12. Final Status

- Option B is the approved decision for this migration.
- **Phase 0 (Supabase Auth settings): COMPLETE.** Anonymous sign-ins and manual linking are both enabled, with anonymous sign-ins functionally verified end-to-end (see Section 6). Manual linking confirmed ON via dashboard UI.
- **Phase 1 (database): COMPLETE — decision is NO-GO on schema/RLS changes.** No SQL was run, no schema was changed, no RLS was changed. `user_id` remains `text` across all four tables; this is sufficient for Option B and does not block a future identity-based RLS migration (see Section 5).
- **No app/runtime code has been changed.** No deployment has occurred.
- **Phase 2 (app-code auth core) scope has been revised upward.** Original planning scoped this to `index.tsx` plus two low-risk files. Verified inventory found Google Sign-In and Guest Mode entry independently duplicated three times (`index.tsx`, `tap-japam.tsx`, `timer.tsx` — Section 2.1), a fifth affected table (`japam_user_totals` — Section 5), and additional gate-only changes needed in `contexts/timer-context.tsx` and `history.tsx`. Revised scope: **7 files modified + 1 new small shared helper**, versus the original 3 files. See Sections 4, 5, 8, and 9 for the full revised plan.
- Next recommended phase: **Phase 2 — app-code auth core, per the revised scope above** (wire `signInAnonymously()` into guest entry **in all three screen files**, introduce the `isAnonymous` flag, branch all three `handleNativeGoogleSignIn()`/`handleGoogleLogin()` copies to call `linkIdentity()` when an anonymous session is active, and add the one new shared collision-dialog helper per Section 4.2). This requires separate explicit authorization before any runtime code is written.
