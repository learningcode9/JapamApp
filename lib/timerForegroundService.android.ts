/**
 * Android-only: bridges to the Kotlin JapamTimerService ForegroundService.
 * The Kotlin service owns the notification, countdown, sound, and vibration
 * so they survive app backgrounding without relying on JS execution.
 */
import { NativeModules } from 'react-native';
import { getTimerState } from './timerState';

const Native: {
  startTimer(
    durationSeconds: number,
    completedLoops: number,
    totalLoops: number,
    soundEnabled: boolean,
    vibrationEnabled: boolean,
    userId: string,
    startedAt: number,
  ): Promise<void>;
  pauseTimer(): Promise<void>;
  resumeTimer(): Promise<void>;
  stopTimer(): Promise<void>;
  setAppActive(isActive: boolean): void;
  getState(): Promise<{
    isRunning: boolean;
    isPaused: boolean;
    startedAt: number;
    pausedElapsedMs: number;
    durationMs: number;
    completedLoops: number;
    totalLoops: number;
    userId: string;
  }>;
  isServiceRunning(): Promise<boolean>;
} | null = NativeModules.JapamTimerService ?? null;

// Diagnostic: log module availability at import time so we can see it in adb logcat
console.log('[TimerNative] module =', NativeModules.JapamTimerService);

// Tracks the startedAt we last issued a native ACTION_START for. showNotification()
// (and therefore startForegroundService()) is called from many places per session —
// the initial start(), the [isRunning] refresh effect, the notification-permission
// callback, the background hand-off, and resume/restore paths. On Android each call
// re-issues ACTION_START, which resets the native ticker AND native isPaused → the
// "one Start = two native startTimer calls" desync. Deduping by startedAt means a
// single user Start (or loop/resume, which each carry a fresh startedAt) issues
// exactly one native start; redundant refreshes are skipped.
let lastNativeStartKey = 0;

export const startForegroundService = async (): Promise<void> => {
  if (!Native) {
    console.error(
      '[TimerNative] FATAL: NativeModules.JapamTimerService is null — ' +
      'module not registered. JapamTimerPackage may not be in MainApplication.kt, ' +
      'or the package was not copied during prebuild. Foreground service will NOT start.'
    );
    return;
  }
  const s = getTimerState();
  const startedAt = s.startedAt ?? Date.now();
  if (startedAt === lastNativeStartKey) {
    console.log('[NativeTimer] TIMER_START_SKIPPED_DUPLICATE startedAt=%d duration=%ds loops=%d/%d',
      startedAt, s.durationSeconds, s.completedLoops, s.totalLoops);
    return;
  }
  lastNativeStartKey = startedAt;
  console.log('[NativeTimer] NATIVE_START_CALLED startTimer startedAt=%d duration=%ds loops=%d/%d',
    startedAt, s.durationSeconds, s.completedLoops, s.totalLoops);
  try {
    await Native.startTimer(
      s.durationSeconds,
      s.completedLoops,
      s.totalLoops,
      s.soundEnabled,
      s.vibrationEnabled,
      s.userId,
      startedAt,
    );
    console.log('[TimerNative] startTimer OK duration=%ds loops=%d/%d', s.durationSeconds, s.completedLoops, s.totalLoops);
  } catch (e) {
    console.error('[TimerNative] startTimer FAILED:', e);
  }
};

export const pauseForegroundService = async (): Promise<void> => {
  if (!Native) return;
  try {
    await Native.pauseTimer();
  } catch (e) {
    console.warn('[TimerNative] pauseTimer error:', e);
  }
};

export const stopForegroundService = async (): Promise<void> => {
  // Reset the dedup key so the next session (even if it reuses a startedAt value)
  // always issues a fresh native start.
  lastNativeStartKey = 0;
  if (!Native) return;
  try {
    await Native.stopTimer();
  } catch (e) {
    console.warn('[TimerNative] stopTimer error:', e);
  }
};

export const resumeForegroundService = async (): Promise<void> => {
  if (!Native) return;
  try {
    await Native.resumeTimer();
  } catch (e) {
    console.warn('[TimerNative] resumeTimer error:', e);
  }
};

export const setNativeAppActive = (isActive: boolean): void => {
  Native?.setAppActive(isActive);
};

export const getNativeTimerState = async () => {
  if (!Native) return null;
  try {
    return await Native.getState();
  } catch {
    return null;
  }
};

export const isForegroundServiceRunning = async (): Promise<boolean> => {
  if (!Native) return false;
  try {
    return await Native.isServiceRunning();
  } catch {
    return false;
  }
};
