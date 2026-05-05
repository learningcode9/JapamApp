import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Haptics from 'expo-haptics';
import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { getDailyQuote } from '@/constants/quotes';

type Session = {
  date: string;
  malas: number;
  totalCount: number;
  duration: number;
  manual?: boolean;
};

const HISTORY_KEY = 'history';
const COUNT_KEY = 'count';
const MALAS_KEY = 'malas';
const TOTAL_KEY = 'totalCount';

export default function JapamMain() {
  const [count, setCount] = useState(0);
  const [malas, setMalas] = useState(0);
  const [totalCount, setTotalCount] = useState(0);

  const [seconds, setSeconds] = useState(0);
  const [minutesInput, setMinutesInput] = useState('1');
  const [targetSeconds, setTargetSeconds] = useState(60);
  const [isRunning, setIsRunning] = useState(false);

  const fade = useRef(new Animated.Value(0)).current;

  const quote = getDailyQuote();

  useEffect(() => {
    Animated.timing(fade, {
      toValue: 1,
      duration: 800,
      useNativeDriver: true,
    }).start();
  }, [fade]);

  useEffect(() => {
    void (async () => {
      const [c, m, t] = await Promise.all([
        AsyncStorage.getItem(COUNT_KEY),
        AsyncStorage.getItem(MALAS_KEY),
        AsyncStorage.getItem(TOTAL_KEY),
      ]);

      setCount(Number(c ?? 0));
      setMalas(Number(m ?? 0));
      setTotalCount(Number(t ?? 0));
    })();
  }, []);

  useEffect(() => {
    void Promise.all([
      AsyncStorage.setItem(COUNT_KEY, String(count)),
      AsyncStorage.setItem(MALAS_KEY, String(malas)),
      AsyncStorage.setItem(TOTAL_KEY, String(totalCount)),
    ]);
  }, [count, malas, totalCount]);

  useEffect(() => {
    if (!isRunning) return;
    const interval = setInterval(() => setSeconds((prev) => prev + 1), 1000);
    return () => clearInterval(interval);
  }, [isRunning]);

  useEffect(() => {
    if (!isRunning || seconds < targetSeconds) return;
    void saveSession(targetSeconds);
    setIsRunning(false);
    setSeconds(0);
  }, [isRunning, seconds, targetSeconds]);

  const saveSession = async (duration: number) => {
    const raw = await AsyncStorage.getItem(HISTORY_KEY);
    const history: Session[] = raw ? JSON.parse(raw) : [];

    const session: Session = {
      date: new Date().toISOString(),
      malas: 1,
      totalCount: 108,
      duration,
    };

    await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify([session, ...history]));
  };

  const onTap = () => {
    setCount((prev) => {
      const next = prev + 1;

      if (Platform.OS !== 'web') {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      }

      if (next >= 108) {
        setMalas((m) => m + 1);
        setTotalCount((t) => t + 108);

        if (Platform.OS !== 'web') {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        }

        void saveSession(0);
        return 0;
      }

      return next;
    });
  };

  const formatTime = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>🧘 Japam Tracker</Text>
      <Animated.Text style={[styles.quote, { opacity: fade }]}>{quote}</Animated.Text>

      <Text style={styles.big}>{count}</Text>
      <Text style={styles.meta}>
        📿 {malas} malas   🔢 {totalCount} total   ⏱ {formatTime(seconds)}
      </Text>
      <Text style={styles.hint}>Tap resets at 108</Text>

      <Pressable style={styles.circle} onPress={onTap} />

      <Text style={styles.inputLabel}>Session duration (minutes)</Text>
      <View style={styles.row}>
        <TextInput
          style={styles.input}
          value={minutesInput}
          onChangeText={setMinutesInput}
          keyboardType="numeric"
        />
        <Pressable
          style={styles.btn}
          onPress={() => setTargetSeconds((Number(minutesInput) || 1) * 60)}
        >
          <Text style={styles.btnText}>Apply</Text>
        </Pressable>
      </View>

      <View style={styles.row}>
        <Pressable
          style={styles.btn}
          onPress={() => {
            setSeconds(0);
            setIsRunning(true);
          }}
        >
          <Text style={styles.btnText}>Start</Text>
        </Pressable>

        <Pressable style={[styles.btn, styles.gray]} onPress={() => setIsRunning(false)}>
          <Text style={styles.btnText}>Pause</Text>
        </Pressable>

        <Pressable
          style={[styles.btn, styles.red]}
          onPress={() => {
            setIsRunning(false);
            setSeconds(0);
            setCount(0);
          }}
        >
          <Text style={styles.btnText}>Reset</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a' },
  content: { alignItems: 'center', padding: 20, paddingBottom: 120 },
  title: { color: 'white', fontSize: 28, fontWeight: '800', marginTop: 24 },
  quote: { color: '#cbd5e1', textAlign: 'center', marginVertical: 12 },
  big: { color: 'white', fontSize: 72, fontWeight: '900', marginTop: 10 },
  meta: { color: '#e2e8f0', fontSize: 16 },
  hint: { color: '#94a3b8', marginTop: 6 },

  circle: {
    width: 220,
    height: 220,
    borderRadius: 110,
    backgroundColor: '#6366f1',
    marginVertical: 24,
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 12,
    elevation: 6,
  },

  row: { flexDirection: 'row', gap: 10, marginTop: 12 },
  inputLabel: { color: '#94a3b8', marginTop: 4 },
  input: {
    backgroundColor: '#1e293b',
    color: 'white',
    borderRadius: 10,
    width: 90,
    textAlign: 'center',
    padding: 10,
  },
  btn: {
    backgroundColor: '#6366f1',
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: 10,
  },
  gray: { backgroundColor: '#475569' },
  red: { backgroundColor: '#ef4444' },
  btnText: { color: 'white', fontWeight: '700' },
});