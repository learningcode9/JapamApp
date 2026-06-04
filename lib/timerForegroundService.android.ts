/**
 * Android native foreground timer is intentionally disabled.
 *
 * The previous ForegroundService path introduced duplicate completion sources
 * (JS + Kotlin), stale notifications, late Om playback, and 4/3 loop states.
 * Keep this module as a safe no-op so the app uses the single JS timer source
 * of truth while native files remain untouched.
 */
export const startForegroundService = async (): Promise<void> => {};
export const pauseForegroundService = async (): Promise<void> => {};
export const resumeForegroundService = async (): Promise<void> => {};
export const stopForegroundService = async (): Promise<void> => {};
export const setNativeAppActive = (_isActive: boolean): void => {};
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
} | null> => null;
export const isForegroundServiceRunning = async (): Promise<boolean> => false;
