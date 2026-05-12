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
  Dimensions,
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

import { getRandomQuote } from '@/constants/quotes';

WebBrowser.maybeCompleteAuthSession();

type Session = {
  date: string;
  malas: number;
  totalCount: number;
  duration: number;
  manual?: boolean;
  userId?: string;
};

const COUNT_KEY = 'count';
const MALAS_KEY = 'malas';
const TOTAL_KEY = 'totalCount';
const HISTORY_KEY = 'history';
const JAPAM_NAME_KEY = 'japamName';
const LAST_OPEN_DATE_KEY = 'lastOpenDate';
const SOUND_ENABLED_KEY = 'soundEnabled';
const VIBRATION_ENABLED_KEY = 'vibrationEnabled';
const USER_NAME_KEY = 'userName';
const USER_ID_KEY = 'userId';
const AUTH_PENDING_KEY = 'authPending';
const LAST_TOTAL_KEY = 'lastTotal';
const AUTH_PENDING_MAX_MS = 2 * 60 * 1000;
const TIMER_SECONDS_KEY = 'timerSeconds';
const TIMER_RUNNING_KEY = 'timerRunning';
const TIMER_TARGET_KEY = 'timerTarget';
const TIMER_MINUTES_KEY = 'timerMinutes';
const TIMER_LOOP_KEY = 'timerLoop';

const screenWidth = Dimensions.get('window').width;
const isMobile = screenWidth < 500;


const getLocalDateKey = (date = new Date()) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

const isSameLocalDay = (dateValue: string, dayKey = getLocalDateKey()) => {
  const d = new Date(dateValue);
  if (Number.isNaN(d.getTime())) return false;
  return getLocalDateKey(d) === dayKey;
};

