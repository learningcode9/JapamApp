import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { Audio } from 'expo-av';
import * as Haptics from 'expo-haptics';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import * as Notifications from 'expo-notifications';
import { usePathname, useRouter } from 'expo-router';
import { getTimerState, updateTimerState } from '../lib/timerState';
import {
  appendCompletion,
  applyTombstones,
  buildSupabaseHistoryPayload,
  dedupeByCompletionId,
  getPending,
  markSynced,
  mergeTombstones,
  toLocalDayKey,
  type HistoryRecord,
} from '../lib/historyStore';
import { getWebOmAudioUri } from '../lib/webOmAudio';
import {
  getNativeTimerState,
  pauseForegroundService,
  setNativeAppActive,
  startForegroundService,
  stopForegroundService,
} from '../lib/timerForegroundService';
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  AppState,
  DeviceEventEmitter,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  Vibration,
  View,
} from 'react-native';

const TEAL = '#0F8F87';
const T_DURATION_KEY = 'timerTab_duration';
const T_LOOPS_KEY = 'timerTab_loops';
const TIMER_SECONDS_KEY = 'timerSeconds';
const TIMER_RUNNING_KEY = 'timerRunning';
const TIMER_TARGET_KEY = 'timerTarget';
const TIMER_PAUSED_KEY = 'timerPaused';
const TIMER_COMPLETED_LOOPS_KEY = 'timerCompletedLoops';
const TIMER_STARTED_AT_KEY = 'timerStartedAt';
const TIMER_SESSION_ID_KEY = 'timerSessionId';
const HISTORY_KEY = 'history';
const DELETED_COMPLETIONS_KEY = 'deletedCompletions';
const USER_ID_KEY = 'userId';
const USER_NAME_KEY = 'userName';
const SOUND_ENABLED_KEY = 'soundEnabled';
const VIBRATION_ENABLED_KEY = 'vibrationEnabled';
const WEB_OM_AUDIO_SRC = '/om_complete.mp3';
const WEB_TIMER_AUDIO_SRC = '/silent-timer.wav';

export const STD_DURATIONS = [1, 3, 5, 10, 15];
export const LOOP_OPTIONS = [1, 2, 3, 5, 10];

const getUserKey = (key: string, uid: string) => `${key}:${uid}`;
export const formatTimer = (s: number) =>
  `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

const getLocalDateKey = (date = new Date()) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

const createTimerSessionId = () =>
  `timer-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

const getCurrentMalaLabel = (completedLoops: number, selectedLoops: number, runningOrPaused = true) => {
  const safeSelectedLoops = Math.max(1, selectedLoops);
  const safeCompletedLoops = Math.min(Math.max(0, completedLoops), safeSelectedLoops);
  const activeLoop = Math.min(safeSelectedLoops, safeCompletedLoops + (runningOrPaused ? 1 : 0));
  return `Mala ${activeLoop} / ${safeSelectedLoops}`;
};

const clampCompletedLoops = (completed: number, target: number) => {
  const safeTarget = Math.max(1, target);
  return Math.min(Math.max(0, completed), safeTarget);
};

type TimerContextValue = {
  seconds: number;
  selectedDuration: number;
  selectedLoops: number;
  completedLoops: number;
  isRunning: boolean;
  timeLeft: number;
  targetSeconds: number;
  isPaused: boolean;
  isCustomDuration: boolean;
  canStart: boolean;
  start: () => void;
  pause: () => void;
  reset: () => void;
  selectDuration: (minutes: number) => void;
  selectLoops: (loops: number) => void;
};

const TimerContext = createContext<TimerContextValue | null>(null);

const pulse = (pattern: number | number[]) => {
  if (Platform.OS === 'web') return;
  try {
    Vibration.vibrate(pattern as any);
  } catch {}
};

const configureAudio = async () => {
  try {
    await Audio.setAudioModeAsync({
      playsInSilentModeIOS: true,
      staysActiveInBackground: true,
      shouldDuckAndroid: false,
      playThroughEarpieceAndroid: false,
    });
  } catch (error) {
    console.log('Audio mode error:', error);
  }
};

