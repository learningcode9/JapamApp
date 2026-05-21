import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { Audio } from 'expo-av';
import * as Haptics from 'expo-haptics';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import * as Notifications from 'expo-notifications';
import { usePathname, useRouter } from 'expo-router';
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
const HISTORY_KEY = 'history';
const USER_ID_KEY = 'userId';
const SOUND_ENABLED_KEY = 'soundEnabled';
const VIBRATION_ENABLED_KEY = 'vibrationEnabled';
const TOTAL_KEY = 'totalCount';
const COUNT_KEY = 'count';
const MALAS_KEY = 'malas';
const TOTAL_DATE_KEY = 'totalDate';

export const STD_DURATIONS = [1, 3, 5, 10, 15];
export const LOOP_OPTIONS = [1, 3, 5, 10];

const getUserKey = (key: string, uid: string) => `${key}:${uid}`;
export const formatTimer = (s: number) =>
  `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

const getLocalDateKey = (date = new Date()) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

const getCurrentMalaLabel = (completedLoops: number, selectedLoops: number, runningOrPaused = true) => {
  const activeLoop = Math.min(selectedLoops, completedLoops + (runningOrPaused ? 1 : 0));
  return `Mala ${activeLoop} / ${selectedLoops}`;
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

if (Platform.OS !== 'web') {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
}

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
  const timerStartedAtRef = useRef<number | null>(null);
  const timerIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const notifIdRef = useRef<string | null>(null);
  const notifIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const soundRef = useRef<Audio.Sound | null>(null);
  const isCompletingRef = useRef(false);
  const appStateRef = useRef(AppState.currentState);
  const wakeLockRef = useRef<any>(null);

  useEffect(() => { secondsRef.current = seconds; }, [seconds]);
  useEffect(() => { isRunningRef.current = isRunning; }, [isRunning]);
  useEffect(() => { completedLoopsRef.current = completedLoops; }, [completedLoops]);
  useEffect(() => { selectedLoopsRef.current = selectedLoops; }, [selectedLoops]);
  useEffect(() => { selectedDurationRef.current = selectedDuration; }, [selectedDuration]);
  useEffect(() => { soundEnabledRef.current = soundEnabled; }, [soundEnabled]);
  useEffect(() => { vibrationEnabledRef.current = vibrationEnabled; }, [vibrationEnabled]);

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
    const paused = !running && secondsRef.current > 0 && secondsRef.current < tSec;
    const pairs: [string, string][] = [
      [TIMER_SECONDS_KEY, String(secondsRef.current)],
      [TIMER_RUNNING_KEY, String(running)],
      [TIMER_TARGET_KEY, String(tSec)],
      [TIMER_PAUSED_KEY, String(paused)],
      [TIMER_COMPLETED_LOOPS_KEY, String(completedLoopsRef.current)],
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

  const startTimerInterval = useCallback(() => {
    clearTimerInterval();
    const tick = () => {
      if (timerStartedAtRef.current === null) return;
      setSeconds(Math.floor((Date.now() - timerStartedAtRef.current) / 1000));
    };
    tick();
    timerIntervalRef.current = setInterval(tick, 1000);
  }, [clearTimerInterval]);

  const hideNotification = useCallback(() => {
    if (notifIntervalRef.current) {
      clearInterval(notifIntervalRef.current);
      notifIntervalRef.current = null;
    }
    if (Platform.OS === 'web') {
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
  }, []);

  const showNotification = useCallback(() => {
    if (Platform.OS === 'web') {
      return;
    }

    const schedule = async () => {
      try {
        const perm = await Notifications.getPermissionsAsync();
        if (!perm.granted) return;
        if (notifIdRef.current) {
          try { await Notifications.dismissNotificationAsync(notifIdRef.current); } catch {}
          notifIdRef.current = null;
        }
        const left = Math.max(0, selectedDurationRef.current * 60 - secondsRef.current);
        const malaLabel = getCurrentMalaLabel(completedLoopsRef.current, selectedLoopsRef.current);
        const id = await Notifications.scheduleNotificationAsync({
          content: {
            title: 'Japam Timer',
            body: `${malaLabel} · ${formatTimer(left)}`,
            sticky: true,
            sound: false,
            ...(Platform.OS === 'android' ? { channelId: 'japam-timer' } : {}),
          },
          trigger: null,
        } as any);
        notifIdRef.current = id;
      } catch {}
    };
    void schedule();
    if (notifIntervalRef.current) clearInterval(notifIntervalRef.current);
    notifIntervalRef.current = setInterval(schedule, 5000);
  }, []);

  const saveSession = useCallback(async () => {
    const uid = userIdRef.current;
    const duration = selectedDurationRef.current * 60;
    const now = new Date();
    const session = {
      date: now.toISOString(),
      malas: 1,
      totalCount: 108,
      duration,
      manual: false,
      userId: uid || undefined,
    };

    try {
      const raw = await AsyncStorage.getItem(HISTORY_KEY);
      const history = raw ? JSON.parse(raw) : [];
      await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify([session, ...history]));

      if (uid) {
        const todayKey = getLocalDateKey(now);
        const storedTotalDate = await AsyncStorage.getItem(getUserKey(TOTAL_DATE_KEY, uid));
        const previousTotal =
          storedTotalDate === todayKey
            ? Number((await AsyncStorage.getItem(getUserKey(TOTAL_KEY, uid))) || '0')
            : 0;
        const nextTotal = previousTotal + 108;
        const nextMalas = Math.floor(nextTotal / 108);
        const nextCount = nextTotal % 108;
        await AsyncStorage.multiSet([
          [getUserKey(TOTAL_DATE_KEY, uid), todayKey],
          [getUserKey(TOTAL_KEY, uid), String(nextTotal)],
          [getUserKey(MALAS_KEY, uid), String(nextMalas)],
          [getUserKey(COUNT_KEY, uid), String(nextCount)],
          [TOTAL_DATE_KEY, todayKey],
          [TOTAL_KEY, String(nextTotal)],
          [MALAS_KEY, String(nextMalas)],
          [COUNT_KEY, String(nextCount)],
        ]);
      }

      DeviceEventEmitter.emit('japam-stats-updated');
      DeviceEventEmitter.emit('japam-history-updated', { userId: uid || 'guest' });
      if (Platform.OS === 'web' && typeof window !== 'undefined') {
        window.dispatchEvent(new Event('japam-stats-updated'));
        window.dispatchEvent(new Event('japam-history-updated'));
      }

      if (!uid) return;
      const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
      const key = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
      if (!url || !key) return;
      const userName = await AsyncStorage.getItem('userName') || '';
      const response = await fetch(`${url}/rest/v1/japam_history`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: key,
          Authorization: `Bearer ${key}`,
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({ user_id: uid, user_name: userName, malas: 1, count: 108 }),
      });

      if (response.ok) {
        const latestRaw = await AsyncStorage.getItem(HISTORY_KEY);
        const latestHistory = latestRaw ? JSON.parse(latestRaw) : [];
        const withoutSyncedSession = latestHistory.filter((item: typeof session) => {
          return !(
            item.userId === session.userId &&
            item.date === session.date &&
            Number(item.malas) === session.malas &&
            Number(item.totalCount) === session.totalCount &&
            Number(item.duration) === session.duration
          );
        });
        await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(withoutSyncedSession));
        DeviceEventEmitter.emit('japam-history-updated', { userId: uid });
        if (Platform.OS === 'web' && typeof window !== 'undefined') {
          window.dispatchEvent(new Event('japam-history-updated'));
        }
      } else {
        console.log('Timer Supabase save error:', await response.text());
      }
    } catch (err) {
      console.log('Timer session save error:', err);
    }
  }, []);

  const refreshAuthState = useCallback(async () => {
    const uid = await AsyncStorage.getItem(USER_ID_KEY) || '';
    userIdRef.current = uid;
    setUserId(uid);

    if (!uid) {
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
      void hideNotification();
    }
  }, [clearTimerInterval, hideNotification, releaseWakeLock]);

  const completeCycle = useCallback(async () => {
    if (isCompletingRef.current) return;
    isCompletingRef.current = true;
    clearTimerInterval();
    releaseWakeLock();
    setIsRunning(false);
    isRunningRef.current = false;
    hideNotification();

    const newDone = completedLoopsRef.current + 1;
    setCompletedLoops(newDone);
    completedLoopsRef.current = newDone;
    const isFinal = newDone >= selectedLoopsRef.current;

    if (vibrationEnabledRef.current && Platform.OS !== 'web') {
      pulse([0, 1200, 80, 1500]);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      setTimeout(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {}), 400);
    }

    if (Platform.OS !== 'web') {
      try {
        const perm = await Notifications.getPermissionsAsync();
        if (perm.granted) {
          await Notifications.scheduleNotificationAsync({
            content: {
              title: isFinal ? '🙏 Japam Complete' : '🔔 Mala Complete',
              body: isFinal ? 'Your japam session is complete.' : 'Starting next mala...',
              sound: true,
              ...(Platform.OS === 'android' ? { channelId: 'japam-complete' } : {}),
            },
            trigger: null,
          } as any);
        }
      } catch {}
    }

    void saveSession();

    if (soundEnabledRef.current) {
      try {
        await configureAudio();
        const sound = soundRef.current;
        if (sound) {
          await sound.stopAsync().catch(() => {});
          await sound.setPositionAsync(0).catch(() => {});
          await sound.setVolumeAsync(0.95).catch(() => {});
          await sound.setIsLoopingAsync(false).catch(() => {});
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
      } catch {}
    }

    if (isFinal) {
      void persistState(false);
      isCompletingRef.current = false;
      return;
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 1000));
    isCompletingRef.current = false;
    setSeconds(0);
    secondsRef.current = 0;
    timerStartedAtRef.current = Date.now();
    setIsRunning(true);
    isRunningRef.current = true;
    startTimerInterval();
    void acquireWakeLock();
    showNotification();
    void persistState(true);
  }, [
    acquireWakeLock,
    clearTimerInterval,
    hideNotification,
    persistState,
    releaseWakeLock,
    saveSession,
    showNotification,
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
        const { sound } = await Audio.Sound.createAsync(
          require('../assets/om_complete.mp3'),
          { shouldPlay: false, isLooping: false, volume: 0.95 }
        );
        soundRef.current = sound;
      } catch {}
    })();
    return () => {
      soundRef.current?.unloadAsync().catch(() => {});
      soundRef.current = null;
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
        const [sec, target, dur, loops, paused, completed] = await Promise.all([
          get(TIMER_SECONDS_KEY),
          get(TIMER_TARGET_KEY),
          get(T_DURATION_KEY),
          get(T_LOOPS_KEY),
          get(TIMER_PAUSED_KEY),
          get(TIMER_COMPLETED_LOOPS_KEY),
        ]);
        const savedSec = Number(sec) || 0;
        const savedTarget = Number(target) || 0;
        const savedDur = Number(dur) || 0;
        const savedLoops = Number(loops) || 0;
        const savedCompletedLoops = Math.max(0, Number(completed) || 0);
        const savedPaused = paused === 'true';
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
        if (savedPaused && savedSec > 0 && savedTarget > 0 && savedSec < savedTarget) {
          setSeconds(savedSec);
          secondsRef.current = savedSec;
          setIsRunning(false);
          isRunningRef.current = false;
          timerStartedAtRef.current = null;
        }
      } catch {}
    })();
  }, []);

  useEffect(() => {
    if (isRunning && seconds > 0 && seconds >= targetSeconds && !isCompletingRef.current) {
      void completeCycle();
    }
  }, [completeCycle, isRunning, seconds, targetSeconds]);

  useEffect(() => {
    if (!isRunning) return;
    const iv = setInterval(() => void persistState(true), 10000);
    return () => clearInterval(iv);
  }, [isRunning, persistState]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active' && appStateRef.current !== 'active' && isRunningRef.current && timerStartedAtRef.current !== null) {
        setSeconds(Math.floor((Date.now() - timerStartedAtRef.current) / 1000));
      }
      appStateRef.current = next;
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    const onVis = () => {
      if (document.visibilityState === 'visible' && isRunningRef.current) {
        void acquireWakeLock();
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [acquireWakeLock]);

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    document.title = isRunning ? `⏱ ${formatTimer(timeLeft)} — Mantra Japam` : 'Mantra Japam';
  }, [isRunning, timeLeft]);

  useEffect(() => {
    if (!isRunning) return;
    void showNotification();
  }, [completedLoops, isRunning, seconds, showNotification]);

  useEffect(() => () => {
    clearTimerInterval();
    releaseWakeLock();
    if (notifIntervalRef.current) clearInterval(notifIntervalRef.current);
  }, [clearTimerInterval, releaseWakeLock]);

  const start = useCallback(() => {
    if (!userIdRef.current || isRunning) return;
    isCompletingRef.current = false;
    const resume = seconds > 0 && seconds < targetSeconds;
    if (resume) {
      timerStartedAtRef.current = Date.now() - seconds * 1000;
    } else {
      setSeconds(0);
      secondsRef.current = 0;
      setCompletedLoops(0);
      completedLoopsRef.current = 0;
      timerStartedAtRef.current = Date.now();
    }
    setIsRunning(true);
    isRunningRef.current = true;
    startTimerInterval();
    void acquireWakeLock();
    void showNotification();
    void persistState(true);
  }, [acquireWakeLock, isRunning, persistState, seconds, showNotification, startTimerInterval, targetSeconds]);

  const pause = useCallback(() => {
    clearTimerInterval();
    releaseWakeLock();
    setIsRunning(false);
    isRunningRef.current = false;
    void hideNotification();
    void persistState(false);
  }, [clearTimerInterval, hideNotification, persistState, releaseWakeLock]);

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
    timerStartedAtRef.current = null;
    void hideNotification();
    void persistState(false);
  }, [clearTimerInterval, hideNotification, persistState, releaseWakeLock]);

  const selectDuration = useCallback((mins: number) => {
    if (isRunningRef.current) return;
    setSelectedDuration(mins);
    selectedDurationRef.current = mins;
    setSeconds(0);
    secondsRef.current = 0;
    setCompletedLoops(0);
    completedLoopsRef.current = 0;
    timerStartedAtRef.current = null;
    void AsyncStorage.setItem(T_DURATION_KEY, String(mins));
  }, []);

  const selectLoops = useCallback((loops: number) => {
    if (isRunningRef.current) return;
    setSelectedLoops(loops);
    selectedLoopsRef.current = loops;
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
    canStart: Boolean(userId),
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
