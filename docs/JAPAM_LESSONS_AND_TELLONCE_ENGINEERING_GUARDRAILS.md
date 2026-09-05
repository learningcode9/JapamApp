# Japam App Postmortem & Engineering Guardrails for TellOnce

**Purpose:** Preserve the mistakes, incidents, root causes, fixes, and release lessons from the Japam App so the TellOnce / Household Action Inbox project does not repeat them.

**Status:** Living engineering document. Read before every new slice, PR, migration, OTA, native build, or production release.

**Scope:** This document combines confirmed Japam App incidents, recurring failure patterns, release/process mistakes, and the engineering guardrails we will apply to TellOnce.

---

# 1. Why we are doing this

The Japam App taught us that most serious bugs did not come from one bad line of code. They came from a few recurring patterns:

- multiple sources of truth;
- race conditions between lifecycle events;
- local state and server state disagreeing;
- identity changing underneath persisted data;
- release source drifting away from Git `main`;
- OTA/native/runtime assumptions not being verified;
- environment variables or signing identity differing between builds;
- UI changes not being tested on narrow real devices;
- business rules changing after implementation;
- async loads being allowed to overwrite newer state;
- fixes being tested only in the happy path;
- agents working from the wrong branch/worktree or carrying unrelated changes.

TellOnce should be built with these lessons as engineering constraints, not just as historical notes.

---

# 2. Prevention plan before we continue TellOnce

## Phase A — Freeze the current TellOnce checkpoint

Before the next functional slice:

1. Keep the current TellOnce UI commit as a stable checkpoint.
2. Do not mix the next feature with UI cleanup, dependency upgrades, or release tooling.
3. Start each new slice from a clean branch/worktree.
4. Record the exact base SHA before changing anything.

## Phase B — Put these lessons in the repository

This file should live in TellOnce as:

`docs/JAPAM_LESSONS_AND_ENGINEERING_GUARDRAILS.md`

Every coding agent should be told to read it before modifying architecture, persistence, auth, background behavior, releases, or backend schema.

## Phase C — Convert lessons into hard guardrails

The rules in Sections 13–16 are not suggestions. They should be checked in every PR/release.

## Phase D — Keep it alive

Whenever TellOnce has a meaningful bug or incident, add:

- symptom;
- impact;
- root cause;
- why existing tests missed it;
- exact fix;
- prevention rule;
- regression test added.

---

# 3. Git, branch, and release-lineage mistakes

## 3.1 Production source drifted away from `main`

### What happened
At one point the production OTA lineage and web `main` lineage had diverged badly. The OTA source was not an ancestor of `main`; each side contained many commits the other did not.

This meant:

- production behavior could not be inferred from `main`;
- a new PR against `main` could accidentally omit production fixes;
- diffs became huge and misleading;
- "what is production?" required forensic reconstruction.

### Root cause
Production changes were shipped from sidebar/release branches without immediately reconciling the canonical branch and release metadata.

### Fix
Production baseline/manifest/release documentation was added, and release candidates were later built from explicitly verified source SHAs.

### TellOnce rule
**There must always be one answer to "what source is production?"**

For every release record:

- source commit SHA;
- branch;
- native version/build number;
- runtime version;
- environment;
- backend project;
- release/update ID;
- deployment timestamp.

Never publish from an untracked local branch without reconciling it back into the canonical lineage.

---

## 3.2 Working on the wrong branch/worktree

### What happened
Across Japam development, work repeatedly accumulated in unrelated branches, temporary worktrees, stashes, and forensic branches. This made it easy to:

- patch the wrong codebase;
- accidentally include unrelated files;
- reason about the wrong production baseline;
- lose confidence in whether a fix was isolated.

### TellOnce rule
Before every edit, an agent must verify:

```text
pwd
git rev-parse --show-toplevel
git branch --show-current
git rev-parse HEAD
git status --short
```

Do not auto-stash, reset, switch branches, or merge without explicit approval.

Use a dedicated worktree for risky or isolated changes.

---

## 3.3 Large/mixed fixes were difficult to validate and revert

### What happened
Some Japam investigations produced broad refactors or large WIP diffs when the user wanted one narrow bug fix.

### Why this was risky
A large change:

- hides the true root cause;
- increases regression surface;
- makes rollback harder;
- makes staged validation ambiguous.

### TellOnce rule
Prefer the **smallest architectural fix** that resolves the proven cause.

One PR should have one primary purpose.

---

# 4. OTA, runtime, environment, and deployment mistakes

## 4.1 Broken OTA because environment variables were missing

### What happened
A staging OTA was published from a clean worktree without the required Expo public environment values. The embedded APK worked, but the OTA Hermes bundle crashed with:

