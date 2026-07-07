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
 *   1. Check (read-only, via historyRepository.loadHistoryForUser + the pure
 *      planLegacyHistoryBackfill) whether this identity has ANY null-japamId history at all. No
 *      Japam is created for this check -- planLegacyHistoryBackfill is pure and never persists
 *      anything, so a placeholder id/name here is safe and discarded.
 *   2. Only if step 1 found something: create ONE default Japam via the Context's existing
 *      createJapam (which also auto-selects it -- untouched, existing behavior).
 *   3. Persist the real reassignment via historyRepository.applyLegacyHistoryBackfill, using the
 *      just-created Japam's real id/name.
 *   4. Mark this identity's "already backfilled" flag complete.
 *   5. Show a single, dismissible, non-blocking notice.
 * If step 1 finds nothing to migrate, the flag is marked complete immediately and no Japam is
 * created at all -- a genuinely new user is untouched by this feature.
 *
 * No Supabase call anywhere in this flow (Japams have no Supabase sync yet at all -- see
 * lib/japamsRepository.ts's own doc comment). This means the one default Japam this creates is
 * LOCAL TO THIS DEVICE ONLY. A signed-in user with multiple devices, each running this backfill
 * independently before Japams sync exists, will end up with a DIFFERENT default Japam (different
 * client-generated id) per device, and could see the same underlying history rows tagged
 * inconsistently across devices once ordinary history sync uploads each device's reassignment.
 * This is a known, accepted limitation (per the approved proposal) until Japams themselves get
 * Supabase sync -- not something this commit attempts to solve.
 *
 * The suggested name for the created Japam is a fixed generic default (DEFAULT_JAPAM_NAME), not
 * user_profiles.japam_name -- deliberately, to avoid adding any new Supabase read to this
 * commit. Using that profile field as a nicer suggested name is a natural, separate, later
 * enhancement, not part of this orchestration.
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
const DEFAULT_JAPAM_NAME = 'My Japam';
// Never persisted -- only used to ask planLegacyHistoryBackfill "is there anything to reassign?"
// without actually reassigning anything yet.
const CHECK_ONLY_PLACEHOLDER = '__legacy_backfill_check_only__';

export default function LegacyHistoryBackfillRunner() {
  const { isLoading, createJapam } = useCurrentJapam();
  const hasRunRef = useRef(false);

  useEffect(() => {
    if (isLoading || hasRunRef.current) return;
    hasRunRef.current = true;

    (async () => {
      const userId = await AsyncStorage.getItem(USER_ID_KEY);

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

      // Step 2: create the one default Japam. createJapam already auto-selects it -- existing,
      // untouched Context behavior.
      const created = await createJapam(DEFAULT_JAPAM_NAME);
      if (!created) return; // Defensive only: createJapam only returns null for a blank name.

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
      // Best-effort, non-blocking: on any failure, the flag is deliberately NOT marked complete,
      // so this identity's backfill is retried on a future launch instead of silently lost.
    });
  }, [isLoading, createJapam]);

  return null;
}