export function TimerProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [seconds, setSeconds] = useState(0);
  const [selectedDuration, setSelectedDuration] = useState(10);
  const [selectedLoops, setSelectedLoops] = useState(1);
  const [completedLoops, setCompletedLoops] = useState(0);
  const [isRunning, setIsRunning] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [vibrationEnabled, setVibrationEnabled] = useState(true);
  const [userId, setUserId] = useState('');
  const [isGuest, setIsGuest] = useState(false);

  const targetSeconds = selectedDuration * 60;
  const timeLeft = Math.max(0, targetSeconds - seconds);
  const isPaused = !isRunning && seconds > 0 && seconds < targetSeconds;
  const isCustomDuration = !STD_DURATIONS.includes(selectedDuration);

  const secondsRef = useRef(0);
  const isRunningRef = useRef(false);
  const completedLoopsRef = useRef(0);
  const selectedLoopsRef = useRef(1);
  const selectedDurationRef = useRef(10);
  const soundEnabledRef = useRef(true);
  const vibrationEnabledRef = useRef(true);
  const userIdRef = useRef('');
  const isGuestRef = useRef(false);
  const timerStartedAtRef = useRef<number | null>(null);
  const timerSessionIdRef = useRef('');
  const timerIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const notifIdRef = useRef<string | null>(null);
  const completionNotifIdRef = useRef<string | null>(null);
  const webRunningNotificationRef = useRef<Notification | null>(null);
  const webRunningNotificationShownRef = useRef(false);
  const webTimerAudioRef = useRef<HTMLAudioElement | null>(null);
  const webCompletionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const webCompletionNotificationShownRef = useRef(false);
  const notifIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const soundRef = useRef<Audio.Sound | null>(null);
  const isCompletingRef = useRef(false);
  const syncInFlightRef = useRef(false);
  const processedCompletionLoopsRef = useRef<Set<number>>(new Set());
  const lastSavedSessionRef = useRef<{ key: string; savedAt: number } | null>(null);
  const suppressNextCompletionSoundRef = useRef(false);
  const webCompletionAudioPrimedRef = useRef(false);
  const appStateRef = useRef(AppState.currentState);
  const wakeLockRef = useRef<any>(null);
  const omAudioContextRef = useRef<AudioContext | null>(null);
  const omAudioBufferRef = useRef<AudioBuffer | null>(null);
  const omKeepAliveAudioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => { secondsRef.current = seconds; }, [seconds]);
  useEffect(() => { isRunningRef.current = isRunning; }, [isRunning]);
  useEffect(() => { completedLoopsRef.current = completedLoops; }, [completedLoops]);
  useEffect(() => { selectedLoopsRef.current = selectedLoops; }, [selectedLoops]);
  useEffect(() => { selectedDurationRef.current = selectedDuration; }, [selectedDuration]);
  useEffect(() => { soundEnabledRef.current = soundEnabled; }, [soundEnabled]);
  useEffect(() => { vibrationEnabledRef.current = vibrationEnabled; }, [vibrationEnabled]);

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    setNativeAppActive(true);
    return () => { setNativeAppActive(false); };
  }, []);

  const getCurrentRemainingSeconds = useCallback(() => (
    Math.max(0, selectedDurationRef.current * 60 - secondsRef.current)
  ), []);

  const getActiveSessionId = useCallback(() => {
    if (!timerSessionIdRef.current) {
      timerSessionIdRef.current = createTimerSessionId();
    }
    return timerSessionIdRef.current;
  }, []);

  const primeWebCompletionAudio = useCallback(async () => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;

    // If already primed: try to resume a suspended context (e.g. after background) and
    // restart the keep-alive — both are safe no-ops if already running.
    if (webCompletionAudioPrimedRef.current) {
      const ctx = omAudioContextRef.current;
      if (ctx?.state === 'suspended') {
        await ctx.resume().catch(() => undefined);
      }
      const ka = omKeepAliveAudioRef.current;
      if (ka?.paused) {
        ka.play().catch(() => undefined);
      }
      return;
    }

    try {
      // Step 1 — Unlock iOS audio session via silent HTMLMediaElement.
      // This must fire before any async I/O so the gesture activation window is still open.
      const unlock = new window.Audio(WEB_TIMER_AUDIO_SRC);
      await unlock.play().catch(() => undefined);

      // Step 2 — Create and authorize AudioContext inside the gesture activation window.
      // ctx.resume() is the critical call; once the context is running it stays running
      // as long as audio flows through it — no further gesture needed.
      const AudioContextClass = (
        window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      );
      const ctx = new AudioContextClass();
      await ctx.resume();

      // Step 3 — Decode Om into an AudioBuffer (raw PCM in memory, ZERO audio output).
      // Nothing plays here. The buffer is reused for every loop completion.
      let omBuffer: AudioBuffer | null = null;
      try {
        const resp = await fetch(WEB_OM_AUDIO_SRC, { cache: 'force-cache' });
        if (resp.ok) {
          const arrayBuf = await resp.arrayBuffer();
          omBuffer = await ctx.decodeAudioData(arrayBuf);
        }
      } catch {
        // Decode failure: Om won't play at completion, but nothing audible leaks at start.
        console.log('[TimerBG] Om decode failed — completion sound unavailable');
      }
      omAudioBufferRef.current = omBuffer;
      omAudioContextRef.current = ctx;

      // Step 4 — Route a dedicated silent-timer.wav element through the AudioContext.
      // WHY: HTMLMediaElement playback is handled by iOS's media engine, not JS. When JS
      // is frozen in background, iOS keeps feeding the audio bitstream into the
      // MediaElementSourceNode, which keeps ctx.state === 'running'. This guarantees
      // AudioBufferSourceNode.start() works at completion without a new gesture.
      const keepAlive = new window.Audio(WEB_TIMER_AUDIO_SRC);
      keepAlive.loop = true;
      keepAlive.volume = 0;  // completely silent — sole purpose is to tick the AudioContext
      const srcNode = ctx.createMediaElementSource(keepAlive);
      srcNode.connect(ctx.destination);
      keepAlive.play().catch(() => undefined);
      omKeepAliveAudioRef.current = keepAlive;

      // Step 5 — Pre-cache Om in the browser cache for instant access at completion.
      if ('caches' in window) {
        caches.open('japam-audio-v1')
          .then((cache) => cache.add(WEB_OM_AUDIO_SRC).catch(() => undefined))
          .catch(() => undefined);
      }

      webCompletionAudioPrimedRef.current = true;
      console.log('[TimerBG] AudioContext primed for Om completion');
    } catch (error) {
      console.log('[TimerBG] Web AudioContext setup error:', error);
    }
  }, []);

  const claimCompletionLoop = useCallback((
    source: 'JS' | 'NATIVE' | 'SINGLETON',
    loopNumber: number,
    remainingSeconds: number,
    options?: { allowRunningNextLoop?: boolean }
  ) => {
    const targetMalaCount = Math.max(1, selectedLoopsRef.current);
    const currentMala = Math.min(Math.max(1, loopNumber), targetMalaCount);
    const normalizedLoop = clampCompletedLoops(loopNumber, targetMalaCount);
    const alreadyProcessed = processedCompletionLoopsRef.current.has(normalizedLoop);
    const tooEarly = remainingSeconds > 0 && !options?.allowRunningNextLoop;
    const outOfRange = loopNumber < 1 || loopNumber > targetMalaCount;

    if (alreadyProcessed || tooEarly || outOfRange) {
      console.log(
        '[COMPLETION_%s] skippedDuplicate=%s reason=%s remainingSeconds=%d currentMala=%d targetMalaCount=%d requestedLoop=%d',
        source,
        alreadyProcessed,
        alreadyProcessed ? 'already-processed' : tooEarly ? 'completion-before-expiry' : 'out-of-range',
        remainingSeconds,
        currentMala,
        targetMalaCount,
        loopNumber
      );
      return false;
    }

    processedCompletionLoopsRef.current.add(normalizedLoop);
    console.log(
      '[COMPLETION_%s] accepted remainingSeconds=%d currentMala=%d targetMalaCount=%d requestedLoop=%d',
      source,
      remainingSeconds,
      currentMala,
      targetMalaCount,
      loopNumber
    );
    return true;
  }, []);

  const releaseWakeLock = useCallback(() => {
    if (Platform.OS !== 'web') {
      deactivateKeepAwake();
      return;
    }
    if (!wakeLockRef.current) return;
    wakeLockRef.current.release?.().catch?.(() => {});
    wakeLockRef.current = null;
  }, []);

  const acquireWakeLock = useCallback(async () => {
    if (Platform.OS !== 'web') {
      await activateKeepAwakeAsync().catch(() => {});
      return;
    }
    if (typeof navigator === 'undefined') return;
    try {
      const nav = navigator as Navigator & {
        wakeLock?: { request: (type: 'screen') => Promise<any> };
      };
      if (!nav.wakeLock || wakeLockRef.current) return;
      wakeLockRef.current = await nav.wakeLock.request('screen');
      wakeLockRef.current?.addEventListener?.('release', () => {
        wakeLockRef.current = null;
        if (isRunningRef.current) void acquireWakeLock();
      });
    } catch (error) {
      console.log('Wake lock error:', error);
    }
  }, []);

  const clearTimerInterval = useCallback(() => {
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }
  }, []);

  const persistState = useCallback(async (running: boolean) => {
    const uid = userIdRef.current;
    const tSec = selectedDurationRef.current * 60;
    const currentSeconds =
      running && timerStartedAtRef.current !== null
        ? Math.max(0, Math.floor((Date.now() - timerStartedAtRef.current) / 1000))
        : secondsRef.current;
    const paused = !running && currentSeconds > 0 && currentSeconds < tSec;
    const pairs: [string, string][] = [
      [TIMER_SECONDS_KEY, String(currentSeconds)],
      [TIMER_RUNNING_KEY, String(running)],
      [TIMER_TARGET_KEY, String(tSec)],
      [TIMER_PAUSED_KEY, String(paused)],
      [TIMER_COMPLETED_LOOPS_KEY, String(completedLoopsRef.current)],
      [TIMER_STARTED_AT_KEY, running && timerStartedAtRef.current ? String(timerStartedAtRef.current) : ''],
      [TIMER_SESSION_ID_KEY, timerSessionIdRef.current],
      [T_DURATION_KEY, String(selectedDurationRef.current)],
      [T_LOOPS_KEY, String(selectedLoopsRef.current)],
    ];
    try {
      await AsyncStorage.multiSet(pairs);
      if (uid) {
        await AsyncStorage.multiSet(pairs.map(([k, v]) => [getUserKey(k, uid), v] as [string, string]));
      }
    } catch {}
  }, []);

  const persistCompletedLoops = useCallback(async (nextCompletedLoops: number) => {
    const uid = userIdRef.current;
    const value = String(clampCompletedLoops(nextCompletedLoops, selectedLoopsRef.current));
    try {
      await AsyncStorage.setItem(TIMER_COMPLETED_LOOPS_KEY, value);
      if (uid) {
        await AsyncStorage.setItem(getUserKey(TIMER_COMPLETED_LOOPS_KEY, uid), value);
      }
    } catch {}
  }, []);

  const readPersistedCompletedLoops = useCallback(async () => {
    const uid = userIdRef.current;
    try {
      const raw = uid
        ? (await AsyncStorage.getItem(getUserKey(TIMER_COMPLETED_LOOPS_KEY, uid))) ??
          (await AsyncStorage.getItem(TIMER_COMPLETED_LOOPS_KEY))
        : await AsyncStorage.getItem(TIMER_COMPLETED_LOOPS_KEY);
      return clampCompletedLoops(Number(raw) || 0, selectedLoopsRef.current);
    } catch {
      return 0;
    }
  }, []);

  const startTimerInterval = useCallback(() => {
    clearTimerInterval();
    const tick = () => {
      if (timerStartedAtRef.current === null) return;
      const elapsed = Math.floor((Date.now() - timerStartedAtRef.current) / 1000);
      secondsRef.current = elapsed;
      setSeconds(elapsed);
    };
    tick();
    timerIntervalRef.current = setInterval(tick, 1000);
  }, [clearTimerInterval]);

  const startWebTimerAudio = useCallback(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined' || typeof window.Audio === 'undefined') return;
    try {
      if (!webTimerAudioRef.current) {
        const audio = new window.Audio(WEB_TIMER_AUDIO_SRC);
        audio.loop = true;
        audio.preload = 'auto';
        audio.volume = 0.02;
        audio.setAttribute('playsinline', 'true');
        webTimerAudioRef.current = audio;
      }

      const audio = webTimerAudioRef.current;
      if (!audio.paused) return;
      audio.currentTime = 0;
      const playResult = audio.play();
      if (playResult && typeof playResult.catch === 'function') {
        playResult.catch((error) => {
          console.log('[TimerNotify] Web timer audio start error:', error);
        });
      }
    } catch (error) {
      console.log('[TimerNotify] Web timer audio setup error:', error);
    }
  }, []);

  const stopWebTimerAudio = useCallback(() => {
    if (Platform.OS !== 'web') return;
    try {
      const audio = webTimerAudioRef.current;
      if (!audio) return;
      audio.pause();
      audio.currentTime = 0;
      audio.src = '';
      audio.load();
      webTimerAudioRef.current = null;
    } catch (error) {
      console.log('[TimerNotify] Web timer audio stop error:', error);
    }
  }, []);

  const hideNotification = useCallback((opts?: { skipWebAudioCleanup?: boolean }) => {
    if (notifIntervalRef.current) {
      clearInterval(notifIntervalRef.current);
      notifIntervalRef.current = null;
    }
    if (Platform.OS === 'web') {
      if (!opts?.skipWebAudioCleanup) {
        stopWebTimerAudio();
      }
      try {
        webRunningNotificationRef.current?.close();
        webRunningNotificationRef.current = null;
        webRunningNotificationShownRef.current = false;
      } catch (error) {
        console.log('[TimerNotify] Web notification close error:', error);
      }
      return;
    }
    if (Platform.OS === 'android') {
      return;
    }
    void (async () => {
      try {
        if (notifIdRef.current) {
          await Notifications.dismissNotificationAsync(notifIdRef.current);
          notifIdRef.current = null;
        }
      } catch {}
    })();
  }, [stopWebTimerAudio]);

  const clearCompletionNotification = useCallback(() => {
    if (webCompletionTimeoutRef.current) {
      clearTimeout(webCompletionTimeoutRef.current);
      webCompletionTimeoutRef.current = null;
    }
    webCompletionNotificationShownRef.current = false;

    if (Platform.OS === 'web') return;
    void (async () => {
      try {
        if (completionNotifIdRef.current) {
          await Notifications.cancelScheduledNotificationAsync(completionNotifIdRef.current);
          completionNotifIdRef.current = null;
        }
      } catch {}
    })();
  }, []);

  const requestNotificationPermission = useCallback(async () => {
    try {
      if (Platform.OS === 'web') {
        if (typeof Notification === 'undefined') return false;
        if (Notification.permission === 'granted') return true;
        if (Notification.permission === 'denied') return false;
        return (await Notification.requestPermission()) === 'granted';
      }

      const current = await Notifications.getPermissionsAsync();
      if (current.granted) return true;
      const requested = await Notifications.requestPermissionsAsync();
      return requested.granted;
    } catch (error) {
      console.log('[TimerNotify] Permission error:', error);
      return false;
    }
  }, []);

  const showBrowserCompletionNotification = useCallback((isFinal: boolean) => {
    if (Platform.OS !== 'web') return;
    if (typeof Notification === 'undefined') return;
    if (Notification.permission !== 'granted') return;

    try {
      new Notification(isFinal ? 'Japam complete' : 'Mala completed', {
        body: 'Your Japam timer is complete',
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
        silent: false,
      });
    } catch (error) {
      console.log('[TimerNotify] Completion notification error:', error);
    }
  }, []);

  const scheduleCompletionNotification = useCallback((secondsUntilComplete: number) => {
    const delaySeconds = Math.max(1, Math.ceil(secondsUntilComplete));
    const isAndroid = Platform.OS === 'android';

    if (webCompletionTimeoutRef.current) {
      clearTimeout(webCompletionTimeoutRef.current);
      webCompletionTimeoutRef.current = null;
    }
    webCompletionNotificationShownRef.current = false;

    if (Platform.OS === 'web') {
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
      webCompletionTimeoutRef.current = setTimeout(() => {
        const isHidden =
          (typeof document !== 'undefined' && document.visibilityState !== 'visible') ||
          appStateRef.current !== 'active';
        if (!isHidden || webCompletionNotificationShownRef.current) return;
        webCompletionNotificationShownRef.current = true;
        showBrowserCompletionNotification(completedLoopsRef.current + 1 >= selectedLoopsRef.current);
      }, delaySeconds * 1000);
      return;
    }

    if (isAndroid) {
      // Simple timer mode: Android has no countdown/completion notification path.
      // Avoid scheduled notifications because Doze can delay them and create stale alerts.
      if (completionNotifIdRef.current) {
        void Notifications.cancelScheduledNotificationAsync(completionNotifIdRef.current).catch(() => {});
        completionNotifIdRef.current = null;
      }
      return;
    }

    void (async () => {
      try {
        const perm = await Notifications.getPermissionsAsync();
        if (!perm.granted) return;

        if (completionNotifIdRef.current) {
          await Notifications.cancelScheduledNotificationAsync(completionNotifIdRef.current);
          completionNotifIdRef.current = null;
        }

        completionNotifIdRef.current = await Notifications.scheduleNotificationAsync({
          content: {
            title: 'Mala completed',
            body: 'Your Japam timer is complete',
            sound: true,
            ...(Platform.OS === 'android' ? { channelId: 'japam-complete' } : {}),
          },
          trigger: {
            type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
            seconds: delaySeconds,
          },
        });
      } catch {}
    })();
  }, [showBrowserCompletionNotification]);

  const showNotification = useCallback((options?: { forceWebNotification?: boolean }) => {
    if (Platform.OS === 'web') {
      startWebTimerAudio();
      const updateWebTimerStatus = () => {
        const left = Math.max(0, selectedDurationRef.current * 60 - secondsRef.current);
        const malaLabel = getCurrentMalaLabel(completedLoopsRef.current, selectedLoopsRef.current);
        const statusText = `${malaLabel} · ${formatTimer(left)}`;

        try {
          const shouldShowNotification =
            typeof Notification !== 'undefined' &&
            Notification.permission === 'granted' &&
            (options?.forceWebNotification || !webRunningNotificationShownRef.current);

          if (shouldShowNotification) {
            webRunningNotificationRef.current?.close();
            webRunningNotificationRef.current = null;

            const notificationOptions: NotificationOptions = {
              body: statusText,
              icon: '/icons/icon-192.png',
              badge: '/icons/icon-192.png',
              tag: 'japam-timer-running',
              silent: true,
            };

            if (typeof navigator !== 'undefined' && navigator.serviceWorker?.ready) {
              navigator.serviceWorker.ready
                .then((registration) =>
                  registration.showNotification('Japam Timer running', notificationOptions)
                )
                .catch((error) => {
                  console.log('[TimerNotify] Service worker running notification error:', error);
                  webRunningNotificationRef.current = new Notification('Japam Timer running', notificationOptions);
                  webRunningNotificationRef.current.onclick = () => {
                    try {
                      if (typeof window !== 'undefined') window.focus();
                    } catch {}
                  };
                });
            } else {
              webRunningNotificationRef.current = new Notification('Japam Timer running', notificationOptions);
              webRunningNotificationRef.current.onclick = () => {
                try {
                  if (typeof window !== 'undefined') window.focus();
                } catch {}
              };
            }

            webRunningNotificationShownRef.current = true;
          }
        } catch (error) {
          console.log('[TimerNotify] Web running notification error:', error);
        }
      };

      updateWebTimerStatus();
      if (notifIntervalRef.current) clearInterval(notifIntervalRef.current);
      notifIntervalRef.current = setInterval(updateWebTimerStatus, 15000);
      return;
    }

    if (Platform.OS === 'android') {
      return;
    }

    // iOS: post a regular notification that refreshes every 60 s
    const schedule = async () => {
      try {
        const perm = await Notifications.getPermissionsAsync();
        if (!perm.granted) return;
        const left = Math.max(0, selectedDurationRef.current * 60 - secondsRef.current);
        const malaLabel = getCurrentMalaLabel(completedLoopsRef.current, selectedLoopsRef.current);
        const id = await Notifications.scheduleNotificationAsync({
          content: {
            title: 'Japam Timer',
            body: `Time left: ${formatTimer(left)} · ${malaLabel}`,
            sticky: true,
            sound: false,
          },
          trigger: null,
        } as any);
        const oldId = notifIdRef.current;
        notifIdRef.current = id;
        if (oldId) {
          try { await Notifications.dismissNotificationAsync(oldId); } catch {}
        }
      } catch {}
    };
    void schedule();
    if (notifIntervalRef.current) clearInterval(notifIntervalRef.current);
    notifIntervalRef.current = setInterval(schedule, 60000);
  }, [startWebTimerAudio]);

  // Diagnostic-only: raw (pre-dedup) snapshot of today's malas/count for this user,
  // so STATS_SAVE_* logs can show malasTodayBefore/After. Mirrors the totalCount→malas
  // math used by the stats screen; the displayed value additionally de-dupes, so treat
  // this as an approximate before/after.
  const readMalasTodaySnapshot = useCallback(async () => {
    try {
      const uid = userIdRef.current;
      const raw = await AsyncStorage.getItem(HISTORY_KEY);
      const hist: any[] = raw ? JSON.parse(raw) : [];
      const todayKey = getLocalDateKey();
      let count = 0;
      let entries = 0;
      for (const item of hist) {
        if (toLocalDayKey(item?.date) !== todayKey) continue;
        const matchesUser = uid ? item.userId === uid : !item.userId;
        if (!matchesUser) continue;
        count += Number(item.totalCount) || (Number(item.malas) || 0) * 108;
        entries += 1;
      }
      return { malas: Math.floor(count / 108), count, entries };
    } catch {
      return { malas: -1, count: -1, entries: -1 };
    }
  }, []);

  // Opportunistic offline-first sync: upload pending (not-yet-synced) records for the signed-in
  // user. On success mark them synced; on failure (offline) leave them pending to retry later.
  // Dedup is by completionId, so each record uploads at most once and never double-counts.
  const syncPendingHistory = useCallback(async () => {
    const uid = userIdRef.current;
    if (!uid) return;
    const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
    const key = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !key) return;
    // Concurrency guard: only one sync runs at a time. Overlapping triggers (after completion +
    // app-foreground/launch, especially on reconnect) would otherwise both read the same record as
    // pending and POST it twice -> duplicate Supabase rows. Re-entrant calls are skipped.
    if (syncInFlightRef.current) {
      console.log('[Stats] STATS_SYNC_SKIPPED reason=in-flight');
      return;
    }
    syncInFlightRef.current = true;
    try {
      let history: any[] = [];
      try {
        const raw = await AsyncStorage.getItem(HISTORY_KEY);
        history = raw ? JSON.parse(raw) : [];
      } catch {
        return;
      }
      console.log('[LOCAL_HISTORY_COUNT_BEFORE_SYNC] count=%d', history.length);

      // Tombstones (explicit deletions). Pull remote tombstones, merge with local, REMOVE the
      // matching local records, and push any local-only tombstones (record the tombstone + delete
      // the Supabase rows). This is the ONLY thing that deletes local records — never "absent from
      // remote", so un-uploaded offline malas are safe. Self-heal below skips tombstoned ids.
      let tombstoneSet = new Set<string>();
      try {
        const rawTomb = await AsyncStorage.getItem(DELETED_COMPLETIONS_KEY);
        const localTomb: string[] = rawTomb ? JSON.parse(rawTomb) : [];
        const encUid = encodeURIComponent(uid);
        let remoteTomb: string[] = [];
        try {
          const tRes = await fetch(
            `${url}/rest/v1/deleted_completions?user_id=eq.${encUid}&select=completion_id`,
            { headers: { apikey: key, Authorization: `Bearer ${key}` } }
          );
          if (tRes.ok) {
            remoteTomb = ((await tRes.json()) as { completion_id?: string }[]).map((r) =>
              String(r.completion_id)
            );
            console.log('[TOMBSTONE_REMOTE_COUNT] count=%d', remoteTomb.length);
          } else {
            console.log('[TOMBSTONE_FETCH_SKIPPED] status=%d', tRes.status);
          }
        } catch {
          console.log('[TOMBSTONE_FETCH_SKIPPED] reason=network');
        }
        const mergedTomb = mergeTombstones(localTomb, remoteTomb);
        tombstoneSet = new Set(mergedTomb);
        if (mergedTomb.length !== localTomb.length) {
          await AsyncStorage.setItem(DELETED_COMPLETIONS_KEY, JSON.stringify(mergedTomb));
        }
        const beforeLen = history.length;
        const filtered = applyTombstones(history, tombstoneSet);
        if (filtered.length !== beforeLen) {
          history = filtered;
          await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(filtered));
          console.log('[TOMBSTONE_APPLIED_LOCAL] removed=%d', beforeLen - filtered.length);
          DeviceEventEmitter.emit('japam-stats-updated');
          DeviceEventEmitter.emit('japam-history-updated', { userId: uid });
          if (Platform.OS === 'web' && typeof window !== 'undefined') {
            window.dispatchEvent(new Event('japam-stats-updated'));
            window.dispatchEvent(new Event('japam-history-updated'));
          }
        }
        // Propagate local-only tombstones to Supabase: record tombstone + delete the history rows.
        const localOnly = localTomb.filter((id) => !remoteTomb.includes(id));
        for (const id of localOnly) {
          try {
            await fetch(`${url}/rest/v1/deleted_completions?on_conflict=completion_id`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                apikey: key,
                Authorization: `Bearer ${key}`,
                Prefer: 'return=minimal,resolution=merge-duplicates',
              },
              body: JSON.stringify({ completion_id: id, user_id: uid }),
            });
            await fetch(
              `${url}/rest/v1/japam_history?completion_id=eq.${encodeURIComponent(id)}`,
              {
                method: 'DELETE',
                headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: 'return=minimal' },
              }
            );
            console.log('[TOMBSTONE_PUSHED] completionId=%s', id);
          } catch {
            console.log('[TOMBSTONE_PUSH_FAILED] completionId=%s reason=network', id);
          }
        }
      } catch {
        console.log('[TOMBSTONE_SKIPPED] reason=error');
      }

      const pending = getPending(history).filter((r) => r.userId === uid);
      console.log('[PENDING_RECORDS_COUNT] count=%d userId=%s', pending.length, uid);
      if (pending.length === 0) return;
      const storedUserName = (await AsyncStorage.getItem('userName')) || '';
      const storedUserEmail = (await AsyncStorage.getItem('userEmail')) || '';
      const fallbackUserName = storedUserName || storedUserEmail || 'Unknown User';
      const syncedIds: string[] = [];
      for (const rec of pending) {
        const payload = buildSupabaseHistoryPayload(rec, uid, fallbackUserName);
        console.log(
          '[SYNC_PAYLOAD_CREATED_AT] completionId=%s created_at=%s localDay=%s',
          payload.completion_id,
          payload.created_at,
          toLocalDayKey(payload.created_at)
        );
        try {
          // Idempotent upsert: on_conflict=completion_id + ignore-duplicates makes a re-uploaded
          // completion a no-op at the DB (no duplicate row). A duplicate attempt still returns ok,
          // so we treat it as success and mark the local record synced.
          const res = await fetch(`${url}/rest/v1/japam_history?on_conflict=completion_id`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              apikey: key,
              Authorization: `Bearer ${key}`,
              Prefer: 'return=minimal,resolution=merge-duplicates',
            },
            body: JSON.stringify(payload),
          });
          if (res.ok) {
            syncedIds.push(rec.completionId);
            console.log('[SYNC_SUCCESS] completionId=%s', rec.completionId);
          } else {
            console.log('[SYNC_FAILED] completionId=%s status=%d', rec.completionId, res.status);
          }
        } catch {
          // Offline / network error — stop; remaining records stay pending for the next attempt.
          console.log('[SYNC_FAILED] completionId=%s reason=network', rec.completionId);
          break;
        }
      }
    if (syncedIds.length > 0) {
      try {
        const latestRaw = await AsyncStorage.getItem(HISTORY_KEY);
        const latest = latestRaw ? JSON.parse(latestRaw) : [];
        await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(markSynced(latest, syncedIds)));
        console.log('[MARK_SYNCED] count=%d ids=%s', syncedIds.length, syncedIds.join(','));
        DeviceEventEmitter.emit('japam-stats-updated');
        DeviceEventEmitter.emit('japam-history-updated', { userId: uid || 'guest' });
        if (Platform.OS === 'web' && typeof window !== 'undefined') {
          window.dispatchEvent(new Event('japam-stats-updated'));
          window.dispatchEvent(new Event('japam-history-updated'));
        }
      } catch {}
    }
    } finally {
      syncInFlightRef.current = false;
    }
  }, []);

  // Mirrors tap-japam.tsx/index.tsx's saveUserTotalToSupabase exactly (same request shape) — the
  // Timer flow previously only wrote japam_history, never japam_user_totals, so Groups Dashboard's
  // Lifetime Count (sourced from japam_user_totals) stayed at 0 for Timer-only users even though
  // Today's Count (sourced from japam_history) was correct. Computes the lifetime total the same
  // way history.tsx computes "Total Malas"/"Total Count": dedupe by completionId, filter to this
  // user's own records, sum totalCount. Never throws — a failed upsert must not block completion.
  const syncLifetimeTotalToSupabase = useCallback(async (uid: string, history: HistoryRecord[]) => {
    try {
      const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
      const key = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
      if (!url || !key || !uid) return;

      const ownRecords = dedupeByCompletionId(history).filter(
        (r) => (r.userId || null) === uid && r.totalCount > 0
      );
      const lifetimeTotalCount = ownRecords.reduce((sum, r) => sum + (Number(r.totalCount) || 0), 0);

      const storedUserName = await AsyncStorage.getItem(USER_NAME_KEY);

      const response = await fetch(`${url}/rest/v1/japam_user_totals?on_conflict=user_id`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: key,
          Authorization: `Bearer ${key}`,
          Prefer: 'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify({
          user_id: uid,
          user_name: storedUserName || 'User',
          total_count: lifetimeTotalCount,
          malas: Math.floor(lifetimeTotalCount / 108),
          count: lifetimeTotalCount % 108,
          updated_at: new Date().toISOString(),
        }),
      });

      if (!response.ok) console.log('[TimerLifetimeTotal] upsert error:', await response.text());
    } catch (err) {
      console.log('[TimerLifetimeTotal] upsert failed (non-blocking):', err);
    }
  }, []);

  const saveSession = useCallback(async () => {
    const uid = userIdRef.current;
    const duration = selectedDurationRef.current * 60;
    const before = await readMalasTodaySnapshot();
    const pausedNow = !isRunningRef.current && secondsRef.current > 0 && secondsRef.current < duration;
    console.log('[Stats] STATS_SAVE_REQUEST completionSource=JS currentMala=%d targetMalaCount=%d completedLoops=%d isPaused=%s isRunning=%s malasTodayBefore=%d todayCountBefore=%d entriesBefore=%d',
      completedLoopsRef.current, selectedLoopsRef.current, completedLoopsRef.current,
      pausedNow, isRunningRef.current, before.malas, before.count, before.entries);
    const sessionKey = [
      uid || 'guest',
      duration,
      completedLoopsRef.current,
      selectedLoopsRef.current,
      getLocalDateKey(),
    ].join(':');
    const lastSaved = lastSavedSessionRef.current;
    if (lastSaved?.key === sessionKey && Date.now() - lastSaved.savedAt < 30000) {
      console.log('[Stats] STATS_SAVE_SKIPPED reason=recent-duplicate sessionKey=%s malasTodayBefore=%d', sessionKey, before.malas);
      return;
    }
    // Also skip if this active timer session already saved this loop index.
    if (getTimerState().lastSavedCompletedLoops >= completedLoopsRef.current) {
      console.log('[Stats] STATS_SAVE_SKIPPED reason=bg-already-saved loop=%d lastSavedCompletedLoops=%d malasTodayBefore=%d',
        completedLoopsRef.current, getTimerState().lastSavedCompletedLoops, before.malas);
      // Still emit stats events in case the foreground listener missed the background emit
      DeviceEventEmitter.emit('japam-stats-updated');
      DeviceEventEmitter.emit('japam-history-updated', { userId: uid || 'guest' });
      console.log('[StatsRefresh] Events re-emitted from foreground path');
      return;
    }
    lastSavedSessionRef.current = { key: sessionKey, savedAt: Date.now() };
    updateTimerState({ lastSavedCompletedLoops: completedLoopsRef.current });

    const now = new Date();
    console.log('[TimerSessionDate] deviceLocalTime=%s generatedDateKey=%s sessionIso=%s',
      now.toString(),
      getLocalDateKey(now),
      now.toISOString()
    );
    const [storedUserName, storedUserEmail] = uid
      ? await Promise.all([
          AsyncStorage.getItem('userName'),
          AsyncStorage.getItem('userEmail'),
        ])
      : [null, null];
    const completionUserName = storedUserName || storedUserEmail || (uid ? 'Unknown User' : undefined);
    const completion = {
      date: now.toISOString(),
      malas: 1,
      totalCount: 108,
      duration,
      manual: false,
      userId: uid || null,
      userName: completionUserName,
      userEmail: storedUserEmail || undefined,
    };

    // Local save FIRST (offline-first) + event emission — awaited by completeCycle so stats
    // refresh immediately. appendCompletion stamps a stable completionId and syncStatus:'pending'.
    try {
      const raw = await AsyncStorage.getItem(HISTORY_KEY);
      const history = raw ? JSON.parse(raw) : [];
      const updatedHistory = appendCompletion(history, completion);
      await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(updatedHistory));
      console.log(
        '[OFFLINE_SAVE_ACCEPTED] source=timer completionId=%s created_at=%s localDay=%s syncStatus=%s',
        updatedHistory[0]?.completionId,
        updatedHistory[0]?.date,
        toLocalDayKey(updatedHistory[0]?.date),
        updatedHistory[0]?.syncStatus
      );

      const after = await readMalasTodaySnapshot();
      console.log('[Stats] STATS_SAVE_ACCEPTED completionSource=JS currentMala=%d targetMalaCount=%d malasTodayAfter=%d todayCountAfter=%d entriesAfter=%d',
        completedLoopsRef.current, selectedLoopsRef.current, after.malas, after.count, after.entries);
      DeviceEventEmitter.emit('japam-stats-updated');
      DeviceEventEmitter.emit('japam-history-updated', { userId: uid || 'guest' });
      if (Platform.OS === 'web' && typeof window !== 'undefined') {
        window.dispatchEvent(new Event('japam-stats-updated'));
        window.dispatchEvent(new Event('japam-history-updated'));
      }

      // Fire-and-forget: keeps Groups Dashboard's Lifetime Count correct for Timer completions.
      // syncLifetimeTotalToSupabase never throws and a failure here must never block completion.
      if (uid) void syncLifetimeTotalToSupabase(uid, updatedHistory);
    } catch (err) {
      console.log('Timer session save error:', err);
      return;
    }

    // Opportunistic sync — uploads all pending records (including this one). Offline-safe:
    // records stay 'pending' and retry on the next attempt. Never blocks completeCycle.
    void syncPendingHistory();
  }, [readMalasTodaySnapshot, syncPendingHistory, syncLifetimeTotalToSupabase]);

  // Flush any pending (offline-recorded) malas on launch and whenever the app returns to the
  // foreground — i.e. opportunistically when connectivity is likely back. No-op when offline.
  useEffect(() => {
    console.log('[SYNC_TRIGGER_SOURCE] source=timer-provider-mount');
    void syncPendingHistory();
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        console.log('[SYNC_TRIGGER_SOURCE] source=appstate-active');
        void syncPendingHistory();
      }
    });
    const onOnline = () => {
      console.log('[SYNC_TRIGGER_SOURCE] source=browser-online');
      void syncPendingHistory();
    };
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      window.addEventListener('online', onOnline);
    }
    return () => {
      sub.remove();
      if (Platform.OS === 'web' && typeof window !== 'undefined') {
        window.removeEventListener('online', onOnline);
      }
    };
  }, [syncPendingHistory]);

  const refreshAuthState = useCallback(async () => {
    const uid = await AsyncStorage.getItem(USER_ID_KEY) || '';
    const guestName = await AsyncStorage.getItem(USER_NAME_KEY);
    const prevUid = userIdRef.current;
    userIdRef.current = uid;
    isGuestRef.current = !uid && !!guestName;
    setUserId(uid);
    setIsGuest(!uid && !!guestName);
    updateTimerState({ userId: uid });

    if (!uid && !guestName) {
      clearTimerInterval();
      releaseWakeLock();
      setIsRunning(false);
      isRunningRef.current = false;
      setSeconds(0);
      secondsRef.current = 0;
      setCompletedLoops(0);
      completedLoopsRef.current = 0;
      isCompletingRef.current = false;
      timerStartedAtRef.current = null;
      timerSessionIdRef.current = '';
      updateTimerState({ sessionId: '', startedAt: null, completedLoops: 0, isCompleting: false });
      void hideNotification();
      if (Platform.OS === 'android') void stopForegroundService();
    }

    // When a user just signed in (uid transitions from empty to a real value), flush any pending
    // records immediately — covers Guest → Google migration records.
    if (uid && !prevUid) void syncPendingHistory();
  }, [clearTimerInterval, hideNotification, releaseWakeLock, syncPendingHistory]);

  const completeCycle = useCallback(async () => {
    if (isCompletingRef.current) {
      console.log(
        '[COMPLETION_JS] skippedDuplicate=true reason=isCompleting remainingSeconds=%d currentMala=%d targetMalaCount=%d',
        getCurrentRemainingSeconds(),
        clampCompletedLoops(completedLoopsRef.current + 1, selectedLoopsRef.current),
        selectedLoopsRef.current
      );
      return;
    }
    // Guard against duplicate completion for the same loop.
    if (getTimerState().isCompleting) {
      console.log(
        '[COMPLETION_JS] skippedDuplicate=true reason=singleton-isCompleting remainingSeconds=%d currentMala=%d targetMalaCount=%d',
        getCurrentRemainingSeconds(),
        clampCompletedLoops(completedLoopsRef.current + 1, selectedLoopsRef.current),
        selectedLoopsRef.current
      );
      return;
    }
    const currentDone = clampCompletedLoops(completedLoopsRef.current, selectedLoopsRef.current);
    if (currentDone >= selectedLoopsRef.current) {
      console.log(
        '[LoopComplete] skipped source=JS reason=already-complete remaining=%d currentMala=%d targetMalaCount=%d',
        Math.max(0, selectedDurationRef.current * 60 - secondsRef.current),
        currentDone,
        selectedLoopsRef.current
      );
      clearTimerInterval();
      releaseWakeLock();
      setIsRunning(false);
      isRunningRef.current = false;
      setCompletedLoops(selectedLoopsRef.current);
      completedLoopsRef.current = selectedLoopsRef.current;
      timerSessionIdRef.current = '';
      updateTimerState({ sessionId: '', completedLoops: selectedLoopsRef.current, isCompleting: false, startedAt: null });
      void hideNotification();
      void persistState(false);
      return;
    }
    const nextLoop = currentDone + 1;
    const remainingBeforeCompletion = getCurrentRemainingSeconds();
    if (!claimCompletionLoop('JS', nextLoop, remainingBeforeCompletion)) {
      updateTimerState({ isCompleting: false });
      isCompletingRef.current = false;
      return;
    }
    isCompletingRef.current = true;
    updateTimerState({ isCompleting: true }); // block duplicate completion handling
    console.log(
      '[LoopComplete] Foreground handling loop completion source=JS remaining=%d currentMala=%d targetMalaCount=%d',
      remainingBeforeCompletion,
      currentDone,
      selectedLoopsRef.current
    );

    clearTimerInterval();
    releaseWakeLock();
    setIsRunning(false);
    isRunningRef.current = false;
    hideNotification(Platform.OS === 'web' ? { skipWebAudioCleanup: true } : undefined);
    const completedInBackground = appStateRef.current !== 'active';
    if (!completedInBackground) {
      clearCompletionNotification();
    }

    const newDone = clampCompletedLoops(nextLoop, selectedLoopsRef.current);
    setCompletedLoops(newDone);
    completedLoopsRef.current = newDone;
    updateTimerState({ completedLoops: newDone });
    await persistCompletedLoops(newDone);
    const isFinal = newDone >= selectedLoopsRef.current;
    console.log('[LoopComplete] Foreground: loop %d/%d done, isFinal=%s source=JS', newDone, selectedLoopsRef.current, isFinal);
    console.log('[Stats] MALA_COMPLETE completionSource=JS currentMala=%d targetMalaCount=%d isFinal=%s isPaused=%s isRunning=%s',
      newDone, selectedLoopsRef.current, isFinal, false, isRunningRef.current);

    if (vibrationEnabledRef.current && Platform.OS !== 'web') {
      pulse([0, 1200, 80, 1500]);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      setTimeout(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {}), 400);
    }

    if (completedInBackground && !webCompletionNotificationShownRef.current) {
      webCompletionNotificationShownRef.current = true;
      showBrowserCompletionNotification(isFinal);
    }

    const shouldPlaySound = soundEnabledRef.current && !suppressNextCompletionSoundRef.current;
    suppressNextCompletionSoundRef.current = false;

    if (shouldPlaySound) {
      try {
        if (Platform.OS === 'web') {
          // Play Om via the pre-authorized AudioContext.
          // AudioBufferSourceNode.start() does not require a user gesture — it only requires
          // the AudioContext to be in 'running' state, which is maintained by the keep-alive
          // MediaElementSource even while JS is frozen in iOS background.
          const ctx = omAudioContextRef.current;
          const buf = omAudioBufferRef.current;
          if (ctx && buf && ctx.state === 'running') {
            const source = ctx.createBufferSource();
            source.buffer = buf;
            source.connect(ctx.destination);
            await new Promise<void>((resolve) => {
              let done = false;
              const finish = () => { if (done) return; done = true; resolve(); };
              const cutoff = setTimeout(() => {
                try { source.stop(); } catch {}
                finish();
              }, 5000);
              source.onended = () => { clearTimeout(cutoff); finish(); };
              source.start(0);
            });
          }
        } else {
          const sound = soundRef.current;
          if (sound) {
            await sound.stopAsync().catch(() => {});
            await sound.playAsync();
            await new Promise<void>((resolve) => {
              let done = false;
              const finish = () => {
                if (done) return;
                done = true;
                sound.setOnPlaybackStatusUpdate(null);
                resolve();
              };
              const cutoff = setTimeout(async () => {
                await sound.stopAsync().catch(() => {});
                finish();
              }, 5000);
              sound.setOnPlaybackStatusUpdate((status) => {
                if (status.isLoaded && status.didJustFinish) {
                  clearTimeout(cutoff);
                  finish();
                }
              });
            });
          }
        }
      } catch {}
    }
    // Om has played (or was skipped). Now safe to release the web audio session.
    if (Platform.OS === 'web') {
      stopWebTimerAudio();
    }
    // Save session after Om: local write + stats events fire after sound completes.
    await saveSession();

    if (isFinal) {
      timerSessionIdRef.current = '';
      updateTimerState({ sessionId: '', isCompleting: false, startedAt: null });
      if (Platform.OS === 'android') void stopForegroundService();
      void persistState(false);
      isCompletingRef.current = false;
      console.log('[LoopComplete] All loops done in foreground');
      return;
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 1000));
    isCompletingRef.current = false;
    setSeconds(0);
    secondsRef.current = 0;
    timerStartedAtRef.current = Date.now();
    // Update singleton with new loop's startedAt BEFORE starting background service
    updateTimerState({
      sessionId: timerSessionIdRef.current,
      startedAt: timerStartedAtRef.current,
      completedLoops: newDone,
      isCompleting: false,
    });
    console.log('[TimerBG] Foreground starting loop %d at %d', newDone + 1, timerStartedAtRef.current);
    setIsRunning(true);
    isRunningRef.current = true;
    startTimerInterval();
    void acquireWakeLock();
    showNotification();
    scheduleCompletionNotification(selectedDurationRef.current * 60);
    void persistState(true);
    if (Platform.OS === 'android') {
      void startForegroundService({
        sessionId: timerSessionIdRef.current,
        durationSeconds: selectedDurationRef.current * 60,
        completedLoops: completedLoopsRef.current,
        totalLoops: selectedLoopsRef.current,
        soundEnabled: soundEnabledRef.current,
        vibrationEnabled: vibrationEnabledRef.current,
        userId: userIdRef.current,
        startedAt: timerStartedAtRef.current!,
      });
    }
  }, [
    acquireWakeLock,
    claimCompletionLoop,
    clearTimerInterval,
    clearCompletionNotification,
    getCurrentRemainingSeconds,
    hideNotification,
    persistState,
    releaseWakeLock,
    saveSession,
    persistCompletedLoops,
    primeWebCompletionAudio,
    scheduleCompletionNotification,
    showNotification,
    showBrowserCompletionNotification,
    startTimerInterval,
  ]);

  useEffect(() => {
    let active = true;
    void (async () => {
      const [dur, loops, snd, vib, uid] = await Promise.all([
        AsyncStorage.getItem(T_DURATION_KEY),
        AsyncStorage.getItem(T_LOOPS_KEY),
        AsyncStorage.getItem(SOUND_ENABLED_KEY),
        AsyncStorage.getItem(VIBRATION_ENABLED_KEY),
        AsyncStorage.getItem(USER_ID_KEY),
      ]);
      if (!active) return;
      if (dur) {
        setSelectedDuration(Number(dur));
        selectedDurationRef.current = Number(dur);
      }
      if (loops) {
        setSelectedLoops(Number(loops));
        selectedLoopsRef.current = Number(loops);
      }
      setSoundEnabled(snd !== 'false');
      soundEnabledRef.current = snd !== 'false';
      setVibrationEnabled(vib !== 'false');
      vibrationEnabledRef.current = vib !== 'false';
      userIdRef.current = uid || '';
      setUserId(uid || '');
      // Keep singleton in sync with loaded preferences
      updateTimerState({
        soundEnabled: snd !== 'false',
        vibrationEnabled: vib !== 'false',
        userId: uid || '',
      });
    })();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    void refreshAuthState().then(() => {
      if (!active) return;
    });
    return () => { active = false; };
  }, [pathname, refreshAuthState]);

  useEffect(() => {
    const sync = () => {
      void refreshAuthState();
    };
    const sub = DeviceEventEmitter.addListener('japam-auth-updated', sync);
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      window.addEventListener('japam-auth-updated', sync);
    }
    return () => {
      sub.remove();
      if (Platform.OS === 'web' && typeof window !== 'undefined') {
        window.removeEventListener('japam-auth-updated', sync);
      }
    };
  }, [refreshAuthState]);

  // Android: receive loop-complete broadcasts from Kotlin when app is backgrounded.
  // claimCompletionLoop's Set prevents double-saves if reconcileNativeLoops already
  // handled the same loop on foreground restore.
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const sub = DeviceEventEmitter.addListener(
      'japamTimerLoopComplete',
      async (event: { sessionId: string; completedLoops: number; isFinal: boolean; userId: string }) => {
        if (appStateRef.current === 'active') return; // foreground: JS or reconcile handles it
        if (!event.sessionId || event.sessionId !== timerSessionIdRef.current) return;
        const loop = event.completedLoops;
        if (!claimCompletionLoop('NATIVE', loop, 0, { allowRunningNextLoop: true })) return;
        const clamped = clampCompletedLoops(loop, selectedLoopsRef.current);
        completedLoopsRef.current = clamped;
        await persistCompletedLoops(clamped);
        await saveSession();
        console.log('[NativeTimer] japamTimerLoopComplete background save loop=%d isFinal=%s', loop, event.isFinal);
      }
    );
    return () => sub.remove();
  }, [claimCompletionLoop, persistCompletedLoops, saveSession]);

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    void Notifications.setNotificationChannelAsync('japam-timer', {
      name: 'Japam Timer',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [],
      enableVibrate: false,
      showBadge: false,
    });
    void Notifications.setNotificationChannelAsync('japam-complete', {
      name: 'Completion',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250],
      enableVibrate: true,
      showBadge: false,
    });
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        await configureAudio();
        // Web: load the Om from an in-memory blob: URL (cached once while online) so the
        // completion sound plays OFFLINE. Falls back to the network URL if the fetch fails.
        const source = Platform.OS === 'web'
          ? { uri: await getWebOmAudioUri() }
          : require('../assets/om_complete.mp3');
        const { sound } = await Audio.Sound.createAsync(
          source,
          { shouldPlay: false, isLooping: false, volume: 0.95 }
        );
        soundRef.current = sound;
        webCompletionAudioPrimedRef.current = false;
        // Keep the loaded sound object available to the active timer context.
        updateTimerState({ soundObject: sound as any });
        console.log('[TimerBG] Om sound loaded and registered in singleton');
      } catch {}
    })();
    return () => {
      soundRef.current?.unloadAsync().catch(() => {});
      soundRef.current = null;
      webCompletionAudioPrimedRef.current = false;
      updateTimerState({ soundObject: null });
    };
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const uid = await AsyncStorage.getItem(USER_ID_KEY) || '';
        userIdRef.current = uid;
        setUserId(uid);
        const get = async (key: string) =>
          uid
            ? (await AsyncStorage.getItem(getUserKey(key, uid))) ?? (await AsyncStorage.getItem(key))
            : AsyncStorage.getItem(key);
        const [sec, target, dur, loops, paused, completed, running, startedAt, sessionId] = await Promise.all([
          get(TIMER_SECONDS_KEY),
          get(TIMER_TARGET_KEY),
          get(T_DURATION_KEY),
          get(T_LOOPS_KEY),
          get(TIMER_PAUSED_KEY),
          get(TIMER_COMPLETED_LOOPS_KEY),
          get(TIMER_RUNNING_KEY),
          get(TIMER_STARTED_AT_KEY),
          get(TIMER_SESSION_ID_KEY),
        ]);
        const savedSec = Number(sec) || 0;
        const savedTarget = Number(target) || 0;
        const savedDur = Number(dur) || 0;
        const savedLoops = Number(loops) || 0;
        const savedCompletedLoops = Math.max(0, Number(completed) || 0);
        const savedPaused = paused === 'true';
        const savedRunning = running === 'true';
        const savedStartedAt = Number(startedAt) || 0;
        const savedSessionId = sessionId || (savedRunning ? createTimerSessionId() : '');
        timerSessionIdRef.current = savedSessionId;
        if (savedDur > 0) {
          setSelectedDuration(savedDur);
          selectedDurationRef.current = savedDur;
        } else if (savedTarget > 0) {
          const mins = Math.round(savedTarget / 60);
          setSelectedDuration(mins);
          selectedDurationRef.current = mins;
        }
        if (LOOP_OPTIONS.includes(savedLoops)) {
          setSelectedLoops(savedLoops);
          selectedLoopsRef.current = savedLoops;
        }
        const activeLoopLimit = LOOP_OPTIONS.includes(savedLoops) ? savedLoops : selectedLoopsRef.current;

        const safeCompletedLoops = Math.min(savedCompletedLoops, Math.max(0, activeLoopLimit - 1));
        if (safeCompletedLoops > 0) {
          setCompletedLoops(safeCompletedLoops);
          completedLoopsRef.current = safeCompletedLoops;
        }
        const restoredTarget = savedTarget || selectedDurationRef.current * 60;
        const elapsedSinceSavedStart =
          savedRunning && savedStartedAt > 0
            ? Math.max(0, Math.floor((Date.now() - savedStartedAt) / 1000))
            : savedSec;
        const savedRunningStillActive =
          savedRunning && savedStartedAt > 0 && restoredTarget > 0 && elapsedSinceSavedStart < restoredTarget;
        const restoredSeconds = Math.min(
          Math.max(0, elapsedSinceSavedStart),
          Math.max(0, restoredTarget - 1)
        );
        const savedTimerCompleted =
          restoredTarget > 0 && (savedCompletedLoops >= activeLoopLimit || savedSec >= restoredTarget);
        const hasPausedProgress =
          restoredSeconds > 0 &&
          restoredSeconds < restoredTarget &&
          !savedRunningStillActive &&
          !savedTimerCompleted;

        if (savedRunningStillActive) {
          setSeconds(restoredSeconds);
          secondsRef.current = restoredSeconds;
          setIsRunning(true);
          isRunningRef.current = true;
          timerStartedAtRef.current = savedStartedAt;
          updateTimerState({
            startedAt: savedStartedAt,
            sessionId: savedSessionId,
            durationSeconds: restoredTarget,
            completedLoops: safeCompletedLoops,
            totalLoops: activeLoopLimit,
            userId: uid,
            appIsActive: appStateRef.current === 'active',
          });
          startTimerInterval();
          void acquireWakeLock();
          void showNotification();
          scheduleCompletionNotification(restoredTarget - restoredSeconds);
          void persistState(true);
          console.log('[TimerBG] TIMER_RESTORE_RUNNING source=hydrate startedAt=%d elapsed=%ds target=%ds completedLoops=%d/%d',
            savedStartedAt, restoredSeconds, restoredTarget, safeCompletedLoops, activeLoopLimit);
        } else if (
          (savedPaused || savedRunning || hasPausedProgress) &&
          restoredSeconds > 0 &&
          restoredTarget > 0
        ) {
          setSeconds(restoredSeconds);
          secondsRef.current = restoredSeconds;
          setIsRunning(false);
          isRunningRef.current = false;
          timerStartedAtRef.current = null;
          updateTimerState({ sessionId: savedSessionId });
          console.log('[TimerBG] TIMER_RESTORE_PAUSED elapsed=%ds target=%ds completedLoops=%d/%d inferred=%s',
            restoredSeconds, restoredTarget, safeCompletedLoops, activeLoopLimit, hasPausedProgress);
        }
      } catch {}
    })();
  }, [acquireWakeLock, persistState, scheduleCompletionNotification, showNotification, startTimerInterval]);

  useEffect(() => {
    if (isRunning && seconds > 0 && seconds >= targetSeconds && !isCompletingRef.current) {
      void completeCycle();
    }
  }, [completeCycle, isRunning, seconds, targetSeconds]);

  const restoreRunningTimerFromStorage = useCallback(async () => {
    try {
      const uid = await AsyncStorage.getItem(USER_ID_KEY) || '';
      const get = async (key: string) =>
        uid
          ? (await AsyncStorage.getItem(getUserKey(key, uid))) ?? (await AsyncStorage.getItem(key))
          : AsyncStorage.getItem(key);
      const [sec, target, dur, loops, completed, running, startedAt, sessionId] = await Promise.all([
        get(TIMER_SECONDS_KEY),
        get(TIMER_TARGET_KEY),
        get(T_DURATION_KEY),
        get(T_LOOPS_KEY),
        get(TIMER_COMPLETED_LOOPS_KEY),
        get(TIMER_RUNNING_KEY),
        get(TIMER_STARTED_AT_KEY),
        get(TIMER_SESSION_ID_KEY),
      ]);

      const savedRunning = running === 'true';
      const savedTarget = Number(target) || 0;
      const savedDuration = Number(dur) || 0;
      const restoredTarget = savedTarget || savedDuration * 60 || selectedDurationRef.current * 60;
      const savedStartedAt = Number(startedAt) || 0;
      const savedSeconds = Number(sec) || 0;
      if (!savedRunning || restoredTarget <= 0) return false;
      const restoredSessionId = sessionId || createTimerSessionId();

      const restoredStartedAt = savedStartedAt > 0
        ? savedStartedAt
        : Date.now() - savedSeconds * 1000;
      const elapsed = Math.max(0, Math.floor((Date.now() - restoredStartedAt) / 1000));
      if (elapsed >= restoredTarget) return false;

      const savedLoops = Number(loops) || 0;
      const activeLoopLimit = LOOP_OPTIONS.includes(savedLoops) ? savedLoops : selectedLoopsRef.current;
      const safeCompletedLoops = Math.min(
        Math.max(0, Number(completed) || 0),
        Math.max(0, activeLoopLimit - 1)
      );
      const restoredDuration = savedDuration > 0 ? savedDuration : Math.round(restoredTarget / 60);

      setSelectedDuration(restoredDuration);
      selectedDurationRef.current = restoredDuration;
      setSelectedLoops(activeLoopLimit);
      selectedLoopsRef.current = activeLoopLimit;
      setCompletedLoops(safeCompletedLoops);
      completedLoopsRef.current = safeCompletedLoops;
      setSeconds(elapsed);
      secondsRef.current = elapsed;
      timerStartedAtRef.current = restoredStartedAt;
      timerSessionIdRef.current = restoredSessionId;
      setIsRunning(true);
      isRunningRef.current = true;
      updateTimerState({
        sessionId: restoredSessionId,
        startedAt: restoredStartedAt,
        durationSeconds: restoredTarget,
        completedLoops: safeCompletedLoops,
        totalLoops: activeLoopLimit,
        userId: uid,
        appIsActive: appStateRef.current === 'active',
      });
      startTimerInterval();
      void acquireWakeLock();
      void persistState(true);
      console.log('[TimerBG] TIMER_RESTORE_RUNNING sessionId=%s startedAt=%d elapsed=%ds target=%ds completedLoops=%d/%d',
        restoredSessionId, restoredStartedAt, elapsed, restoredTarget, safeCompletedLoops, activeLoopLimit);
      return true;
    } catch (error) {
      console.log('[TimerBG] Restore running timer error:', error);
      return false;
    }
  }, [acquireWakeLock, persistState, startTimerInterval]);

  useEffect(() => {
    if (!isRunning) return;
    const iv = setInterval(() => void persistState(true), 10000);
    return () => clearInterval(iv);
  }, [isRunning, persistState]);

  // Android only: on foreground restore, save any malas Kotlin completed while JS was
  // asleep, then re-anchor the JS ticker to Kotlin's in-progress mala startedAt.
  const reconcileNativeLoops = useCallback(async () => {
    if (Platform.OS !== 'android') return;
    try {
      const native = await getNativeTimerState();
      if (!native || !native.sessionId || native.sessionId !== timerSessionIdRef.current) return;

      const jsDone = completedLoopsRef.current;
      const nativeDone = native.completedLoops;
      if (nativeDone > jsDone) {
        for (let loop = jsDone + 1; loop <= nativeDone; loop++) {
          if (!claimCompletionLoop('NATIVE', loop, 0, { allowRunningNextLoop: true })) continue;
          const clamped = clampCompletedLoops(loop, selectedLoopsRef.current);
          completedLoopsRef.current = clamped;
          setCompletedLoops(clamped);
          updateTimerState({ completedLoops: clamped });
          await persistCompletedLoops(clamped);
          await saveSession();
        }
      }

      // Kotlin still has a mala in flight — re-anchor JS ticker to its startedAt
      const moreToGo = completedLoopsRef.current < selectedLoopsRef.current;
      if (moreToGo && native.isRunning && !native.isPaused && native.startedAt > 0) {
        timerStartedAtRef.current = native.startedAt;
        updateTimerState({ startedAt: native.startedAt });
        const elapsed = Math.max(0, Math.floor((Date.now() - native.startedAt) / 1000));
        setSeconds(elapsed);
        secondsRef.current = elapsed;
        setIsRunning(true);
        isRunningRef.current = true;
        startTimerInterval();
        void acquireWakeLock();
        void persistState(true);
        console.log('[TimerBG] reconcileNativeLoops: restarted JS ticker elapsed=%ds loop=%d/%d',
          elapsed, completedLoopsRef.current, selectedLoopsRef.current);
      }

      // All loops done and Kotlin service stopped — clear stale seconds that was
      // snapshotted when app backgrounded mid-mala, which would otherwise leave
      // isPaused=true and show Resume instead of Start.
      if (!moreToGo && !native.isRunning) {
        const targetSec = selectedDurationRef.current * 60;
        setSeconds(targetSec);
        secondsRef.current = targetSec;
        timerStartedAtRef.current = null;
        timerSessionIdRef.current = '';
        updateTimerState({ startedAt: null, isCompleting: false, sessionId: '' });
        void persistState(false);
        console.log('[TimerBG] reconcileNativeLoops: final completion, cleared stale UI state loops=%d/%d',
          completedLoopsRef.current, selectedLoopsRef.current);
      }
    } catch (e) {
      console.log('[TimerBG] reconcileNativeLoops error:', e);
    }
  }, [acquireWakeLock, claimCompletionLoop, persistCompletedLoops, persistState, saveSession, startTimerInterval]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'background' && appStateRef.current !== 'background') {
        const wasRunning = isRunningRef.current;
        if (isRunningRef.current && timerStartedAtRef.current !== null) {
          const elapsed = Math.max(0, Math.floor((Date.now() - timerStartedAtRef.current) / 1000));
          secondsRef.current = elapsed;
          setSeconds(Math.min(elapsed, Math.max(0, selectedDurationRef.current * 60 - 1)));
        }
        clearTimerInterval();
        releaseWakeLock();
        setIsRunning(false);
        isRunningRef.current = false;
        timerStartedAtRef.current = null;
        updateTimerState({ appIsActive: false, startedAt: null, isCompleting: false });
        soundRef.current?.stopAsync().catch(() => {});
        void hideNotification();
        clearCompletionNotification();
        if (Platform.OS === 'android') setNativeAppActive(false);
        void persistState(false);
        console.log('[TimerBG] App backgrounded, simple JS timer paused wasRunning=%s seconds=%d', wasRunning, secondsRef.current);
      }

      if (next === 'active' && appStateRef.current !== 'active') {
        updateTimerState({ appIsActive: true });
        if (Platform.OS === 'android') {
          setNativeAppActive(true);
          void reconcileNativeLoops().then(() => {
            if (!isRunningRef.current) void restoreRunningTimerFromStorage();
          });
        } else {
          if (!isRunningRef.current) void restoreRunningTimerFromStorage();
        }
      }

      appStateRef.current = next;
    });
    return () => sub.remove();
  }, [
    clearTimerInterval,
    clearCompletionNotification,
    hideNotification,
    persistState,
    reconcileNativeLoops,
    releaseWakeLock,
    restoreRunningTimerFromStorage,
  ]);

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    const onVis = () => {
      if (document.visibilityState !== 'visible') {
        if (isRunningRef.current && timerStartedAtRef.current !== null) {
          secondsRef.current = Math.max(0, Math.floor((Date.now() - timerStartedAtRef.current) / 1000));
        }
        if (isRunningRef.current) {
          void showNotification({ forceWebNotification: true });
        }
        void persistState(isRunningRef.current);
        return;
      }

      if (document.visibilityState === 'visible') {
        if (isRunningRef.current) {
          void acquireWakeLock();
          void showNotification();
          return;
        }
        void restoreRunningTimerFromStorage();
      }
    };
    const onPageHide = () => {
      if (isRunningRef.current && timerStartedAtRef.current !== null) {
        secondsRef.current = Math.max(0, Math.floor((Date.now() - timerStartedAtRef.current) / 1000));
      }
      if (isRunningRef.current) {
        void showNotification({ forceWebNotification: true });
      }
      void persistState(isRunningRef.current);
    };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, [acquireWakeLock, persistState, restoreRunningTimerFromStorage, showNotification]);

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    document.title = isRunning ? `⏱ ${formatTimer(timeLeft)} — Mantra Japam` : 'Mantra Japam';
  }, [isRunning, timeLeft]);

  // Diagnostic: surface the button label the UI derives from (isRunning, isPaused)
  // so running/paused desyncs are visible in logcat.
  useEffect(() => {
    const label = isRunning ? 'Pause' : isPaused ? 'Resume' : 'Start';
    console.log('[TimerBG] BUTTON_STATE label=%s isRunning=%s isPaused=%s', label, isRunning, isPaused);
  }, [isRunning, isPaused]);

  useEffect(() => {
    if (!isRunning) return;
    void showNotification();
    // 'seconds' intentionally excluded — including it caused showNotification() to fire every
    // second, creating a dismiss+recreate storm that made the notification flicker and disappear.
    // The 60-second interval inside showNotification keeps the time display acceptably fresh.
  }, [completedLoops, isRunning, showNotification]);

  useEffect(() => () => {
    clearTimerInterval();
    clearCompletionNotification();
    releaseWakeLock();
    stopWebTimerAudio();
    if (notifIntervalRef.current) clearInterval(notifIntervalRef.current);
    if (Platform.OS === 'web') {
      omKeepAliveAudioRef.current?.pause();
      omKeepAliveAudioRef.current = null;
      void omAudioContextRef.current?.close();
      omAudioContextRef.current = null;
      omAudioBufferRef.current = null;
    }
  }, [clearCompletionNotification, clearTimerInterval, releaseWakeLock, stopWebTimerAudio]);

  const start = useCallback(async () => {
    const resume = seconds > 0 && seconds < targetSeconds;
    console.log('[TimerBG] TIMER_START_REQUEST resume=%s seconds=%d targetSeconds=%d isRunning=%s hasUser=%s',
      resume, seconds, targetSeconds, isRunning, Boolean(userIdRef.current));
    if ((!userIdRef.current && !isGuestRef.current) || isRunning) {
      console.log('[TimerBG] TIMER_START_SKIPPED_DUPLICATE reason=%s',
        (!userIdRef.current && !isGuestRef.current) ? 'no-user' : 'already-running');
      return;
    }
    console.log('[TimerBG] TIMER_START_ACCEPTED resume=%s', resume);
    isCompletingRef.current = false;
    void primeWebCompletionAudio();
    if (resume) {
      const persistedCompletedLoops = await readPersistedCompletedLoops();
      const restoredCompletedLoops = Math.max(completedLoopsRef.current, persistedCompletedLoops);
      if (restoredCompletedLoops !== completedLoopsRef.current) {
        setCompletedLoops(restoredCompletedLoops);
        completedLoopsRef.current = restoredCompletedLoops;
      }
      timerSessionIdRef.current = getActiveSessionId();
      timerStartedAtRef.current = Date.now() - seconds * 1000;
    } else {
      timerSessionIdRef.current = createTimerSessionId();
      processedCompletionLoopsRef.current.clear();
      setSeconds(0);
      secondsRef.current = 0;
      setCompletedLoops(0);
      completedLoopsRef.current = 0;
      timerStartedAtRef.current = Date.now();
    }
    // Populate singleton before ticking starts so the active timer has the
    // correct startedAt, duration, and loop counts.
    updateTimerState({
      sessionId: timerSessionIdRef.current,
      startedAt: timerStartedAtRef.current,
      durationSeconds: selectedDurationRef.current * 60,
      completedLoops: completedLoopsRef.current,
      totalLoops: selectedLoopsRef.current,
      userId: userIdRef.current,
      isCompleting: false,
      lastSavedCompletedLoops: 0,
      appIsActive: appStateRef.current === 'active',
    });
    console.log('[TimerBG] Timer started: sessionId=%s duration=%ds loops=%d/%d startedAt=%d',
      timerSessionIdRef.current, selectedDurationRef.current * 60, completedLoopsRef.current, selectedLoopsRef.current, timerStartedAtRef.current);
    setIsRunning(true);
    isRunningRef.current = true;
    startTimerInterval();
    void acquireWakeLock();
    void showNotification();
    if (Platform.OS === 'android') {
      void startForegroundService({
        sessionId: timerSessionIdRef.current,
        durationSeconds: selectedDurationRef.current * 60,
        completedLoops: completedLoopsRef.current,
        totalLoops: selectedLoopsRef.current,
        soundEnabled: soundEnabledRef.current,
        vibrationEnabled: vibrationEnabledRef.current,
        userId: userIdRef.current,
        startedAt: timerStartedAtRef.current ?? Date.now(),
      });
    }
    void requestNotificationPermission().then((granted) => {
      if (!isRunningRef.current) return;
      if (!granted) {
        console.log('[TimerNotify] Notification permission not granted; continuing in-app timer only.');
      }
      void showNotification();
      scheduleCompletionNotification(targetSeconds - secondsRef.current);
    });
    void persistState(true);
  }, [
    acquireWakeLock,
    getActiveSessionId,
    isRunning,
    persistState,
    primeWebCompletionAudio,
    readPersistedCompletedLoops,
    requestNotificationPermission,
    scheduleCompletionNotification,
    seconds,
    showNotification,
    startTimerInterval,
    targetSeconds,
  ]);

  const pause = useCallback(() => {
    clearTimerInterval();
    releaseWakeLock();
    setIsRunning(false);
    isRunningRef.current = false;
    updateTimerState({ sessionId: timerSessionIdRef.current, startedAt: null, isCompleting: false });
    void hideNotification();
    clearCompletionNotification();
    if (Platform.OS === 'android') void pauseForegroundService();
    void persistState(false);
    console.log('[TimerBG] Timer paused');
  }, [clearCompletionNotification, clearTimerInterval, hideNotification, persistState, releaseWakeLock]);

  const reset = useCallback(() => {
    clearTimerInterval();
    releaseWakeLock();
    setIsRunning(false);
    isRunningRef.current = false;
    setSeconds(0);
    secondsRef.current = 0;
    setCompletedLoops(0);
    completedLoopsRef.current = 0;
    isCompletingRef.current = false;
    processedCompletionLoopsRef.current.clear();
    timerStartedAtRef.current = null;
    timerSessionIdRef.current = '';
    updateTimerState({ sessionId: '', startedAt: null, completedLoops: 0, isCompleting: false, lastSavedCompletedLoops: 0 });
    void hideNotification();
    clearCompletionNotification();
    if (Platform.OS === 'android') void stopForegroundService();
    void persistState(false);
    console.log('[TimerBG] Timer reset');
  }, [clearCompletionNotification, clearTimerInterval, hideNotification, persistState, releaseWakeLock]);

  const selectDuration = useCallback((mins: number) => {
    if (isRunningRef.current) return;
    setSelectedDuration(mins);
    selectedDurationRef.current = mins;
    setSeconds(0);
    secondsRef.current = 0;
    setCompletedLoops(0);
    completedLoopsRef.current = 0;
    processedCompletionLoopsRef.current.clear();
    timerStartedAtRef.current = null;
    timerSessionIdRef.current = '';
    void AsyncStorage.setItem(T_DURATION_KEY, String(mins));
  }, []);

  const selectLoops = useCallback((loops: number) => {
    if (isRunningRef.current) return;
    setSelectedLoops(loops);
    selectedLoopsRef.current = loops;
    processedCompletionLoopsRef.current.clear();
    timerSessionIdRef.current = '';
    void AsyncStorage.setItem(T_LOOPS_KEY, String(loops));
  }, []);

  const value = useMemo<TimerContextValue>(() => ({
    seconds,
    selectedDuration,
    selectedLoops,
    completedLoops,
    isRunning,
    timeLeft,
    targetSeconds,
    isPaused,
    isCustomDuration,
    canStart: Boolean(userId) || isGuest,
    start,
    pause,
    reset,
    selectDuration,
    selectLoops,
  }), [
    completedLoops,
    isCustomDuration,
    isPaused,
    isRunning,
    pause,
    reset,
    seconds,
    selectDuration,
    selectLoops,
    selectedDuration,
    selectedLoops,
    start,
    targetSeconds,
    timeLeft,
    userId,
    isGuest,
  ]);

  return <TimerContext.Provider value={value}>{children}</TimerContext.Provider>;
}