`supabaseUrl is required`

The broken OTA became the newest update until it was replaced.

### Root cause
The build and OTA processes did not use the same environment-injection path. A clean worktree did not contain the expected `.env`, and the release process assumed it would.

### Fix
Release commands were changed to explicitly use the intended EAS environment / environment injection path, and exports were inspected before publishing.

### TellOnce rule
Never publish an OTA/build until the exported bundle is verified to contain the expected environment identity.

Preflight must verify:

- backend URL/project;
- app/project ID;
- channel/branch;
- runtime;
- package ID;
- no production endpoint in staging;
- no staging endpoint in production.

Environment is part of the release artifact, not a developer-machine assumption.

---

## 4.2 OTA channel / branch / runtime confusion

### What happened
Updates sometimes appeared "missing" because the installed binary's baked channel/runtime did not match the update that had been published.

Later, an Android update banner based on versionCode could not cover all production users because production binaries were split across different runtime versions.

### Root cause
OTA eligibility was treated as "published = available to everyone," but Expo updates are constrained by native build channel/runtime compatibility.

### TellOnce rule
Maintain an explicit **OTA eligibility matrix**:

| Native build | Version code | Runtime | Channel | Eligible update branch |
|---|---:|---|---|---|

Before publishing, list exactly which installed builds will receive the update.

Never design a critical communication banner that can reach only one runtime unless that limitation is intentional.

---

## 4.3 Native-required work was mixed with OTA thinking

### What happened
Japam had changes where most code was JavaScript/TypeScript but one timer durability change touched Kotlin/native service files. That single native change meant a Play build was required even if the rest looked OTA-compatible.

### TellOnce rule
Classify every release before execution:

- JS-only / OTA-safe;
- database-only;
- web-only;
- native build required;
- mixed.

If any native module, manifest, permission, Gradle, Kotlin/Java, config-plugin, or native dependency linkage changes, do not assume OTA is enough.

---

## 4.4 Immediate update reloads created startup risk

### What happened
A safer pattern was eventually adopted: fetch an update, but let it apply on the next cold launch instead of forcing an immediate reload during startup/lifecycle work.

### TellOnce rule
Avoid surprise mid-session reloads for non-emergency updates. Prefer controlled next-launch application unless product requirements demand otherwise.

---

## 4.5 Staging and production environment identity were too easy to confuse

### What happened
Japam repeatedly had to verify whether an artifact pointed at staging or production Supabase, whether Vercel preview had the correct environment, and whether an OTA came from the intended environment.

### TellOnce rule
Staging and production must be impossible to confuse.

Use:

- separate backend projects;
- explicit environment names;
- export/build scans;
- visible non-production marker in staging;
- release manifest;
- no implicit fallback from staging config to production config.

---

# 5. Timer, lifecycle, background, and process-restart mistakes

These incidents are particularly important even though TellOnce is not a Japam timer app. TellOnce will still have lifecycle-sensitive operations: capture, upload, draft generation, reminders, guest handoffs, and offline persistence.

## 5.1 Duplicate global `TimerProvider` mounts

### What happened
`TimerProvider` existed in more than one Expo Router layout. Multiple provider instances created multiple AppState listeners and competing persistence writes.

Symptoms included:

- timer reset;
- selected duration corruption;
- duplicate lifecycle behavior.

### Root cause
A global, long-lived provider was mounted inside a layout that could be instantiated more than once.

### Fix
Mount the provider exactly once at the true app root.

### TellOnce rule
Global providers/services must have **one owner and one mount**.

For each global service document:

- where it mounts;
- why it is global;
- how duplicate registration is prevented;
- how listeners are cleaned up.

---

## 5.2 Final-loop save race

### What happened
Timer completion around the final loop had save timing problems, requiring guards to prevent missing or repeated completion persistence.

### TellOnce lesson
Any workflow whose final state triggers persistence must be **idempotent**.

For TellOnce, this directly applies to:

`Draft -> Confirmed Active Actions`

Confirm must be safe if:

- button is tapped twice;
- network retry happens;
- app restarts after server success but before local acknowledgement;
- two events fire close together.

---

## 5.3 Duplicate completion records after process restart

### What happened
Japam originally relied on in-memory duplicate guards. A process restart reset those guards. The same real timer completion could then be saved again with a new timestamp-based ID.

### Root cause
Idempotency lived only in memory, and the record identity was derived from save time rather than the underlying event identity.

### Fix
Use deterministic completion IDs based on stable session + loop identity and reject duplicate IDs.

### TellOnce rule
**Never use "current timestamp" as the only idempotency identity for important writes.**

