// No-op stub for web and iOS — real implementation is timerForegroundService.android.ts
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