export function useTimer() {
  const context = useContext(TimerContext);
  if (!context) throw new Error('useTimer must be used inside TimerProvider');
  return context;
}

export function FloatingMiniTimer() {
  const timer = useTimer();
  const pathname = usePathname();
  const router = useRouter();
  if (pathname.includes('/timer')) return null;
  if (!timer.isRunning && !timer.isPaused) return null;

  const progress = Math.max(0, Math.min(1, timer.timeLeft / Math.max(1, timer.targetSeconds)));
  const activeMala = Math.min(
    timer.selectedLoops,
    timer.completedLoops + (timer.isRunning || timer.isPaused ? 1 : 0)
  );

  return (
    <Pressable
      style={({ pressed }) => [styles.miniTimer, pressed && styles.miniTimerPressed]}
      onPress={() => router.push('/timer' as never)}
    >
      <View style={styles.miniRing}>
        <Text style={styles.miniProgress}>{Math.round(progress * 100)}%</Text>
      </View>
      <View style={styles.miniCopy}>
        <Text style={styles.miniTime}>{formatTimer(timer.timeLeft)}</Text>
        <Text style={styles.miniMeta}>Mala {activeMala} / {timer.selectedLoops}</Text>
      </View>
      <Pressable
        hitSlop={10}
        style={styles.miniButton}
        onPress={(event) => {
          (event as any).stopPropagation?.();
          if (timer.isRunning) timer.pause();
          else timer.start();
        }}
      >
        <Ionicons name={timer.isRunning ? 'pause' : 'play'} size={16} color="#fff" />
      </Pressable>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  miniTimer: {
    position: Platform.OS === 'web' ? ('fixed' as any) : 'absolute',
    top: Platform.OS === 'web' ? ('calc(14px + env(safe-area-inset-top))' as any) : 14,
    left: '50%' as any,
    transform: [{ translateX: -155 }],
    width: 310,
    minHeight: 56,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.92)',
    borderWidth: 1,
    borderColor: 'rgba(15,143,135,0.16)',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    shadowColor: '#0f766e',
    shadowOpacity: 0.18,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 },
    elevation: 40,
    zIndex: 1000,
  },
  miniTimerPressed: {
    opacity: 0.92,
  },
  miniRing: {
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: 3,
    borderColor: 'rgba(15,143,135,0.28)',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
  },
  miniProgress: {
    color: TEAL,
    fontSize: 9,
    fontWeight: '900',
  },
  miniCopy: {
    flex: 1,
  },
  miniTime: {
    color: '#063B3B',
    fontSize: 18,
    fontWeight: '900',
  },
  miniMeta: {
    color: '#5F7F80',
    fontSize: 12,
    fontWeight: '700',
    marginTop: 1,
  },
  miniButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: TEAL,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