Use deterministic idempotency keys for:

- capture ingestion;
- draft generation request;
- confirm operation;
- handoff send;
- completion acknowledgement;
- reminder creation.

---

## 5.4 Stale completed session after reopening

### What happened
The native Android service had logically completed the timer but remained alive for several seconds while the completion sound played. JS interpreted `native.isRunning` as "timer is still active" and skipped cleanup, leaving a stale countdown snapshot.

### Root cause
One boolean represented two different meanings:

- service process is alive;
- logical timer session is active.

### TellOnce lesson
Do not overload state flags.

Prefer explicit state machines such as:

```text
idle
capturing
uploading
processing
draft_ready
confirming
confirmed
handoff_pending
completed
failed
```

A process being alive is not the same as a business operation being active.

---

## 5.5 Native/JS handoff race during background completion

### What happened
A production timer issue appeared while the phone slept: Om played but loop accounting could lag/skip. The production line lacked native handoff state (`isCompleting`) and a resume wait that had existed in a known-good beta path.

### Root cause
Two clocks/state machines (native service and JS) reconciled before the native side had finished its transition.

### TellOnce lesson
When two systems own part of one workflow, define an explicit handoff contract.

Examples:

- local upload worker vs JS UI;
- push notification vs foreground state;
- backend draft generation vs local draft display.

Never infer "done" from timing alone.

---

## 5.6 Cold-start restore behavior was not specified early enough

### What happened
Force-close/reopen behavior required explicit fixes so an expired timer did not auto-resume or auto-complete incorrectly.

### TellOnce rule
For every persisted workflow, define cold-start behavior before implementation.

For each state answer:

- What happens after OS kill?
- What happens after force-close?
- What happens offline?
- What happens if server completed the request while app was closed?
- Which source is authoritative?

---

## 5.7 Duration/state restoration regressions

### What happened
Japam had regressions where timer duration/state could restore incorrectly (including a 10-minute to 5-minute type regression).

### TellOnce lesson
Persisted state schemas must be versioned and tested across restart.

Do not silently reuse a generic storage key for semantically different state.

---

# 6. Product-semantic mistakes

## 6.1 Count mode accidentally became Mala mode

### What happened
Custom/Set Count values such as 108 could be converted into malas because code inferred malas from a numerical multiple of 108.

But the real product rule was semantic:

- Mala mode 108 => 1 mala;
- Set Count 108 => 108 count and **0 malas**.

### Root cause
Business meaning was inferred from numeric value rather than explicit mode.

### Fix
Separate explicit earned malas from internal completion counters and remove `floor(total/108)` style conversion from count-only flows.

### TellOnce rule
Never derive semantic type from a coincidental value.

For TellOnce:

- `event` is not an action type;
- a deadline date does not automatically make an item an event;
- a payment amount does not automatically mean the action is "pay" unless the source supports it;
- one bundle can contain multiple action types;
- exactly one accountable owner per action.

Encode these distinctions explicitly in the domain model.

---

## 6.2 Business rules changed repeatedly during email-campaign work

### What happened
The `15day_inspiration` eligibility rule changed multiple times before the final definition:

Final rule:
- at least one genuine Japam activity in the rolling last 15 days;
- account age is not the deciding criterion;
- one valid Mala/Tap/Timer/Count activity is enough;
- skip if no recent activity;
- preserve suppression/unsubscribe/idempotency safeguards.

### Lesson
Implementation started while policy was still moving.

### TellOnce rule
Before coding automation, freeze:

1. eligibility;
2. trigger;
3. exclusions;
4. idempotency;
5. retry behavior;
6. opt-out/privacy behavior.

Write examples of included and excluded cases first.

---

# 7. Identity, authentication, and profile mistakes

## 7.1 Google numeric identity vs Supabase UUID

### What happened
Legacy local records could be keyed with Google subject IDs while the authenticated backend identity was a Supabase UUID. After identity repair, pending local records keyed to the old ID could become invisible to sync/scoping filters.

### Root cause
One person had multiple identity keys across time and storage layers.

### Fix direction
Migrate scoped storage keys and record ownership together when canonical identity changes.

### TellOnce rule
Use one canonical user ID everywhere: backend-auth UUID.

Provider IDs/emails are attributes, not primary data ownership keys.

---

## 7.2 Web Google sign-in callback did not persist session reliably

### What happened
The web callback could discard the session returned directly by sign-in and immediately call `getSession()`, resulting in a signed-out state and missing local identity keys after refresh.

### TellOnce rule
Authentication transitions must be transactional:

1. receive provider result;
2. establish backend session;
3. persist canonical identity;
4. migrate local guest data if needed;
5. emit one auth-state transition;
6. only then expose signed-in UI.

