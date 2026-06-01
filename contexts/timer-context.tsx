import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { Audio } from 'expo-av';
import * as Haptics from 'expo-haptics';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import * as Notifications from 'expo-notifications';
import { usePathname, useRouter } from 'expo-router';
import {
  getNativeTimerState,
  pauseForegroundService,
  setNativeAppActive,
  startForegroundService,
  stopForegroundService,
} from '../lib/timerForegroundService';
import { getTimerState, updateTimerState } from '../lib/timerState';
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
const HISTORY_KEY = 'history';
const USER_ID_KEY = 'userId';
const SOUND_ENABLED_KEY = 'soundEnabled';
const VIBRATION_ENABLED_KEY = 'vibrationEnabled';
const WEB_TIMER_AUDIO_SRC = '/silent-timer.wav';

export const STD_DURATIONS = [1, 3, 5, 10, 15];
export const LOOP_OPTIONS = [1, 3, 5, 10];

const getUserKey = (key: string, uid: string) => `${key}:${uid}`;
export const formatTimer = (s: number) =>
  `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

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
  const completionNotifIdRef = useRef<string | null>(null);
  const webRunningNotificationRef = useRef<Notification | null>(null);
  const webRunningNotificationShownRef = useRef(false);
  const webTimerAudioRef = useRef<HTMLAudioElement | null>(null);
  const webCompletionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const webCompletionNotificationShownRef = useRef(false);
  const notifIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const soundRef = useRef<Audio.Sound | null>(null);
  const isCompletingRef = useRef(false);
  const lastSavedSessionRef = useRef<{ key: string; savedAt: number } | null>(null);
  const suppressNextCompletionSoundRef = useRef(false);
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
    } catch (error) {
      console.log('[TimerNotify] Web timer audio stop error:', error);
    }
  }, []);

  const hideNotification = useCallback(() => {
    if (notifIntervalRef.current) {
      clearInterval(notifIntervalRef.current);
      notifIntervalRef.current = null;
    }
    if (Platform.OS === 'web') {
      stopWebTimerAudio();
      try {
        webRunningNotificationRef.current?.close();
        webRunningNotificationRef.current = null;
        webRunningNotificationShownRef.current = false;
      } catch (error) {
        console.log('[TimerNotify] Web notification close error:', error);
      }
      try {
        if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
          navigator.mediaSession.metadata = null;
          navigator.mediaSession.playbackState = 'none';
        }
      } catch (error) {
        console.log('[TimerNotify] Media session clear error:', error);
      }
      return;
    }
    if (Platform.OS === 'android') {
      void stopForegroundService();
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
          if (
            typeof navigator !== 'undefined' &&
            'mediaSession' in navigator &&
            typeof window !== 'undefined' &&
            'MediaMetadata' in window
          ) {
            navigator.mediaSession.metadata = new window.MediaMetadata({
              title: 'Japam Timer',
              artist: statusText,
              album: 'Mantra Japam',
              artwork: [
                { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
                { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
              ],
            });
            navigator.mediaSession.playbackState = isRunningRef.current ? 'playing' : 'paused';
          }
        } catch (error) {
          console.log('[TimerNotify] Media session update error:', error);
        }

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
      // Singleton already has the latest startedAt/durationSeconds/completedLoops/totalLoops.
      // The background task reads from it directly — no closures needed.
      void startForegroundService();
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

  const saveSession = useCallback(async () => {
    const uid = userIdRef.current;
    const duration = selectedDurationRef.current * 60;
    const sessionKey = [
      uid || 'guest',
      duration,
      completedLoopsRef.current,
      selectedLoopsRef.current,
      new Date().toISOString().slice(0, 10),
    ].join(':');
    const lastSaved = lastSavedSessionRef.current;
    if (lastSaved?.key === sessionKey && Date.now() - lastSaved.savedAt < 30000) {
      return;
    }
    // Also skip if the background task already saved this loop index
    if (getTimerState().lastSavedCompletedLoops >= completedLoopsRef.current) {
      console.log('[LoopComplete] Background already saved loop %d, skipping foreground save', completedLoopsRef.current);
      // Still emit stats events in case the foreground listener missed the background emit
      DeviceEventEmitter.emit('japam-stats-updated');
      DeviceEventEmitter.emit('japam-history-updated', { userId: uid || 'guest' });
      console.log('[StatsRefresh] Events re-emitted from foreground path');
      return;
    }
    lastSavedSessionRef.current = { key: sessionKey, savedAt: Date.now() };
    updateTimerState({ lastSavedCompletedLoops: completedLoopsRef.current });

    const now = new Date();
    const session = {
      date: now.toISOString(),
      malas: 1,
      totalCount: 108,
      duration,
      manual: false,
      userId: uid || undefined,
    };

    // Local save + event emission — awaited by completeCycle so stats refresh immediately
    try {
      const raw = await AsyncStorage.getItem(HISTORY_KEY);
      const history = raw ? JSON.parse(raw) : [];
      await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify([session, ...history]));

      DeviceEventEmitter.emit('japam-stats-updated');
      DeviceEventEmitter.emit('japam-history-updated', { userId: uid || 'guest' });
      if (Platform.OS === 'web' && typeof window !== 'undefined') {
        window.dispatchEvent(new Event('japam-stats-updated'));
        window.dispatchEvent(new Event('japam-history-updated'));
      }
    } catch (err) {
      console.log('Timer session save error:', err);
      return;
    }

    // Network sync is fire-and-forget — does not block completeCycle
    if (!uid) return;
    const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
    const key = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !key) return;
    void (async () => {
      try {
        const userName = await AsyncStorage.getItem('userName') || '';
        const res = await fetch(`${url}/rest/v1/japam_history`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey: key,
            Authorization: `Bearer ${key}`,
            Prefer: 'return=minimal',
          },
          body: JSON.stringify({
            user_id: uid,
            user_name: userName,
            malas: 1,
            count: 108,
            created_at: session.date,
          }),
        });
        if (!res.ok) {
          console.log('Timer Supabase save error:', await res.text());
        }
      } catch (err) {
        console.log('Timer Supabase sync error:', err);
      }
    })();
  }, []);

  const refreshAuthState = useCallback(async () => {
    const uid = await AsyncStorage.getItem(USER_ID_KEY) || '';
    userIdRef.current = uid;
    setUserId(uid);
    updateTimerState({ userId: uid });

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
      updateTimerState({ startedAt: null, completedLoops: 0, isCompleting: false });
      void hideNotification();
    }
  }, [clearTimerInterval, hideNotification, releaseWakeLock]);

  const completeCycle = useCallback(async () => {
    if (isCompletingRef.current) return;
    // Guard: if background task already started handling this loop, skip
    if (getTimerState().isCompleting) {
      console.log('[LoopComplete] Background task is handling this loop, foreground deferring');
      return;
    }
    isCompletingRef.current = true;
    updateTimerState({ isCompleting: true }); // block background task from interfering
    console.log('[LoopComplete] Foreground handling loop completion');

    clearTimerInterval();
    releaseWakeLock();
    setIsRunning(false);
    isRunningRef.current = false;
    hideNotification();
    const completedInBackground = appStateRef.current !== 'active';
    if (!completedInBackground) {
      clearCompletionNotification();
    }

    const newDone = completedLoopsRef.current + 1;
    setCompletedLoops(newDone);
    completedLoopsRef.current = newDone;
    updateTimerState({ completedLoops: newDone });
    const isFinal = newDone >= selectedLoopsRef.current;
    console.log('[LoopComplete] Foreground: loop %d/%d done, isFinal=%s', newDone, selectedLoopsRef.current, isFinal);

    if (vibrationEnabledRef.current && Platform.OS !== 'web') {
      pulse([0, 1200, 80, 1500]);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      setTimeout(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {}), 400);
    }

    if (completedInBackground && !webCompletionNotificationShownRef.current) {
      webCompletionNotificationShownRef.current = true;
      showBrowserCompletionNotification(isFinal);
    }

    // Await local write so stats events fire before sound plays
    await saveSession();

    const shouldPlaySound = soundEnabledRef.current && !suppressNextCompletionSoundRef.current;
    suppressNextCompletionSoundRef.current = false;

    if (shouldPlaySound) {
      try {
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
      } catch {}
    }

    if (isFinal) {
      updateTimerState({ isCompleting: false, startedAt: null });
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
  }, [
    acquireWakeLock,
    clearTimerInterval,
    clearCompletionNotification,
    hideNotification,
    persistState,
    releaseWakeLock,
    saveSession,
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
        // Share the loaded sound object with the background task via singleton
        updateTimerState({ soundObject: sound as any });
        console.log('[TimerBG] Om sound loaded and registered in singleton');
      } catch {}
    })();
    return () => {
      soundRef.current?.unloadAsync().catch(() => {});
      soundRef.current = null;
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
        const [sec, target, dur, loops, paused, completed, running, startedAt] = await Promise.all([
          get(TIMER_SECONDS_KEY),
          get(TIMER_TARGET_KEY),
          get(T_DURATION_KEY),
          get(T_LOOPS_KEY),
          get(TIMER_PAUSED_KEY),
          get(TIMER_COMPLETED_LOOPS_KEY),
          get(TIMER_RUNNING_KEY),
          get(TIMER_STARTED_AT_KEY),
        ]);
        const savedSec = Number(sec) || 0;
        const savedTarget = Number(target) || 0;
        const savedDur = Number(dur) || 0;
        const savedLoops = Number(loops) || 0;
        const savedCompletedLoops = Math.max(0, Number(completed) || 0);
        const savedPaused = paused === 'true';
        const savedRunning = running === 'true';
        const savedStartedAt = Number(startedAt) || 0;
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

        if (savedRunningStillActive) {
          setSeconds(restoredSeconds);
          secondsRef.current = restoredSeconds;
          setIsRunning(true);
          isRunningRef.current = true;
          timerStartedAtRef.current = savedStartedAt;
          updateTimerState({
            startedAt: savedStartedAt,
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
        } else if ((savedPaused || savedRunning) && restoredSeconds > 0 && restoredTarget > 0) {
          setSeconds(restoredSeconds);
          secondsRef.current = restoredSeconds;
          setIsRunning(false);
          isRunningRef.current = false;
          timerStartedAtRef.current = null;
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
      const [sec, target, dur, loops, completed, running, startedAt] = await Promise.all([
        get(TIMER_SECONDS_KEY),
        get(TIMER_TARGET_KEY),
        get(T_DURATION_KEY),
        get(T_LOOPS_KEY),
        get(TIMER_COMPLETED_LOOPS_KEY),
        get(TIMER_RUNNING_KEY),
        get(TIMER_STARTED_AT_KEY),
      ]);

      const savedRunning = running === 'true';
      const savedTarget = Number(target) || 0;
      const savedDuration = Number(dur) || 0;
      const restoredTarget = savedTarget || savedDuration * 60 || selectedDurationRef.current * 60;
      const savedStartedAt = Number(startedAt) || 0;
      const savedSeconds = Number(sec) || 0;
      if (!savedRunning || restoredTarget <= 0) return false;

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
      setIsRunning(true);
      isRunningRef.current = true;
      updateTimerState({
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

  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      // ── Going to background ──────────────────────────────────────────────
      if (next !== 'active' && appStateRef.current === 'active') {
        updateTimerState({ appIsActive: false });
        if (Platform.OS === 'android') {
          setNativeAppActive(false);
          if (isRunningRef.current) {
            void startForegroundService();
          }
        }
        if (isRunningRef.current && timerStartedAtRef.current !== null) {
          const elapsed = Math.max(0, Math.floor((Date.now() - timerStartedAtRef.current) / 1000));
          secondsRef.current = elapsed;
          const remaining = selectedDurationRef.current * 60 - elapsed;
          if (remaining > 1) {
            scheduleCompletionNotification(remaining);
          }
        }
        soundRef.current?.stopAsync().catch(() => {});
        void persistState(isRunningRef.current);
        console.log('[TimerBG] App backgrounded, native service taking over');
      }

      // ── Returning to foreground ──────────────────────────────────────────
      if (next === 'active' && appStateRef.current !== 'active') {
        updateTimerState({ appIsActive: true });
        if (Platform.OS === 'android') {
          setNativeAppActive(true);
        }

        const handleResume = async () => {
          // For Android: sync state from native Kotlin service (authoritative source in background)
          if (Platform.OS === 'android') {
            try {
              const nativeState = await getNativeTimerState();
              if (nativeState && nativeState.completedLoops > completedLoopsRef.current) {
                const loopsGained = nativeState.completedLoops - completedLoopsRef.current;
                console.log('[TimerNative] Foreground resumed: native completed %d loop(s)', loopsGained);

                // Save any loops that were completed in the native service to history
                const uid = userIdRef.current;
                for (let i = 0; i < loopsGained; i++) {
                  const loopNum = completedLoopsRef.current + i + 1;
                  if (getTimerState().lastSavedCompletedLoops < loopNum) {
                    updateTimerState({ lastSavedCompletedLoops: loopNum });
                    // Fire-and-forget local history save for each native-completed loop
                    const now = new Date();
                    const session = {
                      date: now.toISOString(),
                      malas: 1,
                      totalCount: 108,
                      duration: Math.round(nativeState.durationMs / 1000),
                      manual: false,
                      userId: uid || undefined,
                    };
                    void (async () => {
                      try {
                        const raw = await AsyncStorage.getItem('history');
                        const history = raw ? JSON.parse(raw) : [];
                        await AsyncStorage.setItem('history', JSON.stringify([session, ...history]));
                      } catch {}
                    })();
                  }
                }

                setCompletedLoops(nativeState.completedLoops);
                completedLoopsRef.current = nativeState.completedLoops;

                DeviceEventEmitter.emit('japam-stats-updated');
                DeviceEventEmitter.emit('japam-history-updated', { userId: uid || 'guest' });
                console.log('[StatsRefresh] Events re-emitted on foreground resume (native path)');

                const isFinal = nativeState.completedLoops >= selectedLoopsRef.current;
                if (isFinal || !nativeState.isRunning) {
                  clearTimerInterval();
                  releaseWakeLock();
                  setIsRunning(false);
                  isRunningRef.current = false;
                  timerStartedAtRef.current = null;
                  isCompletingRef.current = false;
                  return;
                }

                // Next loop running in native — sync JS to it
                if (nativeState.startedAt > 0) {
                  timerStartedAtRef.current = nativeState.startedAt;
                  const elapsed = Math.floor((Date.now() - nativeState.startedAt) / 1000);
                  secondsRef.current = elapsed;
                  setSeconds(elapsed);
                  setIsRunning(true);
                  isRunningRef.current = true;
                  startTimerInterval();
                  void showNotification();
                  console.log('[TimerNative] Synced to loop %d, elapsed=%ds', nativeState.completedLoops + 1, elapsed);
                }
                return;
              } else if (nativeState && nativeState.isRunning) {
                // Same loop, timer still running — use native startedAt as authoritative source
                const startedAt = nativeState.startedAt > 0 ? nativeState.startedAt : timerStartedAtRef.current;
                if (startedAt) {
                  timerStartedAtRef.current = startedAt;
                  const elapsed = Math.floor((Date.now() - startedAt) / 1000);
                  secondsRef.current = elapsed;
                  setSeconds(elapsed);
                  setIsRunning(true);
                  isRunningRef.current = true;
                  startTimerInterval();
                  void showNotification();
                  console.log('[TimerNative] Foreground resumed same loop, elapsed=%ds', elapsed);
                }
                return;
              }
            } catch (e) {
              console.log('[TimerNative] getState error on resume:', e);
            }
          }

          // JS singleton fallback (non-Android or if native module unavailable)
          const bgState = getTimerState();
          if (bgState.completedLoops > completedLoopsRef.current) {
            const loopsGained = bgState.completedLoops - completedLoopsRef.current;
            console.log('[TimerBG] Foreground resumed: background completed %d loop(s)', loopsGained);
            setCompletedLoops(bgState.completedLoops);
            completedLoopsRef.current = bgState.completedLoops;
            DeviceEventEmitter.emit('japam-stats-updated');
            DeviceEventEmitter.emit('japam-history-updated', { userId: userIdRef.current || 'guest' });

            if (!bgState.startedAt) {
              clearTimerInterval();
              releaseWakeLock();
              setIsRunning(false);
              isRunningRef.current = false;
              timerStartedAtRef.current = null;
              isCompletingRef.current = false;
            } else {
              timerStartedAtRef.current = bgState.startedAt;
              const elapsed = Math.floor((Date.now() - bgState.startedAt) / 1000);
              secondsRef.current = elapsed;
              setSeconds(elapsed);
              setIsRunning(true);
              isRunningRef.current = true;
              startTimerInterval();
              void showNotification();
            }
          } else if (isRunningRef.current && timerStartedAtRef.current !== null) {
            const elapsed = Math.floor((Date.now() - timerStartedAtRef.current) / 1000);
            secondsRef.current = elapsed;
            setSeconds(elapsed);
            startTimerInterval();
            console.log('[TimerBG] Foreground resumed, resynced elapsed=%ds', elapsed);
          } else {
            await restoreRunningTimerFromStorage();
          }
        };

        void handleResume();
      }

      appStateRef.current = next;
    });
    return () => sub.remove();
  }, [clearTimerInterval, persistState, releaseWakeLock, restoreRunningTimerFromStorage, scheduleCompletionNotification, startTimerInterval]);

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

  useEffect(() => {
    if (!isRunning) return;
    void showNotification();
    // 'seconds' intentionally excluded — including it caused showNotification() to fire every
    // second, creating a dismiss+recreate storm that made the notification flicker and disappear.
    // The 60-second interval inside showNotification keeps the time display acceptably fresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [completedLoops, isRunning, showNotification]);

  useEffect(() => () => {
    clearTimerInterval();
    clearCompletionNotification();
    releaseWakeLock();
    stopWebTimerAudio();
    if (notifIntervalRef.current) clearInterval(notifIntervalRef.current);
  }, [clearCompletionNotification, clearTimerInterval, releaseWakeLock, stopWebTimerAudio]);

  const start = useCallback(async () => {
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
    // Populate singleton BEFORE starting the foreground service so the background
    // task immediately has the correct startedAt, duration, and loop counts.
    updateTimerState({
      startedAt: timerStartedAtRef.current,
      durationSeconds: selectedDurationRef.current * 60,
      completedLoops: completedLoopsRef.current,
      totalLoops: selectedLoopsRef.current,
      userId: userIdRef.current,
      isCompleting: false,
      lastSavedCompletedLoops: 0,
      appIsActive: appStateRef.current === 'active',
    });
    console.log('[TimerBG] Timer started: duration=%ds loops=%d/%d startedAt=%d',
      selectedDurationRef.current * 60, completedLoopsRef.current, selectedLoopsRef.current, timerStartedAtRef.current);
    setIsRunning(true);
    isRunningRef.current = true;
    startTimerInterval();
    void acquireWakeLock();
    if (Platform.OS === 'android') {
      setNativeAppActive(appStateRef.current === 'active');
    }
    void showNotification();
    void requestNotificationPermission().then((granted) => {
      if (!isRunningRef.current) return;
      if (!granted) {
        console.log('[TimerNotify] Notification permission not granted; keeping Media Session/foreground timer only.');
      }
      void showNotification();
      scheduleCompletionNotification(targetSeconds - secondsRef.current);
    });
    void persistState(true);
  }, [
    acquireWakeLock,
    isRunning,
    persistState,
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
    updateTimerState({ startedAt: null, isCompleting: false });
    if (Platform.OS === 'android') {
      // Keep native notification visible but show paused state
      void pauseForegroundService();
    } else {
      void hideNotification();
    }
    clearCompletionNotification();
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
    timerStartedAtRef.current = null;
    updateTimerState({ startedAt: null, completedLoops: 0, isCompleting: false, lastSavedCompletedLoops: 0 });
    void hideNotification();
    clearCompletionNotification();
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
