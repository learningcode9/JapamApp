import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { Audio } from 'expo-av';
import * as Haptics from 'expo-haptics';
import * as Notifications from 'expo-notifications';
import { LinearGradient } from 'expo-linear-gradient';
import { useFocusEffect } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AppState,
  DeviceEventEmitter,
  Dimensions,
  ImageBackground,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  Vibration,
  View,
} from 'react-native';

const { width: screenWidth, height: screenHeight } = Dimensions.get('window');
const isMobile = screenWidth < 768;
const CIRCLE_SIZE = isMobile ? 260 : 300;
const PRIMARY = '#E8823A';

const DURATIONS = [1, 3, 5, 10, 15, 30];
const LOOP_OPTIONS = [1, 3, 5, 9, 11, 27];

const T_DURATION_KEY = 'timerTab_duration';
const T_LOOPS_KEY = 'timerTab_loops';
const TIMER_SECONDS_KEY = 'timerSeconds';
const TIMER_RUNNING_KEY = 'timerRunning';
const TIMER_TARGET_KEY = 'timerTarget';
const HISTORY_KEY = 'history';
const USER_ID_KEY = 'userId';
const SOUND_ENABLED_KEY = 'soundEnabled';
const VIBRATION_ENABLED_KEY = 'vibrationEnabled';

const getUserKey = (key: string, uid: string) => `${key}:${uid}`;