Test refresh/restart, not only initial sign-in.

---

## 7.3 Logout did not fully clear all auth state

### What happened
Japam needed a dedicated fix to clear both Supabase and Google state consistently.

### TellOnce rule
Define one shared logout function. Do not let each screen implement its own partial logout.

Logout must explicitly define what happens to:

- auth tokens;
- cached profile;
- local drafts;
- household selection;
- offline pending writes;
- guest state.

---

## 7.4 Duplicate OAuth responses / nonce races

### What happened
Web auth required idempotency around duplicate AuthSession responses and nonce-readiness gating.

### TellOnce lesson
Auth callbacks are events and can repeat. Make them idempotent.

---

## 7.5 Debug-signed Android build failed Google OAuth

### What happened
A staging APK built with a debug signature could reach the Google account flow but failed the intended OAuth path because signing identity did not match the registered Android OAuth certificate. An EAS-signed staging APK worked.

### TellOnce rule
Authentication validation must use signing identity equivalent to the intended distribution artifact.

Do not declare Google Sign-In broken from a debug-signed artifact if production/staging OAuth is certificate-bound.

---

## 7.6 Display name changed unexpectedly

### What happened
Different code paths used different metadata precedence, producing names such as `learn`, `learn code`, or stale group snapshots.

### Root cause
No single canonical display-name policy.

### Fix
Centralize precedence and preserve durable authenticated identity.

### TellOnce rule
One canonical profile resolver only.

UI surfaces must not invent their own fallback order.

---

## 7.7 Groups stored a stale join-time name snapshot

### What happened
A group member's displayed name could remain stale because `group_members.user_name` was a write-once snapshot.

A client-side sync approach was attempted, but the permanent fix moved name resolution to the server where live provider metadata was already available.

### TellOnce lesson
When the server already owns the source of truth, prefer deterministic server-side reads over client-maintained cache synchronization.

This is especially relevant for:

- household member names;
- guest status;
- handoff state;
- completion state.

---

# 8. Data integrity, scoping, and synchronization mistakes

## 8.1 `japamId = null` records

### What happened
Timer/Tap completions could be saved before the selected Japam/workspace identity was fully resolved.

### Root cause
Persistence was allowed before required ownership context existed.

### TellOnce rule
No durable action write without required ownership scope.

For active actions, require:

- household ID;
- action ID;
- owner;
- source capture/bundle lineage;
- status.

Fail closed if mandatory scope is missing.

---

## 8.2 Cross-Japam scoping and ownership bugs

### What happened
Timer state, History, stats, and Groups needed repeated fixes to ensure data belonged to the selected Japam and did not leak across workspaces.

### TellOnce rule
Every query/storage key must be scoped explicitly.

Never rely on "currently selected household" as an implicit global when writing data.

Write APIs should take the household/action IDs they mutate.

---

## 8.3 Home totals became stale or were overwritten

### What happened
Home could show stale totals while History had the correct authoritative data. Opening History could then cause numbers elsewhere to update.

### Root cause
Multiple caches/reconciliation paths could overwrite newer same-day truth with stale remote/local state.

### TellOnce rule
For every derived UI value, document the authority hierarchy.

Example:

```text
confirmed local mutation
    > server acknowledged state
    > cached snapshot
    > placeholder
```

Older async responses must never overwrite a newer state version.

---

## 8.4 Stale remote reconciliation could cause data loss

### What happened
History reconciliation needed guards so an older or incomplete server fetch did not wipe/replace valid local information.

### TellOnce rule
Offline-first merge must be monotonic wherever possible.

A failed/incomplete remote read is not evidence that local data should be deleted.

---

## 8.5 Tombstones were not consistently authoritative

### What happened
Deleted History/archived data could reappear or still influence Groups totals when different readers did not apply deletion tombstones consistently.

### Fix direction
Make deletion authority explicit and fail closed when deletion state cannot be verified.

### TellOnce rule
Deletion/revocation must have one authoritative representation.

If guest handoff is revoked, no cache or stale link should silently reactivate it.

---

## 8.6 Legacy blank/null attribution

### What happened
Old History rows without `japam_id`, or with ambiguous names, required careful backfill logic. Aggressive automatic assignment risked attributing records to the wrong workspace.

### TellOnce rule
Migration must distinguish:

- unambiguous;
- ambiguous;
- unknown.

Never "best guess" ownership for irreversible data migration.

---

## 8.7 Duplicate default workspace creation

### What happened
Two independent code paths could both decide "no default Japam exists" and create one concurrently. Multi-client behavior made the problem worse.

