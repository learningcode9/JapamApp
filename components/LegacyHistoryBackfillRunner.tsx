/**
 * One-time orchestration for the legacy history backfill: assigns any of this identity's
 * pre-Japam-Workspaces history (japamId == null) to the canonical default Japam, once, ever,
 * per identity.
 *
 * Invisible (renders null), non-blocking (never gates app startup or any screen's render -- runs
 * in its own fire-and-forget effect, same pattern as app/_layout.tsx's existing
 * repairLegacyStoredUserId() call), and mounted INSIDE CurrentJapamProvider (so it can call the
 * Context's own ensureDefaultJapam/useCurrentJapam -- this file does not modify or redesign
 * CurrentJapamContext at all, it's just another consumer of it).
 *
 * Flow, in order:
 *   1. Check (read-only, via historyRepository.loadHistoryForUser + the pure
 *      planLegacyHistoryBackfill) whether this identity has ANY null-japamId history at all. No
 *      Japam is created for this check -- planLegacyHistoryBackfill is pure and never persists
 *      anything, so a placeholder id/name here is safe and discarded.
 *   2. Only if step 1 found something: ensure the active exact-name "My Japam" via the Context's
 *      server-idempotent ensureDefaultJapam path.
 *   3. Persist the real reassignment via historyRepository.applyLegacyHistoryBackfill, using the
 *      just-created Japam's real id/name.
 *   4. Mark this identity's "already backfilled" flag complete.
 *   5. Show a single, dismissible, non-blocking notice.
 * If step 1 finds nothing to migrate, the flag is marked complete immediately and no Japam is
 * created at all -- a genuinely new user is untouched by this feature.
 *
 * Signed-in users use the server RPC's transaction lock and canonical result. Existing duplicate
 * rows are not removed; the history reassignment always targets the exact default returned by the
 * server. Guests have no server identity and therefore have no cross-device guarantee.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useRef } from 'react';
import { Alert } from 'react-native';
import { useCurrentJapam } from '../contexts/current-japam-context';
import * as historyRepository from '../lib/historyRepository';
import { planLegacyHistoryBackfill } from '../lib/legacyHistoryBackfill';
import {
  isLegacyHistoryBackfillComplete,
  markLegacyHistoryBackfillComplete,
} from '../lib/legacyHistoryBackfillStorage';

const USER_ID_KEY = 'userId';
// Never persisted -- only used to ask planLegacyHistoryBackfill "is there anything to reassign?"
// without actually reassigning anything yet.
const CHECK_ONLY_PLACEHOLDER = '__legacy_backfill_check_only__';

export default function LegacyHistoryBackfillRunner() {
  const { isLoading, ensureDefaultJapam } = useCurrentJapam();
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
      const userId = await AsyncStorage.getItem(USER_ID_KEY);
      const identityKey = userId || 'guest';
      identityKeyBeingAttempted = identityKey;
      // Synchronous check-then-mark with no await in between: safe against this effect firing
      // again in quick succession for the SAME identity (e.g. isLoading flickering, or React
      // re-invoking effects), while never blocking a DIFFERENT identity from being checked.
      if (checkedIdentitiesRef.current.has(identityKey)) return;
      checkedIdentitiesRef.current.add(identityKey);

      if (await isLegacyHistoryBackfillComplete(userId)) return;

      // Step 1: read-only check. No Japam created yet, nothing persisted.
      const existing = await historyRepository.loadHistoryForUser(userId);
      const { needsBackfill } = planLegacyHistoryBackfill(
        existing,
        CHECK_ONLY_PLACEHOLDER,
        CHECK_ONLY_PLACEHOLDER
      );

      if (!needsBackfill) {
        await markLegacyHistoryBackfillComplete(userId);
        return;
      }

      // Step 2: reuse or create the one default Japam, named after the best available existing name.
      const created = await ensureDefaultJapam();
      if (!created) return; // Defensive only: ensureDefaultJapam can fail without a user identity.

      // Step 3: persist the real reassignment using the just-created Japam's real id/name.
      await historyRepository.applyLegacyHistoryBackfill(userId, created.id, created.name);

      // Step 4.
      await markLegacyHistoryBackfillComplete(userId);

      // Step 5: one-time, dismissible, non-blocking notice.
      Alert.alert(
        'History organized',
        `We've added your past Japam history to "${created.name}". You can rename it anytime from My Japams.`,
        [{ text: 'Got it' }]
      );
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
  }, [isLoading, ensureDefaultJapam]);

  return null;
}
