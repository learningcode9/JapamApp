import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform, DeviceEventEmitter } from 'react-native';
import { supabase } from './supabase';
import {
  appendCompletion,
  buildSupabaseHistoryPayload,
  markSynced,
  toLocalDayKey,
} from './historyStore';
import * as japamsRepository from './japamsRepository';
import { canPersistJapamCompletion } from './japamActionReadiness';
import { type TapIdentitySnapshot } from './tapJapamBehavior';

export interface TapSaveSessionRefs {
  isSavingSession: { current: boolean };
  lastSavedSession: { current: string };
  activeJapamId: { current: string | null };
  activeJapamName: { current: string | null };
}

const USER_ID_KEY = 'userId';
const USER_NAME_KEY = 'userName';
const USER_EMAIL_KEY = 'userEmail';
const HISTORY_KEY = 'history';
const HISTORY_SYNC_VERSION_KEY = 'historyStatsSyncVersion';

const getLocalDateKey = (date = new Date()) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

/**
 * Persist one mala-completion to local storage, fire events, and kick off Supabase sync.
 *
 * Extracted from tap-japam.tsx's inline useCallback so the same runtime code can be tested
 * without indirection or duplication.
 */
export async function tapSaveSession(
  duration: number,
  sessionMalas: number,
  sessionTotal: number,
  accumulatedTotal: number,
  source: 'tap' | 'timer' = 'timer',
  refs: TapSaveSessionRefs,
  identity?: TapIdentitySnapshot,
  userName?: string,
): Promise<boolean> {
  if (refs.isSavingSession.current) {
    if (source === 'tap') console.log('TAP_HISTORY_SAVE_SKIPPED reason=in-flight');
    return false;
  }

  const currentUserId = identity?.userId ?? await AsyncStorage.getItem(USER_ID_KEY);
  const isAnonymousUser = (await AsyncStorage.getItem('isAnonymousUser')) === 'true';
  const resolvedJapamId = identity?.japamId ?? refs.activeJapamId.current;
  if (!canPersistJapamCompletion({ userId: currentUserId, isAnonymous: isAnonymousUser, japamId: resolvedJapamId })) {
    console.log('TAP_HISTORY_SAVE_SKIPPED reason=missing-japam-scope userId=%s source=%s', currentUserId, source);
    return false;
  }
  const sessionSignature = `${currentUserId || 'guest'}-${getLocalDateKey()}-${duration}-${sessionMalas}-${sessionTotal}-${accumulatedTotal}`;

  if (refs.lastSavedSession.current === sessionSignature) {
    if (source === 'tap') console.log('TAP_HISTORY_SAVE_SKIPPED reason=duplicate signature=%s', sessionSignature);
    return false;
  }

  refs.isSavingSession.current = true;
  refs.lastSavedSession.current = sessionSignature;

  try {
    if (source === 'tap') {
      console.log('TAP_HISTORY_SAVE_START signature=%s total=%d count=%d', sessionSignature, accumulatedTotal, sessionTotal);
    }

    const raw = await AsyncStorage.getItem(HISTORY_KEY);
    const history: any[] = raw ? JSON.parse(raw) : [];
    const userId = currentUserId;
    const savedUserName = await AsyncStorage.getItem(USER_NAME_KEY);
    const savedUserEmail = await AsyncStorage.getItem(USER_EMAIL_KEY);
    const historyUserName = savedUserName || userName || savedUserEmail || 'Unknown User';

    const japamId = resolvedJapamId;
    const japamName = identity?.japamName ?? refs.activeJapamName.current;

    console.log('TAP_SAVE_IDENTITY RESOLVED userId=%s japamId=%s japamName=%s', userId, japamId, japamName);

    const sessionDate = new Date().toISOString();
    const updatedHistory = appendCompletion(history, {
      date: sessionDate,
      malas: sessionMalas,
      totalCount: sessionTotal,
      duration,
      manual: false,
      userId: userId ?? null,
      userName: userId ? historyUserName : undefined,
      userEmail: userId ? savedUserEmail || undefined : undefined,
      source,
      japamId,
      japamName,
    });
    const savedRecord = updatedHistory[0];

    console.log('TAP_APPEND_COMPLETION completionId=%s historyLength=%d', savedRecord.completionId, updatedHistory.length);

    await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(updatedHistory));
    await AsyncStorage.setItem(HISTORY_SYNC_VERSION_KEY, String(Date.now()));

    console.log(
      '[OFFLINE_SAVE_ACCEPTED] source=%s completionId=%s created_at=%s localDay=%s syncStatus=%s',
      source,
      savedRecord.completionId,
      savedRecord.date,
      toLocalDayKey(savedRecord.date),
      savedRecord.syncStatus
    );

    if (source === 'tap') {
      console.log(
        'TAP_HISTORY_SAVE_ACCEPTED completionId=%s userId=%s userName=%s',
        savedRecord.completionId,
        userId || 'guest',
        historyUserName
      );
    }

    DeviceEventEmitter.emit('japam-stats-updated');
    DeviceEventEmitter.emit('japam-history-updated', { userId: userId || 'guest', todayTotal: accumulatedTotal });

    console.log('TAP_EVENTS_EMITTED japam-stats-updated + japam-history-updated');

    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      window.dispatchEvent(new Event('japam-stats-updated'));
      window.dispatchEvent(new Event('japam-history-updated'));
    }

    if (source === 'tap') {
      console.log('TAP_STATS_EVENT_DISPATCHED completionId=%s', savedRecord.completionId);
    }

    if (userId) {
      const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
      const key = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

      if (url && key) {
        const payload = buildSupabaseHistoryPayload(savedRecord, userId, historyUserName);
        console.log(
          '[SYNC_PAYLOAD_CREATED_AT] source=%s completionId=%s created_at=%s localDay=%s',
          source,
          payload.completion_id,
          payload.created_at,
          toLocalDayKey(payload.created_at)
        );

        void (async () => {
          try {
            const sessionToken = (await supabase.auth.getSession()).data.session?.access_token;
            if (!sessionToken) {
              console.log('[SYNC_FAILED] source=%s completionId=%s reason=no-session', source, payload.completion_id);
              return;
            }
            if (savedRecord.japamId && !(await japamsRepository.ensureRemoteJapamExists(userId, savedRecord.japamId))) {
              console.log('[SYNC_FAILED] source=%s completionId=%s reason=missing-remote-japam', source, payload.completion_id);
              return;
            }
            const res = await fetch(`${url}/rest/v1/japam_history?on_conflict=completion_id`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                apikey: key,
                Authorization: `Bearer ${sessionToken}`,
                Prefer: 'return=minimal,resolution=merge-duplicates',
              },
              body: JSON.stringify(payload),
            });

            if (!res.ok) {
              console.log('[SYNC_FAILED] source=%s completionId=%s status=%d', source, payload.completion_id, res.status);
              console.log('Tap Supabase save error:', await res.text());
              return;
            }
            console.log('[SYNC_SUCCESS] source=%s completionId=%s', source, payload.completion_id);

            const latestRaw = await AsyncStorage.getItem(HISTORY_KEY);
            const latest = latestRaw ? JSON.parse(latestRaw) : [];
            await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(markSynced(latest, [savedRecord.completionId])));
            console.log('[MARK_SYNCED] source=%s completionId=%s', source, savedRecord.completionId);
          } catch (error) {
            console.log('[SYNC_FAILED] source=%s completionId=%s reason=network', source, payload.completion_id);
            console.log('Tap Supabase save error:', error);
          }
        })();
      }
    }

    return true;
  } catch (error) {
    console.log('Supabase save error:', error);
    if (source === 'tap') {
      refs.lastSavedSession.current = '';
      console.log('TAP_HISTORY_SAVE_SKIPPED reason=error');
    }
    return false;
  } finally {
    refs.isSavingSession.current = false;
  }
}