### Root cause
Check-then-create was distributed across callers with no shared critical section/server uniqueness.

### Fix
Route all automatic creation through a shared coordinator and add stronger cross-client prevention.

### TellOnce rule
Household/bootstrap creation must be idempotent and server-constrained.

Do not let multiple screens independently create the same default entity.

---

## 8.8 Restore/archive/permanent-delete behavior required many safety fixes

### What happened
Japam restoration, archiving, permanent deletion, canonical selection, and hidden archived rows required repeated hardening.

### Lesson
Lifecycle states were introduced incrementally without one complete state-transition contract.

### TellOnce rule
Define entity lifecycle up front.

Example action lifecycle:

```text
draft
confirmed
in_progress
waiting
completed
cancelled
```

Define allowed transitions and what each transition means for:

- UI visibility;
- reminders;
- handoffs;
- analytics;
- deletion.

---

## 8.9 Offline pending records could become invisible after identity repair

### What happened
Sync filtered records by current user ID. If local pending data still contained the old identity, the data existed but the sync engine no longer selected it.

### TellOnce rule
Identity migration and scoped-data migration must be one operation.

Add a regression test: "pending data created before identity change still syncs after identity change."

---

# 9. Groups / async-loading mistakes

## 9.1 Deleted records could still affect Groups totals

### What happened
Groups dashboard server aggregation needed tombstone-aware logic so deleted History did not remain counted.

### TellOnce rule
Aggregations must use the same deletion/visibility rules as detail screens.

Do not compute dashboards from a different semantic dataset than the underlying list.

---

## 9.2 Stale async response could overwrite a newer dashboard load

### What happened
Groups dashboard needed request-versioning, queued reloads, mounted guards, and abort handling.

### Root cause
Multiple refresh triggers could overlap and resolve out of order.

### TellOnce rule
For screens with network loads:

- assign request version/token;
- discard responses older than current request;
- abort on unmount when possible;
- coalesce burst refreshes;
- never set state after unmount.

This applies to Inbox processing, Today refresh, and guest handoff status.

---

## 9.3 Auth events caused repeated reload/race behavior

### What happened
Japam had auth-driven reload duplication and "shake loop" style problems.

### TellOnce rule
One event should cause one logical refresh.

Use deduplication/coalescing around auth, household, and sync events.

---

## 9.4 Groups workspace isolation leaked across contexts

### What happened
Groups and Japam selection required explicit workspace isolation guards.

### TellOnce rule
Household ID is a first-class scope key in every repository/API operation.

---

# 10. UI and responsive-layout mistakes

## 10.1 Four-column Groups table clipped values on real phones

### What happened
A UI fix initially showed headings but values were clipped/invisible on narrow devices. A horizontal-scroll solution was also rejected because the desired UX was four responsive columns without scrolling.

### Fix
Shared responsive column wrappers and explicit readable number sizes were validated around ~411dp width.

### TellOnce rule
Do not call a responsive change complete from desktop or one emulator size.

Minimum visual matrix:

- narrow Android (~360dp);
- common Android (~411dp);
- larger phone;
- tablet if supported;
- long text;
- large numbers;
- accessibility font scaling where practical.

---

## 10.2 UI regressions were introduced while fixing another screen

### What happened
Home visual regressions required restoring an older known-good layout while retaining newer logic.

### TellOnce rule
Separate presentation changes from domain changes whenever possible.

For a visual-only PR:

- no domain file changes;
- screenshot before/after;
- feature behavior regression tests remain unchanged.

---

## 10.3 Empty/loaded state timing made correct data look broken

### What happened
Some values showed `0` initially and updated only after navigating to History or another screen.

### TellOnce rule
Hydration state must be explicit.

Never render `0` when the truth is actually "not loaded yet."

Use:

- loading/skeleton;
- cached value with freshness marker;
- or explicit empty state.

---

# 11. Backend, SQL, RLS, and query mistakes

## 11.1 RLS / permission-denied failures

### What happened
Permanent-delete and other flows hit `permission denied for table japams` while client behavior looked correct.

### Lesson
Client tests are not enough. Database grants/RLS are part of the feature contract.

### TellOnce rule
Every backend mutation needs contract tests for:

- owner allowed;
- non-owner denied;
- anonymous denied/allowed intentionally;
- repeated call idempotency;
- deleted/revoked state;
- wrong household.

---

## 11.2 Malformed PostgREST filters (`PGRST100`)

### What happened
A malformed/empty filter could generate parse errors.

### TellOnce rule
Centralize REST/query construction. Avoid hand-built query strings scattered through screens.

Validate empty/null filter cases.

---

## 11.3 Supabase CLI returned exit code 0 even when SQL failed

