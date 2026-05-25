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

export const startForegroundService = async (): Promise<void> => {
  if (!Native) {
    console.warn('[NativeTimer] NativeModules.JapamTimerService is null — module not registered in this build');
    return;
  }
  const s = getTimerState();
  const startedAt = s.startedAt ?? Date.now();
  console.log('[NativeTimer] calling NativeModules.JapamTimerService.startTimer duration=%ds loops=%d/%d',
    s.durationSeconds, s.completedLoops, s.totalLoops);
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
    console.warn('[TimerNative] startTimer error:', e);
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
