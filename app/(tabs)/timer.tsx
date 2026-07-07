import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { GoogleSignin } from '@react-native-google-signin/google-signin';
import {
  dedupeByCompletionId,
  mergeHistories,
  normalizeAll,
  todayStatsFor,
  toLocalDayKey,
} from '../../lib/historyStore';
import { ZEN_BACKGROUND } from '../../constants/assets';
import * as Google from 'expo-auth-session/providers/google';
import { useFocusEffect, useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  DeviceEventEmitter,
  Dimensions,
  ImageBackground,
  Keyboard,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  LOOP_OPTIONS,
  STD_DURATIONS,
  formatTimer,
  useTimer,
} from '../../contexts/timer-context';
import { useCurrentJapam } from '../../contexts/current-japam-context';
import { ResponseType } from 'expo-auth-session';
import { isIOSDeviceWeb, isStandaloneOrInstalledWeb } from '../../lib/pwaInstall';
import {
  signInAsGuest,
  getIsAnonymous,
  setIsAnonymous,
  signInOrLinkGoogle,
  showGoogleAccountCollisionDialog,
} from '../../lib/anonymousAuth';
import { supabase } from '../../lib/supabase';

WebBrowser.maybeCompleteAuthSession();

const { width: screenWidth, height: screenHeight } = Dimensions.get('window');
const isMobile = screenWidth < 768;
const isShortMobile = isMobile && screenHeight < 760;
// Native phones fill the real viewport via flexbox (see container/appShell)
// instead of the static captured screenHeight, and reserve the floating tab
// bar's true height (computed from safe-area insets) so the stats card always
// clears the bottom bar.
const isNativeMobile = isMobile && Platform.OS !== 'web';
const isWebMobile = Platform.OS === 'web' && isMobile;
const CIRCLE_SIZE = (isWebMobile && isShortMobile) ? 176 : isShortMobile ? 204 : isMobile ? 224 : 296;
const TEAL = '#0F8F87';
// Guest Mode is temporarily hidden — Google Sign-In is the only entry point for now. Flip this
// back to true to restore the "Continue as Guest" button; none of the underlying guest/anonymous
// auth code is removed, only this UI entry point is gated.
const GUEST_MODE_ENABLED = false;
const HISTORY_KEY = 'history';
const USER_ID_KEY = 'userId';
const USER_NAME_KEY = 'userName';
const USER_EMAIL_KEY = 'userEmail';
const AUTH_PENDING_KEY = 'authPending';

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

// Dedup by stable completionId only (no time-window collapse) so two legitimate malas completed
// close together are never merged. Drops only invalid/zero-count rows. See lib/historyStore.ts.
const dedupeHistoryForStats = (history: Session[]): Session[] =>
  dedupeByCompletionId(history).filter(
    (item) => item.totalCount > 0 && toLocalDayKey(item.date) !== 'unknown'
  );

// With Guest Mode hidden, a failed Google Sign-In leaves the user with no fallback into the app
// — silently re-showing the same sign-in modal gives no explanation. Alert.alert is not
// interactive in react-native-web (see the same caveat in tap-japam.tsx's handleResetCount), so
// this branches to window.alert on web, matching this codebase's existing pattern for
// cross-platform alerts.
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

