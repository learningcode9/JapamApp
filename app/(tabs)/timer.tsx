import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import {
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
  View,
} from 'react-native';
import {
  LOOP_OPTIONS,
  STD_DURATIONS,
  formatTimer,
  useTimer,
} from '../../contexts/timer-context';

const { width: screenWidth, height: screenHeight } = Dimensions.get('window');
const isMobile = screenWidth < 768;
const isShortMobile = isMobile && screenHeight < 760;
const CIRCLE_SIZE = isShortMobile ? 204 : isMobile ? 224 : 296;
const TEAL = '#0F8F87';
const HISTORY_KEY = 'history';
const USER_ID_KEY = 'userId';
const TOTAL_KEY = 'totalCount';
const TOTAL_DATE_KEY = 'totalDate';

type Session = {
  date: string;
  malas: number;
  totalCount: number;
  duration: number;
  manual?: boolean;
  userId?: string;
};

const getUserStorageKey = (key: string, userId: string) => `${key}:${userId}`;

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

export default function TimerScreen() {
  const router = useRouter();
  const timer = useTimer();
  const [showCustomInput, setShowCustomInput] = useState(false);
  const [customText, setCustomText] = useState('');
  const [malasToday, setMalasToday] = useState(0);
  const [todayCount, setTodayCount] = useState(0);
  const [dayStreak, setDayStreak] = useState(0);
  const [totalMalas, setTotalMalas] = useState(0);

  const loadStats = useCallback(async () => {
    const userId = await AsyncStorage.getItem(USER_ID_KEY);
    const todayKey = getLocalDateKey();
    const rawHistory = await AsyncStorage.getItem(HISTORY_KEY);
    const history = parseHistory(rawHistory).filter((item) => {
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

    let storedTodayTotal = 0;
    if (userId) {
      const storedDate = await AsyncStorage.getItem(getUserStorageKey(TOTAL_DATE_KEY, userId));
      if (storedDate === todayKey) {
        storedTodayTotal = Number((await AsyncStorage.getItem(getUserStorageKey(TOTAL_KEY, userId))) || '0');
      }
    } else {
      const storedDate = await AsyncStorage.getItem(TOTAL_DATE_KEY);
      if (storedDate === todayKey) {
        storedTodayTotal = Number((await AsyncStorage.getItem(TOTAL_KEY)) || '0');
      }
    }

    const safeTodayTotal = Math.max(storedTodayTotal, totalByDay.get(todayKey) || 0);
    if (safeTodayTotal > 0) totalByDay.set(todayKey, safeTodayTotal);

    const activeDays = new Set([...totalByDay.entries()].filter(([, total]) => total > 0).map(([day]) => day));
    let cursor = activeDays.has(todayKey) ? todayKey : getPreviousDateKey(todayKey);
    let nextStreak = 0;
    while (activeDays.has(cursor)) {
      nextStreak += 1;
      cursor = getPreviousDateKey(cursor);
    }

    const allTimeTotal = [...totalByDay.values()].reduce((sum, value) => sum + value, 0);
    setTodayCount(safeTodayTotal);
    setMalasToday(Math.floor(safeTodayTotal / 108));
    setDayStreak(nextStreak);
    setTotalMalas(Math.floor(allTimeTotal / 108));
  }, []);

  useFocusEffect(
    useCallback(() => {
      void loadStats();
    }, [loadStats])
  );

  useEffect(() => {
    const refresh = () => void loadStats();
    const statsSub = DeviceEventEmitter.addListener('japam-stats-updated', refresh);
    const historySub = DeviceEventEmitter.addListener('japam-history-updated', refresh);
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      window.addEventListener('japam-stats-updated', refresh);
      window.addEventListener('japam-history-updated', refresh);
    }
    return () => {
      statsSub.remove();
      historySub.remove();
      if (Platform.OS === 'web' && typeof window !== 'undefined') {
        window.removeEventListener('japam-stats-updated', refresh);
        window.removeEventListener('japam-history-updated', refresh);
      }
    };
  }, [loadStats]);

  const handleStart = () => {
    if (!timer.canStart) {
      router.push('/tap-japam?signin=1' as never);
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
            style={({ pressed }) => [styles.startBtn, pressed && { opacity: 0.82 }]}
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
          <View style={styles.statCard}>
            <Text style={styles.statValue}>{totalMalas}</Text>
            <Text style={styles.statLabel}>Total Malas</Text>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingTop: Platform.OS === 'web'
      ? (isShortMobile ? 18 : isMobile ? 26 : 60)
      : (isShortMobile ? 20 : isMobile ? 30 : 72),
    paddingBottom: isMobile ? 112 : 140,
    paddingHorizontal: isMobile ? 18 : 24,
    alignItems: 'center',
    minHeight: screenHeight,
  },
  header: { alignItems: 'center', marginBottom: isShortMobile ? 12 : isMobile ? 16 : 32 },
  subtitle: {
    fontSize: isMobile ? 16 : 18,
    color: '#4a7c80',
    textAlign: 'center',
    fontWeight: '700',
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
    flexBasis: '47%',
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
