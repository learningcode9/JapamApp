import AsyncStorage from '@react-native-async-storage/async-storage';

export const T_DURATION_KEY = 'timerTab_duration';
export const T_LOOPS_KEY = 'timerTab_loops';
export const TIMER_SECONDS_KEY = 'timerSeconds';
export const TIMER_RUNNING_KEY = 'timerRunning';
export const TIMER_TARGET_KEY = 'timerTarget';
export const TIMER_PAUSED_KEY = 'timerPaused';
export const TIMER_COMPLETED_LOOPS_KEY = 'timerCompletedLoops';
export const TIMER_STARTED_AT_KEY = 'timerStartedAt';
export const TIMER_SESSION_ID_KEY = 'timerSessionId';

export function getJapamKey(key: string, uid: string, japamId: string): string {
  return `${key}:${uid}:${japamId}`;
}

export function getUserKey(key: string, uid: string): string {
  return `${key}:${uid}`;
}

export function buildSelectionPairs(
  bareKey: string, value: string,
  uid: string | null, japamId: string | null
): [string, string][] {
  const pairs: [string, string][] = [[bareKey, value]];
  if (uid) {
    pairs.push([getUserKey(bareKey, uid), value]);
    if (japamId) {
      pairs.push([getJapamKey(bareKey, uid, japamId), value]);
    }
  }
  return pairs;
}

export const PER_JAPAM_KEYS = [
  TIMER_SECONDS_KEY,
  TIMER_TARGET_KEY,
  T_DURATION_KEY,
  T_LOOPS_KEY,
  TIMER_PAUSED_KEY,
  TIMER_COMPLETED_LOOPS_KEY,
  TIMER_RUNNING_KEY,
  TIMER_STARTED_AT_KEY,
  TIMER_SESSION_ID_KEY,
] as const;

export interface TimerStateSnapshot {
  seconds: number;
  running: boolean;
  target: number;
  paused: boolean;
  completedLoops: number;
  startedAt: number | '';
  sessionId: string;
  duration: number;
  loops: number;
}

export function buildTimerPairs(snapshot: TimerStateSnapshot): [string, string][] {
  return [
    [TIMER_SECONDS_KEY, String(snapshot.seconds)],
    [TIMER_RUNNING_KEY, String(snapshot.running)],
    [TIMER_TARGET_KEY, String(snapshot.target)],
    [TIMER_PAUSED_KEY, String(snapshot.paused)],
    [TIMER_COMPLETED_LOOPS_KEY, String(snapshot.completedLoops)],
    [TIMER_STARTED_AT_KEY, snapshot.startedAt === '' ? '' : String(snapshot.startedAt)],
    [TIMER_SESSION_ID_KEY, snapshot.sessionId],
    [T_DURATION_KEY, String(snapshot.duration)],
    [T_LOOPS_KEY, String(snapshot.loops)],
  ];
}

export async function saveJapamTimerState(
  uid: string,
  japamId: string,
  snapshot: TimerStateSnapshot
): Promise<void> {
  const pairs = buildTimerPairs(snapshot);
  await AsyncStorage.multiSet(
    pairs.map(([k, v]) => [getJapamKey(k, uid, japamId), v] as [string, string])
  );
}

export interface RawJapamTimerState {
  seconds: string | null;
  target: string | null;
  duration: string | null;
  loops: string | null;
  paused: string | null;
  completedLoops: string | null;
  running: string | null;
  startedAt: string | null;
  sessionId: string | null;
}

export async function readJapamTimerState(
  uid: string,
  japamId: string
): Promise<RawJapamTimerState> {
  const japamKeys = PER_JAPAM_KEYS.map(k => getJapamKey(k, uid, japamId));
  const entries = await AsyncStorage.multiGet(japamKeys);
  return {
    seconds: entries[0]?.[1] ?? null,
    target: entries[1]?.[1] ?? null,
    duration: entries[2]?.[1] ?? null,
    loops: entries[3]?.[1] ?? null,
    paused: entries[4]?.[1] ?? null,
    completedLoops: entries[5]?.[1] ?? null,
    running: entries[6]?.[1] ?? null,
    startedAt: entries[7]?.[1] ?? null,
    sessionId: entries[8]?.[1] ?? null,
  };
}
