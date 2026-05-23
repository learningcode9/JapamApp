import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import * as Google from 'expo-auth-session/providers/google';
import { useFocusEffect, useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  DeviceEventEmitter,
  Dimensions,
  ImageBackground,
  Keyboard,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  LOOP_OPTIONS,
  STD_DURATIONS,
  formatTimer,
  useTimer,
} from '../../contexts/timer-context';

WebBrowser.maybeCompleteAuthSession();

const { width: screenWidth, height: screenHeight } = Dimensions.get('window');
const isMobile = screenWidth < 768;
const isShortMobile = isMobile && screenHeight < 760;
const CIRCLE_SIZE = isShortMobile ? 204 : isMobile ? 224 : 296;
const TEAL = '#0F8F87';
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
  userId?: string;
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

const dedupeHistoryForStats = (history: Session[]) => {
  const exactSeen = new Set<string>();
  const nearTimerRows = new Map<string, number[]>();

  return history.filter((item) => {
    const date = new Date(item.date);
    if (Number.isNaN(date.getTime())) return false;

    const totalCount = Number(item.totalCount) || (Number(item.malas) || 0) * 108;
    if (totalCount <= 0) return false;

    const dayKey = getLocalDateKey(date);
    const key = [
      item.userId || 'guest',
      dayKey,
      date.toISOString(),
      totalCount,
      Number(item.malas) || 0,
      Number(item.duration) || 0,
      item.manual ? 'manual' : 'auto',
    ].join(':');

    if (exactSeen.has(key)) return false;
    exactSeen.add(key);

    if (!item.manual) {
      const nearKey = [
        item.userId || 'guest',
        dayKey,
        totalCount,
        Number(item.malas) || 0,
      ].join(':');
      const existingTimes = nearTimerRows.get(nearKey) || [];
      const time = date.getTime();
      if (existingTimes.some((existing) => Math.abs(existing - time) < 30000)) {
        return false;
      }
      nearTimerRows.set(nearKey, [...existingTimes, time]);
    }

    return true;
  });
};

