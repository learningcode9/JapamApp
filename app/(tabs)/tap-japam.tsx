import AsyncStorage from '@react-native-async-storage/async-storage';
import { GoogleSignin } from '@react-native-google-signin/google-signin';
import {
  appendCompletion,
  buildSupabaseHistoryPayload,
  dayStreakForJapam,
  japamStatsFor,
  markSynced,
  mergeHistories,
  statsByJapam,
  toLocalDayKey,
} from '../../lib/historyStore';
import {
  createMalaCompletionGuard,
  detectMalaCrossing,
  runMalaCompletion,
} from '../../lib/malaCompletion';
import { useCurrentJapam } from '../../contexts/current-japam-context';
import CurrentJapamHeaderButton from '../../components/CurrentJapamHeaderButton';
import { CircularProgressArc } from '../../components/CircularProgressArc';
import { getWebOmAudioUri } from '../../lib/webOmAudio';
import { ZEN_BACKGROUND } from '../../constants/assets';
import * as Google from 'expo-auth-session/providers/google';
import { ResponseType } from 'expo-auth-session';
import { Audio } from 'expo-av';
import * as Haptics from 'expo-haptics';
import * as Notifications from 'expo-notifications';
import * as Updates from 'expo-updates';
import { LinearGradient } from 'expo-linear-gradient';
import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../../lib/supabase';

import {
  Alert,
  Animated,
  AppState,
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
import { useSafeAreaInsets } from 'react-native-safe-area-context';

WebBrowser.maybeCompleteAuthSession();

type Session = {
  date: string;
  malas: number;
  totalCount: number;
  duration: number;
  manual?: boolean;
  userId?: string | null;
  userName?: string;
  userEmail?: string;
  source?: string;
  completionId?: string;
  syncStatus?: 'pending' | 'synced';
};

type TimerStateRow = {
  seconds?: number | string;
  is_running?: boolean;
  target_seconds?: number | string;
  minutes_input?: string | null;
  loop_timer?: boolean;
  updated_at?: string | null;
};

const triggerDeepHardwarePulse = (durationOrPattern: number | number[]) => {
  if (Platform.OS === 'web') return;
  try {
    if (typeof durationOrPattern === 'number') {
      Vibration.vibrate(durationOrPattern);
    } else {
      Vibration.vibrate(durationOrPattern);
    }
  } catch {}
};

const COUNT_KEY = 'count';
const MALAS_KEY = 'malas';
const TOTAL_KEY = 'totalCount';
const MANUAL_COUNT_KEY = 'manualTapCount';
const MANUAL_MALAS_KEY = 'manualTapMalas';
const MANUAL_TOTAL_KEY = 'manualTapTotal';
const MANUAL_TOTAL_DATE_KEY = 'manualTapTotalDate';
const HISTORY_KEY = 'history';
const JAPAM_NAME_KEY = 'japamName';
const LAST_OPEN_DATE_KEY = 'lastOpenDate';
const SOUND_ENABLED_KEY = 'soundEnabled';
const REPETITION_SOUND_ENABLED_KEY = 'repetitionSoundEnabled';
const VIBRATION_ENABLED_KEY = 'vibrationEnabled';
const WEB_OM_AUDIO_SRC = '/om_complete.mp3';
// Guest Mode is temporarily hidden — Google Sign-In is the only entry point for now. Flip this
// back to true to restore the "Continue as Guest" button; none of the underlying guest/anonymous
// auth code is removed, only this UI entry point is gated.
const GUEST_MODE_ENABLED = false;

// With Guest Mode hidden, a failed Google Sign-In leaves the user with no fallback into the app
// — silently re-showing the same sign-in modal gives no explanation. Alert.alert is not
// interactive in react-native-web (see the same caveat in this file's handleResetCount), so this
// branches to window.alert on web, matching this codebase's existing pattern for cross-platform
// alerts.
const showGoogleSignInRequiredAlert = () => {
  if (GUEST_MODE_ENABLED) return;
  const message =
    'Google Sign-In is required right now. Please check your Google account or internet connection and try again.';
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined') window.alert(message);
  } else {
    Alert.alert('Sign-In Required', message);
  }
};

const USER_NAME_KEY = 'userName';
const USER_EMAIL_KEY = 'userEmail';
const USER_ID_KEY = 'userId';
const AUTH_PENDING_KEY = 'authPending';
const LAST_TOTAL_KEY = 'lastTotal';
const HISTORY_SYNC_VERSION_KEY = 'historyStatsSyncVersion';
const NOTIF_PERMISSION_ASKED_KEY = 'notifPermissionAsked';
const AUTH_PENDING_MAX_MS = 2 * 60 * 1000;
const TIMER_SECONDS_KEY = 'timerSeconds';
const TIMER_RUNNING_KEY = 'timerRunning';
const TIMER_TARGET_KEY = 'timerTarget';
const TIMER_MINUTES_KEY = 'timerMinutes';
const TIMER_LOOP_KEY = 'timerLoop';
const TOTAL_DATE_KEY = 'totalDate';
const DEFAULT_TIMER_MINUTES = 5;
const SESSION_TIME_OPTIONS = [5, 10, 15];

const screenWidth = Dimensions.get('window').width;
const screenHeight = Dimensions.get('window').height;
const isMobile = screenWidth < 500;
const isShortMobile = isMobile && screenHeight < 760;
const progressCircleSize = isShortMobile ? 242 : isMobile ? 292 : 330;
const progressRingSize = progressCircleSize - (isMobile ? 10 : 14);
const shellMinHeight =
  isMobile
    ? Platform.OS === 'web'
      ? ('100%' as any)
      : screenHeight
    : Math.min(Math.max(screenHeight - 54, 820), 940);

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

/**
 * Per-(identity, Japam) scoped key for the live tap counter (TOTAL_KEY/MALAS_KEY/COUNT_KEY and
 * their MANUAL_* mirrors) -- the only key shape these now use, replacing the old bare (fully
 * unscoped) and per-user-only shapes. userId null means guest ('guest' in the key), japamId null
 * means legacy/unassigned, matching the same convention as
 * statsByJapam/japamStatsFor/dayStreakForJapam everywhere else. Product requirement: Home/Timer/Tap
 * Japam must always reflect the selected Japam only, so no cached value under any OTHER key shape
 * may be read back and repaint the wrong Japam's count after switching.
 */