### What happened
`supabase db query` could print a SQL error while the shell exit status still appeared successful in some workflows.

### Risk
Automation could report "success" after a failed migration.

### TellOnce rule
Migration automation must verify success with a positive sentinel/postcondition, not exit code alone.

Examples:

- expected function fingerprint;
- expected row count;
- explicit `VALIDATION_OK`;
- schema introspection.

---

## 11.4 SQL file was passed incorrectly to the CLI

### What happened
Passing file contents as a command argument mangled the command. The correct `-f` path was needed.

### TellOnce rule
Use documented CLI file-input modes and test the exact production command in staging first.

---

## 11.5 Migration verification guard itself had a bug

### What happened
A production SQL migration initially rolled back because its own postcheck used `LIKE` with backslash-containing regex text. The check looked for the wrong literal because backslash was interpreted as an escape.

### Positive outcome
The migration was transactional/fail-closed, so the guard bug prevented an unverified change from being committed.

### TellOnce rule
Production migrations must:

- run in a transaction when possible;
- include prechecks;
- include postchecks;
- fail closed;
- verify the live fingerprint after execution;
- keep verification logic simpler than the migration itself.

---

## 11.6 Repository SQL did not always match live production

### What happened
A migration draft assumed another fix was already live because repository files suggested it. Fresh production inspection showed the live function differed.

### TellOnce rule
Before production DB work, inspect the **live** schema/function/policy. Git is intended state; production is actual state.

---

## 11.7 Test-data insertion failed because of identity-column semantics

### What happened
A staging seed attempted to insert into a `GENERATED ALWAYS` identity column and failed until the insert semantics were corrected.

### TellOnce rule
Test fixtures must follow real schema constraints. Do not weaken production schema just to make fixtures easier.

---

# 12. Build, signing, emulator, and tooling mistakes

## 12.1 EAS build quota blocked validation

### What happened
Cloud EAS quota was exhausted during staging validation, forcing local alternatives.

### TellOnce rule
Do not make release safety dependent on one build path.

Maintain documented fallback:

- cloud build;
- local build;
- artifact verification;
- signing verification.

---

## 12.2 Disk/cache exhaustion and temp-artifact sprawl

### What happened
Gradle caches, transforms, and many temporary Japam build directories consumed significant disk space.

### TellOnce rule
Temporary build directories must have predictable naming and cleanup.

Do not remove unknown user files; clean only verified generated artifacts.

---

## 12.3 JDK / Android SDK environment mismatches

### What happened
Local Android builds failed when the wrong Java version was active or Android SDK paths were missing.

### TellOnce rule
Pin/document toolchain:

- Node version;
- Java version;
- Android SDK path;
- Gradle/Expo compatibility.

Add a local preflight script eventually.

---

## 12.4 Native dependency packaging failures

### What happened
A validation build could fail because a native dependency expected a shared library (`libworklets.so`) that was not produced at the expected path.

### TellOnce lesson
JS tests and Expo export passing do not prove a native binary will package.

Before a Play release, build the actual native artifact.

---

## 12.5 Offline/wrong emulator was repeatedly auto-selected

### What happened
Expo tooling tried to use an offline emulator while another emulator was the intended validation device.

### TellOnce rule
For release validation, identify the device explicitly and verify:

```text
adb devices
package/version
installed signing identity
backend/environment
```

Never infer the test target from "an emulator is running."

---

# 13. Operations and observability warnings

## 13.1 Very high request volume compared with user count

### What happened
Supabase reported roughly millions of requests per month even though the app had relatively few users.

### Status
This was an operational warning requiring investigation; the complete root cause was not yet established in the material reviewed.

Likely classes of causes to investigate include:

- polling;
- duplicate listeners;
- repeated refresh events;
- retry loops;
- unbounded REST reads;
- background sync loops.

### TellOnce rule
Set request budgets early.

Instrument request counts by:

- endpoint;
- screen;
- user/session;
- background vs foreground;
- retry reason.

A small user base generating a large request count should trigger an alert.

---

## 13.2 Point-in-Time Recovery was not enabled

### What happened
Supabase warned that PITR was not enabled, increasing recovery risk from destructive migrations or accidental deletes.

### TellOnce rule
Before meaningful production data exists, define:

- backup policy;
- PITR/restore capability;
- migration rollback plan;
- destructive-operation approvals.

---

## 13.3 Diagnostics were added late

### What happened
Some lifecycle/auth issues required temporary diagnostic builds because normal logs did not prove mount/listener/update state.

### TellOnce rule
Build structured observability early:

- stable event names;
- no sensitive raw user content;
- request correlation IDs;
- capture/draft/action IDs;
- lifecycle transitions;
- retry counts;
- release/runtime metadata.

