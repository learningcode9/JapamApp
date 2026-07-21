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
 * The suggested name for the created Japam is a best-effort read of user_profiles.japam_name (the
 * SAME read-only query already used elsewhere in this app -- see loadJapamNameFromSupabase in
 * app/(tabs)/index.tsx and app/(tabs)/tap-japam.tsx), falling back to a fixed generic default
 * (DEFAULT_JAPAM_NAME) for guests, a missing/blank profile name, or any fetch failure. This lookup
 * never blocks startup (it only runs after step 1 already confirmed there's something to migrate,
 * inside the same fire-and-forget effect) and never fails the backfill itself -- any error here is
 * caught locally and just falls through to the generic default, same as every other best-effort
 * step in this flow.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useRef } from 'react';
import { Alert } from 'react-native';
import { useCurrentJapam } from '../contexts/current-japam-context';
import { ensureDefaultJapam } from '../lib/ensureDefaultJapam';
import * as historyRepository from '../lib/historyRepository';
import { planLegacyHistoryBackfill } from '../lib/legacyHistoryBackfill';
import { supabase } from '../lib/supabase';
import {
  isLegacyHistoryBackfillComplete,
  markLegacyHistoryBackfillComplete,
} from '../lib/legacyHistoryBackfillStorage';

const USER_ID_KEY = 'userId';
const DEFAULT_JAPAM_NAME = 'My Japam';
// Never persisted -- only used to ask planLegacyHistoryBackfill "is there anything to reassign?"
// without actually reassigning anything yet.
const CHECK_ONLY_PLACEHOLDER = '__legacy_backfill_check_only__';

/**
 * Best-effort suggested name for the default Japam: user_profiles.japam_name for a signed-in
 * user, if present and non-blank, else DEFAULT_JAPAM_NAME. Guests, missing env config, a
 * not-found/empty profile row, a blank name, or any network/parse error all fall through to the
 * same generic default -- this never throws.
 *
 * Uses the signed-in user's session JWT, not the anon key (mirrors the F15/F7 session-token
 * pattern from syncPendingHistory/saveToSupabase in lib/historyStore.ts and app/(tabs)/index.tsx).
 * No session: skip the lookup entirely and return DEFAULT_JAPAM_NAME — fail-closed, never falls
 * back to the anon key.
 */
const fetchSuggestedJapamName = async (userId: string | null): Promise<string> => {
  if (!userId) return DEFAULT_JAPAM_NAME;

  try {
    const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
    const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
    if (!supabaseUrl || !supabaseAnonKey) return DEFAULT_JAPAM_NAME;

    // Require a real session JWT. No session: skip, same fail-closed discipline as the F15/F7
    // session-token guards (index.tsx's saveUserTotalToSupabase, timer-context.tsx's
    // syncPendingHistory, etc.).
    const { data: sessionData } = await supabase.auth.getSession();
    const sessionToken = sessionData.session?.access_token;
    if (!sessionToken) return DEFAULT_JAPAM_NAME;

    const encodedUserId = encodeURIComponent(userId);
    const response = await fetch(
      `${supabaseUrl}/rest/v1/user_profiles?user_id=eq.${encodedUserId}&select=japam_name`,
      { headers: { apikey: supabaseAnonKey, Authorization: `Bearer ${sessionToken}` } }
    );
    if (!response.ok) return DEFAULT_JAPAM_NAME;

    const rows = await response.json();
    const profileName = rows?.[0]?.japam_name;
    const trimmed = typeof profileName === 'string' ? profileName.trim() : '';
    return trimmed.length > 0 ? trimmed : DEFAULT_JAPAM_NAME;
  } catch {
    return DEFAULT_JAPAM_NAME;
  }
};

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

      // Step 2: create or reuse the one default Japam, named after the best available
      // existing name. Uses the shared ensureDefaultJapam coordinator so a Japam created
      // by CurrentJapamProvider.refresh() is found and reused instead of creating another.
      if (!userId) return;
      const suggestedName = await fetchSuggestedJapamName(userId);
      const created = await ensureDefaultJapam(userId, suggestedName);
      if (!created) return;

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
  }, [isLoading]);

  return null;
}
