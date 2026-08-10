import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { GoogleSignin } from '@react-native-google-signin/google-signin';
import {
  dedupeByCompletionId,
  japamScopedStatsFor,
  mergeHistories,
  toLocalDayKey,
} from '../../lib/historyStore';
import { activeJapams } from '../../lib/japams';
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
import CurrentJapamHeaderButton from '../../components/CurrentJapamHeaderButton';
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
import { fetchJapamHistoryRows } from '../../lib/supabaseRestHelper';
import { claimAuthResponse, emitJapamAuthUpdated } from '../../lib/authEvents';

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
const TEAL = '#70885A';
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
  const { currentJapam, japams, isLoading: isJapamContextLoading } = useCurrentJapam();
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
  const isRestoringRef = useRef(false);
  const [hashedNonce, setHashedNonce] = useState<string>('');
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const arr = new Uint8Array(16);
    crypto.getRandomValues(arr);
    const raw = Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
    rawNonceRef.current = raw;
    void crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw)).then((buf) => {
      const hashed = Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
      setHashedNonce(hashed);
    });
  }, []);


  const [request, response, promptAsync] = Google.useAuthRequest({
    webClientId: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID || undefined,
    androidClientId: process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID,
    clientId:
      process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID ||
      process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID ||
      process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID,
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
    emitJapamAuthUpdated();
  }, [guestNameInput]);

  const loadStats = useCallback(async () => {
    if (isRestoringRef.current) return;
    isRestoringRef.current = true;
    try {
    const userId = await AsyncStorage.getItem(USER_ID_KEY);
    const todayKey = getLocalDateKey();
    const rawHistory = await AsyncStorage.getItem(HISTORY_KEY);
    const localHistory = parseHistory(rawHistory);
    let mergedHistory = localHistory;

    // Option A: anonymous guest data syncs to Supabase immediately, same as a signed-in user —
    // no anonymous-specific suppression here.
    if (userId) {
        try {
          const remoteRows = await fetchJapamHistoryRows({
            select: 'id,created_at,malas,count,user_name,completion_id,japam_id,japam_name',
            userId,
            order: { column: 'created_at', ascending: true },
            limit: 10000,
          });

          if (remoteRows !== null) {
            const remoteHistory: Session[] = remoteRows.map((row: any) => ({
              date: row.created_at,
              malas: Number(row.malas) || Math.floor((Number(row.count) || 0) / 108),
              totalCount: Number(row.count) || (Number(row.malas) || 0) * 108,
              duration: 0,
              manual: false,
              userId,
              userName: row.user_name,
              completionId: row.completion_id,
              syncStatus: 'synced' as const,
              japamId: row.japam_id ?? null,
              japamName: row.japam_name ?? null,
            }));
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
          }
        } catch {
          console.log('[SYNC_FAILED] source=timer-stats-restore reason=network');
        }
      }

    const history = dedupeHistoryForStats(mergedHistory).filter((item) => {
      if (!userId) return !item.userId;
      return item.userId === userId;
    });

    // Scoped to the currently selected Japam only -- Home/Timer must never show a combined total
    // across every Japam (product requirement: Home/Timer/Tap Japam always reflect the selected
    // Japam, matching History/My Japams). Routed through japamScopedStatsFor, which uses the SAME
    // filterByJapam selector History uses (dedupe + strict japamId match + legacy null/name
    // fallback) so Timer and History can never disagree on which records belong to the selected
    // Japam -- including null-japamId legacy records that match the selected Japam's name.
    const japamId = currentJapam?.id ?? null;
    const includeBlankLegacy = japamId === activeJapams(japams)[0]?.id;
    const scopedStats = japamScopedStatsFor(
      history,
      userId,
      japamId,
      currentJapam?.name ?? null,
      todayKey,
      toLocalDayKey,
      getPreviousDateKey,
      { includeBlankLegacy },
      // Pass the live Japam list so legacy-name attribution is ambiguity-safe and identical to
      // My Japams' statsByJapamWithAttribution (shared rule).
      japams,
    );
    const safeTodayTotal = scopedStats.todayTotalCount;
    const nextStreak = scopedStats.dayStreak;

    setTodayCount(safeTodayTotal);
    setMalasToday(scopedStats.todayMalas);
    setDayStreak(nextStreak);
  } finally {
    isRestoringRef.current = false;
  }
  }, [currentJapam, japams]);

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
        webClientId:
          process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID ||
          process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID,
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
    const session = (await supabase.auth.getSession()).data.session;
    const sessionUserId = session?.user?.id;
    const hasValidSession =
      !!session?.access_token &&
      !!session.refresh_token &&
      !!sessionUserId &&
      (!session.user.is_anonymous || skipMigration);

    if (!hasValidSession) {
      setShowUserModal(true);
      showGoogleSignInRequiredAlert();
      return;
    }

    await AsyncStorage.setItem(USER_NAME_KEY, googleName);
    if (googleEmail) await AsyncStorage.setItem(USER_EMAIL_KEY, googleEmail);
    if (!skipMigration) {
      // Direct Google sign-in (no prior anonymous session) uses only the Supabase UUID that
      // signInWithIdToken / signInOrLinkGoogle established.
      const userId = sessionUserId!;
      await migrateGuestHistoryToGoogle(userId);
      await AsyncStorage.setItem(USER_ID_KEY, userId);
    }
    // skipMigration=true means linkIdentity was used: USER_ID_KEY already holds the anonymous
    // Supabase UUID (set by signInAsGuest). Do not overwrite it with the Google numeric ID.
    setUserName(googleName);
    setShowUserModal(false);
    emitJapamAuthUpdated();
    DeviceEventEmitter.emit('japam-stats-updated');
    void loadStats();
  }, [loadStats, migrateGuestHistoryToGoogle]);

  const handleNativeGoogleSignIn = useCallback(async () => {
    setIsSigningIn(true);
    setShowUserModal(false);
    try {
      await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
      const userInfo = await GoogleSignin.signIn();
      const rawUserInfo = userInfo as any;
      const googleUser =
        rawUserInfo?.type
          ? rawUserInfo.type === 'success'
            ? rawUserInfo.data?.user
            : null
          : rawUserInfo?.user;

      if (!googleUser) {
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
          setShowUserModal(true);
          showGoogleSignInRequiredAlert();
          return;
        }

        if (result.kind === 'linked') {
          skipMigration = true;
          await setIsAnonymous(false);
        }
      }

      await finishGoogleSignIn(googleName, googleEmail, googleUserId, skipMigration);
    } catch (error) {
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

  const handledWebAuthResponseRef = useRef<NonNullable<typeof response> | null>(null);

  useEffect(() => {
    const handleGoogleLogin = async () => {
      if (Platform.OS !== 'web') return; // native platforms use handleNativeGoogleSignIn
      if (!claimAuthResponse(handledWebAuthResponseRef, response)) return;

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

      if (!accessToken && !idToken) {
        await AsyncStorage.removeItem(AUTH_PENDING_KEY);
        setIsSigningIn(false);
        setShowUserModal(true);
        showGoogleSignInRequiredAlert();
        return;
      }

      try {
        if (idToken) {
          await supabase.auth.signInWithIdToken({
            provider: 'google',
            token: idToken,
            nonce: rawNonceRef.current,
          });
        }

        const session = (await supabase.auth.getSession()).data.session;
        const sessionIsAnonymous =
          !!((session?.user as { is_anonymous?: boolean } | undefined)?.is_anonymous);
        if (!session?.access_token || sessionIsAnonymous) {
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
        emitJapamAuthUpdated();
        DeviceEventEmitter.emit('japam-stats-updated');
        if (Platform.OS === 'web' && typeof window !== 'undefined') {
          window.dispatchEvent(new Event('japam-stats-updated'));
        }
        void loadStats();
      } catch (error) {
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
    if (isJapamContextLoading || !currentJapam?.id || !currentJapam?.name) {
      Alert.alert('Please wait', 'Your current Japam is still loading. Please try again in a moment.');
      return;
    }
    // Snapshot whichever Japam is current AT THIS EXACT MOMENT, once, before starting. Switching
    // the app's current Japam later must never retroactively change what this running session's
    // eventual completion is attributed to -- see setActiveJapamSelection in timer-context.tsx.
    timer.setActiveJapamSelection(currentJapam?.id ?? null, currentJapam?.name ?? null);
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
            <CurrentJapamHeaderButton variant="timer" />
            <View style={styles.brandBlock}>
              <Text style={styles.brandMark}>ॐ</Text>
              <Text numberOfLines={1} style={styles.welcomeText}>Sage Serenity</Text>
            </View>
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
          <Text style={styles.subtitle}>Simple. Sacred. Centered.</Text>

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

          <View style={styles.repeatCard}>
            <View style={styles.repeatHeader}>
              <View style={styles.repeatIconWrap}>
                <Ionicons name="repeat-outline" size={22} color={TEAL} />
              </View>
              <View style={styles.repeatCopy}>
                <Text style={styles.repeatTitle}>Repeat malas</Text>
                <Text style={styles.repeatSubtitle}>
                  {timer.selectedLoops === 1 ? 'One mala' : `${timer.selectedLoops} malas in this session`}
                </Text>
              </View>
              <Text style={styles.repeatValue}>{timer.selectedLoops}</Text>
            </View>
            <View style={styles.repeatOptions}>
              {LOOP_OPTIONS.map((l) => (
                <Pressable
                  key={l}
                  style={[
                    styles.repeatOption,
                    timer.selectedLoops === l && styles.repeatOptionActive,
                    timer.isRunning && styles.chipDisabled,
                  ]}
                  onPress={() => timer.selectLoops(l)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: timer.selectedLoops === l, disabled: timer.isRunning }}
                >
                  <Text style={[styles.repeatOptionText, timer.selectedLoops === l && styles.repeatOptionTextActive]}>
                    {l}
                  </Text>
                </Pressable>
              ))}
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
            <Text style={styles.cardLabel}>Japam time</Text>
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
    backgroundColor: 'rgba(250, 248, 240, 0.62)',
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
    backgroundColor: 'rgba(251, 249, 242, 0.94)',
    borderRadius: isMobile ? 0 : 34,
    paddingHorizontal: isMobile ? 22 : 28,
    paddingTop: Platform.OS === 'web'
      ? (isMobile
          ? (isShortMobile
              ? ('calc(26px + env(safe-area-inset-top))' as any)
              : ('calc(32px + env(safe-area-inset-top))' as any))
          : 58)
      : (isShortMobile ? 24 : isMobile ? 28 : 58),
    paddingBottom: 112,
    shadowColor: '#58694B',
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
    marginBottom: isShortMobile ? 8 : isMobile ? 10 : 18,
    gap: 10,
  },
  brandBlock: {
    flex: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  brandMark: {
    color: TEAL,
    fontSize: isShortMobile ? 18 : 20,
    lineHeight: isShortMobile ? 20 : 22,
    marginBottom: 1,
  },
  welcomeText: {
    color: '#34452F',
    fontSize: isShortMobile ? 16 : isMobile ? 18 : 20,
    fontWeight: '800',
    letterSpacing: 0.2,
    textAlign: 'center',
  },
  accountButton: {
    flex: 1,
    minHeight: 40,
    minWidth: 74,
    maxWidth: 128,
    paddingHorizontal: 14,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,250,0.82)',
    borderWidth: 1,
    borderColor: 'rgba(112,136,90,0.22)',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#70885A',
    shadowOpacity: 0.08,
    shadowRadius: 16,
    elevation: 4,
  },
  accountNameText: {
    color: '#34452F',
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
    color: '#7A856F',
    fontSize: isShortMobile ? 13 : isMobile ? 14 : 15,
    fontWeight: '700',
    marginBottom: isShortMobile ? 8 : isMobile ? 10 : 14,
  },
  subtitle: {
    fontSize: isShortMobile ? 14 : isMobile ? 16 : 18,
    color: '#68765F',
    textAlign: 'center',
    fontWeight: '700',
    marginBottom: (isWebMobile && isShortMobile) ? 6 : isShortMobile ? 12 : isMobile ? 10 : 26,
  },
  circleWrap: { marginBottom: (isWebMobile && isShortMobile) ? 8 : isShortMobile ? 14 : isMobile ? 14 : 24 },
  circleOuter: {
    width: CIRCLE_SIZE,
    height: CIRCLE_SIZE,
    borderRadius: CIRCLE_SIZE / 2,
    backgroundColor: 'rgba(255,255,250,0.88)',
    borderWidth: isMobile ? 12 : 18,
    borderColor: 'rgba(112,136,90,0.26)',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#70885A',
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
    color: '#7A856F',
    marginTop: isMobile ? 6 : 10,
    fontWeight: '500',
  },
  controls: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: isMobile ? 10 : 14,
    marginBottom: (isWebMobile && isShortMobile) ? 8 : isShortMobile ? 12 : isMobile ? 10 : 28,
  },
  startBtn: {
    flex: 1,
    maxWidth: 340,
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
    backgroundColor: 'rgba(255,255,250,0.82)',
    borderRadius: 26,
    paddingVertical: (isWebMobile && isShortMobile) ? 9 : isShortMobile ? 13 : isMobile ? 11 : 22,
    paddingHorizontal: isShortMobile ? 13 : isMobile ? 15 : 22,
    shadowColor: '#58694B',
    shadowOpacity: 0.07,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 4 },
    elevation: 5,
    borderWidth: 1,
    borderColor: 'rgba(112,136,90,0.18)',
  },
  repeatCard: {
    width: '100%',
    maxWidth: 460,
    backgroundColor: 'rgba(255,255,250,0.9)',
    borderRadius: 26,
    paddingVertical: isShortMobile ? 13 : isMobile ? 16 : 20,
    paddingHorizontal: isShortMobile ? 14 : isMobile ? 16 : 22,
    marginBottom: (isWebMobile && isShortMobile) ? 10 : isShortMobile ? 14 : isMobile ? 16 : 22,
    borderWidth: 1,
    borderColor: 'rgba(112,136,90,0.24)',
    shadowColor: '#58694B',
    shadowOpacity: 0.1,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 8 },
    elevation: 6,
  },
  repeatHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: isShortMobile ? 10 : 14,
  },
  repeatIconWrap: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: 'rgba(112,136,90,0.13)',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  repeatCopy: {
    flex: 1,
  },
  repeatTitle: {
    color: '#34452F',
    fontSize: isMobile ? 16 : 17,
    fontWeight: '900',
  },
  repeatSubtitle: {
    color: '#7A856F',
    fontSize: isMobile ? 12 : 13,
    fontWeight: '600',
    marginTop: 3,
  },
  repeatValue: {
    color: TEAL,
    fontSize: isMobile ? 24 : 28,
    fontWeight: '900',
  },
  repeatOptions: {
    flexDirection: 'row',
    gap: isMobile ? 8 : 10,
  },
  repeatOption: {
    flex: 1,
    minWidth: 42,
    minHeight: isShortMobile ? 38 : 42,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(112,136,90,0.28)',
    backgroundColor: 'rgba(250,248,240,0.78)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  repeatOptionActive: {
    backgroundColor: TEAL,
    borderColor: TEAL,
    shadowColor: TEAL,
    shadowOpacity: 0.2,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 4,
  },
  repeatOptionText: {
    color: '#526047',
    fontSize: isMobile ? 14 : 15,
    fontWeight: '900',
  },
  repeatOptionTextActive: {
    color: '#FFFDF4',
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
    backgroundColor: 'rgba(255,255,250,0.88)',
    borderRadius: 18,
    paddingVertical: (isWebMobile && isShortMobile) ? 8 : isShortMobile ? 12 : isMobile ? 14 : 16,
    paddingHorizontal: isShortMobile ? 8 : 10,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(112,136,90,0.22)',
    shadowColor: '#58694B',
    shadowOpacity: 0.1,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
    elevation: 5,
  },
  statValue: {
    color: '#34452F',
    fontSize: isShortMobile ? 26 : isMobile ? 29 : 32,
    fontWeight: '900',
    lineHeight: isShortMobile ? 31 : isMobile ? 35 : 38,
  },
  statLabel: {
    color: '#68765F',
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
    color: '#7A856F',
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
    borderColor: 'rgba(112,136,90,0.34)',
    backgroundColor: 'rgba(255,255,250,0.9)',
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
    color: '#526047',
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