export default function TimerScreen() {
  const router = useRouter();
  const timer = useTimer();
  const { currentJapam } = useCurrentJapam();
  const insets = useSafeAreaInsets();
  // Mirror the floating tab bar geometry from _layout.tsx exactly.
  // _layout.tsx uses screenWidth < 500 as its isMobile threshold (different from
  // this file's < 768), so we replicate that split to get the correct bottom offset
  // for every device width — phones vs phablets/tablets get different formulas.
  const tabBarLayoutIsMobile = screenWidth < 500;
  const tabBarSpaceFromBottom = 74 + (tabBarLayoutIsMobile
    ? Math.max(12, insets.bottom + 8)   // phone: matches nativeTabBarStyle bottom in _layout.tsx
    : Math.max(22, insets.bottom + 14)); // tablet: matches nativeTabBarStyle bottom in _layout.tsx
  const visibleMala = Math.min(
    Math.max(1, timer.completedLoops + (timer.isRunning || timer.isPaused ? 1 : 0)),
    timer.selectedLoops
  );
  const [showCustomInput, setShowCustomInput] = useState(false);
  const [customText, setCustomText] = useState('');
  const [userName, setUserName] = useState('');
  const [showUserModal, setShowUserModal] = useState(false);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [showGuestWarningModal, setShowGuestWarningModal] = useState(false);
  const [showGuestNameModal, setShowGuestNameModal] = useState(false);
  const [guestNameInput, setGuestNameInput] = useState('');
  const [showInstallBanner, setShowInstallBanner] = useState(false);
  const [showInstallHelp, setShowInstallHelp] = useState(false);
  const [malasToday, setMalasToday] = useState(0);
  const [todayCount, setTodayCount] = useState(0);
  const [dayStreak, setDayStreak] = useState(0);
  const deferredInstallPromptRef = useRef<any>(null);
  const isIosDeviceWeb = isIOSDeviceWeb();

  const rawNonceRef = useRef<string>('');
  const [hashedNonce, setHashedNonce] = useState<string>('');
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const arr = new Uint8Array(16);
    crypto.getRandomValues(arr);
    const raw = Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
    rawNonceRef.current = raw;
    console.log('[NONCE_GEN] timer raw_prefix=%s', raw.slice(0, 8));
    void crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw)).then((buf) => {
      const hashed = Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
      console.log('[NONCE_GEN] timer hashed_prefix=%s', hashed.slice(0, 8));
      setHashedNonce(hashed);
    });
  }, []);


  const [request, response, promptAsync] = Google.useAuthRequest({
    webClientId: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID || undefined,
    androidClientId: process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID,
    clientId: process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID,
    scopes: ['openid', 'profile', 'email'],
    redirectUri: Platform.OS === 'web' && typeof window !== 'undefined' ? window.location.origin : undefined,
    responseType: Platform.OS === 'web' ? ResponseType.IdToken : undefined,
    extraParams: Platform.OS === 'web' && hashedNonce ? { nonce: hashedNonce } : undefined,
  });

  const loadUser = useCallback(async () => {
    setUserName((await AsyncStorage.getItem(USER_NAME_KEY)) || '');
  }, []);

  const openSignInModal = useCallback(() => {
    setIsSigningIn(false);
    setShowUserModal(true);
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
    // Best-effort: creates a real Supabase anonymous user (auth.uid()) so this guest's identity
    // can later be linked to Google without losing data. On failure (offline, disabled), this
    // leaves USER_ID_KEY unset, identical to today's local-only guest fallback.
    await signInAsGuest();
    setUserName(name);
    setShowGuestNameModal(false);
    setShowUserModal(false);
    setGuestNameInput('');
    DeviceEventEmitter.emit('japam-auth-updated');
  }, [guestNameInput]);

  const loadStats = useCallback(async () => {
    const userId = await AsyncStorage.getItem(USER_ID_KEY);
    const todayKey = getLocalDateKey();
    const rawHistory = await AsyncStorage.getItem(HISTORY_KEY);
    const localHistory = parseHistory(rawHistory);
    let mergedHistory = localHistory;
    let rawSupabaseRows = 0;
    let rawSupabaseCount = 0;

    // Option A: anonymous guest data syncs to Supabase immediately, same as a signed-in user —
    // no anonymous-specific suppression here.
    if (userId) {
      const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
      const key = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
      if (url && key) {
        try {
          const encodedUserId = encodeURIComponent(userId);
          const res = await fetch(
            `${url}/rest/v1/japam_history?user_id=eq.${encodedUserId}&select=id,created_at,malas,count,user_name,completion_id&order=created_at.asc&limit=10000`,
            { headers: { apikey: key, Authorization: `Bearer ${key}` } }
          );
          if (res.ok) {
            const rows: {
              id?: number | string;
              created_at: string;
              malas: number | string;
              count: number | string;
              user_name?: string;
              completion_id?: string;
            }[] = await res.json();
            rawSupabaseRows = rows.length;
            const remoteHistory: Session[] = rows.map((row) => ({
              date: row.created_at,
              malas: Number(row.malas) || Math.floor((Number(row.count) || 0) / 108),
              totalCount: Number(row.count) || (Number(row.malas) || 0) * 108,
              duration: 0,
              manual: false,
              userId,
              userName: row.user_name,
              completionId: row.completion_id,
              syncStatus: 'synced' as const,
            }));
            rawSupabaseCount = remoteHistory.reduce(
              (sum, row) => sum + (Number(row.totalCount) || 0),
              0
            );
            mergedHistory = mergeHistories(localHistory, remoteHistory);
            const rawTombData = await AsyncStorage.getItem('deletedCompletions');
            if (rawTombData) {
              const tombIds = new Set<string>(JSON.parse(rawTombData) as string[]);
              if (tombIds.size > 0) {
                mergedHistory = mergedHistory.filter(
                  (item) => !tombIds.has(item.completionId ?? '')
                );
              }
            }
            const remoteCount = rows.length;
            const localSynced = localHistory.filter(
              (r) => r.userId === userId && r.syncStatus === 'synced'
            ).length;
            const localPending = localHistory.filter(
              (r) => r.userId === userId && r.syncStatus === 'pending'
            ).length;
            console.log(
              '[RECONCILE_PRE] screen=timer remote_count=%d local_synced=%d local_pending=%d',
              remoteCount, localSynced, localPending
            );
            const remoteIds = new Set(normalizeAll(remoteHistory).map((r) => r.completionId));
            if (remoteCount >= 10000) {
              console.log('[RECONCILE_SKIPPED] screen=timer reason=possible-truncation count=%d', remoteCount);
            } else {
              const before = mergedHistory.length;
              mergedHistory = mergedHistory.filter((r) =>
                !r.completionId || (r.userId || null) !== userId || r.syncStatus !== 'synced' || remoteIds.has(r.completionId)
              );
              console.log('[RECONCILE_APPLIED] screen=timer removed=%d', before - mergedHistory.length);
            }
            await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(mergedHistory));
            console.log('[RESTORE_REMOTE_COUNT] screen=timer count=%d', remoteHistory.length);
            console.log(
              '[MERGE_LOCAL_COUNT_BEFORE] screen=timer count=%d pending=%d',
              localHistory.length,
              localHistory.filter((item) => item.userId === userId && item.syncStatus === 'pending').length
            );
            console.log('[MERGE_LOCAL_COUNT_AFTER] screen=timer count=%d', mergedHistory.length);
          } else {
            console.log('[SYNC_FAILED] source=timer-stats-restore status=%d', res.status);
          }
        } catch {
          console.log('[SYNC_FAILED] source=timer-stats-restore reason=network');
        }
      }
    }

    const history = dedupeHistoryForStats(mergedHistory).filter((item) => {
      if (!userId) return !item.userId;
      return item.userId === userId;
    });

    const totalByDay = new Map<string, number>();
    history.forEach((item) => {
      const dayKey = toLocalDayKey(item.date);
      if (dayKey === 'unknown') return;
      const totalCount = Number(item.totalCount) || (Number(item.malas) || 0) * 108;
      if (totalCount <= 0) return;
      console.log('[LOCAL_DAY_BUCKET] screen=timer userLocalDate=%s recordCreatedAtISO=%s recordLocalDay=%s recordUTCDate=%s completion_id=%s source=%s user_id=%s',
        todayKey,
        item.date,
        dayKey,
        item.date?.slice(0, 10),
        item.completionId || '',
        item.source || '',
        item.userId || ''
      );
      totalByDay.set(dayKey, (totalByDay.get(dayKey) || 0) + totalCount);
    });

    const { totalCount: safeTodayTotal } = todayStatsFor(
      history,
      userId,
      todayKey,
      toLocalDayKey
    );
    if (safeTodayTotal > 0) totalByDay.set(todayKey, safeTodayTotal);

    const activeDays = new Set([...totalByDay.entries()].filter(([, total]) => total > 0).map(([day]) => day));
    let cursor = activeDays.has(todayKey) ? todayKey : getPreviousDateKey(todayKey);
    let nextStreak = 0;
    while (activeDays.has(cursor)) {
      nextStreak += 1;
      cursor = getPreviousDateKey(cursor);
    }

    setTodayCount(safeTodayTotal);
    setMalasToday(Math.floor(safeTodayTotal / 108));
    setDayStreak(nextStreak);
    console.log('[TimerStatsDate] deviceLocalTime=%s userLocalDate=%s rawSupabaseRows=%d rawSupabaseCount=%d dedupedCount=%d appMalasToday=%d todayTotal=%d streak=%d',
      new Date().toString(),
      todayKey,
      rawSupabaseRows,
      rawSupabaseCount,
      safeTodayTotal,
      Math.floor(safeTodayTotal / 108),
      safeTodayTotal,
      nextStreak
    );
  }, []);

  useFocusEffect(
    useCallback(() => {
      void loadUser();
      void loadStats();
    }, [loadStats, loadUser])
  );

  useEffect(() => {
    const refresh = () => void loadStats();
    const refreshAuth = () => void loadUser();
    const statsSub = DeviceEventEmitter.addListener('japam-stats-updated', refresh);
    const historySub = DeviceEventEmitter.addListener('japam-history-updated', refresh);
    const authSub = DeviceEventEmitter.addListener('japam-auth-updated', refreshAuth);
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      window.addEventListener('japam-stats-updated', refresh);
      window.addEventListener('japam-history-updated', refresh);
      window.addEventListener('japam-auth-updated', refreshAuth);
    }
    return () => {
      statsSub.remove();
      historySub.remove();
      authSub.remove();
      if (Platform.OS === 'web' && typeof window !== 'undefined') {
        window.removeEventListener('japam-stats-updated', refresh);
        window.removeEventListener('japam-history-updated', refresh);
        window.removeEventListener('japam-auth-updated', refreshAuth);
      }
    };
  }, [loadStats, loadUser]);

  useEffect(() => {
    if (Platform.OS !== 'web') {
      GoogleSignin.configure({
        webClientId: process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID,
      });
    }
  }, []);

  // Shared tail of native Google sign-in: stores the Google identity locally and (unless this was
  // a linkIdentity success, or the user chose to sign in anyway after a collision) migrates any
  // local guest-only history rows to this googleUserId — same storage steps as today, just
  // factored out so the collision dialog's "Sign In" button can reach them too.
  const finishGoogleSignIn = useCallback(async (
    googleName: string,
    googleEmail: string,
    googleUserId: string,
    skipMigration: boolean
  ) => {
    await AsyncStorage.setItem(USER_NAME_KEY, googleName);
    if (googleEmail) await AsyncStorage.setItem(USER_EMAIL_KEY, googleEmail);
    if (!skipMigration) {
      // Direct Google sign-in (no prior anonymous session): use the Supabase UUID that
      // signInWithIdToken / signInOrLinkGoogle just established, falling back to the Google
      // numeric ID only if the session is unexpectedly unavailable.
      const session = (await supabase.auth.getSession()).data.session;
      const userId = session?.user?.id ?? googleUserId;
      await migrateGuestHistoryToGoogle(userId);
      await AsyncStorage.setItem(USER_ID_KEY, userId);
    }
    // skipMigration=true means linkIdentity was used: USER_ID_KEY already holds the anonymous
    // Supabase UUID (set by signInAsGuest). Do not overwrite it with the Google numeric ID.
    setUserName(googleName);
    setShowUserModal(false);
    DeviceEventEmitter.emit('japam-auth-updated');
    DeviceEventEmitter.emit('japam-stats-updated');
    void loadStats();
  }, [loadStats, migrateGuestHistoryToGoogle]);

  const handleNativeGoogleSignIn = useCallback(async () => {
    console.log('SIGNIN PATH:', Platform.OS);
    console.log('Using native GoogleSignin');
    setIsSigningIn(true);
    setShowUserModal(false);
    try {
      await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
      const userInfo = await GoogleSignin.signIn();
      const rawUserInfo = userInfo as any;
      console.log('Native Google sign-in result type:', rawUserInfo?.type || 'raw-user');
      const googleUser =
        rawUserInfo?.type
          ? rawUserInfo.type === 'success'
            ? rawUserInfo.data?.user
            : null
          : rawUserInfo?.user;

      if (!googleUser) {
        console.log('Native Google sign-in did not return a user.');
        setIsSigningIn(false);
        setShowUserModal(true);
        showGoogleSignInRequiredAlert();
        return;
      }
      const { id, name, givenName, email } = googleUser;
      const idToken = rawUserInfo?.data?.idToken as string | null | undefined;
      const googleName = givenName || name || email || 'User';
      const googleEmail = email || '';
      const googleUserId = String(id).trim();

      if (!googleUserId) {
        setIsSigningIn(false);
        setShowUserModal(true);
        showGoogleSignInRequiredAlert();
        return;
      }

      let skipMigration = false;

      if (idToken) {
        const isAnonymous = await getIsAnonymous();
        const result = await signInOrLinkGoogle(idToken, isAnonymous);

        if (result.kind === 'collision') {
          // Approved UX (no merge, no silent failure): "Sign In" completes a normal direct
          // sign-in into the existing linked account, abandoning this device's anonymous
          // history; "Cancel" leaves the current anonymous session untouched.
          showGoogleAccountCollisionDialog(
            () => { void finishGoogleSignIn(googleName, googleEmail, googleUserId, true); },
            () => { /* leave the current anonymous session untouched */ }
          );
          return;
        }

        if (result.kind === 'error') {
          console.log('signInOrLinkGoogle error:', result.error);
          // Preserve today's tolerant behavior: a Supabase auth error was always discarded and
          // never blocked sign-in, so fall through and store the Google identity locally anyway.
        }

        if (result.kind === 'linked') {
          skipMigration = true;
          await setIsAnonymous(false);
        }
      }

      await finishGoogleSignIn(googleName, googleEmail, googleUserId, skipMigration);
    } catch (error) {
      console.log('Native Google sign-in error:', error);
      setShowUserModal(true);
      showGoogleSignInRequiredAlert();
    } finally {
      setIsSigningIn(false);
    }
  }, [finishGoogleSignIn]);

  useEffect(() => {
    const signInSub = DeviceEventEmitter.addListener('japam-start-google-signin', () => void handleNativeGoogleSignIn());
    return () => signInSub.remove();
  }, [handleNativeGoogleSignIn]);

  useEffect(() => {
    const handleGoogleLogin = async () => {
      if (Platform.OS !== 'web') return; // native platforms use handleNativeGoogleSignIn
      if (!response) return;

      console.log('[AUTH_CALLBACK] source=timer-web response.type=%s', response.type);
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

      console.log('[AUTH_CALLBACK] source=timer-web hasIdToken=%s hasAccessToken=%s paramKeys=%s',
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
          console.log('[SUPABASE_AUTH] timer nonce_prefix=%s', rawNonceRef.current.slice(0, 8));
          const { error: supaAuthError } = await supabase.auth.signInWithIdToken({
            provider: 'google',
            token: idToken,
            nonce: rawNonceRef.current,
          });
          if (supaAuthError) console.log('[SUPABASE_AUTH] timer signInWithIdToken error:', supaAuthError.message);
          else console.log('[SUPABASE_AUTH] timer web session established');
        } else {
          console.log('[SUPABASE_AUTH] timer no id_token — session not established');
        }

        const session = (await supabase.auth.getSession()).data.session;
        const sessionIsAnonymous =
          !!((session?.user as { is_anonymous?: boolean } | undefined)?.is_anonymous);
        console.log(
          '[SUPABASE_AUTH] timer session.user.id=%s session.user.email=%s hasAccessToken=%s tokenLength=%s isAnonymous=%s',
          session?.user?.id || 'none',
          session?.user?.email || 'none',
          !!session?.access_token,
          session?.access_token?.length || 0,
          sessionIsAnonymous
        );
        if (!session?.access_token || sessionIsAnonymous) {
          console.log('[SUPABASE_AUTH] timer missing non-anonymous Supabase session after Google login');
          setShowUserModal(true);
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
        await AsyncStorage.setItem(USER_NAME_KEY, googleName);
        if (googleEmail) {
          await AsyncStorage.setItem(USER_EMAIL_KEY, googleEmail);
        }
        await migrateGuestHistoryToGoogle(userId);
        await AsyncStorage.setItem(USER_ID_KEY, userId);
        setUserName(googleName);
        setShowUserModal(false);
        DeviceEventEmitter.emit('japam-auth-updated');
        DeviceEventEmitter.emit('japam-stats-updated');
        if (Platform.OS === 'web' && typeof window !== 'undefined') {
          window.dispatchEvent(new Event('japam-auth-updated'));
          window.dispatchEvent(new Event('japam-stats-updated'));
        }
        void loadStats();
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
  }, [loadStats, response]);

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;

    const isStandalone =
      window.matchMedia?.('(display-mode: standalone)').matches ||
      (window.navigator as any).standalone === true;
    const isInstalled = isStandaloneOrInstalledWeb();
    if (isInstalled) {
      setShowInstallBanner(false);
      setShowInstallHelp(false);
      return;
    }
    if (isIosDeviceWeb) {
      setShowInstallBanner(true);
      setShowInstallHelp(true);
      return;
    }

    if (!isStandalone) {
      setShowInstallBanner(true);
    }

    const onBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      if (isIosDeviceWeb) return;
      deferredInstallPromptRef.current = event;
      setShowInstallHelp(false);
      setShowInstallBanner(true);
    };

    const onAppInstalled = () => {
      deferredInstallPromptRef.current = null;
      setShowInstallBanner(false);
      setShowInstallHelp(false);
    };

    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    window.addEventListener('appinstalled', onAppInstalled);

    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
      window.removeEventListener('appinstalled', onAppInstalled);
    };
  }, [isIosDeviceWeb]);

  const handleStart = () => {
    if (!timer.canStart) {
      openSignInModal();
      return;
    }
    timer.start();
  };

  const handleDurationSelect = (mins: number) => {
    timer.selectDuration(mins);
    setShowCustomInput(false);
  };

  const handleCustomSet = () => {
    const mins = parseInt(customText, 10);
    if (!mins || mins < 1 || mins > 180) return;
    timer.selectDuration(mins);
    setShowCustomInput(false);
    setCustomText('');
    Keyboard.dismiss();
  };

  const handleAccountPress = () => {
    if (!userName) {
      openSignInModal();
      return;
    }

    router.push('/settings' as never);
  };

  const handleInstallNow = async () => {
    const prompt = deferredInstallPromptRef.current;
    if (!prompt || typeof prompt.prompt !== 'function') {
      setShowInstallHelp(true);
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

  const todayLabel = new Date().toLocaleDateString();

  return (
    <View style={styles.root}>
      <ScrollView
        style={[
          styles.scroll,
          Platform.OS !== 'web' && { marginBottom: tabBarSpaceFromBottom },
        ]}
        contentContainerStyle={[
          styles.container,
          isNativeMobile && { minHeight: undefined },
        ]}
        onLayout={undefined}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <View
          style={[
            styles.appShell,
            // paddingBottom: 16 provides a small visual gap below the stats cards.
            // The large tabBarSpaceFromBottom padding is no longer needed here because
            // the ScrollView's own marginBottom already ends at the tab bar top.
            isNativeMobile && { flexGrow: 1, minHeight: undefined, paddingBottom: 16 },
            Platform.OS === 'web' && isMobile && { paddingBottom: 16 },
          ]}
        >
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

          <View style={styles.topControls}>
            <Pressable
              style={({ pressed }) => [styles.currentJapamButton, pressed && styles.softPressed]}
              onPress={() => router.push('/my-japams')}
              accessibilityRole="button"
              accessibilityLabel={
                currentJapam ? `Current Japam: ${currentJapam.name}. Tap to switch.` : 'Open My Japams'
              }
            >
              <Text numberOfLines={1} style={styles.currentJapamText}>
                {currentJapam ? `${currentJapam.name} ▾` : 'My Japams'}
              </Text>
            </Pressable>
            <Text numberOfLines={1} style={styles.welcomeText}>Welcome</Text>
            <Pressable
              style={({ pressed }) => [styles.accountButton, pressed && styles.softPressed]}
              onPress={handleAccountPress}
            >
              <Text numberOfLines={1} style={styles.accountNameText}>
                {userName || 'Sign in'}
              </Text>
            </Pressable>
          </View>

          <Text style={styles.dateText}>Today · {todayLabel}</Text>
          <Text style={styles.subtitle}>Pick a duration, set loops, breathe.</Text>

      {showInstallBanner && !isStandaloneOrInstalledWeb() && (
            <View style={styles.installBanner}>
              <Text style={styles.installBannerTitle}>
                {isIosDeviceWeb ? 'Add to Home Screen' : 'Install this app for a better experience'}
              </Text>
              {isIosDeviceWeb ? (
                <Text style={styles.installBannerHelp}>Use Share → Add to Home Screen.</Text>
              ) : showInstallHelp ? (
                <Text style={styles.installBannerHelp}>Tap browser menu ⋮ → Add to Home screen</Text>
              ) : null}
              <View style={styles.installBannerActions}>
                {!isIosDeviceWeb && (
                  <Pressable style={styles.installBannerPrimary} onPress={() => void handleInstallNow()}>
                    <Text style={styles.installBannerPrimaryText}>Install Now</Text>
                  </Pressable>
                )}
                <Pressable style={styles.installBannerSecondary} onPress={() => setShowInstallBanner(false)}>
                  <Text style={styles.installBannerSecondaryText}>Later</Text>
                </Pressable>
              </View>
            </View>
          )}

          <View style={styles.circleWrap}>
            <View style={styles.circleOuter}>
              <View style={styles.circleInner}>
                <Text style={styles.timerText}>{formatTimer(timer.timeLeft)}</Text>
                <Text style={styles.malaText}>Mala {visibleMala} / {timer.selectedLoops}</Text>
              </View>
            </View>
          </View>

          <View style={styles.controls}>
            <Pressable
              style={({ pressed }) => [styles.startBtn, pressed && styles.softPressed]}
              onPress={timer.isRunning ? timer.pause : handleStart}
            >
              <Ionicons name={timer.isRunning ? 'pause' : 'play'} size={20} color="#fff" style={{ marginRight: 8 }} />
              <Text style={styles.startBtnText}>
                {timer.isRunning ? 'Pause' : timer.isPaused ? 'Resume' : 'Start'}
              </Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [styles.resetBtn, pressed && { opacity: 0.65 }]}
              onPress={timer.reset}
            >
              <Ionicons name="refresh-outline" size={22} color={TEAL} />
            </Pressable>
          </View>

          {isIosDeviceWeb && timer.isRunning && (
            <Text style={styles.iosWakeTip}>
              For long sessions, keep screen open or set Auto-Lock to Never in Settings.
            </Text>
          )}

          <View style={styles.card}>
            <Text style={styles.cardLabel}>Select Japam Time (minutes)</Text>
            <View style={styles.chips}>
              {STD_DURATIONS.map((d) => (
                <Pressable
                  key={d}
                  style={[
                    styles.chip,
                    timer.selectedDuration === d && !timer.isCustomDuration && styles.chipActive,
                    timer.isRunning && styles.chipDisabled,
                  ]}
                  onPress={() => handleDurationSelect(d)}
                >
                  <Text style={[
                    styles.chipText,
                    timer.selectedDuration === d && !timer.isCustomDuration && styles.chipTextActive,
                  ]}>
                    {d}m
                  </Text>
                </Pressable>
              ))}
              <Pressable
                style={[
                  styles.chip,
                  timer.isCustomDuration && styles.chipActive,
                  timer.isRunning && styles.chipDisabled,
                ]}
                onPress={() => {
                  if (!timer.isRunning) setShowCustomInput(!showCustomInput);
                }}
              >
                <Text style={[styles.chipText, timer.isCustomDuration && styles.chipTextActive]}>
                  {timer.isCustomDuration ? `${timer.selectedDuration}m` : 'Custom'}
                </Text>
              </Pressable>
            </View>

            {showCustomInput && !timer.isRunning && (
              <View style={styles.customRow}>
                <TextInput
                  style={styles.customInput}
                  value={customText}
                  onChangeText={setCustomText}
                  placeholder="Enter minutes"
                  placeholderTextColor="#7f9ea0"
                  keyboardType="numeric"
                  returnKeyType="done"
                  onSubmitEditing={handleCustomSet}
                  autoFocus
                />
                <Pressable style={styles.customSetBtn} onPress={handleCustomSet}>
                  <Text style={styles.customSetText}>Set</Text>
                </Pressable>
              </View>
            )}

            <Text style={[styles.cardLabel, { marginTop: (isWebMobile && isShortMobile) ? 8 : isShortMobile ? 12 : isMobile ? 10 : 22 }]}>Auto-Repeat Malas</Text>
            <View style={styles.chips}>
              {LOOP_OPTIONS.map((l) => (
                <Pressable
                  key={l}
                  style={[
                    styles.chip,
                    timer.selectedLoops === l && styles.chipActive,
                    timer.isRunning && styles.chipDisabled,
                  ]}
                  onPress={() => timer.selectLoops(l)}
                >
                  <Text style={[styles.chipText, timer.selectedLoops === l && styles.chipTextActive]}>{l}</Text>
                </Pressable>
              ))}
            </View>
          </View>

          <View style={styles.statsGrid}>
            <View style={styles.statCard}>
              <Text style={styles.statValue}>{malasToday}</Text>
              <Text style={styles.statLabel}>Malas Today</Text>
            </View>
            <View style={styles.statCard}>
              <Text style={styles.statValue}>{todayCount}</Text>
              <Text style={styles.statLabel}>Today Count</Text>
            </View>
            <View style={styles.statCard}>
              <Text style={styles.statValue}>{dayStreak}</Text>
              <Text style={styles.statLabel}>Day Streak</Text>
            </View>
          </View>
        </View>

        <Modal
          visible={showUserModal && !isSigningIn}
          transparent
          animationType="fade"
          onRequestClose={() => setShowUserModal(false)}
        >
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
                style={[styles.modalButton, (Platform.OS === 'web' && !request) && styles.disabledButton]}
                onPress={() => {
                  if (Platform.OS !== 'web') {
                    void handleNativeGoogleSignIn();
                  } else {
                    console.log('SIGNIN PATH:', Platform.OS);
                    console.log('Using web promptAsync');
                    setIsSigningIn(true);
                    setShowUserModal(false);
                    void (async () => {
                      try {
                        await AsyncStorage.setItem(AUTH_PENDING_KEY, String(Date.now()));
                        const result = await promptAsync({ showInRecents: true });
                        if (result.type !== 'success') {
                          await AsyncStorage.removeItem(AUTH_PENDING_KEY);
                          setIsSigningIn(false);
                          setShowUserModal(true);
                          showGoogleSignInRequiredAlert();
                        }
                      } catch (error) {
                        console.log('Google prompt error:', error);
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

        <Modal
          visible={showGuestWarningModal}
          transparent
          animationType="fade"
          onRequestClose={() => setShowGuestWarningModal(false)}
        >
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

        <Modal
          visible={showGuestNameModal}
          transparent
          animationType="fade"
          onRequestClose={() => setShowGuestNameModal(false)}
        >
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

    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#edf7f4',
  },
  scroll: {
    flex: 1,
    backgroundColor: 'transparent',
  },
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
    backgroundColor: 'rgba(245, 250, 250, 0.28)',
  },
  container: {
    flexGrow: 1,
    justifyContent: isMobile ? 'flex-start' : 'center',
    width: '100%',
    alignSelf: 'center',
    paddingHorizontal: isMobile ? 0 : 24,
    alignItems: 'center',
    minHeight: screenHeight,
  },
  appShell: {
    width: '100%',
    maxWidth: isMobile ? undefined : 460,
    minHeight: isMobile
      ? (Platform.OS === 'web' ? ('100%' as any) : screenHeight)
      : Math.min(screenHeight - 48, 900),
    alignItems: 'center',
    overflow: 'hidden',
    position: 'relative',
    backgroundColor: 'rgba(238, 248, 246, 0.94)',
    borderRadius: isMobile ? 0 : 28,
    paddingHorizontal: isMobile ? 22 : 28,
    paddingTop: Platform.OS === 'web'
      ? (isMobile
          ? (isShortMobile
              ? ('calc(26px + env(safe-area-inset-top))' as any)
              : ('calc(32px + env(safe-area-inset-top))' as any))
          : 58)
      : (isShortMobile ? 24 : isMobile ? 28 : 58),
    paddingBottom: 112,
    shadowColor: '#0f766e',
    shadowOpacity: isMobile ? 0 : 0.16,
    shadowRadius: 28,
    shadowOffset: { width: 0, height: 16 },
    elevation: isMobile ? 0 : 12,
  },
  topControls: {
    width: '100%',
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: isShortMobile ? 8 : isMobile ? 8 : 18,
    gap: 10,
  },
  currentJapamButton: {
    flex: 1,
    minHeight: 40,
    minWidth: 74,
    maxWidth: 128,
    paddingHorizontal: 14,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.78)',
    borderWidth: 1,
    borderColor: 'rgba(15,143,135,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#0f8f87',
    shadowOpacity: 0.08,
    shadowRadius: 16,
    elevation: 4,
  },
  currentJapamText: {
    color: '#063B3B',
    fontSize: isMobile ? 14 : 15,
    fontWeight: '900',
  },
  welcomeText: {
    flex: 2,
    color: '#063B3B',
    fontSize: isShortMobile ? 20 : isMobile ? 22 : 24,
    fontWeight: '800',
    letterSpacing: 0,
    textAlign: 'center',
  },
  accountButton: {
    flex: 1,
    minHeight: 40,
    minWidth: 74,
    maxWidth: 128,
    paddingHorizontal: 14,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.78)',
    borderWidth: 1,
    borderColor: 'rgba(15,143,135,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#0f8f87',
    shadowOpacity: 0.08,
    shadowRadius: 16,
    elevation: 4,
  },
  accountNameText: {
    color: '#063B3B',
    fontSize: isMobile ? 14 : 15,
    fontWeight: '900',
  },
  softPressed: {
    transform: [{ scale: 0.96 }],
    opacity: 0.86,
    ...(Platform.OS === 'web'
      ? ({ transition: 'transform 180ms ease, opacity 180ms ease' } as any)
      : {}),
  },
  dateText: {
    color: '#5F7F80',
    fontSize: isShortMobile ? 13 : isMobile ? 14 : 15,
    fontWeight: '700',
    marginBottom: isShortMobile ? 8 : isMobile ? 10 : 14,
  },
  subtitle: {
    fontSize: isShortMobile ? 14 : isMobile ? 16 : 18,
    color: '#4a7c80',
    textAlign: 'center',
    fontWeight: '700',
    marginBottom: (isWebMobile && isShortMobile) ? 6 : isShortMobile ? 12 : isMobile ? 10 : 26,
  },
  circleWrap: { marginBottom: (isWebMobile && isShortMobile) ? 8 : isShortMobile ? 14 : isMobile ? 12 : 32 },
  circleOuter: {
    width: CIRCLE_SIZE,
    height: CIRCLE_SIZE,
    borderRadius: CIRCLE_SIZE / 2,
    backgroundColor: 'rgba(255,255,255,0.80)',
    borderWidth: isMobile ? 12 : 18,
    borderColor: 'rgba(15,143,135,0.18)',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#0F8F87',
    shadowOpacity: 0.16,
    shadowRadius: 32,
    shadowOffset: { width: 0, height: 8 },
    elevation: 12,
  },
  circleInner: { alignItems: 'center' },
  timerText: {
    fontSize: (isWebMobile && isShortMobile) ? 38 : isShortMobile ? 44 : isMobile ? 50 : 72,
    fontWeight: '800',
    color: TEAL,
    letterSpacing: -2,
  },
  malaText: {
    fontSize: isMobile ? 13 : 14,
    color: '#4a7c80',
    marginTop: isMobile ? 6 : 10,
    fontWeight: '500',
  },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: isMobile ? 10 : 14,
    marginBottom: (isWebMobile && isShortMobile) ? 8 : isShortMobile ? 12 : isMobile ? 10 : 28,
  },
  startBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: TEAL,
    paddingVertical: isShortMobile ? 12 : isMobile ? 13 : 15,
    paddingHorizontal: isShortMobile ? 28 : isMobile ? 32 : 40,
    borderRadius: 50,
    shadowColor: TEAL,
    shadowOpacity: 0.38,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 5 },
    elevation: 10,
  },
  startBtnText: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '800',
  },
  resetBtn: {
    width: isMobile ? 48 : 50,
    height: isMobile ? 48 : 50,
    borderRadius: isMobile ? 24 : 25,
    borderWidth: 2,
    borderColor: TEAL,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.82)',
  },
  card: {
    width: '100%',
    maxWidth: 460,
    backgroundColor: 'rgba(255,255,255,0.86)',
    borderRadius: 22,
    paddingVertical: (isWebMobile && isShortMobile) ? 9 : isShortMobile ? 13 : isMobile ? 11 : 22,
    paddingHorizontal: isShortMobile ? 13 : isMobile ? 15 : 22,
    shadowColor: '#0a3a3c',
    shadowOpacity: 0.07,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 4 },
    elevation: 5,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.9)',
  },
  statsGrid: {
    width: '100%',
    maxWidth: 460,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 9,
    marginTop: (isWebMobile && isShortMobile) ? 8 : isShortMobile ? 12 : isMobile ? 8 : 22,
    marginBottom: isMobile ? 6 : 0,
  },
  statCard: {
    flexGrow: 1,
    flexBasis: '30%',
    minHeight: (isWebMobile && isShortMobile) ? 68 : isShortMobile ? 88 : isMobile ? 96 : 104,
    backgroundColor: 'rgba(255,255,255,0.94)',
    borderRadius: 18,
    paddingVertical: (isWebMobile && isShortMobile) ? 8 : isShortMobile ? 12 : isMobile ? 14 : 16,
    paddingHorizontal: isShortMobile ? 8 : 10,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(15,143,135,0.24)',
    shadowColor: '#0a3a3c',
    shadowOpacity: 0.1,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
    elevation: 5,
  },
  statValue: {
    color: '#063B3B',
    fontSize: isShortMobile ? 26 : isMobile ? 29 : 32,
    fontWeight: '900',
    lineHeight: isShortMobile ? 31 : isMobile ? 35 : 38,
  },
  statLabel: {
    color: '#234E52',
    fontSize: isShortMobile ? 12 : isMobile ? 13 : 14,
    fontWeight: '800',
    lineHeight: isShortMobile ? 15 : 17,
    marginTop: 5,
    textAlign: 'center',
  },
  installBanner: {
    width: '100%',
    maxWidth: 380,
    alignSelf: 'center',
    marginTop: isShortMobile ? 0 : 4,
    marginBottom: isShortMobile ? 12 : 16,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.82)',
    borderWidth: 1,
    borderColor: 'rgba(15,118,110,0.14)',
    padding: 13,
    shadowColor: '#0f766e',
    shadowOpacity: 0.08,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 5,
  },
  installBannerTitle: {
    color: '#063B3B',
    fontSize: 14,
    fontWeight: '800',
    textAlign: 'center',
    lineHeight: 20,
  },
  installBannerHelp: {
    color: '#5F7F80',
    fontSize: 13,
    fontWeight: '700',
    textAlign: 'center',
    marginTop: 6,
    lineHeight: 18,
  },
  iosWakeTip: {
    color: '#5F7F80',
    fontSize: 12,
    textAlign: 'center',
    marginTop: 8,
    marginBottom: 2,
    paddingHorizontal: 16,
    lineHeight: 17,
  },
  installBannerActions: {
    flexDirection: 'row',
    gap: 10,
    justifyContent: 'center',
    marginTop: 11,
  },
  installBannerPrimary: {
    flex: 1,
    minHeight: 42,
    borderRadius: 999,
    backgroundColor: TEAL,
    alignItems: 'center',
    justifyContent: 'center',
  },
  installBannerPrimaryText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '900',
  },
  installBannerSecondary: {
    flex: 1,
    minHeight: 42,
    borderRadius: 999,
    backgroundColor: 'rgba(95,127,128,0.1)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  installBannerSecondaryText: {
    color: '#063B3B',
    fontSize: 14,
    fontWeight: '800',
  },
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
  modalTitle: {
    color: '#12383c',
    fontSize: 26,
    fontWeight: '900',
    marginBottom: 10,
    textAlign: 'center',
  },
  modalSubtitle: {
    color: '#365f61',
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'center',
    marginBottom: 22,
  },
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
  modalFootnote: {
    color: '#547071',
    fontSize: 12,
    lineHeight: 17,
    textAlign: 'center',
    marginTop: 14,
  },
  modalClose: { position: 'absolute', right: 14, top: 10, zIndex: 10 },
  modalCloseText: { color: '#547071', fontSize: 28, fontWeight: '800' },
  cardLabel: {
    fontSize: 13,
    fontWeight: '800',
    color: '#4a8c90',
    letterSpacing: 1.0,
    textTransform: 'uppercase',
    marginBottom: (isWebMobile && isShortMobile) ? 6 : isMobile ? 8 : 14,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: isMobile ? 9 : 10,
    justifyContent: 'center',
  },
  chip: {
    paddingVertical: (isWebMobile && isShortMobile) ? 6 : isShortMobile ? 7 : isMobile ? 8 : 9,
    paddingHorizontal: isShortMobile ? 13 : isMobile ? 15 : 18,
    borderRadius: 50,
    borderWidth: 1.5,
    borderColor: 'rgba(15,143,135,0.36)',
    backgroundColor: 'rgba(255,255,255,0.94)',
  },
  chipActive: {
    backgroundColor: TEAL,
    borderColor: TEAL,
    shadowColor: TEAL,
    shadowOpacity: 0.18,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 4,
  },
  chipDisabled: {
    opacity: 0.45,
  },
  chipText: {
    fontSize: isMobile ? 15 : 15,
    fontWeight: '800',
    color: '#12383c',
  },
  chipTextActive: {
    color: '#fff',
    fontWeight: '900',
  },
  customRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 10,
    gap: 8,
  },
  customInput: {
    flex: 1,
    height: isMobile ? 40 : 44,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: 'rgba(15,143,135,0.35)',
    paddingHorizontal: 14,
    fontSize: 15,
    color: '#12383c',
    backgroundColor: 'rgba(255,255,255,0.9)',
  },
  customSetBtn: {
    backgroundColor: TEAL,
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: 12,
  },
  customSetText: {
    color: '#fff',
    fontWeight: '800',
    fontSize: 14,
  },
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