const getJapamScopedKey = (
  key: string,
  userId: string | null,
  japamId: string | null
) => `${key}:${userId ?? 'guest'}:${japamId ?? 'legacy'}`;

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
  const { currentJapam } = useCurrentJapam();
  // The Japam this screen's completions belong to. Tap Japam has no discrete "Start" button (see
  // handleStart below, which is not wired to any visible control on this screen) -- tapping the
  // circle is the actual interaction, with no clear start/stop boundary of its own. Treating
  // "arriving at this screen to tap" as the practical equivalent of pressing Start: captured once
  // per focus (not on every tap), so switching the app's current Japam elsewhere while the user
  // keeps tapping here never retroactively changes what those taps are attributed to. Refs, not
  // state, matching the same discipline as Timer/Home's equivalent wiring.
  const activeJapamIdRef = useRef<string | null>(null);
  const activeJapamNameRef = useRef<string | null>(null);
  useFocusEffect(
    useCallback(() => {
      activeJapamIdRef.current = currentJapam?.id ?? null;
      activeJapamNameRef.current = currentJapam?.name ?? null;
    }, [currentJapam])
  );

  const insets = useSafeAreaInsets();
  const tabBarSpaceFromBottom = 74 + (isMobile
    ? Math.max(12, insets.bottom + 8)
    : Math.max(22, insets.bottom + 14));

  const params = useLocalSearchParams<{ signin?: string }>();
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [count, setCount] = useState(0);
  const [malas, setMalas] = useState(0);
  const [total, setTotal] = useState(0);
  const [, setDayStreak] = useState(0);
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
  const [showGuestWarningModal, setShowGuestWarningModal] = useState(false);
  const [showGuestNameModal, setShowGuestNameModal] = useState(false);
  const [guestNameInput, setGuestNameInput] = useState('');
  const [isGuestMode, setIsGuestMode] = useState(false);
  const [authReady, setAuthReady] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [repetitionSoundEnabled, setRepetitionSoundEnabled] = useState(true);
  const [vibrationEnabled, setVibrationEnabled] = useState(true);

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
  const localTimerSaveThrottleRef = useRef(0);
  const lastSavedIsRunningRef = useRef(false);
  const timerStartedAtRef = useRef<number | null>(null);
  const timerIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoRepeatTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isCompletingRef = useRef(false);
  const completedLoopMalasRef = useRef(0);
  const rippleAnim = useRef(new Animated.Value(0)).current;
  const isSavingSessionRef = useRef(false);
  const completeSoundRef = useRef<Audio.Sound | null>(null);
  const webAudioPrimedRef = useRef(false);
  const timerNotifIdRef = useRef<string | null>(null);
  const timerNotifUpdateRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const userIdRef = useRef<string | null>(null);
  const lastSavedSessionRef = useRef('');
  const lastTapRef = useRef(0);
  const lastCompletedCycleRef = useRef<number>(0);
  const tapMalaCompletionGuardRef = useRef(createMalaCompletionGuard());
  const startTimerIntervalRef = useRef<() => void>(() => {});
  const appStateRef = useRef(AppState.currentState);
  const restoreTodayTotalRef = useRef<() => Promise<void>>(async () => {});

  const glowAnim = useRef(new Animated.Value(0)).current;

  const formatTime = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

  const configureAudio = useCallback(async () => {
    try {
      await Audio.setAudioModeAsync({
        playsInSilentModeIOS: true,
        staysActiveInBackground: true,
        shouldDuckAndroid: false,
      });
    } catch (error) {
      console.log('Audio mode error:', error);
    }
  }, []);

  const syncStoredAuth = useCallback(async () => {
    const savedUserName = await AsyncStorage.getItem(USER_NAME_KEY);
    const savedUserId = await AsyncStorage.getItem(USER_ID_KEY);
    const authPending = await isAuthPending();

    if (savedUserName && savedUserId) {
      userIdRef.current = savedUserId;
      setUserName(savedUserName);
      setIsGuestMode(false);
      setShowUserModal(false);
      setIsSigningIn(false);
    } else if (savedUserName && !savedUserId) {
      userIdRef.current = null;
      setUserName(savedUserName);
      setIsGuestMode(true);
      setShowUserModal(false);
      setIsSigningIn(false);
    } else {
      userIdRef.current = null;
      lastSavedSessionRef.current = '';
      setUserName('');
      setIsGuestMode(false);
      setIsSigningIn(authPending);
      if (!authPending) {
        setShowUserModal(false);
      }
    }

    setAuthReady(true);
    return { savedUserName, savedUserId, authPending };
  }, []);

  const primeWebCompletionAudio = useCallback(async () => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    if (webAudioPrimedRef.current) return;

    const sound = completeSoundRef.current;
    if (!sound) return;

    try {
      // Unlock iOS audio session with the existing silent file — must happen before any
      // I/O await so the user-gesture trust token is still valid when play() fires.
      const unlock = new window.Audio('/silent-timer.wav');
      await unlock.play().catch(() => undefined);
      if ('caches' in window) {
        caches.open('japam-audio-v1')
          .then((cache) => cache.add(WEB_OM_AUDIO_SRC).catch(() => undefined))
          .catch(() => undefined);
      }
      await fetch(WEB_OM_AUDIO_SRC, { cache: 'force-cache' }).catch(() => undefined);
      webAudioPrimedRef.current = true;
    } catch (error) {
      console.log('Web audio unlock error:', error);
    }
  }, []);

  const requestNotificationPermissionOnce = useCallback(async () => {
    try {
      if (Platform.OS === 'web') {
        if (typeof window === 'undefined' || !('Notification' in window)) return;
        if (Notification.permission !== 'default') return;
        await Notification.requestPermission();
        return;
      }
      const alreadyAsked = await AsyncStorage.getItem(NOTIF_PERMISSION_ASKED_KEY);
      if (alreadyAsked) return;
      const result = await Notifications.requestPermissionsAsync();
      await AsyncStorage.setItem(NOTIF_PERMISSION_ASKED_KEY, result.granted ? 'granted' : 'denied');
    } catch (e) {
      console.log('Notification permission error:', e);
    }
  }, []);

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    void Notifications.setNotificationChannelAsync('japam-timer', {
      name: 'Timer',
      importance: Notifications.AndroidImportance.DEFAULT,
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

  const showTimerNotification = useCallback(async () => {
    if (Platform.OS === 'web') return;

    const scheduleNotif = async () => {
      try {
        const perm = await Notifications.getPermissionsAsync();
        if (!perm.granted) return;

        if (timerNotifIdRef.current) {
          try { await Notifications.dismissNotificationAsync(timerNotifIdRef.current); } catch {}
          timerNotifIdRef.current = null;
        }

        const elapsed = timerRef.current.seconds;
        const target = timerRef.current.targetSeconds;
        const left = Math.max(0, target - elapsed);
        const mm = String(Math.floor(left / 60)).padStart(2, '0');
        const ss = String(left % 60).padStart(2, '0');

        const id = await Notifications.scheduleNotificationAsync({
          content: {
            title: `Time left · ${mm}:${ss}`,
            body: 'Japam Timer',
            ...(Platform.OS === 'android' ? { channelId: 'japam-timer' } : {}),
          },
          trigger: null,
        });
        timerNotifIdRef.current = id;
      } catch (e) {
        console.log('Timer notification error:', e);
      }
    };

    await scheduleNotif();

    if (timerNotifUpdateRef.current) clearInterval(timerNotifUpdateRef.current);
    timerNotifUpdateRef.current = setInterval(scheduleNotif, 15000);
  }, []);

  const hideTimerNotification = useCallback(async () => {
    completeSoundRef.current?.stopAsync().catch(console.log);

    if (timerNotifUpdateRef.current) {
      clearInterval(timerNotifUpdateRef.current);
      timerNotifUpdateRef.current = null;
    }

    if (Platform.OS === 'web') {
      if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
        navigator.mediaSession.metadata = null;
        try { (navigator.mediaSession as any).playbackState = 'none'; } catch {}
      }
      return;
    }
    try {
      if (timerNotifIdRef.current) {
        await Notifications.dismissNotificationAsync(timerNotifIdRef.current);
        timerNotifIdRef.current = null;
      }
      await Notifications.dismissAllNotificationsAsync();
    } catch (e) {
      console.log('Hide timer notification error:', e);
    }
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', async (nextState) => {
      const prevState = appStateRef.current;
      appStateRef.current = nextState;

      // On foreground resume: check whether timer completed while backgrounded
      if (nextState === 'active' && (prevState === 'background' || prevState === 'inactive')) {
        const ref = timerRef.current;
        if (ref.isRunning && timerStartedAtRef.current !== null) {
          const elapsed = Math.floor((Date.now() - timerStartedAtRef.current) / 1000);
          if (elapsed >= ref.targetSeconds) {
            // Timer finished while screen was off — trigger completion exactly once
            if (!isCompletingRef.current && Date.now() - lastCompletedCycleRef.current > 2000) {
              setSeconds(elapsed); // triggers the completion useEffect
            }
          } else {
            // Still mid-cycle — update to correct elapsed time and ensure interval is alive
            setSeconds(elapsed);
            if (!timerIntervalRef.current) {
              startTimerIntervalRef.current();
            }
          }
        }
        void restoreTodayTotalRef.current();
        return;
      }

      if (nextState !== 'background' && nextState !== 'inactive') return;

      const savedUserId = await AsyncStorage.getItem(USER_ID_KEY);
      if (!savedUserId) return;

      const ref = timerRef.current;
      const currentSeconds =
        ref.isRunning && timerStartedAtRef.current !== null
          ? Math.min(ref.targetSeconds, Math.max(0, Math.floor((Date.now() - timerStartedAtRef.current) / 1000)))
          : ref.seconds;

      const currentTotal = totalRef.current;
      const currentMalas = Math.floor(currentTotal / 108);
      const currentCount = currentTotal % 108;
      const todayKey = getLocalDateKey();
      const japamId = activeJapamIdRef.current;

      await AsyncStorage.multiSet([
        [getUserStorageKey(TIMER_SECONDS_KEY, savedUserId), String(currentSeconds)],
        [TIMER_SECONDS_KEY, String(currentSeconds)],
        [getUserStorageKey(TIMER_RUNNING_KEY, savedUserId), String(ref.isRunning)],
        [TIMER_RUNNING_KEY, String(ref.isRunning)],
        [getJapamScopedKey(TOTAL_KEY, savedUserId, japamId), String(currentTotal)],
        [getJapamScopedKey(COUNT_KEY, savedUserId, japamId), String(currentCount)],
        [getJapamScopedKey(MALAS_KEY, savedUserId, japamId), String(currentMalas)],
        [getJapamScopedKey(TOTAL_DATE_KEY, savedUserId, japamId), todayKey],
        [getJapamScopedKey(MANUAL_TOTAL_KEY, savedUserId, japamId), String(currentTotal)],
        [getJapamScopedKey(MANUAL_COUNT_KEY, savedUserId, japamId), String(currentCount)],
        [getJapamScopedKey(MANUAL_MALAS_KEY, savedUserId, japamId), String(currentMalas)],
        [getJapamScopedKey(MANUAL_TOTAL_DATE_KEY, savedUserId, japamId), todayKey],
      ]);

      const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
      const key = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
      if (!url || !key) return;

      try {
        // Require a real session JWT — an anon-key request has no INSERT/UPDATE policy for this
        // user's own row once RLS is tightened (mirrors syncPendingHistory's session-token
        // preference in contexts/timer-context.tsx). No session: skip this pass, retry next time.
        const { data: bgSessionData } = await supabase.auth.getSession();
        const bgSessionToken = bgSessionData.session?.access_token;
        if (!bgSessionToken) {
          console.log('[TimerState] BACKGROUND_SAVE_SKIPPED reason=no-session');
          return;
        }
        await fetch(`${url}/rest/v1/japam_timer_state?on_conflict=user_id`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey: key,
            Authorization: `Bearer ${bgSessionToken}`,
            Prefer: 'resolution=merge-duplicates,return=minimal',
          },
          body: JSON.stringify({
            user_id: savedUserId,
            seconds: currentSeconds,
            is_running: ref.isRunning,
            target_seconds: ref.targetSeconds,
            minutes_input: ref.minutesInput,
            loop_timer: ref.loopTimer,
            updated_at: new Date().toISOString(),
          }),
        });
      } catch (e) {
        console.log('Background timer save error:', e);
      }
    });

    return () => subscription.remove();
  }, []);

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
  startTimerIntervalRef.current = startTimerInterval;

  const rawNonceRef = useRef<string>('');
  const [hashedNonce, setHashedNonce] = useState<string>('');
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const arr = new Uint8Array(16);
    crypto.getRandomValues(arr);
    const raw = Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
    rawNonceRef.current = raw;
    console.log('[NONCE_GEN] tap-japam raw_prefix=%s', raw.slice(0, 8));
    void crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw)).then((buf) => {
      const hashed = Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
      console.log('[NONCE_GEN] tap-japam hashed_prefix=%s', hashed.slice(0, 8));
      setHashedNonce(hashed);
    });
  }, []);

  const [request, response, promptAsync] = Google.useAuthRequest({
    webClientId: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID || undefined,
    clientId: process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID,
    scopes: ['openid', 'profile', 'email'],
    redirectUri: Platform.OS === 'web' && typeof window !== 'undefined' ? window.location.origin : undefined,
    responseType: Platform.OS === 'web' ? ResponseType.IdToken : undefined,
    extraParams: Platform.OS === 'web' && hashedNonce ? { nonce: hashedNonce } : undefined,
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

  useEffect(() => {
    if (!authReady) return;
    if (params.signin === '1' && !userName && !isSigningIn) {
      setShowUserModal(true);
    }
  }, [authReady, isSigningIn, params.signin, userName]);

  const restoreTotal = useCallback(
    async (nextTotal: number, options?: { userId?: string | null; japamId?: string | null }) => {
      const safeTotal = Math.max(0, Math.floor(Number(nextTotal) || 0));
      const nextMalas = Math.floor(safeTotal / 108);
      const nextCount = safeTotal % 108;
      const activeUserId =
        options?.userId === undefined
          ? await AsyncStorage.getItem(USER_ID_KEY)
          : options.userId;
      const japamId = options?.japamId === undefined ? activeJapamIdRef.current : options.japamId;

      totalRef.current = safeTotal;
      setTotal(safeTotal);
      setMalas(nextMalas);
      setCount(nextCount);

      const todayKey = getLocalDateKey();
      await AsyncStorage.setItem(getJapamScopedKey(TOTAL_KEY, activeUserId, japamId), String(safeTotal));
      await AsyncStorage.setItem(getJapamScopedKey(MALAS_KEY, activeUserId, japamId), String(nextMalas));
      await AsyncStorage.setItem(getJapamScopedKey(COUNT_KEY, activeUserId, japamId), String(nextCount));
      await AsyncStorage.setItem(getJapamScopedKey(MANUAL_TOTAL_KEY, activeUserId, japamId), String(safeTotal));
      await AsyncStorage.setItem(getJapamScopedKey(MANUAL_MALAS_KEY, activeUserId, japamId), String(nextMalas));
      await AsyncStorage.setItem(getJapamScopedKey(MANUAL_COUNT_KEY, activeUserId, japamId), String(nextCount));
      await AsyncStorage.setItem(getJapamScopedKey(MANUAL_TOTAL_DATE_KEY, activeUserId, japamId), todayKey);
    },
    []
  );

  const refreshDayStreak = useCallback(
    async (options?: { userId?: string | null; japamId?: string | null }) => {
      const activeUserId =
        options?.userId === undefined
          ? await AsyncStorage.getItem(USER_ID_KEY)
          : options.userId;

      if (!activeUserId) {
        setDayStreak(0);
        return;
      }

      const japamId = options?.japamId === undefined ? activeJapamIdRef.current : options.japamId;
      const rawHistory = await AsyncStorage.getItem(HISTORY_KEY);
      const history: Session[] = rawHistory ? JSON.parse(rawHistory) : [];
      const todayKey = getLocalDateKey();

      const nextStreak = dayStreakForJapam(
        history,
        activeUserId,
        japamId,
        todayKey,
        toLocalDayKey,
        getPreviousDateKey
      );

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

  const saveUserTotalToSupabase = async (userId: string, userNameValue: string | null, totalValue: number) => {
    const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
    const key = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !key || !userId) return;

    // Require a real session JWT — an anon-key request has no INSERT/UPDATE policy for this
    // user's own row once RLS is tightened (mirrors syncPendingHistory's session-token preference
    // in contexts/timer-context.tsx). No session: skip this pass, retry next time.
    const { data: totalSessionData } = await supabase.auth.getSession();
    const totalSessionToken = totalSessionData.session?.access_token;
    if (!totalSessionToken) {
      console.log('[UserTotal] SAVE_SKIPPED reason=no-session');
      return;
    }

    const safeTotal = Math.max(0, Math.floor(Number(totalValue) || 0));

    const response = await fetch(`${url}/rest/v1/japam_user_totals?on_conflict=user_id`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: key,
        Authorization: `Bearer ${totalSessionToken}`,
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

  const restoreTodayTotal = useCallback(async (options?: { preserveManualCount?: boolean }) => {
    const preserveManualCount = Boolean(options?.preserveManualCount);
    const savedUserId = await AsyncStorage.getItem(USER_ID_KEY);
    const todayKey = getLocalDateKey();
    // Captured once per focus by the ref above (see its own comment) -- every read/write below
    // uses this SAME value, so a Japam switch elsewhere never retroactively repaints this restore
    // pass with a mix of two different Japams' cached numbers.
    const japamId = activeJapamIdRef.current;

    const getManualStoredTotal = async (userId: string | null) => {
      const manualDate = await AsyncStorage.getItem(getJapamScopedKey(MANUAL_TOTAL_DATE_KEY, userId, japamId));
      if (manualDate === todayKey) {
        return Number((await AsyncStorage.getItem(getJapamScopedKey(MANUAL_TOTAL_KEY, userId, japamId))) || '0');
      }

      // Backward compatibility for users who already had manual progress saved
      // before the dedicated manual storage keys existed.
      const legacyDate = await AsyncStorage.getItem(getJapamScopedKey(TOTAL_DATE_KEY, userId, japamId));
      if (manualDate === null && legacyDate === todayKey) {
        return Number((await AsyncStorage.getItem(getJapamScopedKey(TOTAL_KEY, userId, japamId))) || '0');
      }

      return 0;
    };

    if (savedUserId) {
      const localStoredTotal = await getManualStoredTotal(savedUserId);

      if (localStoredTotal > 0 && !preserveManualCount) {
        await restoreTotal(localStoredTotal, { userId: savedUserId, japamId });
        totalRef.current = localStoredTotal;
      }

      try {
        const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
        const key = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
        let remoteSessions: Session[] | null = null;

        // Require a real session JWT — an anon-key request has no SELECT policy for another
        // user's rows and none for this user's own rows once RLS is tightened (mirrors
        // syncPendingHistory's session-token preference). No session means remoteSessions stays
        // null below, which skips the merge and leaves local history untouched.
        const sessionToken = (await supabase.auth.getSession()).data.session?.access_token;
        if (url && key && sessionToken) {
          const encodedUserId = encodeURIComponent(savedUserId);
          const res = await fetch(
            `${url}/rest/v1/japam_history?user_id=eq.${encodedUserId}&select=created_at,malas,count,user_name,completion_id&order=created_at.asc`,
            { headers: { apikey: key, Authorization: `Bearer ${sessionToken}` } }
          );
          if (res.ok) {
            const rows: {
              created_at: string;
              malas: number | string;
              count: number | string;
              user_name?: string;
              completion_id?: string;
            }[] =
              await res.json();
            remoteSessions = rows.map((row) => ({
              date: row.created_at,
              malas: Number(row.malas) || 0,
              totalCount: Number(row.count) || 0,
              duration: 0,
              manual: false,
              userId: savedUserId,
              userName: row.user_name,
              completionId: row.completion_id,
              syncStatus: 'synced' as const,
            }));
          }
        }

        if (remoteSessions !== null) {
          const rawLocal = await AsyncStorage.getItem(HISTORY_KEY);
          const localHistory: Session[] = rawLocal ? JSON.parse(rawLocal) : [];
          const rawTomb = await AsyncStorage.getItem('deletedCompletions');
          const tombSet = new Set<string>(rawTomb ? JSON.parse(rawTomb) : []);
          const mergedHistory = mergeHistories(localHistory, remoteSessions).filter((s) => {
            const day = toLocalDayKey(s.date);
            return (day === 'unknown' || day <= todayKey) && !tombSet.has(s.completionId as string);
          });

          await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(mergedHistory));

          if (!preserveManualCount) {
            await restoreTotal(localStoredTotal, { userId: savedUserId, japamId });
            totalRef.current = localStoredTotal;
          }
          await refreshDayStreak({ userId: savedUserId, japamId });
        } else {
          if (!preserveManualCount) {
            await restoreTotal(localStoredTotal, { userId: savedUserId, japamId });
            totalRef.current = localStoredTotal;
          }
          await refreshDayStreak({ userId: savedUserId, japamId });
        }
      } catch (error) {
        console.log('Stats sync error, using local data:', error);
        if (!preserveManualCount) {
          await restoreTotal(localStoredTotal, { userId: savedUserId, japamId });
          totalRef.current = localStoredTotal;
        }
        await refreshDayStreak({ userId: savedUserId, japamId });
      }

      setHasRestoredTotal(true);
      return;
    }

    // Not logged in (guest) — restore today's in-progress count from this Japam's own guest-scoped
    // keys (previously unkeyed/global, which is exactly what let a different Japam's cached total
    // flash on screen after switching).
    if (!preserveManualCount) {
      const manualDate = await AsyncStorage.getItem(getJapamScopedKey(MANUAL_TOTAL_DATE_KEY, null, japamId));
      const guestTotal = manualDate === todayKey
        ? Number((await AsyncStorage.getItem(getJapamScopedKey(MANUAL_TOTAL_KEY, null, japamId))) || '0')
        : 0;
      await restoreTotal(guestTotal, { userId: null, japamId });
      totalRef.current = guestTotal;
    } else {
      setMalas(0);
      setTotal(0);
    }
    await refreshDayStreak({ userId: null, japamId });
    setHasRestoredTotal(true);
  }, [refreshDayStreak, restoreTotal]);

  useEffect(() => {
    restoreTodayTotalRef.current = restoreTodayTotal;
  }, [restoreTodayTotal]);

  useFocusEffect(
    useCallback(() => {
      let mounted = true;

      void (async () => {
        if (!mounted) return;
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
      void restoreTodayTotal({ preserveManualCount: true });
    };

    const historySubscription = DeviceEventEmitter.addListener('japam-history-updated', onHistoryUpdated);
    const statsSubscription = DeviceEventEmitter.addListener('japam-stats-updated', onHistoryUpdated);

    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      window.addEventListener('japam-history-updated', onHistoryUpdated as EventListener);
      window.addEventListener('japam-stats-updated', onHistoryUpdated as EventListener);
    }

    return () => {
      historySubscription.remove();
      statsSubscription.remove();
      if (Platform.OS === 'web' && typeof window !== 'undefined') {
        window.removeEventListener('japam-history-updated', onHistoryUpdated as EventListener);
        window.removeEventListener('japam-stats-updated', onHistoryUpdated as EventListener);
      }
    };
  }, [restoreTodayTotal]);

  useEffect(() => {
    timerRef.current = { seconds, isRunning, targetSeconds, minutesInput, loopTimer };
  }, [seconds, isRunning, targetSeconds, minutesInput, loopTimer]);

  useEffect(() => {
    let isMounted = true;

    const preloadSounds = async () => {
      try {
        await configureAudio();
        // Web: load the Om from an in-memory blob: URL (cached once while online) so the
        // completion sound plays OFFLINE. Falls back to the network URL if the fetch fails.
        const source = Platform.OS === 'web'
          ? { uri: await getWebOmAudioUri() }
          : require('../../assets/om_complete.mp3');

        const { sound: normalSound } = await Audio.Sound.createAsync(
          source,
          { shouldPlay: false, volume: 0.9 }
        );

        if (!isMounted) {
          await normalSound.unloadAsync().catch(console.log);
          return;
        }

        completeSoundRef.current = normalSound;
        webAudioPrimedRef.current = false;
      } catch (error) {
        console.log('Sound preload error:', error);
      }
    };

    void preloadSounds();

    return () => {
      isMounted = false;
      completeSoundRef.current?.unloadAsync().catch(console.log);
      completeSoundRef.current = null;
    };
  }, [configureAudio]);

  const saveTimerStateToSupabase = async (userId: string, timerState: {
    seconds: number; isRunning: boolean; targetSeconds: number; minutesInput: string; loopTimer: boolean;
  }) => {
    const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
    const key = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !key || !userId) return;

    // Require a real session JWT — an anon-key request has no INSERT/UPDATE policy for this
    // user's own row once RLS is tightened (mirrors syncPendingHistory's session-token preference
    // in contexts/timer-context.tsx). No session: skip this pass, retry next time.
    const { data: stateSessionData } = await supabase.auth.getSession();
    const stateSessionToken = stateSessionData.session?.access_token;
    if (!stateSessionToken) {
      console.log('[TimerState] SAVE_SKIPPED reason=no-session');
      return;
    }

    await fetch(`${url}/rest/v1/japam_timer_state?on_conflict=user_id`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: key,
        Authorization: `Bearer ${stateSessionToken}`,
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

    const isRunningChanged = lastSavedIsRunningRef.current !== isRunning;
    const now = Date.now();
    if (!isRunningChanged && isRunning && now - localTimerSaveThrottleRef.current < 5000) return;

    lastSavedIsRunningRef.current = isRunning;
    localTimerSaveThrottleRef.current = now;

    void (async () => {
      const savedUserId = await AsyncStorage.getItem(USER_ID_KEY);
      const pairs: [string, string][] = [
        [TIMER_SECONDS_KEY, String(seconds)],
        [TIMER_RUNNING_KEY, String(isRunning)],
        [TIMER_TARGET_KEY, String(targetSeconds)],
        [TIMER_MINUTES_KEY, minutesInput],
        [TIMER_LOOP_KEY, String(loopTimer)],
      ];
      if (savedUserId) {
        pairs.push(
          [getUserStorageKey(TIMER_SECONDS_KEY, savedUserId), String(seconds)],
          [getUserStorageKey(TIMER_RUNNING_KEY, savedUserId), String(isRunning)],
          [getUserStorageKey(TIMER_TARGET_KEY, savedUserId), String(targetSeconds)],
          [getUserStorageKey(TIMER_MINUTES_KEY, savedUserId), minutesInput],
          [getUserStorageKey(TIMER_LOOP_KEY, savedUserId), String(loopTimer)],
        );
      }
      await AsyncStorage.multiSet(pairs);

      if (!savedUserId) return;
      if (isRunning && Date.now() - timerCloudLastSavedAtRef.current < 10000) return;
      timerCloudLastSavedAtRef.current = Date.now();
      await saveTimerStateToSupabase(savedUserId, { seconds, isRunning, targetSeconds, minutesInput, loopTimer });
    })();
  }, [seconds, isRunning, targetSeconds, minutesInput, loopTimer, hasRestoredTimer]);

  const fetchTimerStateFromSupabase = useCallback(async (userId: string): Promise<TimerStateRow | null> => {
    const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
    const key = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !key || !userId) return null;

    // Require a real session JWT — an anon-key request has no SELECT policy for this user's own
    // row once RLS is tightened (mirrors syncPendingHistory's session-token preference in
    // contexts/timer-context.tsx). No session: treat as "nothing to restore" this pass.
    const { data: fetchSessionData } = await supabase.auth.getSession();
    const fetchSessionToken = fetchSessionData.session?.access_token;
    if (!fetchSessionToken) return null;

    const encodedUserId = encodeURIComponent(userId);
    const response = await fetch(
      `${url}/rest/v1/japam_timer_state?user_id=eq.${encodedUserId}&select=seconds,is_running,target_seconds,minutes_input,loop_timer,updated_at&limit=1`,
      { headers: { apikey: key, Authorization: `Bearer ${fetchSessionToken}` } }
    );

    if (!response.ok) return null;
    const rows = await response.json();
    return rows?.[0] || null;
  }, []);

  const applyRestoredTimerState = useCallback((timerState: TimerStateRow) => {
    const savedTarget = Math.max(60, Math.floor(Number(timerState.target_seconds) || DEFAULT_TIMER_MINUTES * 60));
    const savedSeconds = Math.max(0, Math.floor(Number(timerState.seconds) || 0));
  
    timerStartedAtRef.current = null;
    setSeconds(savedSeconds);
    setIsRunning(false);
    setTargetSeconds(savedTarget);
    setMinutesInput(timerState.minutes_input || String(Math.max(1, Math.floor(savedTarget / 60))));
    setHasSelectedTimer(true);
    setLoopTimer(Boolean(timerState.loop_timer));
  }, []);

  useEffect(() => {
    const sync = () => {
      void syncStoredAuth();
    };
    const authSubscription = DeviceEventEmitter.addListener('japam-auth-updated', sync);
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      window.addEventListener('japam-auth-updated', sync);
    }

    const loadData = async () => {
      const today = getLocalDateKey();
      const { savedUserName, savedUserId } = await syncStoredAuth();

      if (savedUserId) {
        const userJapamName = await AsyncStorage.getItem(getUserStorageKey(JAPAM_NAME_KEY, savedUserId));
        if (userJapamName) {
          setJapamName(userJapamName);
          setNameInput(userJapamName);
          setHasSetName(true); // ✅ name already set
        }
      }

      if (savedUserName && savedUserId) {
        userIdRef.current = savedUserId;
        setUserName(savedUserName);
        setShowUserModal(false);
        await restoreTodayTotal();
      } else if (savedUserName && !savedUserId) {
        userIdRef.current = null;
        setUserName(savedUserName);
        setShowUserModal(false);
      } else {
        setUserName('');
        setShowUserModal(false);
        setDayStreak(0);
        await restoreTotal(0, { userId: null });
      }

      if (savedUserId) {
        let timerState: TimerStateRow | null = null;
        try {
          timerState = await fetchTimerStateFromSupabase(savedUserId);
        } catch {
          // offline — fall through to local AsyncStorage restore below
        }
        if (timerState) {
          // Local storage may have more recent seconds if app was killed between cloud saves
          const localSeconds = Number((await AsyncStorage.getItem(getUserStorageKey(TIMER_SECONDS_KEY, savedUserId))) || '0');
          const cloudSeconds = Number(timerState.seconds || 0);
          if (localSeconds > cloudSeconds) {
            timerState.seconds = localSeconds;
          }
          applyRestoredTimerState(timerState);
        } else {
          const savedTimerSeconds = Number((await AsyncStorage.getItem(getUserStorageKey(TIMER_SECONDS_KEY, savedUserId))) || '0');
          const savedTimerTarget = Number((await AsyncStorage.getItem(getUserStorageKey(TIMER_TARGET_KEY, savedUserId))) || String(DEFAULT_TIMER_MINUTES * 60));
          const savedTimerMinutes = (await AsyncStorage.getItem(getUserStorageKey(TIMER_MINUTES_KEY, savedUserId))) || String(DEFAULT_TIMER_MINUTES);
          const savedTimerLoop = (await AsyncStorage.getItem(getUserStorageKey(TIMER_LOOP_KEY, savedUserId))) === 'true';
          setSeconds(Math.max(0, savedTimerSeconds));
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
    return () => {
      authSubscription.remove();
      if (Platform.OS === 'web' && typeof window !== 'undefined') {
        window.removeEventListener('japam-auth-updated', sync);
      }
    };
  }, [applyRestoredTimerState, fetchTimerStateFromSupabase, restoreTodayTotal, restoreTotal, syncStoredAuth]);

  useEffect(() => {
    return () => {
      if (dbTotalSaveTimeoutRef.current) {
        clearTimeout(dbTotalSaveTimeoutRef.current);
      }
      completeSoundRef.current?.unloadAsync().catch(console.log);
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

      // Require a real session JWT — an anon-key request has no SELECT policy for this user's
      // rows once RLS is tightened. No session means we leave local history untouched (same
      // no-op path as any other fetch failure below).
      const sessionToken = (await supabase.auth.getSession()).data.session?.access_token;
      if (!sessionToken) return;

      const encodedUserId = encodeURIComponent(googleUserId);
      const response = await fetch(
        `${supabaseUrl}/rest/v1/japam_history?user_id=eq.${encodedUserId}&select=*&order=created_at.asc`,
        { headers: { apikey: supabaseKey, Authorization: `Bearer ${sessionToken}` } }
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
        userName: item.user_name,
        userEmail: item.user_email,
        completionId: item.completion_id,
        syncStatus: 'synced' as const,
      }));

      const rawLocal = await AsyncStorage.getItem(HISTORY_KEY);
      const localHistory: Session[] = rawLocal ? JSON.parse(rawLocal) : [];

      // Merge — never overwrite (see lib/historyStore.ts). Keeps all local records, including
      // unsynced 'pending' malas, and upgrades any the remote confirms to 'synced'.
      const mergedHistory = mergeHistories(localHistory, remoteHistory);
      console.log('[RESTORE_REMOTE_COUNT] screen=tap-login count=%d', remoteHistory.length);
      console.log(
        '[MERGE_LOCAL_COUNT_BEFORE] screen=tap-login count=%d pending=%d',
        localHistory.length,
        localHistory.filter((item) => item.userId === googleUserId && item.syncStatus === 'pending').length
      );
      console.log('[MERGE_LOCAL_COUNT_AFTER] screen=tap-login count=%d', mergedHistory.length);

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
    if (Platform.OS !== 'web') {
      GoogleSignin.configure({
        webClientId: process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID,
      });
    }
  }, []);

  const migrateGuestHistoryToGoogle = useCallback(async (googleUserId: string) => {
    const raw = await AsyncStorage.getItem(HISTORY_KEY);
    const history: Session[] = raw ? JSON.parse(raw) : [];
    if (!history.some((r) => !r.userId)) return;
    const migrated = history.map((r) =>
      !r.userId ? { ...r, userId: googleUserId, syncStatus: 'pending' as const } : r
    );
    await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(migrated));
  }, []);

  const handleSaveGuestName = useCallback(async () => {
    const name = guestNameInput.trim();
    if (!name) return;
    await AsyncStorage.setItem(USER_NAME_KEY, name);
    setUserName(name);
    setIsGuestMode(true);
    setShowGuestNameModal(false);
    setShowUserModal(false);
    setGuestNameInput('');
    DeviceEventEmitter.emit('japam-auth-updated');
  }, [guestNameInput]);

  const handleNativeGoogleSignIn = useCallback(async () => {
    console.log('SIGNIN PATH:', Platform.OS);
    console.log('Using native GoogleSignin');
    setIsSigningIn(true);
    setShowUserModal(false);
    try {
      await GoogleSignin.hasPlayServices();
      const userInfo = await GoogleSignin.signIn();
      if (userInfo.type !== 'success') {
        setIsSigningIn(false);
        setShowUserModal(true);
        showGoogleSignInRequiredAlert();
        return;
      }
      const { id, name, givenName, email } = userInfo.data.user;
      const { idToken } = userInfo.data;
      let supabaseUuid: string | undefined;
      if (idToken) {
        const { data: authData, error: authError } = await supabase.auth.signInWithIdToken({ provider: 'google', token: idToken });
        if (authError) console.log('Supabase signInWithIdToken error:', authError.message);
        else supabaseUuid = authData?.user?.id;
      }
      const googleName = givenName || name || email || 'User';
      const googleEmail = email || '';
      const googleUserId = String(id).trim();

      if (!googleUserId) {
        setIsSigningIn(false);
        setShowUserModal(true);
        showGoogleSignInRequiredAlert();
        return;
      }

      const userId = supabaseUuid ?? googleUserId;
      setHasRestoredTimer(false);
      setUserName(googleName);
      setIsGuestMode(false);
      setShowUserModal(false);
      setAuthReady(true);
      setShowUserMenu(false);
      await restoreTotal(0, { userId: null });
      totalRef.current = 0;
      await AsyncStorage.setItem(USER_NAME_KEY, googleName);
      if (googleEmail) await AsyncStorage.setItem(USER_EMAIL_KEY, googleEmail);
      await migrateGuestHistoryToGoogle(userId);
      await AsyncStorage.setItem(USER_ID_KEY, userId);
      userIdRef.current = userId;
      DeviceEventEmitter.emit('japam-auth-updated');

      await loadJapamNameFromSupabase(userId);
      await restoreTodayTotal();
      await restoreHistoryFromSupabase(userId);
      await restoreTimerForUser(userId);
    } catch (error) {
      console.log('Native Google sign-in error:', error);
      setShowUserModal(true);
      showGoogleSignInRequiredAlert();
    } finally {
      setIsSigningIn(false);
    }
  }, [
    loadJapamNameFromSupabase,
    migrateGuestHistoryToGoogle,
    requestNotificationPermissionOnce,
    restoreHistoryFromSupabase,
    restoreTimerForUser,
    restoreTodayTotal,
    restoreTotal,
  ]);

  useEffect(() => {
    const handleGoogleLogin = async () => {
      if (Platform.OS !== 'web') return; // native platforms use handleNativeGoogleSignIn
      if (!response) return;

      console.log('[AUTH_CALLBACK] source=tap-japam-web response.type=%s', response.type);
      if (response.type !== 'success') {
        setIsSigningIn(false);
        await AsyncStorage.removeItem(AUTH_PENDING_KEY);
        const savedUserId = await AsyncStorage.getItem(USER_ID_KEY);
        if (!savedUserId) {
          setShowUserModal(true);
          showGoogleSignInRequiredAlert();
        }
        return;
      }

      setIsSigningIn(true);
      setShowUserModal(false);

      const { authentication } = response;
      const accessToken =
        authentication?.accessToken ||
        ('params' in response ? response.params?.access_token : undefined);
      const idToken =
        authentication?.idToken ||
        ('params' in response ? (response.params as Record<string, string>)?.id_token : undefined);

      console.log('[AUTH_CALLBACK] source=tap-japam-web hasIdToken=%s hasAccessToken=%s paramKeys=%s',
        !!idToken, !!accessToken,
        'params' in response ? Object.keys(response.params ?? {}).join(',') : 'none');

      if (!accessToken && !idToken) {
        await AsyncStorage.removeItem(AUTH_PENDING_KEY);
        setIsSigningIn(false);
        setShowUserModal(true);
        showGoogleSignInRequiredAlert();
        return;
      }

      try {
        if (idToken) {
          console.log('[SUPABASE_AUTH] tap-japam nonce_prefix=%s', rawNonceRef.current.slice(0, 8));
          const { error: supaAuthError } = await supabase.auth.signInWithIdToken({
            provider: 'google',
            token: idToken,
            nonce: rawNonceRef.current,
          });
          if (supaAuthError) console.log('[SUPABASE_AUTH] tap-japam signInWithIdToken error:', supaAuthError.message);
          else console.log('[SUPABASE_AUTH] tap-japam web session established');
        } else {
          console.log('[SUPABASE_AUTH] tap-japam no id_token — session not established');
        }

        const session = (await supabase.auth.getSession()).data.session;
        const sessionIsAnonymous =
          !!((session?.user as { is_anonymous?: boolean } | undefined)?.is_anonymous);
        console.log(
          '[SUPABASE_AUTH] tap-japam session.user.id=%s session.user.email=%s hasAccessToken=%s tokenLength=%s isAnonymous=%s',
          session?.user?.id || 'none',
          session?.user?.email || 'none',
          !!session?.access_token,
          session?.access_token?.length || 0,
          sessionIsAnonymous
        );
        if (!session?.access_token || sessionIsAnonymous) {
          console.log('[SUPABASE_AUTH] tap-japam missing non-anonymous Supabase session after Google login');
          showGoogleSignInRequiredAlert();
          return;
        }

        let googleUserId: string;
        let googleName: string;
        let googleEmail: string;

        if (accessToken) {
          const userInfoResponse = await fetch('https://www.googleapis.com/userinfo/v2/me', {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          const userInfo = await userInfoResponse.json();
          googleName = userInfo?.given_name || userInfo?.name || userInfo?.email || 'User';
          googleEmail = userInfo?.email || '';
          googleUserId = String(userInfo?.id || '').trim();
        } else {
          const claims = JSON.parse(
            decodeURIComponent(
              atob(idToken!.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))
                .split('')
                .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
                .join('')
            )
          ) as Record<string, unknown>;
          googleUserId = String(claims.sub || '');
          googleName = String(claims.given_name || claims.name || claims.email || 'User');
          googleEmail = String(claims.email || '');
        }

        if (!googleUserId) {
          setShowUserModal(true);
          showGoogleSignInRequiredAlert();
          return;
        }

        // session is non-null: the guard above returns early if access_token is missing.
        const userId = session!.user.id;
        setHasRestoredTimer(false);
        setUserName(googleName);
        setIsGuestMode(false);
        setShowUserModal(false);
        setAuthReady(true);
        setShowUserMenu(false);
        await restoreTotal(0, { userId: null });
        totalRef.current = 0;
        await AsyncStorage.setItem(USER_NAME_KEY, googleName);
        if (googleEmail) {
          await AsyncStorage.setItem(USER_EMAIL_KEY, googleEmail);
        }
        await migrateGuestHistoryToGoogle(userId);
        await AsyncStorage.setItem(USER_ID_KEY, userId);
        userIdRef.current = userId;
        DeviceEventEmitter.emit('japam-auth-updated');
        if (Platform.OS === 'web' && typeof window !== 'undefined') {
          window.dispatchEvent(new Event('japam-auth-updated'));
        }

        await loadJapamNameFromSupabase(userId);
        await restoreTodayTotal();
        await restoreHistoryFromSupabase(userId);
        await restoreTimerForUser(userId);
      } catch (error) {
        console.log('Google login error:', error);
        setShowUserModal(true);
        showGoogleSignInRequiredAlert();
      } finally {
        await AsyncStorage.removeItem(AUTH_PENDING_KEY);
        setIsSigningIn(false);
      }
    };

    void handleGoogleLogin();
  }, [
    response,
    loadJapamNameFromSupabase,
    migrateGuestHistoryToGoogle,
    requestNotificationPermissionOnce,
    restoreHistoryFromSupabase,
    restoreTimerForUser,
    restoreTodayTotal,
    restoreTotal,
  ]);

  useEffect(() => {
    totalRef.current = total;
    if (!hasRestoredTotal || !userName) return;

    void (async () => {
      const japamId = activeJapamIdRef.current;
      const savedUserId = await AsyncStorage.getItem(USER_ID_KEY);
      const todayKey = getLocalDateKey();

      await AsyncStorage.setItem(getJapamScopedKey(COUNT_KEY, savedUserId, japamId), String(count));
      await AsyncStorage.setItem(getJapamScopedKey(MALAS_KEY, savedUserId, japamId), String(malas));
      await AsyncStorage.setItem(getJapamScopedKey(TOTAL_KEY, savedUserId, japamId), String(total));
      await AsyncStorage.setItem(getJapamScopedKey(MANUAL_COUNT_KEY, savedUserId, japamId), String(count));
      await AsyncStorage.setItem(getJapamScopedKey(MANUAL_MALAS_KEY, savedUserId, japamId), String(malas));
      await AsyncStorage.setItem(getJapamScopedKey(MANUAL_TOTAL_KEY, savedUserId, japamId), String(total));
      await AsyncStorage.setItem(getJapamScopedKey(MANUAL_TOTAL_DATE_KEY, savedUserId, japamId), todayKey);

      if (savedUserId) {
        await refreshDayStreak({ userId: savedUserId, japamId });

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
    // Guard: prevent duplicate completion if already fired within the last 2 seconds
    if (Date.now() - lastCompletedCycleRef.current < 2000) return;
    completeTimerSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seconds, isRunning, targetSeconds, loopTimer]);

  const playCompleteSound = async (variant: 'normal' | 'final' = 'normal') => {
    try {
      await configureAudio();
      if (!webAudioPrimedRef.current) {
        await primeWebCompletionAudio();
      }
      const sound = completeSoundRef.current;

      if (!sound) return;

      await sound.stopAsync().catch(() => undefined);
      await sound.setPositionAsync(0).catch(() => undefined);
      await sound.setVolumeAsync(0.9).catch(() => undefined);
      await sound.playAsync();
      setTimeout(() => {
        sound.stopAsync().catch(() => undefined);
      }, variant === 'final' ? 6000 : 5000);
    } catch (error) {
      console.log('Sound error:', error);
    }
  };

  const notifyCompletionFallback = useCallback(async (variant: 'normal' | 'final') => {
    try {
      const title = 'Mala completed';
      const body = variant === 'final'
        ? 'Your Japam is complete'
        : 'Your Japam timer is complete';

      if (Platform.OS === 'web' && typeof window !== 'undefined') {
        if ('Notification' in window && Notification.permission === 'granted') {
          new Notification(title, { body });
        }
        return;
      }

      const permission = await Notifications.getPermissionsAsync();
      if (!permission.granted) return;

      await Notifications.scheduleNotificationAsync({
        content: {
          title,
          body,
          ...(Platform.OS === 'android' ? { channelId: 'japam-complete' } : {}),
        },
        trigger: null,
      });
    } catch (error) {
      console.log('Completion notification error:', error);
    }
  }, []);

  const saveSession = useCallback(async (
    duration: number,
    sessionMalas: number,
    sessionTotal: number,
    accumulatedTotal: number,
    source: 'tap' | 'timer' = 'timer'
  ): Promise<boolean> => {
    if (isSavingSessionRef.current) {
      if (source === 'tap') console.log('TAP_HISTORY_SAVE_SKIPPED reason=in-flight');
      return false;
    }
    const currentUserId = await AsyncStorage.getItem(USER_ID_KEY);
    const sessionSignature = `${currentUserId || 'guest'}-${getLocalDateKey()}-${duration}-${sessionMalas}-${sessionTotal}-${accumulatedTotal}`;
    if (lastSavedSessionRef.current === sessionSignature) {
      if (source === 'tap') console.log('TAP_HISTORY_SAVE_SKIPPED reason=duplicate signature=%s', sessionSignature);
      return false;
    }

    isSavingSessionRef.current = true;
    lastSavedSessionRef.current = sessionSignature;

    try {
      if (source === 'tap') {
        console.log('TAP_HISTORY_SAVE_START signature=%s total=%d count=%d', sessionSignature, accumulatedTotal, sessionTotal);
      }
      const raw = await AsyncStorage.getItem(HISTORY_KEY);
      const history: Session[] = raw ? JSON.parse(raw) : [];
      const userId = currentUserId;
      const savedUserName = await AsyncStorage.getItem(USER_NAME_KEY);
      const savedUserEmail = await AsyncStorage.getItem(USER_EMAIL_KEY);
      const historyUserName = savedUserName || userName || savedUserEmail || 'Unknown User';

      const sessionDate = new Date().toISOString();
      const updatedHistory = appendCompletion(history, {
        date: sessionDate,
        malas: sessionMalas,
        totalCount: sessionTotal,
        duration,
        manual: false,
        userId: userId ?? null,
        userName: userId ? historyUserName : undefined,
        userEmail: userId ? savedUserEmail || undefined : undefined,
        source,
        japamId: activeJapamIdRef.current,
        japamName: activeJapamNameRef.current,
      });
      const savedRecord = updatedHistory[0];

      await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(updatedHistory));
      await AsyncStorage.setItem(HISTORY_SYNC_VERSION_KEY, String(Date.now()));
      console.log(
        '[OFFLINE_SAVE_ACCEPTED] source=%s completionId=%s created_at=%s localDay=%s syncStatus=%s',
        source,
        savedRecord.completionId,
        savedRecord.date,
        toLocalDayKey(savedRecord.date),
        savedRecord.syncStatus
      );
      if (source === 'tap') {
        console.log(
          'TAP_HISTORY_SAVE_ACCEPTED completionId=%s userId=%s userName=%s',
          savedRecord.completionId,
          userId || 'guest',
          historyUserName
        );
      }

      // Emit immediately after local save — Home and History update without waiting for Supabase
      DeviceEventEmitter.emit('japam-stats-updated');
      DeviceEventEmitter.emit('japam-history-updated', { userId: userId || 'guest', todayTotal: accumulatedTotal });
      if (Platform.OS === 'web' && typeof window !== 'undefined') {
        window.dispatchEvent(new Event('japam-stats-updated'));
        window.dispatchEvent(new Event('japam-history-updated'));
      }
      if (source === 'tap') {
        console.log('TAP_STATS_EVENT_DISPATCHED completionId=%s', savedRecord.completionId);
      }

      if (userId) {
        const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
        const key = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

        if (url && key) {
          const payload = buildSupabaseHistoryPayload(savedRecord, userId, historyUserName);
          console.log(
            '[SYNC_PAYLOAD_CREATED_AT] source=%s completionId=%s created_at=%s localDay=%s',
            source,
            payload.completion_id,
            payload.created_at,
            toLocalDayKey(payload.created_at)
          );
          void (async () => {
            try {
              // Require a real session JWT — an anon-key request has no INSERT policy for this
              // user's own rows once RLS is tightened (mirrors syncPendingHistory's session-token
              // preference). No session leaves the record 'pending' for the next opportunistic sync.
              const sessionToken = (await supabase.auth.getSession()).data.session?.access_token;
              if (!sessionToken) {
                console.log('[SYNC_FAILED] source=%s completionId=%s reason=no-session', source, payload.completion_id);
                return;
              }
              const res = await fetch(`${url}/rest/v1/japam_history?on_conflict=completion_id`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', apikey: key, Authorization: `Bearer ${sessionToken}`, Prefer: 'return=minimal,resolution=merge-duplicates' },
                body: JSON.stringify(payload),
              });

              if (!res.ok) {
                console.log('[SYNC_FAILED] source=%s completionId=%s status=%d', source, payload.completion_id, res.status);
                console.log('Tap Supabase save error:', await res.text());
                return;
              }
              console.log('[SYNC_SUCCESS] source=%s completionId=%s', source, payload.completion_id);

              const latestRaw = await AsyncStorage.getItem(HISTORY_KEY);
              const latest = latestRaw ? JSON.parse(latestRaw) : [];
              await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(markSynced(latest, [savedRecord.completionId])));
              console.log('[MARK_SYNCED] source=%s completionId=%s', source, savedRecord.completionId);
            } catch (error) {
              console.log('[SYNC_FAILED] source=%s completionId=%s reason=network', source, payload.completion_id);
              console.log('Tap Supabase save error:', error);
            }
          })();
        }
      }
      return true;
    } catch (error) {
      console.log('Supabase save error:', error);
      if (source === 'tap') {
        lastSavedSessionRef.current = '';
        console.log('TAP_HISTORY_SAVE_SKIPPED reason=error');
      }
      return false;
    } finally {
      isSavingSessionRef.current = false;
    }
  }, [userName]);


  const tapFeedback = useCallback(() => {
    if (!vibrationEnabled) return;

    if (Platform.OS === 'web') {
      if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
        navigator.vibrate(200);
      }
      return;
    }

    if (Platform.OS === 'android') {
      // Double-pulse (35ms buzz, 15ms gap, 40ms buzz = 90ms total) at default amplitude
      // (~255/255 max on Android 8+, still the strongest JS-reachable option — see prior note
      // on expo-haptics Heavy capping at 70/255). A single flat pulse of similar total length
      // reads as a smear/buzz on modern Samsung LRA motors; a short buzz-gap-buzz reads as a
      // firmer, more distinct "thump-thump" at the same perceived intensity budget.
      // Total duration (90ms) is kept strictly under the 100ms tap debounce (lastTapRef) so the
      // pattern always finishes and goes silent before the next legal tap's vibrate() call can
      // land — no overlap/clipping even at the fastest tap rate the counting logic allows.
      // Each new Vibration.vibrate() call cancels the previous one, so rapid tapping never
      // accumulates overlapping buzzes — each tap gets its own clean pulse.
      Vibration.vibrate([0, 35, 15, 40]);
      return;
    }

    // iOS: Medium gives a noticably stronger tap than Light ("collision between moderately sized
    // UI elements" vs. Light's "small, light" objects) without being as intense as Heavy, which
    // can feel jarring during 108 consecutive rapid taps. The Taptic Engine rate-limits calls
    // automatically (~8–10 Hz), so very rapid tapping stays comfortable.
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
  }, [vibrationEnabled]);

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

    // Always notify — covers background completion and acts as status feedback
    void notifyCompletionFallback(variant);
  
    if (!vibrationEnabled) return;

    try {
      if (Platform.OS === 'web') {
        if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
          navigator.vibrate(variant === 'final' ? [300, 120, 300, 120, 500] : [200, 80, 200]);
        }
        return;
      }

      if (Platform.OS === 'ios') {
        if (variant === 'final') {
          triggerDeepHardwarePulse([0, 300, 120, 300, 120, 500]);
          await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
          setTimeout(() => {
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
          }, 320);
          setTimeout(() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
          }, 680);
          return;
        }

        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setTimeout(() => {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(console.log);
        }, 350);
        setTimeout(() => {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(console.log);
        }, 700);
        return;
      }

      // Android: [0, 200, 80, 200] = start immediately, 200ms on, 80ms off, 200ms on
      Vibration.vibrate(variant === 'final' ? [0, 300, 120, 300, 120, 500] : [0, 200, 80, 200]);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    } catch (error) {
      console.log('Completion vibration error:', error);
      try { Vibration.vibrate(variant === 'final' ? [0, 300, 120, 300, 120, 500] : [0, 200, 80, 200]); } catch {}
    }
  }, [notifyCompletionFallback, playCompletionAnimation, repetitionSoundEnabled, soundEnabled, vibrationEnabled]);

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
      const japamId = activeJapamIdRef.current;
      const savedUserId = userIdRef.current;
      const todayKey = getLocalDateKey();
      await AsyncStorage.setItem(getJapamScopedKey(TOTAL_KEY, savedUserId, japamId), String(safeTotal));
      await AsyncStorage.setItem(getJapamScopedKey(MALAS_KEY, savedUserId, japamId), String(nextMalas));
      await AsyncStorage.setItem(getJapamScopedKey(COUNT_KEY, savedUserId, japamId), String(nextCount));
      await AsyncStorage.setItem(getJapamScopedKey(TOTAL_DATE_KEY, savedUserId, japamId), todayKey);
      await AsyncStorage.setItem(getJapamScopedKey(MANUAL_TOTAL_KEY, savedUserId, japamId), String(safeTotal));
      await AsyncStorage.setItem(getJapamScopedKey(MANUAL_MALAS_KEY, savedUserId, japamId), String(nextMalas));
      await AsyncStorage.setItem(getJapamScopedKey(MANUAL_COUNT_KEY, savedUserId, japamId), String(nextCount));
      await AsyncStorage.setItem(getJapamScopedKey(MANUAL_TOTAL_DATE_KEY, savedUserId, japamId), todayKey);
    })();

    return safeTotal;
  };

  

  const requireLogin = () => {
    if (!authReady) return false;
    if (!userName) { setShowUserModal(true); return false; }
    return true;
  };

  const handleResetCount = () => {
    if (count === 0) return;
    const title = 'Reset current count?';
    const message = `${count} tap${count === 1 ? '' : 's'} will be cleared. Completed malas are not affected.`;

    if (Platform.OS === 'web') {
      // Alert.alert is not interactive in react-native-web; use window.confirm.
      const confirmed =
        typeof window !== 'undefined' && window.confirm(`${title}\n\n${message}`);
      if (confirmed) setCountersFromTotal(totalRef.current - count);
      return;
    }

    Alert.alert(title, message, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Reset',
        style: 'destructive',
        onPress: () => setCountersFromTotal(totalRef.current - count),
      },
    ]);
  };

  const handleTap = async () => {
    if (!requireLogin()) return;
    void primeWebCompletionAudio();

    const now = Date.now();
    if (now - lastTapRef.current < 100) return;
    lastTapRef.current = now;

    rippleAnim.setValue(0);
    Animated.timing(rippleAnim, {
      toValue: 1,
      duration: 700,
      useNativeDriver: true,
    }).start();

    const previousTotal = totalRef.current;
    const nextTotal = previousTotal + 1;
    const newTotal = setCountersFromTotal(nextTotal);
    const crossing = detectMalaCrossing(previousTotal, nextTotal);

    if (crossing.crossed) {
      console.log('TAP_MALA_COMPLETE_REACHED total=%d count=%d', newTotal, newTotal % 108);
      await runMalaCompletion({
        boundaryKey: crossing.nextMala,
        guard: tapMalaCompletionGuardRef.current,
        save: () => saveSession(0, 1, 108, newTotal, 'tap'),
        playFeedback: () => completeFeedback('final'),
        onError: (stage, error) => console.log('TAP_MALA_COMPLETION_ERROR stage=%s', stage, error),
      });
    } else {
      void tapFeedback();
    }
  };

  const handleStart = () => {
    if (!requireLogin()) return;
    void primeWebCompletionAudio();
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
      // Defensive/consistency wiring matching Home's equivalent handleStart -- this timer-mode
      // path isn't currently wired to any visible control on this screen (tapping the circle is
      // the real interaction, captured on focus above), but re-capturing here too keeps this
      // function correct on its own terms if it's ever reached.
      activeJapamIdRef.current = currentJapam?.id ?? null;
      activeJapamNameRef.current = currentJapam?.name ?? null;
    }
    timerStartedAtRef.current = Date.now() - nextSeconds * 1000;
    timerRef.current = { seconds: nextSeconds, isRunning: true, targetSeconds: nextTargetSeconds, minutesInput: String(mins), loopTimer };
    setMinutesInput(String(mins));
    setHasSelectedTimer(true);
    setTargetSeconds(nextTargetSeconds);
    setSeconds(nextSeconds);
    setIsRunning(true);
    startTimerInterval();
    void showTimerNotification();
  };

  const handlePause = () => {
    clearTimerHandles();
    timerStartedAtRef.current = null;
    setIsRunning(false);
    void hideTimerNotification();
    void (async () => {
      const savedUserId = await AsyncStorage.getItem(USER_ID_KEY);
      if (!savedUserId) return;

      const pausedSeconds = Math.max(0, Math.floor(seconds));
      const pausedTarget = Math.max(60, Math.floor(targetSeconds || DEFAULT_TIMER_MINUTES * 60));
      const pausedMinutes = minutesInput || String(DEFAULT_TIMER_MINUTES);

      await AsyncStorage.setItem(getUserStorageKey(TIMER_SECONDS_KEY, savedUserId), String(pausedSeconds));
      await AsyncStorage.setItem(getUserStorageKey(TIMER_RUNNING_KEY, savedUserId), 'false');
      await AsyncStorage.setItem(getUserStorageKey(TIMER_TARGET_KEY, savedUserId), String(pausedTarget));
      await AsyncStorage.setItem(getUserStorageKey(TIMER_MINUTES_KEY, savedUserId), pausedMinutes);
      await AsyncStorage.setItem(getUserStorageKey(TIMER_LOOP_KEY, savedUserId), String(loopTimer));
      await AsyncStorage.setItem(TIMER_SECONDS_KEY, String(pausedSeconds));
      await AsyncStorage.setItem(TIMER_RUNNING_KEY, 'false');
      await AsyncStorage.setItem(TIMER_TARGET_KEY, String(pausedTarget));
      await AsyncStorage.setItem(TIMER_MINUTES_KEY, pausedMinutes);
      await AsyncStorage.setItem(TIMER_LOOP_KEY, String(loopTimer));
      await saveTimerStateToSupabase(savedUserId, {
        seconds: pausedSeconds,
        isRunning: false,
        targetSeconds: pausedTarget,
        minutesInput: pausedMinutes,
        loopTimer,
      });
    })();
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
    lastCompletedCycleRef.current = Date.now();

    // Add 108 to total so malas increments on Home; count stays the same (count = total % 108)
    const currentTotal = totalRef.current;
    const nextTotal = currentTotal + 108;
    setCountersFromTotal(nextTotal);
    void saveSession(targetSeconds, 1, 108, nextTotal);
    void completeFeedback('normal');
    void hideTimerNotification();

    clearTimerHandles();
    timerStartedAtRef.current = null;

    if (loopTimer) {
      const nextLoopCount = completedLoopMalasRef.current + 1;
      completedLoopMalasRef.current = nextLoopCount;
      setAutoCompletedMalas(nextLoopCount);

      if (nextLoopCount >= 5) {
        clearTimerHandles();
        completedLoopMalasRef.current = 0;
        setAutoCompletedMalas(0);
        setSeconds(0);
        setIsRunning(false);
        isCompletingRef.current = false;
        return;
      }

      if (autoRepeatTimeoutRef.current) {
        clearTimeout(autoRepeatTimeoutRef.current);
        autoRepeatTimeoutRef.current = null;
      }

      autoRepeatTimeoutRef.current = setTimeout(() => {
        autoRepeatTimeoutRef.current = null;

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
        void showTimerNotification();
        startTimerInterval();
        isCompletingRef.current = false;
      }, 4000);
    } else {
      setSeconds(0);
      setIsRunning(false);
      isCompletingRef.current = false;
    }
  }, [clearTimerHandles, completeFeedback, hideTimerNotification, loopTimer, minutesInput, saveSession, showTimerNotification, startTimerInterval, targetSeconds]);

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
      await saveUserTotalToSupabase(currentUserId, currentUserName || userName || 'User', totalRef.current);
      await saveTimerStateToSupabase(currentUserId, {
        seconds: logoutSeconds,
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
    userIdRef.current = null;
    lastSavedSessionRef.current = '';
    clearTimerHandles();
    void hideTimerNotification();
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
    setIsGuestMode(false);
    setJapamName('');
    setNameInput('');
    setHasSetName(false); // ✅ reset on logout
    setShowUserModal(false);

    await AsyncStorage.removeItem(USER_NAME_KEY);
    await AsyncStorage.removeItem(USER_EMAIL_KEY);
    await AsyncStorage.removeItem(USER_ID_KEY);
    DeviceEventEmitter.emit('japam-auth-updated');
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      window.dispatchEvent(new Event('japam-auth-updated'));
    }

    // TOTAL_KEY/MALAS_KEY/COUNT_KEY/MANUAL_* are no longer written under these bare names at all
    // (see getJapamScopedKey) -- removing them here is now a harmless no-op for those names, kept
    // only so a pre-upgrade install's leftover bare keys get cleaned up. The Japam that was active
    // for this session is cleared explicitly by its real (scoped) key below, so no stale cached
    // total for THIS Japam survives into the next sign-in on this device.
    await AsyncStorage.multiRemove([
      TOTAL_KEY,
      COUNT_KEY,
      MALAS_KEY,
      MANUAL_TOTAL_KEY,
      MANUAL_COUNT_KEY,
      MANUAL_MALAS_KEY,
      MANUAL_TOTAL_DATE_KEY,
      LAST_TOTAL_KEY,
      getJapamScopedKey(TOTAL_KEY, currentUserId, activeJapamIdRef.current),
      getJapamScopedKey(COUNT_KEY, currentUserId, activeJapamIdRef.current),
      getJapamScopedKey(MALAS_KEY, currentUserId, activeJapamIdRef.current),
      getJapamScopedKey(TOTAL_DATE_KEY, currentUserId, activeJapamIdRef.current),
      getJapamScopedKey(MANUAL_TOTAL_KEY, currentUserId, activeJapamIdRef.current),
      getJapamScopedKey(MANUAL_COUNT_KEY, currentUserId, activeJapamIdRef.current),
      getJapamScopedKey(MANUAL_MALAS_KEY, currentUserId, activeJapamIdRef.current),
      getJapamScopedKey(MANUAL_TOTAL_DATE_KEY, currentUserId, activeJapamIdRef.current),
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
      <ScrollView
        style={[styles.container, Platform.OS !== 'web' && { marginBottom: tabBarSpaceFromBottom }]}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.appShell}>
          <View pointerEvents="none" style={styles.sceneLayer}>
            <ImageBackground
              source={ZEN_BACKGROUND}
              resizeMode="cover"
              style={styles.backgroundImage}
              imageStyle={styles.backgroundImageStyle}
              fadeDuration={0}
            >
              <View style={styles.backgroundOverlay} />
            </ImageBackground>
          </View>

          <CurrentJapamHeaderButton variant="tapJapam" />

          {isSigningIn && (
            <View style={styles.signingInBanner}>
              <Text style={styles.signingInText}>Signing in...</Text>
            </View>
          )}

          <Text style={styles.tapInstruction}>After each mantra japa,{'\n'}tap the circle</Text>

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
              hitSlop={{ top: 40, bottom: 40, left: 40, right: 40 }}
              pressRetentionOffset={{ top: 45, bottom: 45, left: 45, right: 45 }}
              onPress={() => {
                triggerDeepHardwarePulse(55);
                handleTap();
              }}
              style={({ pressed }) => [
                styles.progressPressable,
                pressed && styles.progressPressed,
              ]}
            >
              <View style={{ width: progressRingSize, height: progressRingSize }}>
                {Platform.OS !== 'web' && (
                  <View style={StyleSheet.absoluteFillObject}>
                    <CircularProgressArc
                      size={progressRingSize}
                      progress={progressPercent}
                      color="#0F8F87"
                      trackColor="rgba(15,143,135,0.14)"
                    />
                  </View>
                )}
                <View
                  style={[
                    styles.progressRing,
                    progressRingBackground,
                    Platform.OS !== 'web' && styles.progressRingNativeOverlay,
                  ]}
                >
                  <View style={styles.progressInner}>
                    <Text style={styles.progressCount}>{count}</Text>
                    <Text style={styles.progressGoal}>/ 108 malas</Text>
                  </View>
                </View>
              </View>
            </Pressable>
          </Animated.View>

          <View style={styles.tapProgressWrap}>
            <View style={styles.tapProgressTrack}>
              <View style={[styles.tapProgressFill, { width: `${progressPercent}%` }]} />
            </View>
            <Text style={styles.tapProgressText}>{count} / 108</Text>
          </View>

          {count > 0 && (
            <Pressable style={styles.resetCountBtn} onPress={handleResetCount}>
              <Text style={styles.resetCountBtnText}>Reset Count</Text>
            </Pressable>
          )}

          {Platform.OS === 'android' && (
            <Text style={styles.buildDebug}>
              {`v3 · ${Updates.isEmbeddedLaunch ? 'embedded' : `ota:${(Updates.updateId ?? '').slice(0, 8)}`}`}
            </Text>
          )}
        </View>

        <Modal visible={showUserModal && !isSigningIn} transparent animationType="fade">
          <View style={styles.modalOverlay}>
            <View style={styles.modalCard}>
              <Pressable style={styles.modalClose} onPress={() => setShowUserModal(false)}>
                <Text style={styles.modalCloseText}>×</Text>
              </Pressable>
              <View style={styles.modalTopMark}>
                <View style={styles.modalTopDot} />
              </View>
              <Text style={styles.modalTitle}>Save your Japam</Text>
              <Text style={styles.modalSubtitle}>
                {GUEST_MODE_ENABLED
                  ? 'Sign in with Google to sync across devices, or continue as a guest to save locally.'
                  : 'Sign in with Google to sync your Japam across devices.'}
              </Text>
              <Pressable
                disabled={Platform.OS === 'web' && !request}
                style={[styles.modalButton, Platform.OS === 'web' && !request && styles.disabledButton]}
                onPress={() => {
                  if (Platform.OS !== 'web') {
                    void handleNativeGoogleSignIn();
                  } else {
                    console.log('SIGNIN PATH:', Platform.OS);
                    console.log('Using web promptAsync');
                    setIsSigningIn(true);
                    setShowUserModal(false);
                    void (async () => {
                      await AsyncStorage.setItem(AUTH_PENDING_KEY, String(Date.now()));
                      const result = await promptAsync({ showInRecents: true });
                      if (result.type !== 'success') {
                        await AsyncStorage.removeItem(AUTH_PENDING_KEY);
                        setIsSigningIn(false);
                        setShowUserModal(true);
                        showGoogleSignInRequiredAlert();
                      }
                    })();
                  }
                }}
              >
                <View style={styles.googleIcon}>
                  <Text style={styles.googleIconText}>G</Text>
                </View>
                <Text style={styles.modalButtonText}>Continue with Google</Text>
              </Pressable>
              {GUEST_MODE_ENABLED && (
                <Pressable
                  style={styles.guestButton}
                  onPress={() => { setShowUserModal(false); setShowGuestWarningModal(true); }}
                >
                  <Text style={styles.guestButtonText}>Continue as Guest</Text>
                </Pressable>
              )}
              {GUEST_MODE_ENABLED && (
                <Text style={styles.modalFootnote}>
                  Guest history is saved on this device only.
                </Text>
              )}
            </View>
          </View>
        </Modal>

        <Modal visible={showGuestWarningModal} transparent animationType="fade">
          <View style={styles.modalOverlay}>
            <View style={styles.modalCard}>
              <Pressable style={styles.modalClose} onPress={() => setShowGuestWarningModal(false)}>
                <Text style={styles.modalCloseText}>×</Text>
              </Pressable>
              <View style={styles.modalTopMark}>
                <View style={styles.modalTopDot} />
              </View>
              <Text style={styles.modalTitle}>Continue as Guest</Text>
              <Text style={styles.modalSubtitle}>
                {'Your Japam history will be stored only on this phone. If you delete the app or change your phone, your history will not be transferred.\n\nFor backup and sync across devices, please sign in with Google.'}
              </Text>
              <Pressable
                style={styles.modalButton}
                onPress={() => { setShowGuestWarningModal(false); setShowGuestNameModal(true); }}
              >
                <Text style={styles.modalButtonText}>Continue as Guest</Text>
              </Pressable>
              <Pressable
                style={styles.guestButton}
                onPress={() => { setShowGuestWarningModal(false); setShowUserModal(true); }}
              >
                <Text style={styles.guestButtonText}>Sign in with Google</Text>
              </Pressable>
            </View>
          </View>
        </Modal>

        <Modal visible={showGuestNameModal} transparent animationType="fade">
          <View style={styles.modalOverlay}>
            <View style={styles.modalCard}>
              <Pressable style={styles.modalClose} onPress={() => setShowGuestNameModal(false)}>
                <Text style={styles.modalCloseText}>×</Text>
              </Pressable>
              <View style={styles.modalTopMark}>
                <View style={styles.modalTopDot} />
              </View>
              <Text style={styles.modalTitle}>Your name</Text>
              <Text style={styles.modalSubtitle}>Enter a name so your records are labeled correctly.</Text>
              <TextInput
                style={styles.guestNameInput}
                placeholder="Enter your name"
                placeholderTextColor="#94a3b8"
                value={guestNameInput}
                onChangeText={setGuestNameInput}
                returnKeyType="done"
                onSubmitEditing={() => void handleSaveGuestName()}
              />
              <Pressable
                style={[styles.modalButton, !guestNameInput.trim() && styles.disabledButton]}
                disabled={!guestNameInput.trim()}
                onPress={() => void handleSaveGuestName()}
              >
                <Text style={styles.modalButtonText}>Continue</Text>
              </Pressable>
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
    minHeight: shellMinHeight,
  },
  appShell: {
    width: '100%',
    maxWidth: isMobile ? undefined : 460,
    minHeight: shellMinHeight,
    alignItems: 'center',
    overflow: 'hidden',
    position: 'relative',
    backgroundColor: 'rgba(238, 248, 246, 0.94)',
    borderRadius: isMobile ? 0 : 28,
    paddingHorizontal: isMobile ? 22 : 28,
    // Keep vertical spacing inside appShell so the absolute background layer
    // covers the scrollable page, but reserve only the fixed tab bar space.
    paddingTop: Platform.OS === 'web'
      ? (isMobile
          ? (isShortMobile
              ? ('calc(14px + env(safe-area-inset-top))' as any)
              : ('calc(20px + env(safe-area-inset-top))' as any))
          : 58)
      : (isShortMobile ? 14 : isMobile ? 20 : 58),
    paddingBottom: 16,
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
  tapInstruction: {
    color: '#365f61',
    fontSize: isMobile ? 17 : 19,
    fontWeight: '800',
    textAlign: 'center',
    marginTop: isShortMobile ? 8 : isMobile ? 12 : 18,
    marginBottom: isShortMobile ? 14 : isMobile ? 18 : 24,
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
    marginBottom: isShortMobile ? 18 : isMobile ? 30 : 40,
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
    marginBottom: isShortMobile ? 20 : isMobile ? 28 : 38,
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
  progressRingNativeOverlay: {
    backgroundColor: 'transparent',
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
  tapProgressWrap: {
    width: '100%',
    maxWidth: isMobile ? 310 : 360,
    alignItems: 'center',
    marginTop: isShortMobile ? -2 : 0,
  },
  tapProgressTrack: {
    width: '100%',
    height: isMobile ? 10 : 12,
    borderRadius: 999,
    backgroundColor: 'rgba(15,118,110,0.14)',
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.62)',
  },
  tapProgressFill: {
    height: '100%',
    borderRadius: 999,
    backgroundColor: '#0F8F87',
  },
  tapProgressText: {
    color: '#365f61',
    fontSize: isMobile ? 15 : 17,
    fontWeight: '800',
    marginTop: 8,
  },
  resetCountBtn: {
    marginTop: 14,
    paddingVertical: 7,
    paddingHorizontal: 20,
    borderRadius: 999,
    borderWidth: 1.5,
    borderColor: 'rgba(15,118,110,0.3)',
    backgroundColor: 'rgba(255,255,255,0.72)',
  },
  resetCountBtnText: {
    color: '#547071',
    fontSize: 13,
    fontWeight: '700',
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
  buildDebug: { color: '#9B9B9B', fontSize: 10, textAlign: 'center', marginTop: 6, opacity: 0.6 },
  guestButton: {
    marginTop: 10,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#dbeceb',
  },
  guestButtonText: {
    color: '#0f766e',
    fontWeight: '700',
    fontSize: 15,
  },
  guestNameInput: {
    borderWidth: 1.5,
    borderColor: 'rgba(15,143,135,0.35)',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
    color: '#12383c',
    backgroundColor: 'rgba(255,255,255,0.9)',
    marginBottom: 14,
    width: '100%',
  },
});