const getTodayRange = () => {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start: start.toISOString(), end: end.toISOString() };
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
  const [seconds, setSeconds] = useState(0);
  const [hasRestoredTotal, setHasRestoredTotal] = useState(false);
  const [hasRestoredTimer, setHasRestoredTimer] = useState(false);
  const [minutesInput, setMinutesInput] = useState('1');
  const [targetSeconds, setTargetSeconds] = useState(60);
  const [isRunning, setIsRunning] = useState(false);
  const [loopTimer, setLoopTimer] = useState(false);
  const [, setAutoCompletedMalas] = useState(0);
  const [japamName, setJapamName] = useState('Japam');
  const [nameInput, setNameInput] = useState('');
  const [showNameEditor, setShowNameEditor] = useState(false);
  const [userName, setUserName] = useState('');
  const [showUserModal, setShowUserModal] = useState(false);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [quote, setQuote] = useState('');
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [vibrationEnabled, setVibrationEnabled] = useState(true);

  const totalRef = useRef(0);
  const timerRef = useRef({
    seconds: 0,
    isRunning: false,
    targetSeconds: 60,
    minutesInput: '1',
    loopTimer: false,
  });
  const suppressTimerSaveRef = useRef(false);
  const backgroundTimerNoticeShownRef = useRef(false);
  const rippleAnim = useRef(new Animated.Value(0)).current;
  const isSavingSessionRef = useRef(false);
  const lastTapRef = useRef(0);

  const fade = useRef(new Animated.Value(0)).current;
  const glowAnim = useRef(new Animated.Value(0)).current;

  const particleAnim = useRef(new Animated.Value(0)).current;
  const omPulseAnim = useRef(new Animated.Value(1)).current;

  const formatTime = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

  const requestTimerNotificationPermission = async () => {
    if (
      Platform.OS !== 'web' ||
      typeof window === 'undefined' ||
      !('Notification' in window)
    ) {
      return;
    }

    if (window.Notification.permission === 'default') {
      await window.Notification.requestPermission();
    }
  };

  const showTimerNotification = useCallback((title: string, body: string) => {
    if (
      Platform.OS !== 'web' ||
      typeof window === 'undefined' ||
      !('Notification' in window) ||
      window.Notification.permission !== 'granted'
    ) {
      return;
    }

    new window.Notification(title, {
      body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: 'japam-timer',
    });
  }, []);

  const vibrateDevice = useCallback((pattern: number | number[]) => {
    if (!vibrationEnabled) return;

    if (
      Platform.OS === 'web' &&
      typeof navigator !== 'undefined' &&
      'vibrate' in navigator
    ) {
      navigator.vibrate(pattern);
      return;
    }

    Vibration.vibrate(pattern);
  }, [vibrationEnabled]);

  const googleRedirectUri =
    Platform.OS === 'web' && typeof window !== 'undefined'
      ? window.location.origin
      : undefined;

  const [request, response, promptAsync] = Google.useAuthRequest({
    clientId: process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID,
    scopes: ['profile', 'email'],
    redirectUri: googleRedirectUri,
  });

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

  const getLocalTodayTotal = useCallback(async (userIdOverride?: string | null) => {
    const today = getLocalDateKey();
    const savedUserId =
      userIdOverride === undefined
        ? await AsyncStorage.getItem(USER_ID_KEY)
        : userIdOverride;

    if (!savedUserId) return 0;

    const rawHistory = await AsyncStorage.getItem(HISTORY_KEY);
    const history: Session[] = rawHistory ? JSON.parse(rawHistory) : [];

    const todayHistoryTotal = history
      .filter((item) => {
        if (!savedUserId || item.userId !== savedUserId) return false;
        return isSameLocalDay(item.date, today);
      })
      .reduce((sum, item) => sum + (Number(item.totalCount) || 0), 0);

    const savedCount = Number((await AsyncStorage.getItem(getUserStorageKey(COUNT_KEY, savedUserId))) || '0');
    const savedMalas = Number((await AsyncStorage.getItem(getUserStorageKey(MALAS_KEY, savedUserId))) || '0');
    const savedTotal = Number((await AsyncStorage.getItem(getUserStorageKey(TOTAL_KEY, savedUserId))) || '0');

    return Math.max(savedTotal, todayHistoryTotal, savedMalas * 108 + savedCount);
  }, []);

  const fetchTodayTotalFromSupabase = useCallback(
    async (userId: string, userNameForFallback?: string | null) => {
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

          if (!result.ok) {
            console.log('Supabase fetch error:', await result.text());
            return null;
          }

          const rows: { count?: number | string }[] = await result.json();
          return rows.reduce((sum, row) => sum + (Number(row.count) || 0), 0);
        };

        const byUserId = await fetchBy('user_id', userId);
        const byUserName = userNameForFallback ? await fetchBy('user_name', userNameForFallback) : null;

        if (byUserId === null) return byUserName;
        if (byUserName === null) return byUserId;
        return Math.max(byUserId, byUserName);
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
      `${url}/rest/v1/japam_user_totals?user_id=eq.${encodedUserId}&select=total_count,count,malas&limit=1`,
      {
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
        },
      }
    );

    if (!response.ok) return null;

    const rows = await response.json();

    if (!rows?.[0]) return null;

    return Number(rows[0].total_count) || 0;
  };
  const saveUserTotalToSupabase = async (
    userId: string,
    userNameValue: string | null,
    totalValue: number
  ) => {
    const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
    const key = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

    if (!url || !key || !userId) {
      console.log('Missing Supabase total config');
      return;
    }

    const safeTotal = Math.max(0, Math.floor(Number(totalValue) || 0));
    if (safeTotal === 0) {
      return;
    }

    const response = await fetch(
      `${url}/rest/v1/japam_user_totals?on_conflict=user_id`,
      {
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
      }
    );

    if (!response.ok) {
      console.log('Total save error:', await response.text());
    }
  };
  const restoreTodayTotal = useCallback(async () => {
    const savedUserId = await AsyncStorage.getItem(USER_ID_KEY);
    const savedUserName = await AsyncStorage.getItem(USER_NAME_KEY);
    const localTodayTotal = await getLocalTodayTotal(savedUserId);

    let cloudTotal: number | null = null;

    if (savedUserId) {
      cloudTotal = await fetchUserTotalFromSupabase(savedUserId);

      const remoteTodayTotal = await fetchTodayTotalFromSupabase(
        savedUserId,
        savedUserName
      );

      const finalTotal =
        cloudTotal !== null
          ? Math.max(cloudTotal, localTodayTotal, remoteTodayTotal || 0)
          : Math.max(localTodayTotal, remoteTodayTotal || 0);

      await restoreTotal(finalTotal, { userId: savedUserId });
      setHasRestoredTotal(true);
      return;
    }

    await restoreTotal(localTodayTotal, { userId: savedUserId });
    setHasRestoredTotal(true);
  }, [
    fetchTodayTotalFromSupabase,
    getLocalTodayTotal,
    restoreTotal
  ]);
  useFocusEffect(
    useCallback(() => {
      const loadSettingsAndRestoreToday = async () => {
        const savedSound = await AsyncStorage.getItem(SOUND_ENABLED_KEY);
        const savedVibration = await AsyncStorage.getItem(VIBRATION_ENABLED_KEY);
        setSoundEnabled(savedSound !== 'false');
        setVibrationEnabled(savedVibration !== 'false');
        await restoreTodayTotal();
      };
      void loadSettingsAndRestoreToday();
    }, [restoreTodayTotal])
  );

  useEffect(() => {
    setQuote(getRandomQuote());
    Animated.timing(fade, { toValue: 1, duration: 800, useNativeDriver: true }).start();
  }, [fade]);

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;

    let manifestLink = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
    if (!manifestLink) {
      manifestLink = document.createElement('link');
      manifestLink.rel = 'manifest';
      document.head.appendChild(manifestLink);
    }
    manifestLink.href = '/manifest.json';

    let appleIconLink = document.querySelector<HTMLLinkElement>('link[rel="apple-touch-icon"]');
    if (!appleIconLink) {
      appleIconLink = document.createElement('link');
      appleIconLink.rel = 'apple-touch-icon';
      document.head.appendChild(appleIconLink);
    }
    appleIconLink.href = '/apple-touch-icon.png';

    let themeMeta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (!themeMeta) {
      themeMeta = document.createElement('meta');
      themeMeta.name = 'theme-color';
      document.head.appendChild(themeMeta);
    }
    themeMeta.content = '#0f172a';
  }, []);

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;

    document.title = isRunning
      ? `Japam timer running - ${formatTime(seconds)}`
      : 'Mantra Japam';
  }, [isRunning, seconds]);

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;

    const handleVisibilityChange = () => {
      if (!document.hidden || !isRunning) {
        if (!document.hidden) backgroundTimerNoticeShownRef.current = false;
        return;
      }

      if (backgroundTimerNoticeShownRef.current) return;

      backgroundTimerNoticeShownRef.current = true;
      showTimerNotification(
        'Japam timer is running',
        `Current timer: ${formatTime(seconds)}. Come back when you are ready to continue.`
      );
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    handleVisibilityChange();

    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [isRunning, seconds, showTimerNotification]);

  useEffect(() => {
    timerRef.current = {
      seconds,
      isRunning,
      targetSeconds,
      minutesInput,
      loopTimer,
    };
  }, [seconds, isRunning, targetSeconds, minutesInput, loopTimer]);

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

      await saveTimerStateToSupabase(savedUserId, {
        seconds,
        isRunning,
        targetSeconds,
        minutesInput,
        loopTimer,
      });
    })();
  }, [seconds, isRunning, targetSeconds, minutesInput, loopTimer, hasRestoredTimer]);

  const fetchTimerStateFromSupabase = useCallback(async (userId: string) => {
    const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
    const key = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

    if (!url || !key || !userId) return null;

    const encodedUserId = encodeURIComponent(userId);

    const response = await fetch(
      `${url}/rest/v1/japam_timer_state?user_id=eq.${encodedUserId}&select=seconds,is_running,target_seconds,minutes_input,loop_timer&limit=1`,
      {
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
        },
      }
    );

    if (!response.ok) return null;

    const rows = await response.json();

    return rows?.[0] || null;
  }, []);

  useEffect(() => {
    const loadData = async () => {
      const today = getLocalDateKey();
      const savedUserName = await AsyncStorage.getItem(USER_NAME_KEY);
      const savedUserId = await AsyncStorage.getItem(USER_ID_KEY);
      const authPending = await isAuthPending();

      if (savedUserId) {
        const userJapamName = await AsyncStorage.getItem(
          getUserStorageKey(JAPAM_NAME_KEY, savedUserId)
        );

        if (userJapamName) {
          setJapamName(userJapamName);
          setNameInput(userJapamName);
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

        const lastTotal = Number(
          (await AsyncStorage.getItem(LAST_TOTAL_KEY)) || '0'
        );

        await restoreTotal(lastTotal);
      }

      if (savedUserId) {
        const savedTimerSeconds = Number(
          (await AsyncStorage.getItem(getUserStorageKey(TIMER_SECONDS_KEY, savedUserId))) || '0'
        );

        const savedTimerRunning =
          (await AsyncStorage.getItem(getUserStorageKey(TIMER_RUNNING_KEY, savedUserId))) === 'true';

        const savedTimerTarget = Number(
          (await AsyncStorage.getItem(getUserStorageKey(TIMER_TARGET_KEY, savedUserId))) || '60'
        );

        const savedTimerMinutes =
          (await AsyncStorage.getItem(getUserStorageKey(TIMER_MINUTES_KEY, savedUserId))) || '1';

        const savedTimerLoop =
          (await AsyncStorage.getItem(getUserStorageKey(TIMER_LOOP_KEY, savedUserId))) === 'true';

        const timerState = await fetchTimerStateFromSupabase(savedUserId);

        if (timerState) {
          setSeconds(Number(timerState.seconds) || 0);
          setIsRunning(Boolean(timerState.is_running));
          setTargetSeconds(Number(timerState.target_seconds) || 60);
          setMinutesInput(timerState.minutes_input || '1');
          setLoopTimer(Boolean(timerState.loop_timer));
        } else {
          setSeconds(savedTimerSeconds);
          setIsRunning(savedTimerRunning);
          setTargetSeconds(savedTimerTarget);
          setMinutesInput(savedTimerMinutes);
          setLoopTimer(savedTimerLoop);
        }
      } else {
        const savedTimerSeconds = Number(
          (await AsyncStorage.getItem(TIMER_SECONDS_KEY)) || '0'
        );

        const savedTimerRunning =
          (await AsyncStorage.getItem(TIMER_RUNNING_KEY)) === 'true';

        const savedTimerTarget = Number(
          (await AsyncStorage.getItem(TIMER_TARGET_KEY)) || '60'
        );

        const savedTimerMinutes =
          (await AsyncStorage.getItem(TIMER_MINUTES_KEY)) || '1';

        const savedTimerLoop =
          (await AsyncStorage.getItem(TIMER_LOOP_KEY)) === 'true';

        setSeconds(savedTimerSeconds);
        setIsRunning(savedTimerRunning);
        setTargetSeconds(savedTimerTarget);
        setMinutesInput(savedTimerMinutes);
        setLoopTimer(savedTimerLoop);
      }

      setHasRestoredTimer(true);

      await AsyncStorage.setItem(LAST_OPEN_DATE_KEY, today);
    };


    void loadData();
  }, [fetchTimerStateFromSupabase, restoreTodayTotal, restoreTotal]);

  useEffect(() => {
    Animated.loop(
      Animated.timing(particleAnim, { toValue: 1, duration: 6000, useNativeDriver: true })
    ).start();
  }, [particleAnim]);

  // ✅ omPulseAnim breathing animation
  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(omPulseAnim, { toValue: 1.05, duration: 1800, useNativeDriver: true }),
        Animated.timing(omPulseAnim, { toValue: 1, duration: 1800, useNativeDriver: true }),
      ])
    ).start();
  }, [omPulseAnim]);

  const saveTimerStateToSupabase = async (
    userId: string,
    timerState: {
      seconds: number;
      isRunning: boolean;
      targetSeconds: number;
      minutesInput: string;
      loopTimer: boolean;
    }
  ) => {
    const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
    const key = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

    if (!url || !key || !userId) return;

    const response = await fetch(
      `${url}/rest/v1/japam_timer_state?on_conflict=user_id`,
      {
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
      }
    );

    if (!response.ok) {
      console.log('Timer save error:', await response.text());
    }
  };

  const restoreTimerForUser = useCallback(async (userId: string) => {
    const savedTimerSeconds = Number(
      (await AsyncStorage.getItem(getUserStorageKey(TIMER_SECONDS_KEY, userId))) || '0'
    );

    const savedTimerRunning =
      (await AsyncStorage.getItem(getUserStorageKey(TIMER_RUNNING_KEY, userId))) === 'true';

    const savedTimerTarget = Number(
      (await AsyncStorage.getItem(getUserStorageKey(TIMER_TARGET_KEY, userId))) || '60'
    );

    const savedTimerMinutes =
      (await AsyncStorage.getItem(getUserStorageKey(TIMER_MINUTES_KEY, userId))) || '1';

    const savedTimerLoop =
      (await AsyncStorage.getItem(getUserStorageKey(TIMER_LOOP_KEY, userId))) === 'true';

    const timerState = await fetchTimerStateFromSupabase(userId);

    if (timerState) {
      const remoteSeconds = Number(timerState.seconds) || 0;
      const remoteTarget = Number(timerState.target_seconds) || 60;
      const restoredSeconds = Math.max(remoteSeconds, savedTimerSeconds);

      setSeconds(restoredSeconds);
      setIsRunning(Boolean(timerState.is_running || savedTimerRunning));
      setTargetSeconds(remoteTarget || savedTimerTarget);
      setMinutesInput(timerState.minutes_input || savedTimerMinutes || '1');
      setLoopTimer(Boolean(timerState.loop_timer || savedTimerLoop));
    } else {
      setSeconds(savedTimerSeconds);
      setIsRunning(savedTimerRunning);
      setTargetSeconds(savedTimerTarget);
      setMinutesInput(savedTimerMinutes);
      setLoopTimer(savedTimerLoop);
    }

    setHasRestoredTimer(true);
  }, [fetchTimerStateFromSupabase]);

  const saveCurrentTimerForUser = async (
    userId: string,
    timerState = timerRef.current
  ) => {
    await AsyncStorage.setItem(getUserStorageKey(TIMER_SECONDS_KEY, userId), String(timerState.seconds));
    await AsyncStorage.setItem(getUserStorageKey(TIMER_RUNNING_KEY, userId), String(timerState.isRunning));
    await AsyncStorage.setItem(getUserStorageKey(TIMER_TARGET_KEY, userId), String(timerState.targetSeconds));
    await AsyncStorage.setItem(getUserStorageKey(TIMER_MINUTES_KEY, userId), timerState.minutesInput);
    await AsyncStorage.setItem(getUserStorageKey(TIMER_LOOP_KEY, userId), String(timerState.loopTimer));
    await saveTimerStateToSupabase(userId, timerState);
  };

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
        await AsyncStorage.setItem(getUserStorageKey(JAPAM_NAME_KEY, googleUserId), rows[0].japam_name);
        return;
      }

      const localName = await AsyncStorage.getItem(getUserStorageKey(JAPAM_NAME_KEY, googleUserId));
      if (localName) {
        setJapamName(localName);
        setNameInput(localName);
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

      if (!response.ok) {
        console.log('History restore error:', await response.text());
        return;
      }

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
      const sameUserLocalHistory = localHistory.filter((item) => item.userId === googleUserId);

      const mergedMap = new Map<string, Session>();
      [...remoteHistory, ...sameUserLocalHistory].forEach((item) => {
        const key = `${item.date}-${item.totalCount}-${item.malas}-${item.manual ? 'manual' : 'auto'}`;
        mergedMap.set(key, item);
      });

      const mergedHistory = [...mergedMap.values()].sort(
        (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
      );

      await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(mergedHistory));
      await restoreTodayTotal();
    } catch (error) {
      console.log('History restore error:', error);
    }
  }, [restoreTodayTotal]);

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
        const googleUserId = String(userInfo?.id || '').trim();

        if (!googleUserId) {
          setShowUserModal(true);
          return;
        }

        setHasRestoredTimer(false);
        setUserName(googleName);
        setShowUserModal(false);
        setShowUserMenu(false);

        await AsyncStorage.setItem(USER_NAME_KEY, googleName);
        await AsyncStorage.setItem(USER_ID_KEY, googleUserId);
        await loadJapamNameFromSupabase(googleUserId);
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
  ]);

  useEffect(() => {
    totalRef.current = total;

    if (!hasRestoredTotal) {
      return;
    }

    if (!userName) {
      return;
    }

    void (async () => {
      await AsyncStorage.setItem(COUNT_KEY, String(count));
      await AsyncStorage.setItem(MALAS_KEY, String(malas));
      await AsyncStorage.setItem(TOTAL_KEY, String(total));

      const savedUserId = await AsyncStorage.getItem(USER_ID_KEY);

      if (savedUserId) {
        await AsyncStorage.setItem(getUserStorageKey(COUNT_KEY, savedUserId), String(count));
        await AsyncStorage.setItem(getUserStorageKey(MALAS_KEY, savedUserId), String(malas));
        await AsyncStorage.setItem(getUserStorageKey(TOTAL_KEY, savedUserId), String(total));

        const savedUserName = await AsyncStorage.getItem(USER_NAME_KEY);

        await saveUserTotalToSupabase(
          savedUserId,
          savedUserName || userName || 'User',
          total
        );
      }
    })();
  }, [count, malas, total, userName, hasRestoredTotal]);

  useEffect(() => {
    if (!isRunning) return;
    const interval = setInterval(() => setSeconds((prev) => prev + 1), 1000);
    return () => clearInterval(interval);
  }, [isRunning]);

  useEffect(() => {
    if (!isRunning) return;
    if (seconds < targetSeconds) return;
    completeTimerSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seconds, isRunning, targetSeconds, loopTimer]);

  const playCompleteSound = async () => {
    try {
      const { sound } = await Audio.Sound.createAsync(
        require('../../assets/om_complete.mp3'),
        { shouldPlay: true, volume: 1.0 }
      );

      sound.setOnPlaybackStatusUpdate((status) => {
        if (status.isLoaded && status.didJustFinish) {
          sound.setOnPlaybackStatusUpdate(null);
          sound.unloadAsync().catch(console.log);
        }
      });

      await sound.playAsync();
      setTimeout(() => {
        sound.stopAsync().catch(console.log);
        sound.unloadAsync().catch(console.log);
      }, 3000);
    } catch (error) {
      console.log('Sound error:', error);
    }
  };

  const saveSession = useCallback(async (
    duration: number,
    sessionMalas: number,
    sessionTotal: number,
    _accumulatedTotal: number
  ) => {
    if (isSavingSessionRef.current) return;
    isSavingSessionRef.current = true;

    try {
      const raw = await AsyncStorage.getItem(HISTORY_KEY);
      const history: Session[] = raw ? JSON.parse(raw) : [];
      const userId = await AsyncStorage.getItem(USER_ID_KEY);
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
        const baseBody = {
          user_name: savedUserName || userName,
          malas: sessionMalas,
          count: sessionTotal,
        };

        const postHistory = async (body: Record<string, unknown>) => {
          const res = await fetch(`${url}/rest/v1/japam_history`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              apikey: key,
              Authorization: `Bearer ${key}`,
              Prefer: 'return=minimal',
            },
            body: JSON.stringify(body),
          });
          if (!res.ok) {
            console.log('Supabase save error:', await res.text());
            return false;
          }
          return true;
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

  const tapFeedback = () => {
    vibrateDevice(35);

    if (Platform.OS !== 'web' && vibrationEnabled) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
  };

  const playCompletionAnimation = useCallback(() => {
    glowAnim.setValue(0);
    Animated.sequence([
      Animated.timing(glowAnim, { toValue: 1, duration: 300, useNativeDriver: false }),
      Animated.timing(glowAnim, { toValue: 0, duration: 300, useNativeDriver: false }),
      Animated.timing(glowAnim, { toValue: 1, duration: 300, useNativeDriver: false }),
      Animated.timing(glowAnim, { toValue: 0, duration: 500, useNativeDriver: false }),
    ]).start();
  }, [glowAnim]);

  const completeFeedback = useCallback(async () => {
    playCompletionAnimation();
    if (soundEnabled) await playCompleteSound();
    vibrateDevice([0, 350, 120, 350, 120, 650]);
  }, [playCompletionAnimation, soundEnabled, vibrateDevice]);

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
        await AsyncStorage.setItem(
          getUserStorageKey(TOTAL_KEY, savedUserId),
          String(safeTotal)
        );

        await AsyncStorage.setItem(
          getUserStorageKey(MALAS_KEY, savedUserId),
          String(nextMalas)
        );

        await AsyncStorage.setItem(
          getUserStorageKey(COUNT_KEY, savedUserId),
          String(nextCount)
        );
      }
    })();

    return safeTotal;
  };

  const handleUndo = () => {
    setCountersFromTotal(Math.max(0, totalRef.current - 1));
  };

  const requireLogin = () => {
    if (!userName) {
      setShowUserModal(true);
      return false;
    }
    return true;
  };

  const handleTap = () => {
    if (!requireLogin()) return;

    const now = Date.now();
    if (now - lastTapRef.current < 100) return;
    lastTapRef.current = now;

    tapFeedback();
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
      void completeFeedback();
    }
  };

  const handleStart = () => {
    if (!requireLogin()) return;
    void requestTimerNotificationPermission();

    const mins = Math.max(1, Math.floor(Number(minutesInput) || 1));
    const nextTargetSeconds = mins * 60;

    setMinutesInput(String(mins));
    setTargetSeconds(nextTargetSeconds);

    if (seconds <= 0 || seconds >= nextTargetSeconds) {
      setSeconds(0);
    }

    setAutoCompletedMalas(0);
    setIsRunning(true);
  };

  const handlePause = () => {
    setIsRunning(false);

    void (async () => {
      const savedUserId = await AsyncStorage.getItem(USER_ID_KEY);
      if (!savedUserId) return;

      await saveCurrentTimerForUser(savedUserId, {
        seconds,
        isRunning: false,
        targetSeconds,
        minutesInput,
        loopTimer,
      });
    })();
  };

  const handleStop = () => {
    setIsRunning(false);
    backgroundTimerNoticeShownRef.current = false;
    setSeconds(0);
    setAutoCompletedMalas(0);
  };

  const completeTimerSession = useCallback(() => {
    const newTotal = setCountersFromTotal(totalRef.current + 108);
    void saveSession(targetSeconds, 1, 108, newTotal);
    void completeFeedback();
    showTimerNotification('Japam timer completed', 'One mala has been added to your count.');

    if (loopTimer) {
      setAutoCompletedMalas((prev) => {
        const next = prev + 1;
        if (next >= 5) {
          setSeconds(0);
          setIsRunning(false);
          setLoopTimer(false);
        } else {
          setSeconds(0);
          setIsRunning(true);
        }
        return next;
      });
    } else {
      setSeconds(0);
      setIsRunning(false);
    }
  }, [loopTimer, targetSeconds, saveSession, completeFeedback, showTimerNotification]);

  const saveJapamNameToSupabase = async (userId: string, userNameValue: string, japamNameValue: string) => {
    try {
      const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
      const key = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
      if (!url || !key) return;

      const encodedUserId = encodeURIComponent(userId);
      const checkResponse = await fetch(
        `${url}/rest/v1/user_profiles?user_id=eq.${encodedUserId}&select=id`,
        { headers: { apikey: key, Authorization: `Bearer ${key}` } }
      );

      const rows = await checkResponse.json();

      if (rows.length > 0) {
        await fetch(`${url}/rest/v1/user_profiles?user_id=eq.${encodedUserId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', apikey: key, Authorization: `Bearer ${key}` },
          body: JSON.stringify({ user_name: userNameValue, japam_name: japamNameValue, updated_at: new Date().toISOString() }),
        });
      } else {
        await fetch(`${url}/rest/v1/user_profiles`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', apikey: key, Authorization: `Bearer ${key}` },
          body: JSON.stringify({ user_id: userId, user_name: userNameValue, japam_name: japamNameValue }),
        });
      }
    } catch (error) {
      console.log('Profile save error:', error);
    }
  };

  const saveJapamName = async () => {
    const name = nameInput.trim();
    if (!name) return;

    setJapamName(name);
    setNameInput(name);
    setShowNameEditor(false);

    const savedUserId = await AsyncStorage.getItem(USER_ID_KEY);
    if (savedUserId) {
      await AsyncStorage.setItem(getUserStorageKey(JAPAM_NAME_KEY, savedUserId), name);
      const savedUserName = await AsyncStorage.getItem(USER_NAME_KEY);
      await saveJapamNameToSupabase(savedUserId, savedUserName || 'User', name);
    } else {
      await AsyncStorage.setItem(JAPAM_NAME_KEY, name);
    }
  };

  const performLogout = async () => {
    const currentUserId = await AsyncStorage.getItem(USER_ID_KEY);
    if (currentUserId) {
      await AsyncStorage.setItem(getUserStorageKey(TOTAL_KEY, currentUserId), String(totalRef.current));
      await saveCurrentTimerForUser(currentUserId, {
        seconds,
        isRunning,
        targetSeconds,
        minutesInput,
        loopTimer,
      });
    }

    suppressTimerSaveRef.current = true;
    setIsRunning(false);
    setSeconds(0);
    setLoopTimer(false);
    setAutoCompletedMalas(0);
    setHasRestoredTimer(false);
    setShowUserMenu(false);
    setUserName('');
    setJapamName('Japam');
    setNameInput('Japam');
    setShowUserModal(false);

    await AsyncStorage.removeItem(USER_NAME_KEY);
    await AsyncStorage.removeItem(USER_ID_KEY);
    await restoreTotal(0, { userId: null });
    setTimeout(() => {
      suppressTimerSaveRef.current = false;
    }, 0);
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

  const openRename = () => { setNameInput(japamName); setShowNameEditor(true); };
  const cancelRename = () => { setNameInput(japamName); setShowNameEditor(false); };
  const todayLabel = new Date().toLocaleDateString();

  return (
    <LinearGradient
    colors={['#0a0015', '#1a0a35', '#0a0015']}
    start={{ x: 0, y: 0 }}
    end={{ x: 0, y: 1 }}
    style={{ flex: 1 }}
  >
    {/* Stars */}
    {[...Array(40)].map((_, i) => (
      <Animated.View
        key={i}
        pointerEvents="none"
        style={{
          position: 'absolute',
          width: i % 3 === 0 ? 3 : 2,
          height: i % 3 === 0 ? 3 : 2,
          borderRadius: 99,
          backgroundColor: 'white',
          left: `${(i * 37 + 11) % 100}%`,
          top: `${(i * 53 + 7) % 100}%`,
          opacity: particleAnim.interpolate({
            inputRange: [0, (i % 5) * 0.2, 1],
            outputRange: [0.1, 0.9, 0.1],
          }),
        }}
      />
    ))}


      <ScrollView style={styles.container} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>

        {isSigningIn && (
          <View style={styles.signingInBanner}>
            <Text style={styles.signingInText}>Signing in...</Text>
          </View>
        )}

        <View style={styles.topBar}>
          <View style={styles.headerCenter}>
            <Pressable onPress={openRename}>
              <Text style={styles.title}>🧘 {japamName}</Text>
            </Pressable>

            {!userName && (
              <Pressable
                style={[styles.loginButton, isMobile ? styles.loginButtonMobile : styles.loginButtonDesktop]}
                onPress={() => setShowUserModal(true)}
              >
                <Text style={styles.loginButtonText}>Sign in</Text>
              </Pressable>
            )}

            {!!userName && (
              <View style={[styles.userMenuWrap, isMobile ? styles.mobileUserBadge : styles.desktopUserBadge]}>
                <Pressable style={styles.userBadge} onPress={() => setShowUserMenu((prev) => !prev)}>
                  <Text style={styles.userBadgeText}>🙏 {userName}</Text>
                </Pressable>
                {showUserMenu && (
                  <View style={styles.userMenu}>
                    <Pressable style={styles.userMenuItem} onPress={handleLogout}>
                      <Text style={styles.userMenuText}>Logout</Text>
                    </Pressable>
                  </View>
                )}
              </View>
            )}

            <Text style={styles.renameHint}>Tap name to rename</Text>
          </View>
        </View>

        {showNameEditor && (
          <View style={styles.nameEditor}>
            <TextInput
              style={styles.nameInput}
              value={nameInput}
              onChangeText={setNameInput}
              placeholder="Enter japam name"
              placeholderTextColor="#94a3b8"
            />
            <Pressable style={styles.smallBtn} onPress={saveJapamName}>
              <Text style={styles.smallBtnText}>Save</Text>
            </Pressable>
            <Pressable style={styles.graySmallBtn} onPress={cancelRename}>
              <Text style={styles.smallBtnText}>Cancel</Text>
            </Pressable>
          </View>
        )}

        <Animated.Text style={[styles.quote, { opacity: fade }]}>{quote}</Animated.Text>

        <Text style={styles.dateText}>Today: {todayLabel}</Text>
        <Text style={styles.big}>{count}</Text>

        <View style={styles.progressBarBackground}>
          <View style={[styles.progressBarFill, { width: `${(count / 108) * 100}%` }]} />
        </View>

        <Text style={styles.progressText}>{count} / 108</Text>

        <View style={styles.metricsRow}>
          <Text style={styles.metricText}>📿 {malas} {malas === 1 ? 'mala' : 'malas'}</Text>
          <Text style={[styles.metricText, isRunning && styles.timerRunningText]}>
            ⏱ {formatTime(seconds)}
          </Text>
          <Text style={styles.metricText}>Total {total}</Text>
        </View>

        <Animated.View style={[styles.circleGlow, { transform: [{ scale: omPulseAnim }] }]}>
          <Animated.View
            pointerEvents="none"
            style={{
              position: 'absolute',
              width: 128,
              height: 128,
              borderRadius: 64,
              borderWidth: 2,
              borderColor: 'rgba(251, 191, 36, 0.6)',
              transform: [{
                scale: rippleAnim.interpolate({
                  inputRange: [0, 1],
                  outputRange: [1, 1.9],
                }),
              }],
              opacity: rippleAnim.interpolate({
                inputRange: [0, 0.7, 1],
                outputRange: [0.9, 0.3, 0],
              }),
            }}
          />
          <Pressable onPress={handleTap} style={({ pressed }) => [pressed && styles.circlePressed]}>
          <LinearGradient
  colors={['#4c1d95', '#2e1065', '#0a0015']}
  start={{ x: 0, y: 0 }}
  end={{ x: 1, y: 1 }}
  style={styles.circle}
>
              <Text style={styles.omText}>ॐ</Text>
            </LinearGradient>
          </Pressable>
        </Animated.View>

        <Pressable style={styles.undoBtn} onPress={handleUndo}>
          <Text style={styles.undoText}>↻ Undo last tap</Text>
        </Pressable>

        <Text style={styles.inputLabel}>Timer (minutes)</Text>

        <TextInput
          style={[styles.input, isRunning && styles.disabledInput]}
          value={minutesInput}
          onChangeText={(value) => {
            if (isRunning) return;
            setMinutesInput(value);
            setSeconds(0);
          }}
          editable={!isRunning}
          selectTextOnFocus={!isRunning}
          keyboardType="numeric"
        />

        <Text style={styles.timerHint}>Timer ending = 1 mala automatically added</Text>

        <View style={styles.autoRepeatRow}>
          <Text style={styles.autoRepeatText}>Auto Repeat (Max 5 Malas)</Text>
          <Switch
            value={loopTimer}
            onValueChange={(value) => {
              setLoopTimer(value);
              setAutoCompletedMalas(0);
              if (!value) { setIsRunning(false); setSeconds(0); }
            }}
          />
        </View>

        <View style={styles.row}>
          <Pressable style={styles.btn} onPress={handleStart}>
            <Text style={styles.btnText}>Start</Text>
          </Pressable>
          <Pressable style={[styles.btn, styles.gray]} onPress={handlePause}>
            <Text style={styles.btnText}>Pause</Text>
          </Pressable>
          <Pressable style={[styles.btn, styles.red]} onPress={handleStop}>
            <Text style={styles.btnText}>Stop</Text>
          </Pressable>
        </View>

        <Modal visible={showUserModal && !isSigningIn} transparent animationType="fade">
          <View style={styles.modalOverlay}>
            <View style={styles.modalCard}>
              <Pressable style={styles.modalClose} onPress={() => setShowUserModal(false)}>
                <Text style={styles.modalCloseText}>×</Text>
              </Pressable>
              <View style={styles.modalTopMark}>
                <Text style={styles.modalTopMarkText}>ॐ</Text>
              </View>
              <Text style={styles.modalTitle}>Sign in to save history</Text>
              <Text style={styles.modalSubtitle}>
                Sign in with Google to save your Japam history and sync it across devices.
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
  container: { flex: 1, backgroundColor: 'transparent' },
  content: {
    flexGrow: 1,
    alignItems: 'center',
  
    justifyContent: 'flex-start',
  
    paddingHorizontal: 20,
    paddingTop: 70,
    paddingBottom: 120,
  
    minHeight: '100%',
  },
  topBar: {
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  headerCenter: {
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    marginBottom: 8,
  },
  userMenuWrap: { alignItems: 'flex-end', zIndex: 20 },
  userBadge: {
    backgroundColor: '#1e293b',
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#334155',
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 6,
    elevation: 4,
  },
  desktopUserBadge: { position: 'absolute', right: 45, top: 12 },
  mobileUserBadge: { marginTop: 10, alignItems: 'center' },
  userBadgeText: { color: '#ffffff', fontSize: 14, fontWeight: '800' },
  userMenu: {
    marginTop: 8,
    backgroundColor: '#1e293b',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#334155',
    overflow: 'hidden',
    minWidth: 110,
  },
  userMenuItem: { paddingVertical: 10, paddingHorizontal: 14 },
  userMenuText: { color: 'white', fontSize: 14, fontWeight: '800' },
  title: {
    color: '#f8fafc',
    fontSize: 24,
    fontWeight: '500',
    textAlign: 'center',
    letterSpacing: 0.3,
    textShadowColor: 'rgba(255,255,255,0.06)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 6,
  },
  renameHint: { color: '#64748b', fontSize: 11, marginTop: 2 },
  nameEditor: {
    width: '100%',
    maxWidth: 520,
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
    marginBottom: 14,
  },
  nameInput: {
    flex: 1,
    backgroundColor: '#1e293b',
    color: 'white',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  quote: {
    color: 'rgba(255,255,255,0.82)',
    textAlign: 'center',
    marginTop: 4,
    marginBottom: 4,
    fontSize: 14,
    fontStyle: 'italic',
    lineHeight: 19,
    maxWidth: 620,
  },
  dateText: { color: '#94a3b8', fontSize: 13, marginBottom: 2 },
  big: { color: 'white', fontSize: 40, fontWeight: '900', marginTop: 0 },
  progressBarBackground: {
    width: 220,
    height: 6,
    backgroundColor: '#1e293b',
    borderRadius: 999,
    overflow: 'hidden',
    marginBottom: 4,
    alignSelf: 'center',
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: '#f59e0b',
    borderRadius: 999,
  },
  progressText: { color: '#94a3b8', fontSize: 12, marginBottom: 4 },
  metricsRow: {
    width: '100%',
    maxWidth: 440,
    flexDirection: 'row',
    justifyContent: 'space-evenly',
    alignItems: 'center',
    marginTop: 4,
    marginBottom: 6,
  },
  metricText: {
    color: '#e2e8f0',
    fontSize: 15,
    fontWeight: '700',
    textAlign: 'center',
  },
  timerRunningText: { fontSize: 24, color: 'white', fontWeight: '900' },
  circleGlow: {
    width: 160,
    height: 160,
    borderRadius: 80,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(251, 191, 36, 0.08)',
    shadowColor: '#fbbf24',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.45,
    shadowRadius: 24,
    elevation: 20,
    marginTop: 18,
    marginBottom: 18,
  },
  circle: {
    width: 136,
    height: 136,
    borderRadius: 68,
    justifyContent: 'center',
    alignItems: 'center',
    overflow: 'hidden',
    shadowColor: '#8b5cf6',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.95,
    shadowRadius: 28,
    elevation: 25,
  },
  circlePressed: { transform: [{ scale: 0.96 }] },
  undoBtn: {
    backgroundColor: 'rgba(15, 23, 42, 0.55)',
    paddingVertical: 9,
    paddingHorizontal: 18,
    borderRadius: 999,
  
    marginTop: 18,
    marginBottom: 8,
  
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.16)',
  },
  undoText: { color: '#f8fafc', fontSize: 14, fontWeight: '700', letterSpacing: 0.2 },
  inputLabel: { color: '#94a3b8', fontSize: 12, marginBottom: 4 },
  input: {
    backgroundColor: '#1e293b',
    color: 'white',
    borderRadius: 10,
    width: 100,
    textAlign: 'center',
    padding: 6,
    fontSize: 16,
  },
  autoRepeatRow: {
    width: 260,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 5,
  },
  autoRepeatText: { color: '#cbd5e1', fontSize: 14, fontWeight: '700' },
  row: { flexDirection: 'row', gap: 10, marginTop: 6 },
  btn: {
    backgroundColor: '#6366f1',
    paddingVertical: 9,
    paddingHorizontal: 16,
    borderRadius: 10,
    minWidth: 86,
    alignItems: 'center',
  },
  gray: { backgroundColor: '#475569' },
  red: { backgroundColor: '#991b1b' },
  smallBtn: { backgroundColor: '#6366f1', paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10 },
  graySmallBtn: { backgroundColor: '#475569', paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10 },
  smallBtnText: { color: 'white', fontWeight: '700', fontSize: 14 },
  btnText: { color: 'white', fontWeight: '700', fontSize: 16 },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(2,6,23,0.78)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  modalCard: {
    width: '100%',
    maxWidth: 380,
    backgroundColor: '#111827',
    borderRadius: 18,
    paddingHorizontal: 24,
    paddingTop: 26,
    paddingBottom: 22,
    borderWidth: 1,
    borderColor: '#374151',
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 18,
    elevation: 12,
  },
  modalTopMark: {
    width: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: '#1f2937',
    borderWidth: 1,
    borderColor: '#4f46e5',
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
    marginBottom: 14,
  },
  modalTopMarkText: { color: '#e0e7ff', fontSize: 28, fontWeight: '800' },
  modalTitle: { color: 'white', fontSize: 30, fontWeight: '900', marginBottom: 10, textAlign: 'center' },
  modalSubtitle: { color: '#cbd5e1', fontSize: 15, lineHeight: 22, textAlign: 'center', marginBottom: 22 },
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
    borderColor: '#e2e8f0',
  },
  disabledButton: { opacity: 0.5 },
  googleIcon: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: 'white',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#cbd5e1',
  },
  googleIconText: { color: '#2563eb', fontSize: 16, fontWeight: '900' },
  modalButtonText: { color: '#0f172a', fontWeight: '900', fontSize: 16 },
  modalFootnote: { color: '#94a3b8', fontSize: 12, lineHeight: 17, textAlign: 'center', marginTop: 14 },
  modalClose: { position: 'absolute', right: 14, top: 10, zIndex: 10 },
  modalCloseText: { color: '#94a3b8', fontSize: 28, fontWeight: '800' },
  loginButton: {
    backgroundColor: '#6366f1',
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderRadius: 999,
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 6,
    elevation: 4,
  },
  loginButtonDesktop: { position: 'absolute', right: 16, top: 12 },
  loginButtonMobile: { marginTop: 8, alignSelf: 'center' },
  loginButtonText: { color: '#ffffff', fontWeight: '900', fontSize: 14 },
  timerHint: { color: '#94a3b8', fontSize: 10, marginTop: 3, textAlign: 'center' },
  disabledInput: { opacity: 0.55 },
  signingInBanner: {
    position: 'absolute',
    top: 60,
    alignSelf: 'center',
    backgroundColor: '#111827',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    zIndex: 20,
  },
  signingInText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  omText: {
    fontSize: 62,
    color: '#fbbf24',
    fontWeight: '300',
    textShadowColor: 'rgba(251,191,36,0.8)',
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 22,
  },
});