export default function TimerScreen() {
  const router = useRouter();
  const timer = useTimer();
  const [showCustomInput, setShowCustomInput] = useState(false);
  const [customText, setCustomText] = useState('');
  const [userName, setUserName] = useState('');
  const [showUserModal, setShowUserModal] = useState(false);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [showInstallBanner, setShowInstallBanner] = useState(false);
  const [showInstallHelp, setShowInstallHelp] = useState(false);
  const [malasToday, setMalasToday] = useState(0);
  const [todayCount, setTodayCount] = useState(0);
  const [dayStreak, setDayStreak] = useState(0);
  const deferredInstallPromptRef = useRef<any>(null);

  const googleRedirectUri =
    Platform.OS === 'web' && typeof window !== 'undefined'
      ? window.location.origin
      : undefined;

  const [request, response, promptAsync] = Google.useAuthRequest({
    clientId: process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID,
    scopes: ['profile', 'email'],
    redirectUri: googleRedirectUri,
  });

  const loadUser = useCallback(async () => {
    setUserName((await AsyncStorage.getItem(USER_NAME_KEY)) || '');
  }, []);

  const openSignInModal = useCallback(() => {
    setIsSigningIn(false);
    setShowUserModal(true);
  }, []);

  const loadStats = useCallback(async () => {
    const userId = await AsyncStorage.getItem(USER_ID_KEY);
    const todayKey = getLocalDateKey();
    const rawHistory = await AsyncStorage.getItem(HISTORY_KEY);
    const history = dedupeHistoryForStats(parseHistory(rawHistory)).filter((item) => {
      if (!userId) return !item.userId;
      return item.userId === userId;
    });

    const totalByDay = new Map<string, number>();
    history.forEach((item) => {
      const date = new Date(item.date);
      if (Number.isNaN(date.getTime())) return;
      const totalCount = Number(item.totalCount) || (Number(item.malas) || 0) * 108;
      if (totalCount <= 0) return;
      const dayKey = getLocalDateKey(date);
      totalByDay.set(dayKey, (totalByDay.get(dayKey) || 0) + totalCount);
    });

    const safeTodayTotal = totalByDay.get(todayKey) || 0;
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

        if (!googleUserId) {
          setShowUserModal(true);
          return;
        }

        await AsyncStorage.setItem(USER_NAME_KEY, googleName);
        if (googleEmail) {
          await AsyncStorage.setItem(USER_EMAIL_KEY, googleEmail);
        }
        await AsyncStorage.setItem(USER_ID_KEY, googleUserId);
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
    if (!isStandalone) {
      setShowInstallBanner(true);
    }

    const onBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
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
  }, []);

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
    <SafeAreaView style={styles.root}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.container}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
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

          <View style={styles.topControls}>
            <View style={styles.headerSideSpacer} />
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

      {showInstallBanner && (
            <View style={styles.installBanner}>
              <Text style={styles.installBannerTitle}>Install this app for a better experience</Text>
              {showInstallHelp && (
                <Text style={styles.installBannerHelp}>Tap browser menu ⋮ → Add to Home screen</Text>
              )}
              <View style={styles.installBannerActions}>
                <Pressable style={styles.installBannerPrimary} onPress={() => void handleInstallNow()}>
                  <Text style={styles.installBannerPrimaryText}>Install Now</Text>
                </Pressable>
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
                <Text style={styles.malaText}>Mala {timer.completedLoops} / {timer.selectedLoops}</Text>
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

          <View style={styles.card}>
            <Text style={styles.cardLabel}>DURATION</Text>
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

            <Text style={[styles.cardLabel, { marginTop: isShortMobile ? 12 : isMobile ? 14 : 22 }]}>AUTO-REPEAT MALAS</Text>
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
          visible={showUserModal}
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
              <Text style={styles.modalTitle}>Sign in to save</Text>
              <Text style={styles.modalSubtitle}>
                Sign in with Google to save your Japam history and sync across devices.
              </Text>
              <Pressable
                disabled={!request || isSigningIn}
                style={[styles.modalButton, (!request || isSigningIn) && styles.disabledButton]}
                onPress={() => {
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
                      }
                    } catch (error) {
                      console.log('Google prompt error:', error);
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
    </SafeAreaView>
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
    backgroundColor: 'rgba(245, 250, 250, 0.45)',
  },
  container: {
    flexGrow: 1,
    justifyContent: isMobile ? 'flex-start' : 'center',
    width: '100%',
    alignSelf: 'center',
    paddingTop: Platform.OS === 'web'
      ? (isMobile ? ('calc(10px + env(safe-area-inset-top))' as any) : 24)
      : (isShortMobile ? 8 : isMobile ? 12 : 24),
    paddingBottom: Platform.OS === 'web'
      ? (isMobile ? ('calc(136px + env(safe-area-inset-bottom))' as any) : 128)
      : (isMobile ? 132 : 128),
    paddingHorizontal: isMobile ? 0 : 24,
    alignItems: 'center',
    minHeight: Platform.OS === 'web' ? ('100dvh' as any) : screenHeight,
  },
  appShell: {
    width: '100%',
    maxWidth: isMobile ? undefined : 460,
    minHeight: isMobile
      ? (Platform.OS === 'web' ? ('100dvh' as any) : screenHeight)
      : Math.min(screenHeight - 48, 900),
    alignItems: 'center',
    overflow: 'hidden',
    position: 'relative',
    backgroundColor: 'rgba(238, 248, 246, 0.94)',
    borderRadius: isMobile ? 0 : 28,
    paddingHorizontal: isMobile ? 22 : 28,
    paddingTop: isShortMobile ? 16 : isMobile ? 22 : 34,
    paddingBottom: isShortMobile ? 48 : isMobile ? 56 : 104,
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
    marginBottom: isShortMobile ? 8 : isMobile ? 10 : 18,
    gap: 10,
  },
  headerSideSpacer: {
    flex: 1,
    minWidth: 74,
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
    marginBottom: isShortMobile ? 12 : isMobile ? 16 : 26,
  },
  circleWrap: { marginBottom: isShortMobile ? 14 : isMobile ? 18 : 32 },
  circleOuter: {
    width: CIRCLE_SIZE,
    height: CIRCLE_SIZE,
    borderRadius: CIRCLE_SIZE / 2,
    backgroundColor: 'rgba(255,255,255,0.72)',
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
    fontSize: isShortMobile ? 44 : isMobile ? 50 : 72,
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
    marginBottom: isShortMobile ? 12 : isMobile ? 16 : 28,
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
    backgroundColor: 'rgba(255,255,255,0.72)',
  },
  card: {
    width: '100%',
    maxWidth: 460,
    backgroundColor: 'rgba(255,255,255,0.78)',
    borderRadius: 22,
    paddingVertical: isShortMobile ? 13 : isMobile ? 15 : 22,
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
    gap: 10,
    marginTop: isShortMobile ? 12 : isMobile ? 14 : 22,
  },
  statCard: {
    flexGrow: 1,
    flexBasis: '30%',
    backgroundColor: 'rgba(255,255,255,0.72)',
    borderRadius: 18,
    paddingVertical: isMobile ? 13 : 16,
    paddingHorizontal: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(15,143,135,0.14)',
  },
  statValue: {
    color: '#12383c',
    fontSize: isMobile ? 24 : 28,
    fontWeight: '900',
  },
  statLabel: {
    color: '#547071',
    fontSize: isMobile ? 12 : 13,
    fontWeight: '800',
    marginTop: 4,
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
    fontSize: 11,
    fontWeight: '800',
    color: '#4a8c90',
    letterSpacing: 1.2,
    marginBottom: isMobile ? 10 : 14,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: isMobile ? 9 : 10,
    justifyContent: 'center',
  },
  chip: {
    paddingVertical: isShortMobile ? 7 : isMobile ? 8 : 9,
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
});