---

# 14. Testing mistakes and lessons

## 14.1 Emulator-only validation was insufficient for lifecycle bugs

Japam proved that background timers, phone sleep, native foreground services, notification/audio behavior, and process death can differ from emulator assumptions.

### TellOnce rule
Use physical Android validation before production for:

- background upload;
- notifications;
- deep links;
- app kill/reopen;
- camera/photo/document capture;
- OS permission flows;
- guest-link app switching if relevant.

---

## 14.2 One successful race-condition test was not enough

### TellOnce rule
Race-condition tests must be repeated deliberately around the vulnerable timing window.

Examples:

- confirm then kill app immediately;
- network success then local crash;
- offline -> online while screen changes;
- two rapid taps on Confirm;
- two devices updating household state.

---

## 14.3 Focused tests and full-suite failures were sometimes mixed together

### What happened
There were periods where focused release suites passed while broad root tests still had known failures.

### TellOnce rule
Every release report must classify:

- new failure;
- pre-existing known failure;
- flaky/unreliable test;
- skipped test;
- not applicable.

"Tests passed" must always state which suite.

---

## 14.4 UI automation by coordinates is fragile

### TellOnce rule
Prefer stable accessibility IDs/content descriptions. Use coordinate taps only when a known UI/tool limitation requires it and derive coordinates from inspected bounds.

---

# 15. Non-negotiable TellOnce engineering guardrails

These rules should be copied into PR/release checklists.

## GIT-01 — Clean isolated source
Before editing: verify repo, branch, HEAD, status. No unrelated files.

## GIT-02 — One-purpose changes
Do not combine feature work, refactor, dependency upgrade, and visual redesign in one change.

## REL-01 — Release manifest
Every release has a source SHA, version, runtime, environment, backend target, artifact/update ID.

## ENV-01 — Explicit environment identity
Never depend on an untracked local `.env` existing.

## OTA-01 — Eligibility matrix
Know exactly which native builds can receive an OTA.

## NATIVE-01 — Native classification
Any native/config-plugin/permission/signing change requires native artifact validation.

## STATE-01 — Explicit state machines
Do not use one boolean to represent multiple business meanings.

## IDEMP-01 — Deterministic idempotency
Every important repeatable operation must have a stable idempotency key.

## AUTH-01 — Canonical identity
Use backend UUID for ownership. Provider IDs/emails are attributes only.

## SCOPE-01 — Explicit household ownership
Every write/query takes household/action identity explicitly.

## SYNC-01 — Authority hierarchy
Document which state wins when local/cache/server disagree.

## SYNC-02 — Failed read does not equal delete
Do not erase local truth because a remote read failed or returned incomplete data.

## RACE-01 — Stale response protection
Version/abort/coalesce async loads.

## DB-01 — Fail-closed migrations
Transaction + precheck + postcheck + live fingerprint.

## UI-01 — Real-width validation
Test narrow/common Android widths and long content.

## OBS-01 — Request budgets
Monitor request volume before scale.

## TEST-01 — Restart/offline/double-action tests
Happy-path tests are insufficient for persistence workflows.

## AGENT-01 — Approved scope only
Coding agents must not "helpfully" modify unrelated code, branches, backend state, or release config.

---

# 16. TellOnce-specific invariants derived from Japam lessons

These are particularly important for the Household Action Inbox design.

## 16.1 Capture -> Draft -> Confirmed must remain a hard boundary

Before Confirm:

- nothing appears as an active Today action;
- no reminder is active;
- no guest handoff is sent;
- no SMS/email is sent;
- no calendar write happens.

This avoids the Japam pattern where partially hydrated state could leak into active behavior.

## 16.2 Confirm must be idempotent

If Confirm is executed twice, only one set of ActiveActions may be created.

Use a deterministic confirmation/idempotency identity derived from the draft bundle.

## 16.3 One accountable owner per action

Do not infer "everyone" ownership. If owner is unclear, the draft should surface uncertainty for verification.

## 16.4 Events and actions are separate

An event may generate several actions. `event` must not become an action type just because both have dates.

## 16.5 AI extraction never becomes authority by itself

AI output is a Draft Action Bundle. User confirmation is the authority transition.

## 16.6 Ambiguity is explicit

Do not silently guess ambiguous dates, people, or deadlines. Mark only the uncertain field for quick verification.

## 16.7 Raw input and structured state are separate

The raw message/photo/document is evidence. The structured actions/events are operational state. Do not let later parsing mutate previously confirmed actions without a new user-visible change.

## 16.8 External side effects require a durable send record

