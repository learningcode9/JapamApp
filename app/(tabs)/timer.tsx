import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { Audio } from 'expo-av';
import * as Notifications from 'expo-notifications';
import { LinearGradient } from 'expo-linear-gradient';
import { useFocusEffect } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  AppState,
  DeviceEventEmitter,
  Dimensions,
  ImageBackground,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  Vibration,
  View,
} from 'react-native';
import * as Haptics2 from 'expo-haptics';

const { width: screenWidth, height: screenHeight } = Dimensions.get('window');
const isMobile = screenWidth < 768;
const isShortMobile = isMobile && screenHeight < 760;
const CIRCLE_SIZE = isShortMobile ? 210 : isMobile ? 230 : 296;
const TEAL = '#0F8F87';

const STD_DURATIONS = [1, 3, 5, 10, 15];
const LOOP_OPTIONS = [1, 3, 5, 10];

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
  const [showCustomInput, setShowCustomInput] = useState(false);
  const [customText, setCustomText] = useState('');

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
          { shouldPlay: false, isLooping: false, volume: 0.85 }
        );
        soundRef.current = sound;
      } catch {}
    })();
    return () => { soundRef.current?.unloadAsync().catch(() => {}); soundRef.current = null; };
  }, []);

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
        if (savedDur > 0) { setSelectedDuration(savedDur); selectedDurationRef.current = savedDur; }
        else if (savedTarget > 0) {
          const mins = Math.round(savedTarget / 60);
          setSelectedDuration(mins); selectedDurationRef.current = mins;
        }
        if (LOOP_OPTIONS.includes(savedLoops)) { setSelectedLoops(savedLoops); selectedLoopsRef.current = savedLoops; }
        if (savedSec > 0 && savedTarget > 0 && savedSec < savedTarget) {
          setSeconds(savedSec); secondsRef.current = savedSec;
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
      // 1. Save to local history
      const raw = await AsyncStorage.getItem(HISTORY_KEY);
      const history = raw ? JSON.parse(raw) : [];
      await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify([session, ...history]));

      // 2. Notify Home and History to refresh
      DeviceEventEmitter.emit('japam-stats-updated');
      DeviceEventEmitter.emit('japam-history-updated', { userId: uid || 'guest' });
      if (Platform.OS === 'web' && typeof window !== 'undefined') {
        window.dispatchEvent(new Event('japam-stats-updated'));
        window.dispatchEvent(new Event('japam-history-updated'));
      }

      // 3. Save to Supabase
      if (!uid) return;
      const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
      const key = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
      if (!url || !key) return;
      const userName = await AsyncStorage.getItem('userName') || '';
      await fetch(`${url}/rest/v1/japam_history`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: key,
          Authorization: `Bearer ${key}`,
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({ user_id: uid, user_name: userName, malas: 1, count: 108 }),
      });
    } catch (err) {
      console.log('Timer session save error:', err);
    }
  }, []);

  const handleComplete = useCallback(async () => {
    if (isCompletingRef.current) return;
    isCompletingRef.current = true;
    clearTimerInterval();
    setIsRunning(false); isRunningRef.current = false;
    await hideNotification();

    const newDone = completedLoopsRef.current + 1;
    setCompletedLoops(newDone); completedLoopsRef.current = newDone;
    const isFinal = newDone >= selectedLoopsRef.current;

    // Immediate feedback: vibration + notification + save (don't wait for sound)
    if (vibrationEnabledRef.current && Platform.OS !== 'web') {
      pulse([0, 1200, 80, 1500]);
      Haptics2.notificationAsync(Haptics2.NotificationFeedbackType.Success).catch(() => {});
      setTimeout(() => Haptics2.notificationAsync(Haptics2.NotificationFeedbackType.Error).catch(() => {}), 400);
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

    // Play Om and wait for it to finish (stop after 3 s to keep it short)
    if (soundEnabledRef.current) {
      try {
        const sound = soundRef.current;
        if (sound) {
          await sound.stopAsync().catch(() => {});
          await sound.setPositionAsync(0).catch(() => {});
          await sound.playAsync();
          await new Promise<void>((resolve) => {
            let done = false;
            const finish = () => { if (done) return; done = true; sound.setOnPlaybackStatusUpdate(null); resolve(); };
            const cutoff = setTimeout(async () => { await sound.stopAsync().catch(() => {}); finish(); }, 3000);
            sound.setOnPlaybackStatusUpdate((status) => {
              if (status.isLoaded && status.didJustFinish) { clearTimeout(cutoff); finish(); }
            });
          });
        }
      } catch {}
    }

    if (isFinal) {
      void persistState(false);
      isCompletingRef.current = false;
    } else {
      // 1 s peaceful pause after Om finishes, then start next loop
      await new Promise<void>((resolve) => setTimeout(resolve, 1000));
      isCompletingRef.current = false;
      setSeconds(0); secondsRef.current = 0;
      timerStartedAtRef.current = Date.now();
      setIsRunning(true); isRunningRef.current = true;
      startTimerInterval();
      void showNotification();
      void persistState(true);
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
    if (!userIdRef.current) {
      Alert.alert('Please sign in to start timer');
      return;
    }
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

  const handleCustomSet = () => {
    const mins = parseInt(customText, 10);
    if (!mins || mins < 1 || mins > 180) return;
    handleDurationSelect(mins);
    setShowCustomInput(false);
    setCustomText('');
    Keyboard.dismiss();
  };

  return (
    <View style={{ flex: 1, backgroundColor: '#edf7f4' }}>
      <ImageBackground
        source={require('../../assets/images/zen-background.png')}
        style={StyleSheet.absoluteFillObject}
        imageStyle={{ opacity: 0.28, resizeMode: 'cover' }}
      />
      <LinearGradient
        colors={['rgba(237,247,244,0.93)', 'rgba(217,238,235,0.88)', 'rgba(248,251,247,0.9)']}
        start={{ x: 0, y: 0 }}
        end={{ x: 0, y: 1 }}
        style={StyleSheet.absoluteFillObject}
      />
      <ScrollView
        contentContainerStyle={styles.container}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.header}>
          <Text style={styles.subtitle}>Pick a duration, set loops, breathe.</Text>
        </View>

        {/* Timer circle */}
        <View style={styles.circleWrap}>
          <View style={styles.circleOuter}>
            <View style={styles.circleInner}>
              <Text style={styles.timerText}>{fmt(timeLeft)}</Text>
              <Text style={styles.malaText}>Mala {completedLoops} / {selectedLoops}</Text>
            </View>
          </View>
        </View>

        {/* Controls */}
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
            <Ionicons name="refresh-outline" size={22} color={TEAL} />
          </Pressable>
        </View>

        {/* Settings card */}
        <View style={styles.card}>
          <Text style={styles.cardLabel}>DURATION</Text>
          <View style={styles.chips}>
            {STD_DURATIONS.map((d) => (
              <Pressable
                key={d}
                style={[styles.chip, selectedDuration === d && !isCustomDuration && styles.chipActive, isRunning && styles.chipDisabled]}
                onPress={() => { handleDurationSelect(d); setShowCustomInput(false); }}
              >
                <Text style={[styles.chipText, selectedDuration === d && !isCustomDuration && styles.chipTextActive]}>{d}m</Text>
              </Pressable>
            ))}
            <Pressable
              style={[styles.chip, isCustomDuration && styles.chipActive, isRunning && styles.chipDisabled]}
              onPress={() => { if (!isRunning) setShowCustomInput(!showCustomInput); }}
            >
              <Text style={[styles.chipText, isCustomDuration && styles.chipTextActive]}>
                {isCustomDuration ? `${selectedDuration}m` : 'Custom'}
              </Text>
            </Pressable>
          </View>

          {showCustomInput && !isRunning && (
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
    paddingTop: Platform.OS === 'web'
      ? (isShortMobile ? 22 : isMobile ? 30 : 60)
      : (isShortMobile ? 24 : isMobile ? 34 : 72),
    paddingBottom: isMobile ? 118 : 140,
    paddingHorizontal: isMobile ? 18 : 24,
    alignItems: 'center',
    minHeight: screenHeight,
  },
  header: { alignItems: 'center', marginBottom: isShortMobile ? 14 : isMobile ? 18 : 32 },
  title: {
    fontSize: isMobile ? 26 : 32,
    fontWeight: '900',
    color: '#12383c',
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: isMobile ? 17 : 18,
    color: '#4a7c80',
    textAlign: 'center',
    fontWeight: '700',
  },
  circleWrap: { marginBottom: isShortMobile ? 16 : isMobile ? 20 : 32 },
  circleOuter: {
    width: CIRCLE_SIZE,
    height: CIRCLE_SIZE,
    borderRadius: CIRCLE_SIZE / 2,
    backgroundColor: 'rgba(255,255,255,0.72)',
    borderWidth: isMobile ? 14 : 18,
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
    fontSize: isShortMobile ? 46 : isMobile ? 52 : 72,
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
    marginBottom: isShortMobile ? 14 : isMobile ? 18 : 28,
  },
  startBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: TEAL,
    paddingVertical: isMobile ? 13 : 15,
    paddingHorizontal: isMobile ? 32 : 40,
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
    width: 50,
    height: 50,
    borderRadius: 25,
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
    padding: isShortMobile ? 14 : isMobile ? 16 : 22,
    shadowColor: '#0a3a3c',
    shadowOpacity: 0.07,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 4 },
    elevation: 5,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.9)',
  },
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
    gap: isMobile ? 8 : 10,
  },
  chip: {
    paddingVertical: isMobile ? 8 : 9,
    paddingHorizontal: isMobile ? 15 : 18,
    borderRadius: 50,
    borderWidth: 1.5,
    borderColor: 'rgba(15,143,135,0.22)',
    backgroundColor: 'rgba(255,255,255,0.85)',
  },
  chipActive: {
    backgroundColor: TEAL,
    borderColor: TEAL,
  },
  chipDisabled: {
    opacity: 0.45,
  },
  chipText: {
    fontSize: isMobile ? 13 : 14,
    fontWeight: '600',
    color: '#2a5c60',
  },
  chipTextActive: {
    color: '#fff',
    fontWeight: '800',
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
