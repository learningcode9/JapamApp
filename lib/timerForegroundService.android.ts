import { NativeModules } from 'react-native';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Native = NativeModules.JapamTimerService as any;

// Dedup guard: prevents re-sending startTimer for the same mala.
// Stores the startedAt (ms epoch) of the last successful startTimer call.
// Reset to 0 in stopForegroundService so the next session starts fresh.
let lastNativeStartKey = 0;

export const startForegroundService = async (params: {
  sessionId: string;
  durationSeconds: number;
  completedLoops: number;
  totalLoops: number;
  soundEnabled: boolean;
  vibrationEnabled: boolean;
  userId: string;
  startedAt: number;
}): Promise<void> => {
  if (!Native) return;
  if (params.startedAt === lastNativeStartKey) return;
  lastNativeStartKey = params.startedAt;
  try {
    await Native.startTimer(
      params.sessionId,
      params.durationSeconds,
      params.completedLoops,
      params.totalLoops,
      params.soundEnabled,
      params.vibrationEnabled,
      params.userId,
      params.startedAt,
    );
  } catch (e) {
    console.log('[NativeTimer] startForegroundService error:', e);
    lastNativeStartKey = 0;
  }
};

export const pauseForegroundService = async (): Promise<void> => {
  if (!Native) return;
  try { await Native.pauseTimer(); } catch {}
};

export const resumeForegroundService = async (): Promise<void> => {
  if (!Native) return;
  try { await Native.resumeTimer(); } catch {}
};

export const stopForegroundService = async (): Promise<void> => {
  lastNativeStartKey = 0;
  if (!Native) return;
  try { await Native.stopTimer(); } catch {}
};

export const setNativeAppActive = (isActive: boolean): void => {
  try { Native?.setAppActive(isActive); } catch {}
};

export const getNativeTimerState = async (): Promise<{
  sessionId: string;
  isRunning: boolean;
  isPaused: boolean;
  startedAt: number;
  pausedElapsedMs: number;
  durationMs: number;
  completedLoops: number;
  totalLoops: number;
  userId: string;
} | null> => {
  if (!Native) return null;
  try { return await Native.getState(); } catch { return null; }
};

export const isForegroundServiceRunning = async (): Promise<boolean> => {
  if (!Native) return false;
  try { return await Native.isServiceRunning(); } catch { return false; }
};