const fmt = (s: number) =>
  `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

const pulse = (pattern: number | number[]) => {
  if (Platform.OS === 'web') return;
  try { Vibration.vibrate(pattern as any); } catch {}
};

if (Platform.OS !== 'web') {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: false,
      shouldShowBanner: false,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });
}

export default function TimerScreen() {
  const [seconds, setSeconds] = useState(0);
  const [selectedDuration, setSelectedDuration] = useState(10);
  const [selectedLoops, setSelectedLoops] = useState(1);
  const [completedLoops, setCompletedLoops] = useState(0);
  const [isRunning, setIsRunning] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [vibrationEnabled, setVibrationEnabled] = useState(true);

  const targetSeconds = selectedDuration * 60;
  const timeLeft = Math.max(0, targetSeconds - seconds);
  const isPaused = !isRunning && seconds > 0 && seconds < targetSeconds;

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

  useEffect(() => { secondsRef.current = seconds; }, [seconds]);
  useEffect(() => { isRunningRef.current = isRunning; }, [isRunning]);
  useEffect(() => { completedLoopsRef.current = completedLoops; }, [completedLoops]);
  useEffect(() => { selectedLoopsRef.current = selectedLoops; }, [selectedLoops]);
  useEffect(() => { selectedDurationRef.current = selectedDuration; }, [selectedDuration]);
  useEffect(() => { soundEnabledRef.current = soundEnabled; }, [soundEnabled]);
  useEffect(() => { vibrationEnabledRef.current = vibrationEnabled; }, [vibrationEnabled]);

  useFocusEffect(useCallback(() => {
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
      if (dur) { setSelectedDuration(Number(dur)); selectedDurationRef.current = Number(dur); }
      if (loops) { setSelectedLoops(Number(loops)); selectedLoopsRef.current = Number(loops); }
      setSoundEnabled(snd !== 'false'); soundEnabledRef.current = snd !== 'false';
      setVibrationEnabled(vib !== 'false'); vibrationEnabledRef.current = vib !== 'false';
      userIdRef.current = uid || '';
    })();
    return () => { active = false; };
  }, []));

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    void Notifications.setNotificationChannelAsync('japam-timer', {
      name: 'Japam Timer', importance: Notifications.AndroidImportance.DEFAULT,
      vibrationPattern: [], enableVibrate: false, showBadge: false,
    });
    void Notifications.setNotificationChannelAsync('japam-complete', {
      name: 'Completion', importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250], enableVibrate: true, showBadge: false,
    });
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        await Audio.setAudioModeAsync({
          playsInSilentModeIOS: true, staysActiveInBackground: true,
          shouldDuckAndroid: false, playThroughEarpieceAndroid: false,
        });
        const { sound } = await Audio.Sound.createAsync(
          require('../../assets/om_complete.mp3'),
          { shouldPlay: false, isLooping: false, volume: 1.0 }
        );
        soundRef.current = sound;
      } catch {}
    })();
    return () => { soundRef.current?.unloadAsync().catch(() => {}); soundRef.current = null; };
  }, []);

  // Restore timer state on mount
  useEffect(() => {
    void (async () => {
      try {
        const uid = await AsyncStorage.getItem(USER_ID_KEY) || '';
        userIdRef.current = uid;
        const get = async (key: string) =>
          uid
            ? (await AsyncStorage.getItem(getUserKey(key, uid))) ?? (await AsyncStorage.getItem(key))
            : AsyncStorage.getItem(key);
        const [sec, target, dur, loops] = await Promise.all([
          get(TIMER_SECONDS_KEY), get(TIMER_TARGET_KEY),
          AsyncStorage.getItem(T_DURATION_KEY), AsyncStorage.getItem(T_LOOPS_KEY),
        ]);
        const savedSec = Number(sec) || 0;
        const savedTarget = Number(target) || 0;
        const savedDur = Number(dur) || 0;
        const savedLoops = Number(loops) || 0;
        if (DURATIONS.includes(savedDur)) {
          setSelectedDuration(savedDur); selectedDurationRef.current = savedDur;
        } else if (savedTarget > 0) {
          const mins = Math.round(savedTarget / 60);
          if (DURATIONS.includes(mins)) { setSelectedDuration(mins); selectedDurationRef.current = mins; }
        }
        if (LOOP_OPTIONS.includes(savedLoops)) {
          setSelectedLoops(savedLoops); selectedLoopsRef.current = savedLoops;
        }
        if (savedSec > 0 && savedTarget > 0 && savedSec < savedTarget) {
          setSeconds(savedSec); secondsRef.current = savedSec;
          // Restore paused — user must press Resume
        }
      } catch {}
    })();
  }, []);

  const persistState = useCallback(async (running: boolean) => {
    const uid = userIdRef.current;
    const tSec = selectedDurationRef.current * 60;
    const pairs: [string, string][] = [
      [TIMER_SECONDS_KEY, String(secondsRef.current)],
      [TIMER_RUNNING_KEY, String(running)],
      [TIMER_TARGET_KEY, String(tSec)],
    ];
    try {
      await AsyncStorage.multiSet(pairs);
      if (uid) await AsyncStorage.multiSet(pairs.map(([k, v]) => [getUserKey(k, uid), v] as [string, string]));
    } catch {}
  }, []);

  const clearTimerInterval = useCallback(() => {
    if (timerIntervalRef.current) { clearInterval(timerIntervalRef.current); timerIntervalRef.current = null; }
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

  const hideNotification = useCallback(async () => {
    if (notifIntervalRef.current) { clearInterval(notifIntervalRef.current); notifIntervalRef.current = null; }
    if (Platform.OS === 'web') return;
    try {
      if (notifIdRef.current) {
        await Notifications.dismissNotificationAsync(notifIdRef.current);
        notifIdRef.current = null;
      }
    } catch {}
  }, []);

  const showNotification = useCallback(async () => {
    if (Platform.OS === 'web') return;
    const schedule = async () => {
      try {
        const perm = await Notifications.getPermissionsAsync();
        if (!perm.granted) return;
        if (notifIdRef.current) {
          try { await Notifications.dismissNotificationAsync(notifIdRef.current); } catch {}
          notifIdRef.current = null;
        }
        const left = Math.max(0, selectedDurationRef.current * 60 - secondsRef.current);
        const id = await Notifications.scheduleNotificationAsync({
          content: {
            title: `⏱ ${fmt(left)}`,
            body: 'Japam Timer Running',
            sticky: true,
            sound: false,
            ...(Platform.OS === 'android' ? { channelId: 'japam-timer' } : {}),
          },
          trigger: null,
        } as any);
        notifIdRef.current = id;
      } catch {}
    };
    await schedule();
    if (notifIntervalRef.current) clearInterval(notifIntervalRef.current);
    notifIntervalRef.current = setInterval(schedule, 10000);
  }, []);

  const saveSession = useCallback(async (loopsDone: number) => {
    const uid = userIdRef.current;
    const today = new Date();
    const dateKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const session = {
      id: Date.now(),
      name: 'Japam',
      duration: selectedDurationRef.current * 60 * loopsDone,
      count: loopsDone * 108,
      malas: loopsDone,
      total: loopsDone * 108,
      date: dateKey,
      time: today.toISOString(),
      type: 'timer',
    };
    try {
      const raw = await AsyncStorage.getItem(HISTORY_KEY);
      const history = raw ? JSON.parse(raw) : [];
      await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify([session, ...history]));
      DeviceEventEmitter.emit('japam-history-updated', { userId: uid || 'guest' });
      if (Platform.OS === 'web' && typeof window !== 'undefined') {
        window.dispatchEvent(new Event('japam-history-updated'));
      }
    } catch {}
  }, []);

  const handleComplete = useCallback(async () => {
    if (isCompletingRef.current) return;
    isCompletingRef.current = true;

    clearTimerInterval();
    setIsRunning(false);
    isRunningRef.current = false;
    await hideNotification();

    const newDone = completedLoopsRef.current + 1;
    setCompletedLoops(newDone);
    completedLoopsRef.current = newDone;
    const isFinal = newDone >= selectedLoopsRef.current;

    if (soundEnabledRef.current) {
      try {
        await soundRef.current?.stopAsync().catch(() => {});
        await soundRef.current?.setPositionAsync(0).catch(() => {});
        await soundRef.current?.playAsync();
      } catch {}
    }

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

    if (isFinal) {
      void saveSession(newDone);
      void persistState(false);
      isCompletingRef.current = false;
    } else {
      setTimeout(() => {
        isCompletingRef.current = false;
        setSeconds(0);
        secondsRef.current = 0;
        timerStartedAtRef.current = Date.now();
        setIsRunning(true);
        isRunningRef.current = true;
        startTimerInterval();
        void showNotification();
        void persistState(true);
      }, 3000);
    }
  }, [clearTimerInterval, hideNotification, persistState, saveSession, showNotification, startTimerInterval]);

  useEffect(() => {
    if (isRunning && seconds > 0 && seconds >= targetSeconds && !isCompletingRef.current) {
      void handleComplete();
    }
  }, [seconds, isRunning, targetSeconds, handleComplete]);

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
    document.title = isRunning ? `⏱ ${fmt(timeLeft)} — Mantra Japam` : 'Mantra Japam';
  }, [isRunning, timeLeft]);

  useEffect(() => () => {
    clearTimerInterval();
    if (notifIntervalRef.current) clearInterval(notifIntervalRef.current);
  }, [clearTimerInterval]);

  const handleStart = useCallback(() => {
    if (isRunning) return;
    isCompletingRef.current = false;
    const resume = seconds > 0 && seconds < targetSeconds;
    if (resume) {
      timerStartedAtRef.current = Date.now() - seconds * 1000;
    } else {
      setSeconds(0); secondsRef.current = 0;
      setCompletedLoops(0); completedLoopsRef.current = 0;
      timerStartedAtRef.current = Date.now();
    }
    setIsRunning(true); isRunningRef.current = true;
    startTimerInterval();
    void showNotification();
    void persistState(true);
  }, [isRunning, seconds, targetSeconds, startTimerInterval, showNotification, persistState]);

  const handlePause = useCallback(() => {
    clearTimerInterval();
    setIsRunning(false); isRunningRef.current = false;
    void hideNotification();
    void persistState(false);
  }, [clearTimerInterval, hideNotification, persistState]);

  const handleReset = useCallback(() => {
    clearTimerInterval();
    setIsRunning(false); isRunningRef.current = false;
    setSeconds(0); secondsRef.current = 0;
    setCompletedLoops(0); completedLoopsRef.current = 0;
    isCompletingRef.current = false;
    timerStartedAtRef.current = null;
    void hideNotification();
    void persistState(false);
  }, [clearTimerInterval, hideNotification, persistState]);

  const handleDurationSelect = (mins: number) => {
    if (isRunning) return;
    setSelectedDuration(mins); selectedDurationRef.current = mins;
    setSeconds(0); secondsRef.current = 0;
    setCompletedLoops(0); completedLoopsRef.current = 0;
    timerStartedAtRef.current = null;
    void AsyncStorage.setItem(T_DURATION_KEY, String(mins));
  };

  const handleLoopSelect = (n: number) => {
    if (isRunning) return;
    setSelectedLoops(n); selectedLoopsRef.current = n;
    void AsyncStorage.setItem(T_LOOPS_KEY, String(n));
  };

  return (
    <View style={{ flex: 1, backgroundColor: '#FFF3E8' }}>
      <ImageBackground
        source={require('../../assets/images/zen-background.png')}
        style={StyleSheet.absoluteFillObject}
        imageStyle={{ opacity: 0.18, resizeMode: 'cover' }}
      />
      <LinearGradient
        colors={['rgba(255,243,232,0.92)', 'rgba(255,228,204,0.88)', 'rgba(245,208,176,0.82)']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFillObject}
      />
      <ScrollView contentContainerStyle={styles.container} showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <Text style={styles.title}>Timer Japam</Text>
          <Text style={styles.subtitle}>Pick a duration, set loops, breathe.</Text>
        </View>

        <View style={styles.circleWrap}>
          <View style={styles.circleOuter}>
            <View style={styles.circleInner}>
              <Text style={styles.timerText}>{fmt(timeLeft)}</Text>
              <Text style={styles.malaText}>Mala {completedLoops} / {selectedLoops}</Text>
            </View>
          </View>
        </View>

        <View style={styles.controls}>
          <Pressable
            style={({ pressed }) => [styles.startBtn, pressed && { opacity: 0.82 }]}
            onPress={isRunning ? handlePause : handleStart}
          >
            <Ionicons name={isRunning ? 'pause' : 'play'} size={20} color="#fff" style={{ marginRight: 8 }} />
            <Text style={styles.startBtnText}>
              {isRunning ? 'Pause' : isPaused ? 'Resume' : 'Start'}
            </Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [styles.resetBtn, pressed && { opacity: 0.65 }]}
            onPress={handleReset}
          >
            <Ionicons name="refresh-outline" size={22} color={PRIMARY} />
          </Pressable>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardLabel}>DURATION</Text>
          <View style={styles.chips}>
            {DURATIONS.map((d) => (
              <Pressable
                key={d}
                style={[styles.chip, selectedDuration === d && styles.chipActive, isRunning && styles.chipDisabled]}
                onPress={() => handleDurationSelect(d)}
              >
                <Text style={[styles.chipText, selectedDuration === d && styles.chipTextActive]}>{d}m</Text>
              </Pressable>
            ))}
          </View>

          <Text style={[styles.cardLabel, { marginTop: 22 }]}>AUTO-REPEAT MALAS</Text>
          <View style={styles.chips}>
            {LOOP_OPTIONS.map((l) => (
              <Pressable
                key={l}
                style={[styles.chip, selectedLoops === l && styles.chipActive, isRunning && styles.chipDisabled]}
                onPress={() => handleLoopSelect(l)}
              >
                <Text style={[styles.chipText, selectedLoops === l && styles.chipTextActive]}>{l}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingTop: Platform.OS === 'web' ? 60 : 72,
    paddingBottom: 140,
    paddingHorizontal: 24,
    alignItems: 'center',
    minHeight: screenHeight,
  },
  header: { alignItems: 'center', marginBottom: 36 },
  title: {
    fontSize: isMobile ? 28 : 34,
    fontWeight: '900',
    color: '#1C1009',
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: 15,
    color: '#7A5C35',
    marginTop: 6,
    textAlign: 'center',
  },
  circleWrap: { marginBottom: 36 },
  circleOuter: {
    width: CIRCLE_SIZE,
    height: CIRCLE_SIZE,
    borderRadius: CIRCLE_SIZE / 2,
    backgroundColor: 'rgba(255,255,255,0.82)',
    borderWidth: 20,
    borderColor: 'rgba(232,130,58,0.2)',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#E8823A',
    shadowOpacity: 0.2,
    shadowRadius: 36,
    shadowOffset: { width: 0, height: 10 },
    elevation: 14,
  },
  circleInner: { alignItems: 'center' },
  timerText: {
    fontSize: isMobile ? 62 : 74,
    fontWeight: '800',
    color: PRIMARY,
    letterSpacing: -2,
  },
  malaText: {
    fontSize: 15,
    color: '#7A5C35',
    marginTop: 10,
    fontWeight: '500',
  },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    marginBottom: 32,
  },
  startBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: PRIMARY,
    paddingVertical: 16,
    paddingHorizontal: 42,
    borderRadius: 50,
    shadowColor: PRIMARY,
    shadowOpacity: 0.45,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 6 },
    elevation: 10,
  },
  startBtnText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '800',
    letterSpacing: 0.2,
  },
  resetBtn: {
    width: 52,
    height: 52,
    borderRadius: 26,
    borderWidth: 2,
    borderColor: PRIMARY,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.78)',
  },
  card: {
    width: '100%',
    maxWidth: 460,
    backgroundColor: 'rgba(255,255,255,0.88)',
    borderRadius: 24,
    padding: 24,
    shadowColor: '#000',
    shadowOpacity: 0.07,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  cardLabel: {
    fontSize: 12,
    fontWeight: '800',
    color: '#9A7040',
    letterSpacing: 1,
    marginBottom: 14,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  chip: {
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: 50,
    borderWidth: 1.5,
    borderColor: 'rgba(0,0,0,0.12)',
    backgroundColor: 'rgba(255,255,255,0.9)',
  },
  chipActive: {
    backgroundColor: PRIMARY,
    borderColor: PRIMARY,
  },
  chipDisabled: {
    opacity: 0.5,
  },
  chipText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#5A4030',
  },
  chipTextActive: {
    color: '#fff',
    fontWeight: '800',
  },
});
