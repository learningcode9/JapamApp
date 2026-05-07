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

import { getRandomQuote } from '@/constants/quotes';

type Session = {
  date: string;
  malas: number;
  totalCount: number;
  duration: number;
  manual?: boolean;
};

const COUNT_KEY = 'count';
const MALAS_KEY = 'malas';
const TOTAL_KEY = 'totalCount';
const HISTORY_KEY = 'history';
const JAPAM_NAME_KEY = 'japamName';

export default function JapamMain() {
  const [count, setCount] = useState(0);
  const [malas, setMalas] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const [minutesInput, setMinutesInput] = useState('1');
  const [targetSeconds, setTargetSeconds] = useState(60);
  const [isRunning, setIsRunning] = useState(false);

  const [japamName, setJapamName] = useState('Japam');
  const [nameInput, setNameInput] = useState('');
  const [showNameEditor, setShowNameEditor] = useState(false);

  const [quote, setQuote] = useState('');

  const fade = useRef(new Animated.Value(0)).current;

  const total = malas * 108 + count;

  useEffect(() => {
    setQuote(getRandomQuote());

    Animated.timing(fade, {
      toValue: 1,
      duration: 800,
      useNativeDriver: true,
    }).start();
  }, []);

  useEffect(() => {
    const loadData = async () => {
      const savedCount = await AsyncStorage.getItem(COUNT_KEY);
      const savedMalas = await AsyncStorage.getItem(MALAS_KEY);
      const savedName = await AsyncStorage.getItem(JAPAM_NAME_KEY);

      setCount(Number(savedCount ?? 0));
      setMalas(Number(savedMalas ?? 0));

      if (savedName) {
        setJapamName(savedName);
        setNameInput(savedName);
      }
    };

    loadData();
  }, []);

  useEffect(() => {
    AsyncStorage.setItem(COUNT_KEY, String(count));
    AsyncStorage.setItem(MALAS_KEY, String(malas));
    AsyncStorage.setItem(TOTAL_KEY, String(total));
  }, [count, malas, total]);

  useEffect(() => {
    if (!isRunning) return;

    const interval = setInterval(() => {
      setSeconds((prev) => prev + 1);
    }, 1000);

    return () => clearInterval(interval);
  }, [isRunning]);

  useEffect(() => {
    if (!isRunning) return;
    if (seconds < targetSeconds) return;

    completeTimerSession();
  }, [seconds, isRunning, targetSeconds]);

  const saveSession = async (duration: number, sessionMalas: number, sessionTotal: number) => {
    const raw = await AsyncStorage.getItem(HISTORY_KEY);
    const history: Session[] = raw ? JSON.parse(raw) : [];

    const session: Session = {
      date: new Date().toISOString(),
      malas: sessionMalas,
      totalCount: sessionTotal,
      duration,
      manual: false,
    };

    await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify([session, ...history]));
  };

  const tapFeedback = () => {
    if (Platform.OS !== 'web') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
  };

  const completeFeedback = () => {
    if (Platform.OS !== 'web') {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
  };

  const handleTap = () => {
    tapFeedback();

    setCount((prev) => {
      const next = prev + 1;

      if (next >= 108) {
        setMalas((m) => m + 1);
        saveSession(0, 1, 108);
        completeFeedback();
        return 0;
      }

      return next;
    });
  };

  const handleStart = () => {
    const mins = Math.max(1, Math.floor(Number(minutesInput) || 1));
    setMinutesInput(String(mins));
    setTargetSeconds(mins * 60);

    // pause tarvata start cheste seconds reset avvakudadhu
    setIsRunning(true);
  };

  const handlePause = () => {
    setIsRunning(false);
  };

  const completeTimerSession = () => {
    setIsRunning(false);
    setSeconds(0);

    setCount(0);
    setMalas((m) => m + 1);

    saveSession(targetSeconds, 1, 108);
    completeFeedback();
  };

  const saveJapamName = async () => {
    const name = nameInput.trim();
    if (!name) return;

    setJapamName(name);
    setShowNameEditor(false);
    await AsyncStorage.setItem(JAPAM_NAME_KEY, name);
  };

  const openRename = () => {
    setNameInput(japamName);
    setShowNameEditor(true);
  };

  const cancelRename = () => {
    setNameInput(japamName);
    setShowNameEditor(false);
  };

  const formatTime = (s: number) =>
    `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

  const todayLabel = new Date().toLocaleDateString();

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.headerCenter}>
        <Pressable onPress={openRename}>
          <Text style={styles.title}>🧘 {japamName}</Text>
        </Pressable>
        <Text style={styles.renameHint}>Tap name to rename</Text>
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

      <Animated.Text style={[styles.quote, { opacity: fade }]}>
        {quote}
      </Animated.Text>

      <Text style={styles.dateText}>Today: {todayLabel}</Text>

      <Text style={styles.big}>{count}</Text>

      <View style={styles.metricsRow}>
        <Text style={styles.metricText}>📿 {malas} malas</Text>

        <Text style={[styles.metricText, isRunning && styles.timerRunningText]}>
          ⏱ {formatTime(seconds)}
        </Text>

        <Text style={styles.metricText}>Total {total}</Text>
      </View>

      <Pressable
        onPress={handleTap}
        style={({ pressed }) => [
          styles.circle,
          pressed && styles.circlePressed,
        ]}
      />

      <Text style={styles.inputLabel}>Set time and start japam</Text>

      <TextInput
        style={styles.input}
        value={minutesInput}
        onChangeText={(value) => {
          setMinutesInput(value);
          setIsRunning(false);
          setSeconds(0);
        }}
        keyboardType="numeric"
      />

      <View style={styles.row}>
        <Pressable style={styles.btn} onPress={handleStart}>
          <Text style={styles.btnText}>Start</Text>
        </Pressable>

        <Pressable style={[styles.btn, styles.gray]} onPress={handlePause}>
          <Text style={styles.btnText}>Pause</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f172a',
  },

  content: {
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 44,
    paddingBottom: 120,
  },

  headerCenter: {
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    marginBottom: 12,
  },

  title: {
    color: 'white',
    fontSize: 34,
    fontWeight: '800',
    textAlign: 'center',
  },

  renameHint: {
    color: '#64748b',
    fontSize: 12,
    marginTop: 4,
  },

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
    color: '#cbd5e1',
    textAlign: 'center',
    marginTop: 4,
    marginBottom: 8,
    fontSize: 20,
    maxWidth: 560,
  },

  dateText: {
    color: '#94a3b8',
    fontSize: 15,
    marginBottom: 8,
  },

  big: {
    color: 'white',
    fontSize: 76,
    fontWeight: '900',
    marginTop: 2,
  },

  metricsRow: {
    width: '100%',
    maxWidth: 440,
    flexDirection: 'row',
    justifyContent: 'space-evenly',
    alignItems: 'center',
    marginTop: 8,
    marginBottom: 4,
  },

  metricText: {
    color: '#e2e8f0',
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
  },

  timerRunningText: {
    fontSize: 28,
    color: 'white',
    fontWeight: '900',
  },

  circle: {
    width: 220,
    height: 220,
    borderRadius: 110,
    backgroundColor: '#6366f1',
    alignSelf: 'center',
    marginTop: 22,
    marginBottom: 14,
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 12,
    elevation: 6,
  },

  circlePressed: {
    transform: [{ scale: 0.96 }],
  },

  inputLabel: {
    color: '#94a3b8',
    fontSize: 13,
    marginBottom: 2,
  },

  input: {
    backgroundColor: '#1e293b',
    color: 'white',
    borderRadius: 10,
    width: 110,
    textAlign: 'center',
    padding: 10,
    fontSize: 18,
  },

  row: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 10,
  },

  btn: {
    backgroundColor: '#6366f1',
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 10,
    minWidth: 100,
    alignItems: 'center',
  },

  gray: {
    backgroundColor: '#475569',
  },

  smallBtn: {
    backgroundColor: '#6366f1',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 10,
  },

  graySmallBtn: {
    backgroundColor: '#475569',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 10,
  },

  smallBtnText: {
    color: 'white',
    fontWeight: '700',
    fontSize: 14,
  },

  btnText: {
    color: 'white',
    fontWeight: '700',
    fontSize: 18,
  },
});