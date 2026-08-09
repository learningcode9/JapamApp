import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform, DeviceEventEmitter } from 'react-native';
import {
  appendCompletion,
  toLocalDayKey,
} from './historyStore';
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
  const japamId = identity?.japamId ?? refs.activeJapamId.current;
  const japamName = identity?.japamName ?? refs.activeJapamName.current;

  if (currentUserId && (!japamId || !japamName)) {
    if (source === 'tap') console.log('TAP_HISTORY_SAVE_SKIPPED reason=current-japam-unresolved');
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

    // TimerProvider owns the single serialized upload path. The event is emitted only after
    // the local write so online saves are picked up immediately, while offline saves remain
    // pending for the existing reconnect/startup/AppState triggers.
    DeviceEventEmitter.emit('japam-history-pending-sync', { userId: userId || 'guest' });
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      window.dispatchEvent(new Event('japam-history-pending-sync'));
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
