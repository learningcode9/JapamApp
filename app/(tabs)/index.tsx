import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Google from 'expo-auth-session/providers/google';
import { Audio } from 'expo-av';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { useFocusEffect } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import {
  Alert,
  Animated,
  DeviceEventEmitter,
  Dimensions,
  ImageBackground,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  Vibration,
  View,
} from 'react-native';

WebBrowser.maybeCompleteAuthSession();

type Session = {
  date: string;
  malas: number;
  totalCount: number;
  duration: number;
  manual?: boolean;
  userId?: string;
};

type TimerStateRow = {
  seconds?: number | string;
  is_running?: boolean;
  target_seconds?: number | string;
  minutes_input?: string | null;
  loop_timer?: boolean;
  updated_at?: string | null;
};

const COUNT_KEY = 'count';
const MALAS_KEY = 'malas';
const TOTAL_KEY = 'totalCount';
const HISTORY_KEY = 'history';
const JAPAM_NAME_KEY = 'japamName';
const LAST_OPEN_DATE_KEY = 'lastOpenDate';
const SOUND_ENABLED_KEY = 'soundEnabled';
const REPETITION_SOUND_ENABLED_KEY = 'repetitionSoundEnabled';
const VIBRATION_ENABLED_KEY = 'vibrationEnabled';
const USER_NAME_KEY = 'userName';
const USER_EMAIL_KEY = 'userEmail';
const USER_ID_KEY = 'userId';
const AUTH_PENDING_KEY = 'authPending';
const LAST_TOTAL_KEY = 'lastTotal';
const HISTORY_SYNC_VERSION_KEY = 'historyStatsSyncVersion';
const AUTH_PENDING_MAX_MS = 2 * 60 * 1000;
const TIMER_SECONDS_KEY = 'timerSeconds';
const TIMER_RUNNING_KEY = 'timerRunning';
const TIMER_TARGET_KEY = 'timerTarget';
const TIMER_MINUTES_KEY = 'timerMinutes';
const TIMER_LOOP_KEY = 'timerLoop';
const DEFAULT_TIMER_MINUTES = 5;
const SESSION_TIME_OPTIONS = [5, 10, 15];

const screenWidth = Dimensions.get('window').width;
const screenHeight = Dimensions.get('window').height;
const isMobile = screenWidth < 500;
const isShortMobile = isMobile && screenHeight < 760;
const progressCircleSize = isShortMobile ? 220 : isMobile ? 260 : 300;
const progressRingSize = progressCircleSize - (isMobile ? 10 : 14);
const malaBeadPositions = [
  { left: 10, top: 1 },
  { left: 15, top: 3 },
  { left: 19, top: 8 },
  { left: 19, top: 14 },
  { left: 15, top: 19 },
  { left: 9, top: 20 },
  { left: 4, top: 17 },
  { left: 1, top: 11 },
  { left: 3, top: 5 },
];
const shellMinHeight =
  isMobile
    ? Platform.OS === 'web'
      ? ('100dvh' as any)
      : screenHeight
    : Math.min(Math.max(screenHeight - 54, 820), 940);
const scrollTopPadding =
  Platform.OS === 'web' ? ('env(safe-area-inset-top)' as any) : 0;
const scrollBottomPadding =
  Platform.OS === 'web'
    ? ('calc(125px + env(safe-area-inset-bottom))' as any)
    : 125;

const getLocalDateKey = (date = new Date()) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

const getPreviousDateKey = (dayKey: string) => {
  const date = new Date(`${dayKey}T12:00:00`);
  date.setDate(date.getDate() - 1);
  return getLocalDateKey(date);
};

const getTodayRange = () => {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start: start.toISOString(), end: end.toISOString() };
};