Guest handoff, email, SMS, reminders, and calendar writes should use deterministic send/operation IDs and persistent status.

## 16.9 Guest links are revocable and scoped

One token should not become a universal household credential.

## 16.10 Offline behavior must be designed before implementation

For every future capture type, define:

- can capture be saved offline?
- when is upload retried?
- what does Processing mean offline?
- can Confirm happen offline?
- what happens if server processes while app is closed?

---

# 17. Checklist before every TellOnce coding slice

- [ ] Read this document.
- [ ] Confirm exact repo/worktree.
- [ ] Confirm branch and base SHA.
- [ ] Confirm current worktree is clean or explain existing changes.
- [ ] Write the domain invariant for the slice.
- [ ] Identify source of truth.
- [ ] Identify idempotency requirement.
- [ ] Identify restart/offline behavior.
- [ ] Identify household/auth scope.
- [ ] Identify external side effects.
- [ ] Define tests before implementation.
- [ ] Define which files may change.
- [ ] No release/publish/deploy during implementation unless explicitly approved.
- [ ] Run focused tests.
- [ ] Run broader regression suite.
- [ ] `git diff --check`.
- [ ] Inspect actual diff before commit.

---

# 18. Checklist before every TellOnce production release

- [ ] Exact source SHA recorded.
- [ ] `main`/release branch relationship understood.
- [ ] No uncommitted changes.
- [ ] Version/build/runtime recorded.
- [ ] Staging vs production backend identity verified.
- [ ] Environment injection verified in built/exported artifact.
- [ ] OTA vs native-build classification confirmed.
- [ ] Auth/signing identity validated.
- [ ] Database migrations separately reviewed and fail-closed.
- [ ] Offline/restart validation complete.
- [ ] Double-submit/idempotency validation complete.
- [ ] Narrow-device UI validation complete.
- [ ] Physical Android validation complete for lifecycle/native features.
- [ ] Request/log behavior checked for loops.
- [ ] Rollback method known before release.
- [ ] Release/update/deployment IDs recorded after execution.
- [ ] Cold launch after release tested.
- [ ] Existing user data verified, not just fresh account.

---

# 19. Incident template for future TellOnce problems

Use this format so lessons stay searchable.

## Incident: <title>

**Date:**  
**Environment:** staging / production  
**Affected version/runtime:**  
**Severity:**  

### Symptom
What the user saw.

### Impact
Data loss? duplicate action? wrong owner? missed reminder? crash? UI only?

### Confirmed root cause
Evidence-based cause. Do not mix speculation into this section.

### Why tests missed it
Exact missing scenario.

### Fix
Smallest permanent fix.

### Regression tests added
List the tests.

### Prevention rule
What rule/checklist changes because of this incident.

### Release evidence
Commit, build/update ID, backend migration fingerprint if applicable.

---

# 20. Known Japam operational warnings that were not fully closed

These should not be presented as proven root causes.

## 20.1 Unexpectedly high Supabase request count
High monthly request volume was observed relative to the apparent user count. A dedicated root-cause audit was still needed.

## 20.2 PITR / recovery posture
PITR was not enabled when Supabase raised the warning. Backup/recovery policy should be treated as a production-readiness item for TellOnce.

## 20.3 Legacy data
Some old Japam devices/accounts contained historical identity/scoping artifacts that could not always be safely auto-repaired. The lesson is to design migration metadata early in TellOnce.

---

# 21. Japam evidence used to build this document

Important Japam sources include:

- `docs/BUGFIX_DUPLICATE_COMPLETION_ID.md`
- `docs/BUGFIX_TIMER_RESTORE_STALE_SESSION.md`
- `docs/BUGFIX_GROUPS_SERVER_SIDE_PROVIDER_NAME_RESOLUTION.md`
- `docs/PRODUCTION_RELEASE_CHECKLIST.md`
- `docs/RELEASE_DATA_INTEGRITY_V1.md`
- `docs/RELEASE_PLAYBOOK.md`
- `docs/PRODUCTION_BASELINE.md`
- `docs/JAPAM_APP_COMPLETE_CODE_GUIDE.html`
- release/incident investigations covering OTA environment failures, runtime/channel drift, per-Japam scoping, History/tombstone reconciliation, duplicate default workspaces, session recovery, Groups concurrency/responsiveness, and staging/production validation.

---

# 22. Final rule

The biggest lesson from Japam is:

> **Do not fix only the symptom. Identify the source of truth, ownership boundary, lifecycle state, idempotency key, and release boundary first.**

For TellOnce, the equivalent product rule is:

> **The user tells us once. We organize it once, verify it once, and every downstream side effect must be deterministic, scoped, and recoverable.**
