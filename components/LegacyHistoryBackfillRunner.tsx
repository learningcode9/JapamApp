/**
 * One-time orchestration for the legacy history backfill: assigns any of this identity's
 * pre-Japam-Workspaces history (japamId == null) to one newly-created default Japam, once, ever,
 * per identity.
 *
 * Invisible (renders null), non-blocking (never gates app startup or any screen's render -- runs
 * in its own fire-and-forget effect, same pattern as app/_layout.tsx's existing
 * repairLegacyStoredUserId() call), and mounted INSIDE CurrentJapamProvider (so it can call the
 * Context's own createJapam/useCurrentJapam -- this file does not modify or redesign
 * CurrentJapamContext at all, it's just another consumer of it).
 *
 * Flow, in order:
 *   1. Read this identity's local history (read-only) so the eligible completion-id set can be
 *      derived through History's attribution rule. Deliberately NOT a gate: for signed-in
 *      identities, local storage can be empty (or already-assigned) while the authoritative
 *      remote japam_history still holds eligible null-japamId rows -- the History screen's remote
 *      merge has not run yet at startup, or this device never downloaded those rows. The remote
 *      half of step 3 decides eligibility from the remote rows themselves, so this runner always
 *      proceeds; a no-op local snapshot just means no local rewrite happens.
 *   2. Resolve the canonical/default Japam via the shared deterministic helper used by
 *      CurrentJapamProvider.
 *   3. Persist the real reassignment via historyRepository.applyLegacyHistoryBackfill, using the
 *      resolved Japam's real id/name. Idempotent: no-ops when nothing is left to reassign.
 *   4. Mark this identity's "already backfilled" flag complete.
 *   5. Show a single, dismissible, non-blocking notice (only on the first run that did work).
 *
 * The shared helper may consult remote state for signed-in users before deciding whether to
 * create anything, but it still resolves to a single canonical Japam id for the same user across
 * concurrent callers.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useRef } from 'react';
import { Alert } from 'react-native';
import { useCurrentJapam } from '../contexts/current-japam-context';
import * as historyRepository from '../lib/historyRepository';
import { activeJapams } from '../lib/japams';
import { filterByJapam } from '../lib/historyStore';
import * as japamsRepository from '../lib/japamsRepository';
import {
  isLegacyHistoryBackfillComplete,
  markLegacyHistoryBackfillComplete,
} from '../lib/legacyHistoryBackfillStorage';

const USER_ID_KEY = 'userId';

export default function LegacyHistoryBackfillRunner() {
  const { isLoading } = useCurrentJapam();
  // Identity-aware run guard, not a single boolean: this component is mounted once for the app's
  // whole lifetime (inside CurrentJapamProvider, which itself never unmounts), so a single
  // hasRunRef would permanently skip a NEW identity's own check for the rest of the session after
  // the FIRST identity was checked -- e.g. starting as a guest, then signing in without
  // restarting the app, would silently skip that signed-in identity's backfill until next cold
  // start. Each identity (a userId, or 'guest') must be checked independently, exactly once per
  // session; a previously-checked identity must never block a different one.
  const checkedIdentitiesRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (isLoading) return;

    // Captured outside the IIFE so the failure handler below can still see which identity was
    // being attempted, without moving the add() call itself (see comment at that call site).
    let identityKeyBeingAttempted: string | null = null;

    (async () => {
      const userId = (await AsyncStorage.getItem(USER_ID_KEY))?.trim() ?? '';
      if (!userId) return;

      identityKeyBeingAttempted = userId;
      // Synchronous check-then-mark with no await in between: safe against this effect firing
      // again in quick succession for the SAME authenticated identity (e.g. isLoading flickering,
      // or React re-invoking effects), while never blocking a DIFFERENT authenticated user from
      // being checked.
      if (checkedIdentitiesRef.current.has(userId)) return;
      checkedIdentitiesRef.current.add(userId);

      const alreadyComplete = await isLegacyHistoryBackfillComplete(userId);

      // Step 1: read this identity's local history so the eligible completion-id set below can be
      // derived through History's attribution rule. This is NOT a gate on whether to run the
      // backfill at all: local AsyncStorage can be empty (or hold only already-assigned rows)
      // while the authoritative remote japam_history still has eligible null-japamId rows -- the
      // History screen's remote merge has not populated local storage yet at startup, or this
      // device never downloaded those rows. Deciding "nothing to do" from the local snapshot alone
      // is exactly what left production's eligible remote rows unassigned. The remote half of
      // applyLegacyHistoryBackfill derives its eligible set from the remote rows themselves, so the
      // runner always reaches it for a signed-in identity; a no-op local snapshot simply means the
      // local plan writes nothing.
      const existing = await historyRepository.loadHistoryForUser(userId);

      // Step 2: resolve the canonical/default Japam through the same deterministic helper the
      // provider uses. This either adopts an existing active Japam or creates the one default
      // record only when the user truly has none.
      const ensured = await japamsRepository.ensureDefaultJapam(userId);
      const defaultJapam = activeJapams(ensured.japams)[0] ?? null;
      if (!defaultJapam) return;

      // History's canonical default bucket is the first active Japam. Use the exact same
      // attribution rule (including blank legacy rows) to build the eligible completion-id set;
      // null rows attributed to another named Japam, another user, or an ambiguous name stay
      // untouched.
      const attributedCompletionIds = new Set(
        filterByJapam(
          existing,
          defaultJapam.id,
          defaultJapam.name,
          { includeBlankLegacy: true },
          ensured.japams,
        )
          .map((record) => record.completionId)
      );

      // Step 3: persist the real reassignment using the just-created Japam's real id/name.
      const plan = await historyRepository.applyLegacyHistoryBackfill(
        userId,
        defaultJapam.id,
        defaultJapam.name,
        { onlyCompletionIds: attributedCompletionIds, japams: ensured.japams },
      );

      // Step 4.
      await markLegacyHistoryBackfillComplete(userId);

      // Step 5: one-time, dismissible, non-blocking notice -- only on the first run that actually
      // reassigned something. A later launch (flag already set) never re-alerts.
      if (!alreadyComplete && plan.needsBackfill) {
        Alert.alert(
          'History organized',
          `We've added your past Japam history to "${defaultJapam.name}". You can rename it anytime from My Japams.`,
          [{ text: 'Got it' }]
        );
      }
    })().catch(() => {
      // Best-effort, non-blocking: on any failure, the persisted flag is deliberately NOT marked
      // complete, so this identity's backfill is retried on a future launch instead of silently
      // lost. Also remove it from the in-memory set (if it was added) so a legitimate retry
      // opportunity WITHIN this same session -- e.g. isLoading resolving again for this same
      // identity for any reason -- isn't silently skipped just because a prior attempt happened
      // to fail. Does not reintroduce the concurrent-duplicate-run risk: the add() above still
      // happens synchronously before any await, so a genuinely concurrent second invocation for
      // the same identity is still blocked while this attempt is in flight.
      if (identityKeyBeingAttempted) {
        checkedIdentitiesRef.current.delete(identityKeyBeingAttempted);
      }
    });
  }, [isLoading]);

  return null;
}