const parseHistory = (raw: string | null): Session[] => {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const getUserStorageKey = (key: string, userId: string) => `${key}:${userId}`;

const isAuthPending = async () => {
  const raw = await AsyncStorage.getItem(AUTH_PENDING_KEY);
  const startedAt = Number(raw || 0);
  if (!startedAt) return false;
  if (Date.now() - startedAt > AUTH_PENDING_MAX_MS) {
    await AsyncStorage.removeItem(AUTH_PENDING_KEY);
    return false;
  }
  return true;
};

export default function JapamMain() {
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [count, setCount] = useState(0);
  const [malas, setMalas] = useState(0);
  const [total, setTotal] = useState(0);
  const [dayStreak, setDayStreak] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const [hasRestoredTotal, setHasRestoredTotal] = useState(false);
  const [hasRestoredTimer, setHasRestoredTimer] = useState(false);
  const [minutesInput, setMinutesInput] = useState(String(DEFAULT_TIMER_MINUTES));
  const [targetSeconds, setTargetSeconds] = useState(DEFAULT_TIMER_MINUTES * 60);
  const [isRunning, setIsRunning] = useState(false);
  const [loopTimer, setLoopTimer] = useState(false);
  const [, setAutoCompletedMalas] = useState(0);
  const [, setJapamName] = useState('');
  const [, setNameInput] = useState('');
  const [, setHasSetName] = useState(false);
  const [userName, setUserName] = useState('');
  const [showUserModal, setShowUserModal] = useState(false);
  const [showTimerSheet, setShowTimerSheet] = useState(false);
  const [showCustomTimerInput, setShowCustomTimerInput] = useState(false);
  const [hasSelectedTimer, setHasSelectedTimer] = useState(false);
  const [customMinutesInput, setCustomMinutesInput] = useState('');
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [repetitionSoundEnabled, setRepetitionSoundEnabled] = useState(true);
  const [vibrationEnabled, setVibrationEnabled] = useState(true);
  const [showInstallBanner, setShowInstallBanner] = useState(false);
  const [installBannerDismissed, setInstallBannerDismissed] = useState(false);

  const totalRef = useRef(0);
  const timerRef = useRef({
    seconds: 0,
    isRunning: false,
    targetSeconds: DEFAULT_TIMER_MINUTES * 60,
    minutesInput: String(DEFAULT_TIMER_MINUTES),
    loopTimer: false,
  });
  const suppressTimerSaveRef = useRef(false);
  const dbTotalSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const timerCloudLastSavedAtRef = useRef(0);
  const timerStartedAtRef = useRef<number | null>(null);
  const timerIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoRepeatTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isCompletingRef = useRef(false);
  const completedLoopMalasRef = useRef(0);
  const deferredInstallPromptRef = useRef<any>(null);
  const rippleAnim = useRef(new Animated.Value(0)).current;
  const isSavingSessionRef = useRef(false);
  const normalCompleteSoundRef = useRef<Audio.Sound | null>(null);
  const finalCompleteSoundRef = useRef<Audio.Sound | null>(null);
  const lastSavedSessionRef = useRef('');
  const lastTapRef = useRef(0);

  const glowAnim = useRef(new Animated.Value(0)).current;

  const formatTime = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

  const clearTimerHandles = useCallback(() => {
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }

    if (autoRepeatTimeoutRef.current) {
      clearTimeout(autoRepeatTimeoutRef.current);
      autoRepeatTimeoutRef.current = null;
    }
  }, []);

  const startTimerInterval = useCallback(() => {
    const startAt = timerStartedAtRef.current;
    if (startAt === null) return;

    clearTimerHandles();

    const tick = () => {
      if (timerStartedAtRef.current === null) return;
      setSeconds(Math.floor((Date.now() - timerStartedAtRef.current) / 1000));
    };

    tick();
    timerIntervalRef.current = setInterval(tick, 1000);
  }, [clearTimerHandles]);

  const googleRedirectUri =
    Platform.OS === 'web' && typeof window !== 'undefined'
      ? window.location.origin
      : undefined;

  const [request, response, promptAsync] = Google.useAuthRequest({
    clientId: process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID,
    scopes: ['profile', 'email'],
    redirectUri: googleRedirectUri,
  });

  useFocusEffect(
    useCallback(() => {
      let isActive = true;

      void (async () => {
        const savedSound = await AsyncStorage.getItem(SOUND_ENABLED_KEY);
        const savedRepetitionSound = await AsyncStorage.getItem(REPETITION_SOUND_ENABLED_KEY);
        const savedVibration = await AsyncStorage.getItem(VIBRATION_ENABLED_KEY);

        if (!isActive) return;
        setSoundEnabled(savedSound !== 'false');
        setRepetitionSoundEnabled(
          savedRepetitionSound === null
            ? savedSound !== 'false'
            : savedRepetitionSound !== 'false'
        );
        setVibrationEnabled(savedVibration !== 'false');
      })();

      return () => {
        isActive = false;
      };
    }, [])
  );

  const restoreTotal = useCallback(
    async (nextTotal: number, options?: { userId?: string | null }) => {
      const safeTotal = Math.max(0, Math.floor(Number(nextTotal) || 0));
      const nextMalas = Math.floor(safeTotal / 108);
      const nextCount = safeTotal % 108;
      const activeUserId =
        options?.userId === undefined
          ? await AsyncStorage.getItem(USER_ID_KEY)
          : options.userId;

      totalRef.current = safeTotal;
      setTotal(safeTotal);
      setMalas(nextMalas);
      setCount(nextCount);

      await AsyncStorage.setItem(TOTAL_KEY, String(safeTotal));
      await AsyncStorage.setItem(MALAS_KEY, String(nextMalas));
      await AsyncStorage.setItem(COUNT_KEY, String(nextCount));

      if (activeUserId) {
        await AsyncStorage.setItem(getUserStorageKey(TOTAL_KEY, activeUserId), String(safeTotal));
        await AsyncStorage.setItem(getUserStorageKey(MALAS_KEY, activeUserId), String(nextMalas));
        await AsyncStorage.setItem(getUserStorageKey(COUNT_KEY, activeUserId), String(nextCount));
      }
    },
    []
  );

  const refreshDayStreak = useCallback(
    async (options?: { userId?: string | null; todayTotal?: number }) => {
      const activeUserId =
        options?.userId === undefined
          ? await AsyncStorage.getItem(USER_ID_KEY)
          : options.userId;

      if (!activeUserId) {
        setDayStreak(0);
        return;
      }

      const rawHistory = await AsyncStorage.getItem(HISTORY_KEY);
      const history: Session[] = rawHistory ? JSON.parse(rawHistory) : [];
      const activeDays = new Set<string>();

      history.forEach((item) => {
        if (item.userId !== activeUserId) return;
        if ((Number(item.totalCount) || 0) <= 0 && (Number(item.malas) || 0) <= 0) return;

        const itemDate = new Date(item.date);
        if (Number.isNaN(itemDate.getTime())) return;

        activeDays.add(getLocalDateKey(itemDate));
      });

      const todayKey = getLocalDateKey();
      if ((options?.todayTotal ?? totalRef.current) > 0) {
        activeDays.add(todayKey);
      }

      let cursor = activeDays.has(todayKey) ? todayKey : getPreviousDateKey(todayKey);
      let nextStreak = 0;

      while (activeDays.has(cursor)) {
        nextStreak += 1;
        cursor = getPreviousDateKey(cursor);
      }

      setDayStreak(nextStreak);
    },
    []
  );

  useFocusEffect(
    useCallback(() => {
      let isActive = true;

      void (async () => {
        const savedUserId = await AsyncStorage.getItem(USER_ID_KEY);
        const savedUserName = await AsyncStorage.getItem(USER_NAME_KEY);

        if (!isActive || savedUserId || savedUserName) return;

        timerStartedAtRef.current = null;
        totalRef.current = 0;
        setUserName('');
        setShowUserMenu(false);
        setJapamName('');
        setNameInput('');
        setHasSetName(false);
        setIsRunning(false);
        setSeconds(0);
        setTargetSeconds(DEFAULT_TIMER_MINUTES * 60);
        setMinutesInput(String(DEFAULT_TIMER_MINUTES));
        setHasSelectedTimer(false);
        setLoopTimer(false);
        setDayStreak(0);
        await restoreTotal(0, { userId: null });
      })();

      return () => {
        isActive = false;
      };
    }, [restoreTotal])
  );

  const fetchTodayTotalFromSupabase = useCallback(
    async (userId: string) => {
      const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
      const key = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
      if (!url || !key || !userId) return null;

      try {
        const { start, end } = getTodayRange();

        const fetchBy = async (field: 'user_id' | 'user_name', value: string) => {
          const query = new URLSearchParams({
            select: 'count',
            [field]: `eq.${value}`,
            created_at: `gte.${start}`,
          });
          query.append('created_at', `lt.${end}`);

          const result = await fetch(`${url}/rest/v1/japam_history?${query.toString()}`, {
            headers: { apikey: key, Authorization: `Bearer ${key}` },
          });

          if (!result.ok) return null;
          const rows: { count?: number | string }[] = await result.json();
          return rows.reduce((sum, row) => sum + (Number(row.count) || 0), 0);
        };

        const byUserId = await fetchBy('user_id', userId);
        return byUserId;
      } catch (error) {
        console.log('Supabase today total error:', error);
        return null;
      }
    },
    []
  );

  const fetchUserTotalFromSupabase = async (userId: string) => {
    const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
    const key = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !key || !userId) return null;

    const encodedUserId = encodeURIComponent(userId);
    const response = await fetch(
      `${url}/rest/v1/japam_user_totals?user_id=eq.${encodedUserId}&select=total_count&limit=1`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } }
    );

    if (!response.ok) return null;
    const rows = await response.json();
    if (!rows?.[0]) return null;
    return Number(rows[0].total_count) || 0;
  };

  const saveUserTotalToSupabase = async (userId: string, userNameValue: string | null, totalValue: number) => {
    const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
    const key = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !key || !userId) return;

    const safeTotal = Math.max(0, Math.floor(Number(totalValue) || 0));

    const response = await fetch(`${url}/rest/v1/japam_user_totals?on_conflict=user_id`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: key,
        Authorization: `Bearer ${key}`,
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify({
        user_id: userId,
        user_name: userNameValue || 'User',
        total_count: safeTotal,
        malas: Math.floor(safeTotal / 108),
        count: safeTotal % 108,
        updated_at: new Date().toISOString(),
      }),
    });

    if (!response.ok) console.log('Total save error:', await response.text());
  };

  const getLocalTodayTotalForUser = useCallback(async (userId: string) => {
    const rawHistory = await AsyncStorage.getItem(HISTORY_KEY);
    const sessions = parseHistory(rawHistory);
    const todayKey = getLocalDateKey();

    return sessions
      .filter((item) => item.userId === userId && getLocalDateKey(new Date(item.date)) === todayKey)
      .reduce((sum, item) => sum + (Number(item.totalCount) || 0), 0);
  }, []);

  const restoreTodayTotal = useCallback(async () => {
    const savedUserId = await AsyncStorage.getItem(USER_ID_KEY);
  
    if (savedUserId) {
      const remoteTodayTotal = await fetchTodayTotalFromSupabase(savedUserId);
      const localTodayTotal = await getLocalTodayTotalForUser(savedUserId);
      const cloudTotal = await fetchUserTotalFromSupabase(savedUserId);
      const safeCloudTotal = Math.max(0, Math.floor(Number(cloudTotal) || 0));
      const safeRemoteTotal = Math.max(0, Math.floor(Number(remoteTodayTotal) || 0));
      const finalTotal =
        remoteTodayTotal !== null
          ? Math.max(safeRemoteTotal, localTodayTotal)
          : Math.max(localTodayTotal, safeCloudTotal);
  
      await restoreTotal(finalTotal, { userId: savedUserId });
      totalRef.current = finalTotal;
      await refreshDayStreak({ userId: savedUserId, todayTotal: finalTotal });
      setHasRestoredTotal(true);
      return;
    }
  
    await restoreTotal(0, { userId: null });
    totalRef.current = 0;
    await refreshDayStreak({ userId: null, todayTotal: 0 });
    setHasRestoredTotal(true);
  }, [fetchTodayTotalFromSupabase, getLocalTodayTotalForUser, refreshDayStreak, restoreTotal]);

  useFocusEffect(
    useCallback(() => {
      let mounted = true;

      void (async () => {
        const marker = await AsyncStorage.getItem(HISTORY_SYNC_VERSION_KEY);
        if (!mounted || !marker) return;
        await restoreTodayTotal();
      })();

      return () => {
        mounted = false;
      };
    }, [restoreTodayTotal])
  );

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    document.title = isRunning ? `⏱ ${formatTime(seconds)} — Mantra Japam` : 'Mantra Japam';
  }, [isRunning, seconds]);

  useEffect(() => {
    const onHistoryUpdated = () => {
      void restoreTodayTotal();
    };

    const subscription = DeviceEventEmitter.addListener('japam-history-updated', onHistoryUpdated);

    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      window.addEventListener('japam-history-updated', onHistoryUpdated as EventListener);
    }

    return () => {
      subscription.remove();
      if (Platform.OS === 'web' && typeof window !== 'undefined') {
        window.removeEventListener('japam-history-updated', onHistoryUpdated as EventListener);
      }
    };
  }, [restoreTodayTotal]);

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;

    const dismissKey = 'install-banner-dismissed-at';
    const dismissWindowMs = 7 * 24 * 60 * 60 * 1000;
    const dismissedAt = Number(window.localStorage.getItem(dismissKey) || '0');
    const recentlyDismissed = dismissedAt > 0 && Date.now() - dismissedAt < dismissWindowMs;

    const onBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      if (recentlyDismissed) return;
      deferredInstallPromptRef.current = event;
      setShowInstallBanner(true);
    };

    const onAppInstalled = () => {
      deferredInstallPromptRef.current = null;
      setShowInstallBanner(false);
      window.localStorage.removeItem(dismissKey);
    };

    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    window.addEventListener('appinstalled', onAppInstalled);

    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
      window.removeEventListener('appinstalled', onAppInstalled);
    };
  }, []);

  useEffect(() => {
    timerRef.current = { seconds, isRunning, targetSeconds, minutesInput, loopTimer };
  }, [seconds, isRunning, targetSeconds, minutesInput, loopTimer]);

  useEffect(() => {
    let isMounted = true;

    const preloadSounds = async () => {
      try {
        const [normalSound, finalSound] = await Promise.all([
          Audio.Sound.createAsync(require('../../assets/soft_tibetan_bowl.wav'), {
            shouldPlay: false,
            volume: 0.45,
          }),
          Audio.Sound.createAsync(require('../../assets/soft_tibetan_bowl_final.wav'), {
            shouldPlay: false,
            volume: 0.5,
          }),
        ]);

        if (!isMounted) {
          await normalSound.sound.unloadAsync().catch(console.log);
          await finalSound.sound.unloadAsync().catch(console.log);
          return;
        }

        normalCompleteSoundRef.current = normalSound.sound;
        finalCompleteSoundRef.current = finalSound.sound;
      } catch (error) {
        console.log('Sound preload error:', error);
      }
    };

    void preloadSounds();

    return () => {
      isMounted = false;
      normalCompleteSoundRef.current?.unloadAsync().catch(console.log);
      finalCompleteSoundRef.current?.unloadAsync().catch(console.log);
      normalCompleteSoundRef.current = null;
      finalCompleteSoundRef.current = null;
    };
  }, []);

  const saveTimerStateToSupabase = async (userId: string, timerState: {
    seconds: number; isRunning: boolean; targetSeconds: number; minutesInput: string; loopTimer: boolean;
  }) => {
    const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
    const key = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !key || !userId) return;

    await fetch(`${url}/rest/v1/japam_timer_state?on_conflict=user_id`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: key,
        Authorization: `Bearer ${key}`,
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify({
        user_id: userId,
        seconds: timerState.seconds,
        is_running: timerState.isRunning,
        target_seconds: timerState.targetSeconds,
        minutes_input: timerState.minutesInput,
        loop_timer: timerState.loopTimer,
        updated_at: new Date().toISOString(),
      }),
    });
  };

  useEffect(() => {
    if (!hasRestoredTimer || suppressTimerSaveRef.current) return;
    void (async () => {
      await AsyncStorage.setItem(TIMER_SECONDS_KEY, String(seconds));
      await AsyncStorage.setItem(TIMER_RUNNING_KEY, String(isRunning));
      await AsyncStorage.setItem(TIMER_TARGET_KEY, String(targetSeconds));
      await AsyncStorage.setItem(TIMER_MINUTES_KEY, minutesInput);
      await AsyncStorage.setItem(TIMER_LOOP_KEY, String(loopTimer));

      const savedUserId = await AsyncStorage.getItem(USER_ID_KEY);
      if (!savedUserId) return;

      await AsyncStorage.setItem(getUserStorageKey(TIMER_SECONDS_KEY, savedUserId), String(seconds));
      await AsyncStorage.setItem(getUserStorageKey(TIMER_RUNNING_KEY, savedUserId), String(isRunning));
      await AsyncStorage.setItem(getUserStorageKey(TIMER_TARGET_KEY, savedUserId), String(targetSeconds));
      await AsyncStorage.setItem(getUserStorageKey(TIMER_MINUTES_KEY, savedUserId), minutesInput);
      await AsyncStorage.setItem(getUserStorageKey(TIMER_LOOP_KEY, savedUserId), String(loopTimer));

      const now = Date.now();
      if (isRunning && now - timerCloudLastSavedAtRef.current < 10000) return;
      timerCloudLastSavedAtRef.current = now;
      await saveTimerStateToSupabase(savedUserId, { seconds, isRunning, targetSeconds, minutesInput, loopTimer });
    })();
  }, [seconds, isRunning, targetSeconds, minutesInput, loopTimer, hasRestoredTimer]);

  const fetchTimerStateFromSupabase = useCallback(async (userId: string): Promise<TimerStateRow | null> => {
    const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
    const key = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !key || !userId) return null;

    const encodedUserId = encodeURIComponent(userId);
    const response = await fetch(
      `${url}/rest/v1/japam_timer_state?user_id=eq.${encodedUserId}&select=seconds,is_running,target_seconds,minutes_input,loop_timer,updated_at&limit=1`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } }
    );

    if (!response.ok) return null;
    const rows = await response.json();
    return rows?.[0] || null;
  }, []);

  const applyRestoredTimerState = useCallback((timerState: TimerStateRow) => {
    const savedTarget = Math.max(60, Math.floor(Number(timerState.target_seconds) || DEFAULT_TIMER_MINUTES * 60));
  
    timerStartedAtRef.current = null;
    setSeconds(0);
    setIsRunning(false);
    setTargetSeconds(savedTarget);
    setMinutesInput(timerState.minutes_input || String(Math.max(1, Math.floor(savedTarget / 60))));
    setHasSelectedTimer(true);
    setLoopTimer(Boolean(timerState.loop_timer));
  }, []);

  useEffect(() => {
    const loadData = async () => {
      const today = getLocalDateKey();
      const savedUserName = await AsyncStorage.getItem(USER_NAME_KEY);
      const savedUserId = await AsyncStorage.getItem(USER_ID_KEY);
      const authPending = await isAuthPending();

      if (savedUserId) {
        const userJapamName = await AsyncStorage.getItem(getUserStorageKey(JAPAM_NAME_KEY, savedUserId));
        if (userJapamName) {
          setJapamName(userJapamName);
          setNameInput(userJapamName);
          setHasSetName(true); // ✅ name already set
        }
      }

      if (savedUserName && savedUserId) {
        setUserName(savedUserName);
        setShowUserModal(false);
        await restoreTodayTotal();
      } else {
        setUserName('');
        setIsSigningIn(authPending);
        setShowUserModal(false);
        setDayStreak(0);
        await restoreTotal(0, { userId: null });
      }

      if (savedUserId) {
        const timerState = await fetchTimerStateFromSupabase(savedUserId);
        if (timerState) {
          applyRestoredTimerState(timerState);
        } else {
          const savedTimerSeconds = Number((await AsyncStorage.getItem(getUserStorageKey(TIMER_SECONDS_KEY, savedUserId))) || '0');
          const savedTimerRunning = (await AsyncStorage.getItem(getUserStorageKey(TIMER_RUNNING_KEY, savedUserId))) === 'true';
          const savedTimerTarget = Number((await AsyncStorage.getItem(getUserStorageKey(TIMER_TARGET_KEY, savedUserId))) || String(DEFAULT_TIMER_MINUTES * 60));
          const savedTimerMinutes = (await AsyncStorage.getItem(getUserStorageKey(TIMER_MINUTES_KEY, savedUserId))) || String(DEFAULT_TIMER_MINUTES);
          const savedTimerLoop = (await AsyncStorage.getItem(getUserStorageKey(TIMER_LOOP_KEY, savedUserId))) === 'true';
          setSeconds(0);
          setIsRunning(false);
          setTargetSeconds(savedTimerTarget);
          setMinutesInput(savedTimerMinutes);
          setHasSelectedTimer(true);
          setLoopTimer(savedTimerLoop);
        }
      } else {
        setSeconds(0);
        setIsRunning(false);
        setTargetSeconds(DEFAULT_TIMER_MINUTES * 60);
        setMinutesInput(String(DEFAULT_TIMER_MINUTES));
        setHasSelectedTimer(false);
        setLoopTimer(false);
        await AsyncStorage.setItem(TIMER_SECONDS_KEY, '0');
        await AsyncStorage.setItem(TIMER_RUNNING_KEY, 'false');
        await AsyncStorage.setItem(TIMER_TARGET_KEY, String(DEFAULT_TIMER_MINUTES * 60));
        await AsyncStorage.setItem(TIMER_MINUTES_KEY, String(DEFAULT_TIMER_MINUTES));
        await AsyncStorage.setItem(TIMER_LOOP_KEY, 'false');
      }

      setHasRestoredTimer(true);
      await AsyncStorage.setItem(LAST_OPEN_DATE_KEY, today);
    };

    void loadData();
  }, [applyRestoredTimerState, fetchTimerStateFromSupabase, restoreTodayTotal, restoreTotal]);

  useEffect(() => {
    return () => {
      if (dbTotalSaveTimeoutRef.current) {
        clearTimeout(dbTotalSaveTimeoutRef.current);
      }
      normalCompleteSoundRef.current?.unloadAsync().catch(console.log);
      finalCompleteSoundRef.current?.unloadAsync().catch(console.log);
      clearTimerHandles();
    };
  }, [clearTimerHandles]);

  const loadJapamNameFromSupabase = useCallback(async (googleUserId: string) => {
    try {
      const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
      const supabaseKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
      if (!supabaseUrl || !supabaseKey) return;

      const encodedUserId = encodeURIComponent(googleUserId);
      const profileResponse = await fetch(
        `${supabaseUrl}/rest/v1/user_profiles?user_id=eq.${encodedUserId}&select=japam_name`,
        { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } }
      );

      const rows = await profileResponse.json();
      if (rows?.length > 0 && rows[0]?.japam_name) {
        setJapamName(rows[0].japam_name);
        setNameInput(rows[0].japam_name);
        setHasSetName(true);
        await AsyncStorage.setItem(getUserStorageKey(JAPAM_NAME_KEY, googleUserId), rows[0].japam_name);
        return;
      }

      const localName = await AsyncStorage.getItem(getUserStorageKey(JAPAM_NAME_KEY, googleUserId));
      if (localName) {
        setJapamName(localName);
        setNameInput(localName);
        setHasSetName(true);
      }
    } catch (error) {
      console.log('Profile fetch error:', error);
    }
  }, []);

  const restoreHistoryFromSupabase = useCallback(async (googleUserId: string) => {
    try {
      const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
      const supabaseKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
      if (!supabaseUrl || !supabaseKey) return;

      const encodedUserId = encodeURIComponent(googleUserId);
      const response = await fetch(
        `${supabaseUrl}/rest/v1/japam_history?user_id=eq.${encodedUserId}&select=*&order=created_at.asc`,
        { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } }
      );

      if (!response.ok) return;

      const rows = await response.json();
      const remoteHistory: Session[] = rows.map((item: any) => ({
        date: item.created_at,
        malas: Number(item.malas) || 0,
        totalCount: Number(item.count) || 0,
        duration: 0,
        manual: false,
        userId: googleUserId,
      }));

      const rawLocal = await AsyncStorage.getItem(HISTORY_KEY);
      const localHistory: Session[] = rawLocal ? JSON.parse(rawLocal) : [];
      const otherUserLocalHistory = localHistory.filter((item) => item.userId !== googleUserId);

      const mergedHistory = [...remoteHistory, ...otherUserLocalHistory].sort(
        (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
      );

      await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(mergedHistory));
      await restoreTodayTotal();
    } catch (error) {
      console.log('History restore error:', error);
    }
  }, [restoreTodayTotal]);

  const restoreTimerForUser = useCallback(async (userId: string) => {
    const timerState = await fetchTimerStateFromSupabase(userId);
    if (timerState) {
      applyRestoredTimerState(timerState);
    }
    setHasRestoredTimer(true);
  }, [applyRestoredTimerState, fetchTimerStateFromSupabase]);

  useEffect(() => {
    const handleGoogleLogin = async () => {
      if (!response) return;

      if (response.type !== 'success') {
        setIsSigningIn(false);
        await AsyncStorage.removeItem(AUTH_PENDING_KEY);
        const savedUserId = await AsyncStorage.getItem(USER_ID_KEY);
        if (!savedUserId) setShowUserModal(true);
        return;
      }

      setIsSigningIn(true);
      setShowUserModal(false);

      const { authentication } = response;
      const accessToken =
        authentication?.accessToken ||
        ('params' in response ? response.params?.access_token : undefined);

      if (!accessToken) {
        await AsyncStorage.removeItem(AUTH_PENDING_KEY);
        setIsSigningIn(false);
        setShowUserModal(true);
        return;
      }

      try {
        const userInfoResponse = await fetch('https://www.googleapis.com/userinfo/v2/me', {
          headers: { Authorization: `Bearer ${accessToken}` },
        });

        const userInfo = await userInfoResponse.json();
        const googleName = userInfo?.given_name || userInfo?.name || userInfo?.email || 'User';
        const googleEmail = userInfo?.email || '';
        const googleUserId = String(userInfo?.id || '').trim();

        if (!googleUserId) { setShowUserModal(true); return; }

        setHasRestoredTimer(false);
        setUserName(googleName);
        setShowUserModal(false);
        setShowUserMenu(false);
        await restoreTotal(0, { userId: null });
        totalRef.current = 0;
        await AsyncStorage.setItem(USER_NAME_KEY, googleName);
        if (googleEmail) {
          await AsyncStorage.setItem(USER_EMAIL_KEY, googleEmail);
        }
        await AsyncStorage.setItem(USER_ID_KEY, googleUserId);

        await loadJapamNameFromSupabase(googleUserId);
        await restoreTodayTotal();
        await restoreHistoryFromSupabase(googleUserId);
        await restoreTimerForUser(googleUserId);
      } catch (error) {
        console.log('Google login error:', error);
        setShowUserModal(true);
      } finally {
        await AsyncStorage.removeItem(AUTH_PENDING_KEY);
        setIsSigningIn(false);
      }
    };

    void handleGoogleLogin();
  }, [
    response,
    loadJapamNameFromSupabase,
    restoreHistoryFromSupabase,
    restoreTimerForUser,
    restoreTodayTotal,
    restoreTotal,
  ]);

  useEffect(() => {
    totalRef.current = total;
    if (!hasRestoredTotal || !userName) return;

    void (async () => {
      await AsyncStorage.setItem(COUNT_KEY, String(count));
      await AsyncStorage.setItem(MALAS_KEY, String(malas));
      await AsyncStorage.setItem(TOTAL_KEY, String(total));

      const savedUserId = await AsyncStorage.getItem(USER_ID_KEY);
      if (savedUserId) {
        await AsyncStorage.setItem(getUserStorageKey(COUNT_KEY, savedUserId), String(count));
        await AsyncStorage.setItem(getUserStorageKey(MALAS_KEY, savedUserId), String(malas));
        await AsyncStorage.setItem(getUserStorageKey(TOTAL_KEY, savedUserId), String(total));
        await refreshDayStreak({ userId: savedUserId, todayTotal: total });

        if (dbTotalSaveTimeoutRef.current) {
          clearTimeout(dbTotalSaveTimeoutRef.current);
        }

        dbTotalSaveTimeoutRef.current = setTimeout(async () => {
          const activeUserId = await AsyncStorage.getItem(USER_ID_KEY);
          if (!activeUserId || activeUserId !== savedUserId) return;

          const savedUserName = await AsyncStorage.getItem(USER_NAME_KEY);
          await saveUserTotalToSupabase(activeUserId, savedUserName || userName || 'User', totalRef.current);
        }, 2000);
      }
    })();
  }, [count, malas, total, userName, hasRestoredTotal, refreshDayStreak]);

  useEffect(() => {
    if (!isRunning) {
      clearTimerHandles();
      return;
    }

    if (timerStartedAtRef.current === null) {
      timerStartedAtRef.current = Date.now() - timerRef.current.seconds * 1000;
    }

    startTimerInterval();
    return () => {
      if (timerIntervalRef.current) {
        clearInterval(timerIntervalRef.current);
        timerIntervalRef.current = null;
      }
    };
  }, [clearTimerHandles, isRunning, startTimerInterval]);

  useEffect(() => {
    if (!isRunning) return;
    if (seconds < targetSeconds) return;
    completeTimerSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seconds, isRunning, targetSeconds, loopTimer]);

  const playCompleteSound = async (variant: 'normal' | 'final' = 'normal') => {
    try {
      const sound = variant === 'final'
        ? finalCompleteSoundRef.current
        : normalCompleteSoundRef.current;

      if (!sound) return;

      await sound.stopAsync().catch(() => undefined);
      await sound.setPositionAsync(0).catch(() => undefined);
      await sound.playAsync();
    } catch (error) {
      console.log('Sound error:', error);
    }
  };

  const saveSession = useCallback(async (
    duration: number, sessionMalas: number, sessionTotal: number, accumulatedTotal: number
  ) => {
    if (isSavingSessionRef.current) return;
    const currentUserId = await AsyncStorage.getItem(USER_ID_KEY);
    const sessionSignature = `${currentUserId || 'guest'}-${getLocalDateKey()}-${duration}-${sessionMalas}-${sessionTotal}-${accumulatedTotal}`;
    if (lastSavedSessionRef.current === sessionSignature) return;

    isSavingSessionRef.current = true;
    lastSavedSessionRef.current = sessionSignature;

    try {
      const raw = await AsyncStorage.getItem(HISTORY_KEY);
      const history: Session[] = raw ? JSON.parse(raw) : [];
      const userId = currentUserId;
      const savedUserName = await AsyncStorage.getItem(USER_NAME_KEY);

      const session: Session = {
        date: new Date().toISOString(),
        malas: sessionMalas,
        totalCount: sessionTotal,
        duration,
        manual: false,
        userId: userId || undefined,
      };

      await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify([session, ...history]));
      if (!userId) return;

      const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
      const key = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

      if (url && key) {
        const baseBody = { user_name: savedUserName || userName, malas: sessionMalas, count: sessionTotal };
        const postHistory = async (body: Record<string, unknown>) => {
          const res = await fetch(`${url}/rest/v1/japam_history`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', apikey: key, Authorization: `Bearer ${key}`, Prefer: 'return=minimal' },
            body: JSON.stringify(body),
          });
          return res.ok;
        };
        const savedWithUserId = await postHistory({ user_id: userId, ...baseBody });
        if (!savedWithUserId) await postHistory(baseBody);
      }
    } catch (error) {
      console.log('Supabase save error:', error);
    } finally {
      isSavingSessionRef.current = false;
    }
  }, [userName]);

  const webVibrate = useCallback((pattern: number | number[]) => {
    if (
      !vibrationEnabled ||
      Platform.OS !== 'web' ||
      typeof navigator === 'undefined'
    ) {
      return false;
    }
  
    if (typeof navigator.vibrate !== 'function') {
      return false;
    }
  
    navigator.vibrate(pattern);
    return true;
  }, [vibrationEnabled]);

  const tapFeedback = useCallback(async () => {
    if (!vibrationEnabled) return;
  
    try {
      if (webVibrate(35)) {
        return;
      }

      if (Platform.OS === 'ios') {
        await Haptics.impactAsync(
          Haptics.ImpactFeedbackStyle.Light
        );
        return;
      }
  
      Vibration.vibrate(35);
  
      if (Platform.OS !== 'web') {
        await Haptics.impactAsync(
          Haptics.ImpactFeedbackStyle.Light
        );
      }
    } catch (error) {
      console.log('Tap vibration error:', error);
    }
  }, [vibrationEnabled, webVibrate]);

  const playCompletionAnimation = useCallback(() => {
    glowAnim.setValue(0);
    rippleAnim.setValue(0);
    Animated.timing(rippleAnim, { toValue: 1, duration: 900, useNativeDriver: true }).start();
    Animated.sequence([
      Animated.timing(glowAnim, { toValue: 1, duration: 300, useNativeDriver: false }),
      Animated.timing(glowAnim, { toValue: 0, duration: 300, useNativeDriver: false }),
      Animated.timing(glowAnim, { toValue: 1, duration: 300, useNativeDriver: false }),
      Animated.timing(glowAnim, { toValue: 0, duration: 500, useNativeDriver: false }),
    ]).start();
  }, [glowAnim, rippleAnim]);

  const completeFeedback = useCallback(async (variant: 'normal' | 'final' = 'normal') => {
    playCompletionAnimation();
  
    if (soundEnabled && repetitionSoundEnabled) {
      await playCompleteSound(variant);
    }
  
    if (!vibrationEnabled) return;
  
    try {
      if (Platform.OS === 'web') {
        webVibrate([200, 80, 200]);
        return;
      }
  
      if (Platform.OS === 'ios') {
        await Haptics.notificationAsync(
          Haptics.NotificationFeedbackType.Success
        );
  
        setTimeout(() => {
          Haptics.notificationAsync(
            Haptics.NotificationFeedbackType.Warning
          ).catch(console.log);
        }, 350);
  
        return;
      }
  
      Vibration.vibrate([200, 80, 200]);
    } catch (error) {
      console.log('Completion vibration error:', error);
    }
  }, [playCompletionAnimation, repetitionSoundEnabled, soundEnabled, vibrationEnabled, webVibrate]);

  const setCountersFromTotal = (nextTotal: number) => {
    const safeTotal = Math.max(0, Math.floor(Number(nextTotal) || 0));
    const nextMalas = Math.floor(safeTotal / 108);
    const nextCount = safeTotal % 108;

    void AsyncStorage.setItem(LAST_TOTAL_KEY, String(safeTotal));
    totalRef.current = safeTotal;
    setTotal(safeTotal);
    setMalas(nextMalas);
    setCount(nextCount);

    void (async () => {
      await AsyncStorage.setItem(TOTAL_KEY, String(safeTotal));
      await AsyncStorage.setItem(MALAS_KEY, String(nextMalas));
      await AsyncStorage.setItem(COUNT_KEY, String(nextCount));
      const savedUserId = await AsyncStorage.getItem(USER_ID_KEY);
      if (savedUserId) {
        await AsyncStorage.setItem(getUserStorageKey(TOTAL_KEY, savedUserId), String(safeTotal));
        await AsyncStorage.setItem(getUserStorageKey(MALAS_KEY, savedUserId), String(nextMalas));
        await AsyncStorage.setItem(getUserStorageKey(COUNT_KEY, savedUserId), String(nextCount));
      }
    })();

    return safeTotal;
  };

  

  const requireLogin = () => {
    if (!userName) { setShowUserModal(true); return false; }
    return true;
  };

  const handleTap = () => {
    if (!requireLogin()) return;
  
    const now = Date.now();
    if (now - lastTapRef.current < 100) return;
    lastTapRef.current = now;
  
    rippleAnim.setValue(0);
    Animated.timing(rippleAnim, {
      toValue: 1,
      duration: 700,
      useNativeDriver: true,
    }).start();
  
    const newTotal = setCountersFromTotal(totalRef.current + 1);
    const newCount = newTotal % 108;
  
    if (newCount === 0) {
      void saveSession(0, 1, 108, newTotal);
      void completeFeedback('final');
    } else {
      void tapFeedback();
    }
  };

  const handleStart = () => {
    if (!requireLogin()) return;
    const mins = Math.max(1, Math.floor(Number(minutesInput) || 1));
    const nextTargetSeconds = mins * 60;
    const targetChanged = nextTargetSeconds !== targetSeconds;
    const isResumeFromPause = !isRunning && seconds > 0 && !targetChanged;
    const nextSeconds = isResumeFromPause ? seconds : 0;

    clearTimerHandles();
    isCompletingRef.current = false;
    if (!isResumeFromPause) {
      completedLoopMalasRef.current = 0;
      setAutoCompletedMalas(0);
    }
    timerStartedAtRef.current = Date.now() - nextSeconds * 1000;
    timerRef.current = { seconds: nextSeconds, isRunning: true, targetSeconds: nextTargetSeconds, minutesInput: String(mins), loopTimer };
    setMinutesInput(String(mins));
    setHasSelectedTimer(true);
    setTargetSeconds(nextTargetSeconds);
    setSeconds(nextSeconds);
    setIsRunning(true);
    startTimerInterval();
  };

  const handlePause = () => {
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }
    timerStartedAtRef.current = null;
    setIsRunning(false);
    // CRITICAL: Do NOT call setSeconds(0) or clear selectedDuration
  };
  
  const applySessionMinutes = (minutes: number) => {
    const safeMinutes = Math.max(1, Math.floor(Number(minutes) || 1));

    if (isRunning) {
      setIsRunning(false);
      timerStartedAtRef.current = null;
    }

    clearTimerHandles();
    setMinutesInput(String(safeMinutes));
    setHasSelectedTimer(true);
    setTargetSeconds(safeMinutes * 60);
    setSeconds(0);
    setAutoCompletedMalas(0);
    setShowTimerSheet(false);
    setShowCustomTimerInput(false);
    setCustomMinutesInput('');
  };

  const applyCustomSessionMinutes = () => {
    applySessionMinutes(Number(customMinutesInput) || DEFAULT_TIMER_MINUTES);
  };

  const completeTimerSession = useCallback(() => {
    if (isCompletingRef.current) return;
    isCompletingRef.current = true;

    const currentTotal = totalRef.current;
    const nextTotal = currentTotal + 108;
    setCountersFromTotal(nextTotal);
    void saveSession(targetSeconds, 1, 108, nextTotal);
    void completeFeedback('normal');

    clearTimerHandles();
    timerStartedAtRef.current = null;

    if (loopTimer) {
      const nextLoopCount = completedLoopMalasRef.current + 1;
      completedLoopMalasRef.current = nextLoopCount;
      setAutoCompletedMalas(nextLoopCount);

      if (nextLoopCount >= 5) {
        setSeconds(0);
        setIsRunning(false);
        setLoopTimer(false);
        isCompletingRef.current = false;
        return;
      }

      autoRepeatTimeoutRef.current = setTimeout(() => {
        if (!timerRef.current.loopTimer || completedLoopMalasRef.current >= 5) {
          isCompletingRef.current = false;
          return;
        }

        timerStartedAtRef.current = Date.now();
        timerRef.current = {
          seconds: 0,
          isRunning: true,
          targetSeconds,
          minutesInput,
          loopTimer: true,
        };
        setSeconds(0);
        setIsRunning(true);
        startTimerInterval();
        isCompletingRef.current = false;
      }, 1700);
    } else {
      setSeconds(0);
      setIsRunning(false);
      isCompletingRef.current = false;
    }
  }, [clearTimerHandles, completeFeedback, loopTimer, minutesInput, saveSession, startTimerInterval, targetSeconds]);

  const performLogout = async () => {
    const currentUserId = await AsyncStorage.getItem(USER_ID_KEY);
    const currentUserName = await AsyncStorage.getItem(USER_NAME_KEY);
    const logoutSeconds = timerStartedAtRef.current === null
      ? seconds
      : Math.min(
          targetSeconds,
          Math.max(0, Math.floor((Date.now() - timerStartedAtRef.current) / 1000))
        );

    if (currentUserId) {
      await AsyncStorage.setItem(getUserStorageKey(TOTAL_KEY, currentUserId), String(totalRef.current));
      await saveUserTotalToSupabase(currentUserId, currentUserName || userName || 'User', totalRef.current);
      await saveTimerStateToSupabase(currentUserId, {
        seconds: 0,
        isRunning: false,
        targetSeconds,
        minutesInput,
        loopTimer,
      });
    }

    if (dbTotalSaveTimeoutRef.current) {
      clearTimeout(dbTotalSaveTimeoutRef.current);
      dbTotalSaveTimeoutRef.current = null;
    }

    timerStartedAtRef.current = null;
    timerStartedAtRef.current = null;
    clearTimerHandles();
    setSeconds(0);
    setIsRunning(false);
    suppressTimerSaveRef.current = true;
    await AsyncStorage.setItem(TIMER_SECONDS_KEY, '0');
    await AsyncStorage.setItem(TIMER_RUNNING_KEY, 'false');
    await AsyncStorage.setItem(TIMER_TARGET_KEY, String(DEFAULT_TIMER_MINUTES * 60));
    await AsyncStorage.setItem(TIMER_MINUTES_KEY, String(DEFAULT_TIMER_MINUTES));
    await AsyncStorage.setItem(TIMER_LOOP_KEY, 'false');
    await AsyncStorage.multiRemove([
      TIMER_SECONDS_KEY,
      TIMER_RUNNING_KEY,
      TIMER_TARGET_KEY,
      TIMER_MINUTES_KEY,
      TIMER_LOOP_KEY,
    ]);
    setIsRunning(false);
    setSeconds(0);
    setTargetSeconds(DEFAULT_TIMER_MINUTES * 60);
    setMinutesInput(String(DEFAULT_TIMER_MINUTES)); 
    setHasSelectedTimer(false);
    setLoopTimer(false);
    setDayStreak(0);
    setAutoCompletedMalas(0);
    setHasRestoredTimer(false);
    setShowUserMenu(false);
    setUserName('');
    setJapamName('');
    setNameInput('');
    setHasSetName(false); // ✅ reset on logout
    setShowUserModal(false);

    await AsyncStorage.removeItem(USER_NAME_KEY);
    await AsyncStorage.removeItem(USER_EMAIL_KEY);
await AsyncStorage.removeItem(USER_ID_KEY);

if (currentUserId) {
  await AsyncStorage.multiRemove([
    getUserStorageKey(TOTAL_KEY, currentUserId),
    getUserStorageKey(COUNT_KEY, currentUserId),
    getUserStorageKey(MALAS_KEY, currentUserId),
  ]);
}

await AsyncStorage.multiRemove([
  TOTAL_KEY,
  COUNT_KEY,
  MALAS_KEY,
  LAST_TOTAL_KEY,
]);

totalRef.current = 0;
setTotal(0);
setCount(0);
setMalas(0);

await restoreTotal(0, { userId: null });
setTimeout(() => { suppressTimerSaveRef.current = false; }, 0);
  };

  const handleLogout = () => {
    if (Platform.OS === 'web') {
      const ok = window.confirm('Do you want to logout?');
      if (ok) void performLogout();
      return;
    }
    Alert.alert('Logout', 'Do you want to logout?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Logout', style: 'destructive', onPress: () => void performLogout() },
    ]);
  };

  const handleInstallApp = async () => {
    const prompt = deferredInstallPromptRef.current;
    if (!prompt || typeof prompt.prompt !== 'function') {
      setShowInstallBanner(false);
      return;
    }

    prompt.prompt();
    try {
      await prompt.userChoice;
    } catch {
      // Ignore prompt cancellation errors.
    } finally {
      deferredInstallPromptRef.current = null;
      setShowInstallBanner(false);
    }
  };

  const dismissInstallBanner = () => {
    setShowInstallBanner(false);
    setInstallBannerDismissed(true);

    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      window.localStorage.setItem('install-banner-dismissed-at', String(Date.now()));
    }
  };

  const todayLabel = new Date().toLocaleDateString();
  const progressPercent = Math.min(100, Math.max(0, (count / 108) * 100));
  const progressRingBackground =
    Platform.OS === 'web'
      ? ({
          background: `conic-gradient(#0F8F87 ${progressPercent}%, rgba(15,143,135,0.14) 0)`,
        } as any)
      : null;

  return (
    <LinearGradient
      colors={['#edf7f4', '#d9eeeb', '#f8fbf7']}
      start={{ x: 0, y: 0 }}
      end={{ x: 0, y: 1 }}
      style={{ flex: 1 }}
    >
      <ScrollView style={styles.container} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.appShell}>
          <View pointerEvents="none" style={styles.sceneLayer}>
            <ImageBackground
              source={require('../../assets/images/zen-background.png')}
              resizeMode="cover"
              style={styles.backgroundImage}
              imageStyle={styles.backgroundImageStyle}
            >
              <View style={styles.backgroundOverlay} />
            </ImageBackground>
          </View>

          {isSigningIn && (
            <View style={styles.signingInBanner}>
              <Text style={styles.signingInText}>Signing in...</Text>
            </View>
          )}

          <View style={styles.topControls}>
            <Text style={styles.welcomeText}>Welcome back</Text>

            <Pressable
              style={({ pressed }) => [styles.accountButton, pressed && styles.softPressed]}
              onPress={() => {
                if (userName) {
                  setShowUserMenu((prev) => !prev);
                  return;
                }

                setShowUserModal(true);
              }}
            >
              <Text style={styles.accountNameText}>{userName || 'Sign in'}</Text>
            </Pressable>

            {showUserMenu && (
              <View style={styles.userMenu}>
                <Pressable style={styles.userMenuItem} onPress={handleLogout}>
                  <Text style={styles.userMenuText}>Logout</Text>
                </Pressable>
              </View>
            )}
          </View>

          {showInstallBanner && !installBannerDismissed && (
            <View style={styles.installBanner}>
              <View style={styles.installBannerTextWrap}>
                <Text style={styles.installBannerTitle}>Install this app for a better experience</Text>
              </View>
              <View style={styles.installBannerActions}>
                <Pressable style={styles.installBannerSecondary} onPress={dismissInstallBanner}>
                  <Text style={styles.installBannerSecondaryText}>Not now</Text>
                </Pressable>
                <Pressable style={styles.installBannerPrimary} onPress={() => void handleInstallApp()}>
                  <Text style={styles.installBannerPrimaryText}>Install App</Text>
                </Pressable>
              </View>
            </View>
          )}

          <Text style={styles.dateText}>Today · {todayLabel}</Text>

          <Animated.View style={styles.progressShell}>
            <Animated.View
              pointerEvents="none"
              style={[
                styles.completionGlow,
                {
                  opacity: glowAnim.interpolate({
                    inputRange: [0, 1],
                    outputRange: [0, 0.42],
                  }),
                  transform: [
                    {
                      scale: glowAnim.interpolate({
                        inputRange: [0, 1],
                        outputRange: [0.92, 1.08],
                      }),
                    },
                  ],
                },
              ]}
            />
            <Pressable
              onPress={handleTap}
              style={({ pressed }) => [
                styles.progressPressable,
                pressed && styles.progressPressed,
              ]}
            >
              <View style={[styles.progressRing, progressRingBackground]}>
                <View style={styles.progressInner}>
                  <Text style={styles.progressCount}>{count}</Text>
                  <Text style={styles.progressGoal}>/ 108 malas</Text>
                </View>
              </View>
            </Pressable>
          </Animated.View>

          <Pressable
            style={({ pressed }) => [styles.primaryAction, pressed && styles.primaryActionPressed]}
            onPress={isRunning ? handlePause : handleStart}
          >
            <Text style={styles.primaryActionText}>
              {isRunning
                ? `Pause Timer · ${formatTime(seconds)}`
                : seconds > 0
                  ? `Resume Japam · ${formatTime(seconds)}`
                  : '▶ Start Japam'}
            </Text>
          </Pressable>

          <Pressable
            style={({ pressed }) => [styles.sessionChip, pressed && styles.softPressed]}
            onPress={() => {
              setShowCustomTimerInput(false);
              setShowTimerSheet(true);
            }}
          >
            <Ionicons name="time-outline" size={21} color="#0F8F87" style={styles.sessionChipIcon} />
            <Text style={styles.sessionChipText}>
              {hasSelectedTimer ? `Timer: ${minutesInput} min` : 'Select timer for Japam'}
            </Text>
            <Text style={styles.sessionChipArrow}>›</Text>
          </Pressable>

          <View style={styles.statsCard}>
            <View style={styles.statColumn}>
              <View style={styles.malaIcon} accessibilityElementsHidden>
                {malaBeadPositions.map((position, index) => (
                  <View
                    key={index}
                    style={[
                      styles.malaBead,
                      {
                        left: position.left,
                        top: position.top,
                      },
                    ]}
                  />
                ))}
              </View>
              <Text style={styles.statValue}>{malas}</Text>
              <Text style={styles.statLabel}>Malas today</Text>
            </View>
            <View style={styles.statDivider} />
            <View style={styles.statColumn}>
              <Ionicons name="flame-outline" style={styles.statIcon} />
              <Text style={styles.statValue}>{dayStreak}</Text>
              <Text style={styles.statLabel}>Day streak</Text>
            </View>
            <View style={styles.statDivider} />
            <View style={styles.statColumn}>
              <Ionicons name="radio-button-on-outline" style={styles.statIcon} />
              <Text style={styles.statValue}>{total}</Text>
              <Text style={styles.statLabel}>Today count</Text>
            </View>
          </View>
        </View>

        <Modal visible={showTimerSheet} transparent animationType="slide">
          <View style={styles.sheetOverlay}>
            <Pressable style={styles.sheetBackdrop} onPress={() => setShowTimerSheet(false)} />
            <View style={styles.sessionSheet}>
              <View style={styles.sheetHandle} />
              {showCustomTimerInput ? (
                <>
                  <Text style={styles.sheetTitle}>Custom timer</Text>
                  <Text style={styles.sheetSubtitle}>Enter your own practice length</Text>

                  <View style={styles.customTimerPanel}>
                    <TextInput
                      style={styles.customTimerInput}
                      value={customMinutesInput}
                      onChangeText={setCustomMinutesInput}
                      placeholder="Minutes"
                      placeholderTextColor="#7f9798"
                      keyboardType="numeric"
                      autoFocus
                    />
                    <Pressable style={styles.customApplyButton} onPress={applyCustomSessionMinutes}>
                      <Text style={styles.customApplyText}>Set</Text>
                    </Pressable>
                  </View>

                  <Pressable
                    style={styles.cancelSheetButton}
                    onPress={() => setShowCustomTimerInput(false)}
                  >
                    <Text style={styles.cancelSheetText}>Back</Text>
                  </Pressable>
                </>
              ) : (
                <>
                  <Text style={styles.sheetTitle}>Select timer for Japam</Text>
                  <Text style={styles.sheetSubtitle}>Choose how long you want to practice</Text>

                  {SESSION_TIME_OPTIONS.map((minutes) => {
                    const isSelected = Number(minutesInput) === minutes;

                    return (
                      <Pressable
                        key={minutes}
                        style={({ pressed }) => [
                          styles.timeOption,
                          isSelected && styles.timeOptionSelected,
                          pressed && styles.softPressed,
                        ]}
                        onPress={() => applySessionMinutes(minutes)}
                      >
                        <Text style={styles.timeOptionIcon}>◷</Text>
                        <Text style={styles.timeOptionText}>{minutes} min</Text>
                        <View style={[styles.optionRadio, isSelected && styles.optionRadioSelected]}>
                          {isSelected && <Text style={styles.optionCheck}>✓</Text>}
                        </View>
                      </Pressable>
                    );
                  })}

                  <Pressable
                    style={({ pressed }) => [styles.timeOption, pressed && styles.softPressed]}
                    onPress={() => setShowCustomTimerInput(true)}
                  >
                    <Text style={styles.timeOptionIcon}>✎</Text>
                    <Text style={styles.timeOptionText}>Custom</Text>
                    <Text style={styles.sessionChipArrow}>›</Text>
                  </Pressable>

                  <View style={styles.sheetAutoRepeatRow}>
                    <View style={styles.sheetAutoRepeatCopy}>
                      <Text style={styles.sheetAutoRepeatTitle}>Auto repeat</Text>
                      <Text style={styles.sheetAutoRepeatDescription}>
                        Repeat up to 5 malas automatically
                      </Text>
                    </View>
                    <Switch
                      value={loopTimer}
                      onValueChange={(value) => {
                        setLoopTimer(value);
                        setAutoCompletedMalas(0);
                        if (!value) {
                          setIsRunning(false);
                          setSeconds(0);
                        }
                      }}
                      trackColor={{ false: '#c8d8d5', true: '#9fd6d0' }}
                      thumbColor={loopTimer ? '#0F8F87' : '#ffffff'}
                    />
                  </View>
                </>
              )}
            </View>
          </View>
        </Modal>

        <Modal visible={showUserModal && !isSigningIn} transparent animationType="fade">
          <View style={styles.modalOverlay}>
            <View style={styles.modalCard}>
              <Pressable style={styles.modalClose} onPress={() => setShowUserModal(false)}>
                <Text style={styles.modalCloseText}>×</Text>
              </Pressable>
              <View style={styles.modalTopMark}>
                <View style={styles.modalTopDot} />
              </View>
              <Text style={styles.modalTitle}>Sign in to save</Text>
              <Text style={styles.modalSubtitle}>
                Sign in with Google to save your Japam history and sync across devices.
              </Text>
              <Pressable
                disabled={!request}
                style={[styles.modalButton, !request && styles.disabledButton]}
                onPress={() => {
                  setIsSigningIn(true);
                  setShowUserModal(false);
                  void (async () => {
                    await AsyncStorage.setItem(AUTH_PENDING_KEY, String(Date.now()));
                    const result = await promptAsync({ showInRecents: true });
                    if (result.type !== 'success') {
                      await AsyncStorage.removeItem(AUTH_PENDING_KEY);
                      setIsSigningIn(false);
                      setShowUserModal(true);
                    }
                  })();
                }}
              >
                <View style={styles.googleIcon}>
                  <Text style={styles.googleIconText}>G</Text>
                </View>
                <Text style={styles.modalButtonText}>Continue with Google</Text>
              </Pressable>
              <Text style={styles.modalFootnote}>
                Your history stays separate from other users on this device.
              </Text>
            </View>
          </View>
        </Modal>
      </ScrollView>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  sceneLayer: {
    ...StyleSheet.absoluteFillObject,
    overflow: 'hidden',
  },
  backgroundImage: {
    ...StyleSheet.absoluteFillObject,
    width: '100%',
    height: '100%',
  },
  backgroundImageStyle: {
    width: '100%',
    height: '100%',
    ...(Platform.OS === 'web'
      ? ({ filter: 'contrast(1.08) saturate(1.04)' } as any)
      : {}),
  },
  backgroundOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(245, 250, 250, 0.45)',
  },
  skyGlow: {
    position: 'absolute',
    width: 440,
    height: 360,
    borderRadius: 220,
    backgroundColor: 'rgba(255,255,255,0.52)',
    top: -100,
    alignSelf: 'center',
  },
  horizonMist: {
    position: 'absolute',
    left: -20,
    right: -20,
    bottom: isMobile ? 214 : 230,
    height: 130,
    backgroundColor: 'rgba(255,255,255,0.32)',
    borderRadius: 80,
  },
  mountainLeftBack: {
    position: 'absolute',
    width: 250,
    height: 190,
    borderRadius: 120,
    backgroundColor: 'rgba(91, 130, 133, 0.16)',
    left: -86,
    bottom: isMobile ? 215 : 236,
    transform: [{ rotate: '-18deg' }, { scaleX: 1.35 }],
  },
  mountainRightBack: {
    position: 'absolute',
    width: 260,
    height: 190,
    borderRadius: 130,
    backgroundColor: 'rgba(81, 137, 138, 0.15)',
    right: -92,
    bottom: isMobile ? 204 : 224,
    transform: [{ rotate: '18deg' }, { scaleX: 1.28 }],
  },
  mountainLeftFront: {
    position: 'absolute',
    width: 210,
    height: 140,
    borderRadius: 100,
    backgroundColor: 'rgba(15, 143, 135, 0.11)',
    left: -74,
    bottom: isMobile ? 185 : 204,
    transform: [{ rotate: '-10deg' }, { scaleX: 1.35 }],
  },
  mountainRightFront: {
    position: 'absolute',
    width: 230,
    height: 150,
    borderRadius: 112,
    backgroundColor: 'rgba(15, 118, 110, 0.1)',
    right: -92,
    bottom: isMobile ? 177 : 198,
    transform: [{ rotate: '10deg' }, { scaleX: 1.36 }],
  },
  lakeSurface: {
    position: 'absolute',
    left: -30,
    right: -30,
    bottom: isMobile ? 70 : 88,
    height: isMobile ? 210 : 235,
    backgroundColor: 'rgba(178, 220, 219, 0.34)',
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.55)',
  },
  waterReflectionWide: {
    position: 'absolute',
    width: 250,
    height: 2,
    borderRadius: 99,
    backgroundColor: 'rgba(255,255,255,0.34)',
    alignSelf: 'center',
    bottom: isMobile ? 176 : 194,
  },
  waterReflectionShort: {
    position: 'absolute',
    width: 132,
    height: 2,
    borderRadius: 99,
    backgroundColor: 'rgba(255,255,255,0.28)',
    right: 62,
    bottom: isMobile ? 152 : 170,
  },
  waterReflectionTiny: {
    position: 'absolute',
    width: 80,
    height: 2,
    borderRadius: 99,
    backgroundColor: 'rgba(255,255,255,0.24)',
    left: 72,
    bottom: isMobile ? 132 : 150,
  },
  leafStem: {
    position: 'absolute',
    width: 2,
    height: 112,
    backgroundColor: 'rgba(77, 132, 91, 0.18)',
    left: 26,
    bottom: isMobile ? 206 : 230,
    transform: [{ rotate: '24deg' }],
  },
  leafOne: {
    position: 'absolute',
    width: 44,
    height: 19,
    borderRadius: 24,
    backgroundColor: 'rgba(94, 145, 103, 0.26)',
    left: 18,
    bottom: isMobile ? 295 : 320,
    transform: [{ rotate: '-24deg' }],
  },
  leafTwo: {
    position: 'absolute',
    width: 38,
    height: 17,
    borderRadius: 20,
    backgroundColor: 'rgba(94, 145, 103, 0.22)',
    left: 48,
    bottom: isMobile ? 270 : 294,
    transform: [{ rotate: '14deg' }],
  },
  leafThree: {
    position: 'absolute',
    width: 34,
    height: 15,
    borderRadius: 20,
    backgroundColor: 'rgba(94, 145, 103, 0.2)',
    left: 8,
    bottom: isMobile ? 254 : 278,
    transform: [{ rotate: '-34deg' }],
  },
  leafFour: {
    position: 'absolute',
    width: 36,
    height: 15,
    borderRadius: 20,
    backgroundColor: 'rgba(94, 145, 103, 0.17)',
    left: 42,
    bottom: isMobile ? 232 : 256,
    transform: [{ rotate: '22deg' }],
  },
  stoneShadow: {
    position: 'absolute',
    width: 124,
    height: 20,
    borderRadius: 99,
    backgroundColor: 'rgba(27, 72, 76, 0.1)',
    right: 42,
    bottom: isMobile ? 80 : 104,
  },
  stoneBase: {
    position: 'absolute',
    width: 102,
    height: 34,
    borderRadius: 99,
    backgroundColor: 'rgba(111, 139, 139, 0.38)',
    right: 52,
    bottom: isMobile ? 92 : 116,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.32)',
  },
  stoneMiddle: {
    position: 'absolute',
    width: 84,
    height: 30,
    borderRadius: 99,
    backgroundColor: 'rgba(133, 157, 157, 0.42)',
    right: 62,
    bottom: isMobile ? 120 : 144,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.32)',
  },
  stoneTop: {
    position: 'absolute',
    width: 62,
    height: 24,
    borderRadius: 99,
    backgroundColor: 'rgba(156, 176, 176, 0.44)',
    right: 74,
    bottom: isMobile ? 145 : 169,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.34)',
  },
  sceneSoftWash: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(245, 252, 250, 0.26)',
  },
  container: { flex: 1, backgroundColor: 'transparent' },
  content: {
    flexGrow: isMobile ? 0 : 1,
    alignItems: 'center',
    justifyContent: isMobile ? 'flex-start' : 'center',
    width: '100%',
    alignSelf: 'center',
    paddingHorizontal: isMobile ? 0 : 24,
    paddingTop: isMobile ? scrollTopPadding : 24,
    paddingBottom: scrollBottomPadding,
    minHeight: isMobile ? undefined : shellMinHeight,
  },
  appShell: {
    width: '100%',
    maxWidth: isMobile ? undefined : 460,
    minHeight: isMobile ? undefined : shellMinHeight,
    alignItems: 'center',
    overflow: 'hidden',
    position: 'relative',
    backgroundColor: 'rgba(238, 248, 246, 0.94)',
    borderRadius: isMobile ? 0 : 28,
    paddingHorizontal: isMobile ? 22 : 28,
    paddingTop: isShortMobile ? 14 : isMobile ? 20 : 34,
    paddingBottom: isMobile ? 20 : 116,
    shadowColor: '#0f766e',
    shadowOpacity: isMobile ? 0 : 0.16,
    shadowRadius: 28,
    shadowOffset: { width: 0, height: 16 },
    elevation: isMobile ? 0 : 12,
  },
  topControls: {
    width: '100%',
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: isShortMobile ? 10 : isMobile ? 16 : 32,
  },
  accountButton: {
    position: 'absolute',
    right: 0,
    top: 2,
    minHeight: 40,
    maxWidth: 128,
    paddingHorizontal: 14,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.66)',
    borderWidth: 1,
    borderColor: 'rgba(15,143,135,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#0f8f87',
    shadowOpacity: 0.08,
    shadowRadius: 16,
    elevation: 4,
  },
  softPressed: {
    transform: [{ scale: 0.96 }],
    opacity: 0.86,
    ...(Platform.OS === 'web'
      ? ({ transition: 'transform 180ms ease, opacity 180ms ease' } as any)
      : {}),
  },
  headerRow: {
    width: '100%',
    maxWidth: 760,
    flexDirection: isMobile ? 'column' : 'row',
    alignItems: 'center',
    justifyContent: isMobile ? 'center' : 'space-between',
    position: 'relative',
    marginBottom: isMobile ? 18 : 30,
  },
  greetingBlock: {
    alignItems: 'center',
    justifyContent: 'center',
    flex: 1,
  },
  headerActions: {
    position: 'absolute',
    right: 0,
    top: 0,
    alignItems: 'center',
    gap: 8,
  },
  welcomeText: {
    color: '#063B3B',
    fontSize: isMobile ? 22 : 24,
    fontWeight: '800',
    letterSpacing: 0,
  },
  accountNameText: {
    color: '#063B3B',
    fontSize: isMobile ? 14 : 15,
    fontWeight: '900',
  },
  kicker: {
    color: '#063B3B',
    fontSize: isMobile ? 23 : 26,
    fontWeight: '800',
    letterSpacing: 0,
  },
  streakPill: {
    minWidth: 78,
    backgroundColor: 'rgba(255,255,255,0.64)',
    borderRadius: 22,
    borderWidth: 1,
    borderColor: 'rgba(15,118,110,0.14)',
    paddingHorizontal: 12,
    paddingVertical: 8,
    alignItems: 'center',
    shadowColor: '#0f766e',
    shadowOpacity: 0.08,
    shadowRadius: 16,
    elevation: 4,
  },
  streakNumber: {
    color: '#0f766e',
    fontSize: 17,
    fontWeight: '900',
    lineHeight: 20,
  },
  streakLabel: {
    color: '#517579',
    fontSize: 10,
    fontWeight: '800',
    marginTop: 1,
  },
  userMenuWrap: { alignItems: 'flex-end', zIndex: 20 },
  userBadge: {
    backgroundColor: 'rgba(255,255,255,0.62)',
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(15,118,110,0.18)',
    elevation: 4,
  },
  desktopUserBadge: { position: 'absolute', right: 45, top: 0 },
  mobileUserBadge: { marginTop: 8, alignItems: 'center' },
  userBadgeText: { color: '#12383c', fontSize: 14, fontWeight: '800' },
  userMenu: {
    position: 'absolute',
    top: 48,
    right: 0,
    backgroundColor: 'rgba(255,255,255,0.9)',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(15,118,110,0.14)',
    overflow: 'hidden',
    minWidth: 124,
    shadowColor: '#0f766e',
    shadowOpacity: 0.12,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 },
    elevation: 8,
    zIndex: 30,
    ...(Platform.OS === 'web'
      ? ({ animation: 'fadeIn 180ms ease', backdropFilter: 'blur(12px)' } as any)
      : {}),
  },
  userMenuItem: { paddingVertical: 12, paddingHorizontal: 18, alignItems: 'center' },
  userMenuText: { color: '#12383c', fontSize: 14, fontWeight: '800' },
  title: {
    color: '#102f34',
    fontSize: isShortMobile ? 26 : isMobile ? 31 : 38,
    fontWeight: '900',
    textAlign: 'center',
    letterSpacing: 0,
  },
  zenSubtitle: {
    color: '#365f61',
    fontSize: isMobile ? 13 : 16,
    fontWeight: '600',
    marginTop: 8,
    textAlign: 'center',
  },
  renameHint: {
    backgroundColor: 'rgba(15,118,110,0.12)',
    color: '#0f766e',
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 999,
    fontSize: 12,
    fontWeight: '800',
    marginTop: 8,
    overflow: 'hidden',
  },
  nameEditor: {
    width: '100%',
    maxWidth: 520,
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
    marginBottom: 14,
    marginTop: 6,
  },
  nameInput: {
    flex: 1,
    backgroundColor: 'rgba(255,255,255,0.72)',
    color: '#12383c',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(15,118,110,0.14)',
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
  },
  dateText: {
    color: '#5F7F80',
    fontSize: isMobile ? 14 : 15,
    fontWeight: '700',
    marginBottom: isShortMobile ? 14 : isMobile ? 20 : 30,
  },
  progressShell: {
    width: progressCircleSize,
    height: progressCircleSize,
    borderRadius: progressCircleSize / 2,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#0f766e',
    shadowOpacity: 0.14,
    shadowRadius: 28,
    shadowOffset: { width: 0, height: 16 },
    elevation: 18,
    marginBottom: isShortMobile ? 18 : isMobile ? 24 : 34,
  },
  progressPressable: {
    borderRadius: 999,
  },
  progressPressed: {
    transform: [{ scale: 0.985 }],
    opacity: 0.92,
  },
  progressRing: {
    width: progressRingSize,
    height: progressRingSize,
    borderRadius: progressRingSize / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(15,143,135,0.14)',
    padding: isMobile ? 12 : 14,
    ...(Platform.OS === 'web'
      ? ({ transition: 'background 360ms ease, transform 220ms ease, opacity 220ms ease' } as any)
      : {}),
  },
  progressInner: {
    width: '100%',
    height: '100%',
    borderRadius: 999,
    backgroundColor: 'rgba(247,253,251,0.94)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.78)',
  },
  progressCount: {
    color: '#063B3B',
    fontSize: isShortMobile ? 58 : isMobile ? 72 : 88,
    fontWeight: '900',
    lineHeight: isShortMobile ? 68 : isMobile ? 82 : 98,
  },
  progressGoal: {
    color: '#5F7F80',
    fontSize: isMobile ? 15 : 17,
    fontWeight: '800',
    marginTop: 2,
  },
  ringProgressBar: {
    position: 'absolute',
    bottom: isMobile ? 34 : 42,
    width: '58%',
    height: 7,
    borderRadius: 999,
    backgroundColor: 'rgba(15,118,110,0.12)',
    overflow: 'hidden',
  },
  ringProgressFill: {
    height: '100%',
    borderRadius: 999,
    backgroundColor: '#0f766e',
  },
  big: {
    color: '#f8ffff',
    fontSize: isShortMobile ? 54 : isMobile ? 66 : 76,
    fontWeight: '900',
    marginTop: 0,
    textShadowColor: 'rgba(15,118,110,0.34)',
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 10,
  },
  progressBarBackground: {
    width: isMobile ? 240 : 320,
    height: 8,
    backgroundColor: 'rgba(15,118,110,0.16)',
    borderRadius: 999,
    overflow: 'hidden',
    marginBottom: 4,
    alignSelf: 'center',
  },
  progressBarFill: { height: '100%', backgroundColor: '#0f766e', borderRadius: 999 },
  progressText: { color: '#365f61', fontSize: isMobile ? 15 : 17, marginBottom: 6 },
  metricsRow: {
    width: '100%',
    maxWidth: isMobile ? 440 : 560,
    flexDirection: 'row',
    justifyContent: 'space-evenly',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.48)',
    borderWidth: 1,
    borderColor: 'rgba(15,118,110,0.14)',
    borderRadius: 24,
    paddingVertical: 13,
    paddingHorizontal: 10,
    marginTop: 8,
    marginBottom: 14,
  },
  metricText: { color: '#12383c', fontSize: isMobile ? 16 : 20, fontWeight: '800', textAlign: 'center' },
  timerRunningText: { fontSize: isMobile ? 26 : 34, color: '#0f766e', fontWeight: '900' },
  guidanceText: {
    maxWidth: 430,
    color: '#547071',
    fontSize: isMobile ? 12 : 14,
    lineHeight: isMobile ? 17 : 20,
    textAlign: 'center',
    marginTop: -2,
    marginBottom: 4,
    paddingHorizontal: 10,
  },
  circleGlow: {
    width: isShortMobile ? 138 : isMobile ? 168 : 198,
    height: isShortMobile ? 138 : isMobile ? 168 : 198,
    borderRadius: isShortMobile ? 69 : isMobile ? 84 : 99,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.26)',
    shadowColor: '#0f766e',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.28,
    shadowRadius: 30,
    elevation: 20,
    marginTop: 10,
    marginBottom: 4,
  },
  completionGlow: {
    position: 'absolute',
    width: progressCircleSize,
    height: progressCircleSize,
    borderRadius: progressCircleSize / 2,
    backgroundColor: 'rgba(15,143,135,0.18)',
  },
  circle: {
    width: isShortMobile ? 118 : isMobile ? 146 : 172,
    height: isShortMobile ? 118 : isMobile ? 146 : 172,
    borderRadius: isShortMobile ? 59 : isMobile ? 73 : 86,
    justifyContent: 'center',
    alignItems: 'center',
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(238,255,255,0.62)',
  },
  circlePressed: { transform: [{ scale: 0.96 }] },
  primaryAction: {
    width: '100%',
    maxWidth: 330,
    minHeight: isShortMobile ? 56 : isMobile ? 58 : 62,
    borderRadius: 999,
    backgroundColor: '#0F8F87',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#0f766e',
    shadowOpacity: 0.24,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 },
    elevation: 8,
    marginBottom: isMobile ? 16 : 26,
    ...(Platform.OS === 'web'
      ? ({ transition: 'transform 180ms ease, opacity 180ms ease, box-shadow 220ms ease' } as any)
      : {}),
  },
  primaryActionPressed: {
    transform: [{ scale: 0.98 }],
    opacity: 0.94,
  },
  primaryActionText: {
    color: '#ffffff',
    fontSize: isMobile ? 18 : 21,
    fontWeight: '900',
  },
  sessionChip: {
    minHeight: isShortMobile ? 46 : 50,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.74)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.8)',
    paddingHorizontal: 18,
    paddingVertical: 10,
    marginBottom: isShortMobile ? 18 : isMobile ? 24 : 24,
    shadowColor: '#0f8f87',
    shadowOpacity: 0.1,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 5,
  },
  sessionChipIcon: {
    marginRight: 2,
  },
  sessionChipText: {
    color: '#063B3B',
    fontSize: 16,
    fontWeight: '700',
  },
  sessionChipArrow: {
    color: '#5F7F80',
    fontSize: 24,
    fontWeight: '700',
    marginTop: -2,
  },
  autoRepeatSimpleRow: {
    width: '100%',
    maxWidth: 340,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: isMobile ? 16 : 18,
  },
  sessionLengthRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    marginBottom: isMobile ? 22 : 26,
  },
  sessionLengthLabel: {
    color: '#5F7F80',
    fontSize: 14,
    fontWeight: '800',
  },
  quietControlPanel: {
    width: '100%',
    maxWidth: isMobile ? 360 : 430,
    backgroundColor: 'rgba(255,255,255,0.5)',
    borderWidth: 1,
    borderColor: 'rgba(15,118,110,0.12)',
    borderRadius: 24,
    paddingHorizontal: isMobile ? 16 : 20,
    paddingVertical: isMobile ? 14 : 18,
    gap: 14,
    shadowColor: '#0f766e',
    shadowOpacity: 0.08,
    shadowRadius: 20,
    elevation: 4,
  },
  timerSummaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 14,
  },
  controlCopy: {
    flex: 1,
  },
  controlLabel: {
    color: '#12383c',
    fontSize: isMobile ? 15 : 17,
    fontWeight: '900',
  },
  controlHint: {
    color: '#5f7778',
    fontSize: isMobile ? 12 : 13,
    fontWeight: '600',
    marginTop: 3,
  },
  inputLabel: { color: '#365f61', fontSize: isMobile ? 14 : 16, marginTop: 14, marginBottom: 6 },
  input: {
    backgroundColor: 'rgba(255,255,255,0.62)',
    color: '#063B3B',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(15,118,110,0.14)',
    width: 76,
    textAlign: 'center',
    paddingVertical: 7,
    paddingHorizontal: 8,
    fontSize: 17,
    fontWeight: '900',
  },
  autoRepeatRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 14,
  },
  autoRepeatText: { color: '#063B3B', fontSize: isMobile ? 15 : 16, fontWeight: '800' },
  statsCard: {
    width: '100%',
    maxWidth: 380,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: 'rgba(255,255,255,0.75)',
    borderRadius: 28,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.72)',
    paddingVertical: isShortMobile ? 13 : isMobile ? 17 : 22,
    paddingHorizontal: isMobile ? 12 : 16,
    shadowColor: '#0f766e',
    shadowOpacity: 0.1,
    shadowRadius: 22,
    shadowOffset: { width: 0, height: 12 },
    elevation: 7,
    marginBottom: isMobile ? 20 : 28,
  },
  installBanner: {
    width: '100%',
    maxWidth: 380,
    alignSelf: 'center',
    marginTop: 8,
    marginBottom: 18,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.88)',
    borderWidth: 1,
    borderColor: 'rgba(15,118,110,0.14)',
    padding: 14,
    shadowColor: '#0f766e',
    shadowOpacity: 0.08,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 5,
  },
  installBannerTextWrap: {
    marginBottom: 12,
  },
  installBannerTitle: {
    color: '#063B3B',
    fontSize: 15,
    fontWeight: '800',
    textAlign: 'center',
    lineHeight: 21,
  },
  installBannerActions: {
    flexDirection: 'row',
    gap: 10,
    justifyContent: 'center',
  },
  installBannerSecondary: {
    flex: 1,
    minHeight: 44,
    borderRadius: 999,
    backgroundColor: 'rgba(95,127,128,0.1)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  installBannerSecondaryText: {
    color: '#063B3B',
    fontSize: 14,
    fontWeight: '700',
  },
  installBannerPrimary: {
    flex: 1,
    minHeight: 44,
    borderRadius: 999,
    backgroundColor: '#0F8F87',
    alignItems: 'center',
    justifyContent: 'center',
  },
  installBannerPrimaryText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '800',
  },
  statColumn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  statDivider: {
    width: 1,
    height: isShortMobile ? 46 : isMobile ? 52 : 58,
    backgroundColor: 'rgba(95,127,128,0.22)',
  },
  statIcon: {
    color: '#0F8F87',
    fontSize: 24,
    marginBottom: 6,
  },
  malaIcon: {
    width: 24,
    height: 24,
    marginBottom: 6,
  },
  malaBead: {
    position: 'absolute',
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#0F8F87',
  },
  statValue: {
    color: '#12383c',
    fontSize: isShortMobile ? 28 : isMobile ? 30 : 32,
    fontWeight: '800',
    lineHeight: isShortMobile ? 32 : isMobile ? 34 : 36,
  },
  statLabel: {
    color: '#5f7778',
    fontSize: isMobile ? 14 : 15,
    fontWeight: '600',
    textAlign: 'center',
    marginTop: 4,
  },
  sheetOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(6, 26, 27, 0.42)',
  },
  sheetBackdrop: {
    ...StyleSheet.absoluteFillObject,
  },
  sessionSheet: {
    width: '100%',
    maxWidth: 480,
    alignSelf: 'center',
    backgroundColor: 'rgba(255,255,255,0.96)',
    borderTopLeftRadius: 34,
    borderTopRightRadius: 34,
    paddingHorizontal: 20,
    paddingTop: 14,
    paddingBottom: 20,
    shadowColor: '#0f8f87',
    shadowOpacity: 0.18,
    shadowRadius: 28,
    shadowOffset: { width: 0, height: -8 },
    elevation: 20,
    ...(Platform.OS === 'web'
      ? ({ backdropFilter: 'blur(18px)', animation: 'sheetIn 260ms ease' } as any)
      : {}),
  },
  sheetHandle: {
    width: 52,
    height: 5,
    borderRadius: 999,
    backgroundColor: 'rgba(95,127,128,0.3)',
    alignSelf: 'center',
    marginBottom: 16,
  },
  sheetTitle: {
    color: '#063B3B',
    fontSize: 21,
    fontWeight: '900',
    textAlign: 'center',
  },
  sheetSubtitle: {
    color: '#5F7F80',
    fontSize: 14,
    fontWeight: '700',
    textAlign: 'center',
    marginTop: 8,
    marginBottom: 16,
  },
  timeOption: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: 'rgba(95,127,128,0.18)',
    backgroundColor: 'rgba(255,255,255,0.72)',
    paddingHorizontal: 16,
    marginBottom: 10,
  },
  timeOptionSelected: {
    borderColor: '#0F8F87',
    backgroundColor: 'rgba(15,143,135,0.08)',
  },
  timeOptionIcon: {
    width: 30,
    color: '#5F7F80',
    fontSize: 20,
    fontWeight: '900',
  },
  timeOptionText: {
    flex: 1,
    color: '#063B3B',
    fontSize: 16,
    fontWeight: '800',
  },
  optionRadio: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: 'rgba(95,127,128,0.28)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  optionRadioSelected: {
    backgroundColor: '#0F8F87',
    borderColor: '#0F8F87',
  },
  optionCheck: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '900',
  },
  customTimerPanel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 16,
  },
  customTimerInput: {
    flex: 1,
    backgroundColor: 'rgba(237,247,244,0.9)',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(15,143,135,0.16)',
    color: '#063B3B',
    fontSize: 16,
    fontWeight: '800',
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  customApplyButton: {
    backgroundColor: '#0F8F87',
    borderRadius: 14,
    paddingHorizontal: 18,
    paddingVertical: 12,
  },
  customApplyText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '900',
  },
  sheetAutoRepeatRow: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: 'rgba(95,127,128,0.18)',
    backgroundColor: 'rgba(237,247,244,0.74)',
    paddingHorizontal: 16,
    paddingVertical: 10,
    marginBottom: 16,
    gap: 12,
  },
  sheetAutoRepeatCopy: {
    flex: 1,
  },
  sheetAutoRepeatTitle: {
    color: '#063B3B',
    fontSize: 16,
    fontWeight: '900',
  },
  sheetAutoRepeatDescription: {
    color: '#5F7F80',
    fontSize: 12,
    fontWeight: '700',
    marginTop: 4,
  },
  cancelSheetButton: {
    minHeight: 52,
    borderRadius: 999,
    backgroundColor: 'rgba(95,127,128,0.1)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelSheetText: {
    color: '#063B3B',
    fontSize: 16,
    fontWeight: '800',
  },
  row: { flexDirection: 'row', gap: 12, marginTop: 14, marginBottom: 10 },
  btn: {
    backgroundColor: '#0f8a87',
    paddingVertical: isMobile ? 12 : 14,
    paddingHorizontal: isMobile ? 24 : 32,
    borderRadius: 999,
    minWidth: isMobile ? 120 : 150,
    alignItems: 'center',
    shadowColor: '#0f766e',
    shadowOpacity: 0.22,
    shadowRadius: 12,
    elevation: 5,
  },
  gray: { backgroundColor: '#5f7778' },
  smallBtn: { backgroundColor: '#0f8a87', paddingVertical: 10, paddingHorizontal: 14, borderRadius: 10 },
  graySmallBtn: { backgroundColor: '#5f7778', paddingVertical: 10, paddingHorizontal: 14, borderRadius: 10 },
  smallBtnText: { color: 'white', fontWeight: '700', fontSize: 14 },
  btnText: { color: 'white', fontWeight: '900', fontSize: isMobile ? 17 : 20 },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(7,32,34,0.52)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  modalCard: {
    width: '100%',
    maxWidth: 380,
    backgroundColor: '#f8ffff',
    borderRadius: 22,
    paddingHorizontal: 24,
    paddingTop: 26,
    paddingBottom: 22,
    borderWidth: 1,
    borderColor: 'rgba(15,118,110,0.18)',
    elevation: 12,
  },
  modalTopMark: {
    width: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: '#dbeceb',
    borderWidth: 1,
    borderColor: '#0f766e',
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
    marginBottom: 14,
  },
  modalTopDot: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#0f8a87',
    shadowColor: '#0f766e',
    shadowOpacity: 0.28,
    shadowRadius: 12,
  },
  modalTitle: { color: '#12383c', fontSize: 26, fontWeight: '900', marginBottom: 10, textAlign: 'center' },
  modalSubtitle: { color: '#365f61', fontSize: 15, lineHeight: 22, textAlign: 'center', marginBottom: 22 },
  modalButton: {
    backgroundColor: '#f8fafc',
    minHeight: 52,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 10,
    borderWidth: 1,
    borderColor: '#dbeceb',
  },
  disabledButton: { opacity: 0.5 },
  googleIcon: {
    width: 26, height: 26, borderRadius: 13,
    backgroundColor: 'white', alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: '#cbd5e1',
  },
  googleIconText: { color: '#2563eb', fontSize: 16, fontWeight: '900' },
  modalButtonText: { color: '#0f172a', fontWeight: '900', fontSize: 16 },
  modalFootnote: { color: '#547071', fontSize: 12, lineHeight: 17, textAlign: 'center', marginTop: 14 },
  modalClose: { position: 'absolute', right: 14, top: 10, zIndex: 10 },
  modalCloseText: { color: '#547071', fontSize: 28, fontWeight: '800' },
  loginButton: {
    backgroundColor: '#0f8a87',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 999,
    marginTop: 10,
    shadowColor: '#0f766e',
    shadowOpacity: 0.22,
    shadowRadius: 10,
    elevation: 4,
  },
  loginButtonDesktop: { position: 'absolute', right: 20, top: 0 },
  loginButtonMobile: {
    alignSelf: 'center',
    width: '90%',
    maxWidth: 300,
    alignItems: 'center',
  },
  loginButtonText: { color: '#ffffff', fontWeight: '900', fontSize: isMobile ? 15 : 16 },
  timerHint: { color: '#547071', fontSize: isMobile ? 12 : 14, marginTop: 8, textAlign: 'center' },
  disabledInput: { opacity: 0.55 },
  signingInBanner: {
    position: 'absolute', top: 60, alignSelf: 'center',
    backgroundColor: '#0f766e', paddingHorizontal: 16, paddingVertical: 8,
    borderRadius: 20, zIndex: 20,
  },
  signingInText: { color: '#fff', fontSize: 14, fontWeight: '600' },
});
