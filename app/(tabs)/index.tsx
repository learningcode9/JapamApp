import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Haptics from 'expo-haptics';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

type DailyHistoryEntry = {
  dateKey: string; // YYYY-MM-DD
  dateLabel: string;
  malas: number;
  totalCount: number;
};

const HISTORY_KEY = 'history';

const sanitizeMinutes = (raw: string) => {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 1;
  return parsed;
};

const toFiniteNumber = (value: unknown) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
};

const toDateKey = (date: Date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const toDateLabel = (date: Date) => date.toLocaleDateString();

const normalizeHistory = (raw: unknown): DailyHistoryEntry[] => {
  if (!Array.isArray(raw)) return [];

  const grouped = new Map<string, DailyHistoryEntry>();

  raw.forEach(item => {
    const rawItem = item as {
      date?: unknown;
      mala?: unknown;
      malas?: unknown;
      totalCount?: unknown;
      count?: unknown;
    };

    const dateValue = typeof rawItem.date === 'string' ? new Date(rawItem.date) : new Date();
    const safeDate = Number.isNaN(dateValue.getTime()) ? new Date() : dateValue;
    const dateKey = toDateKey(safeDate);

    const malas = toFiniteNumber(rawItem.malas ?? rawItem.mala) ?? 1;
    const totalCount =
      toFiniteNumber(rawItem.totalCount ?? rawItem.count) ??
      Math.max(1, Math.floor(malas)) * 108;

    const existing = grouped.get(dateKey);
    if (existing) {
      existing.malas += Math.max(1, Math.floor(malas));
      existing.totalCount += Math.max(1, Math.floor(totalCount));
      return;
    }

    grouped.set(dateKey, {
      dateKey,
      dateLabel: toDateLabel(safeDate),
      malas: Math.max(1, Math.floor(malas)),
      totalCount: Math.max(1, Math.floor(totalCount)),
    });
  });

  return [...grouped.values()].sort((a, b) => b.dateKey.localeCompare(a.dateKey));
};

export default function Home() {
  const [count, setCount] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const [minutesInput, setMinutesInput] = useState('1');
  const [targetSeconds, setTargetSeconds] = useState(60);
  const [isRunning, setIsRunning] = useState(false);

  const [history, setHistory] = useState<DailyHistoryEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showHistory, setShowHistory] = useState(false);
  const [cooldown, setCooldown] = useState<number | null>(null);

  const completionLockRef = useRef(false);

  const totalMalas = useMemo(
    () => history.reduce((sum, item) => sum + item.malas, 0),
    [history]
  );
  const currentCount = useMemo(() => ((count % 108) + 108) % 108, [count]);

  const historyWithCumulative = useMemo(() => {
    let running = 0;
    const cumulativeByDate = new Map<string, number>();

    [...history]
      .sort((a, b) => a.dateKey.localeCompare(b.dateKey))
      .forEach(item => {
        running += item.totalCount;
        cumulativeByDate.set(item.dateKey, running);
      });

    return history.map(item => ({
      ...item,
      cumulativeCount: cumulativeByDate.get(item.dateKey) ?? item.totalCount,
    }));
  }, [history]);

  useEffect(() => {
    void (async () => {
      try {
        const saved = await AsyncStorage.getItem(HISTORY_KEY);
        const parsed = saved ? (JSON.parse(saved) as unknown) : [];
        setHistory(normalizeHistory(parsed));
      } finally {
        setIsLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (isLoading) return;
    void AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  }, [history, isLoading]);

  const completeOneMala = useCallback(
    async (source: 'tap' | 'timer') => {
      if (completionLockRef.current) return;
      completionLockRef.current = true;

      if (source === 'timer') {
        setIsRunning(false);
      }

      const now = new Date();
      const dateKey = toDateKey(now);

      setHistory(prev => {
        const existingIndex = prev.findIndex(entry => entry.dateKey === dateKey);

        if (existingIndex === -1) {
          return [
            {
              dateKey,
              dateLabel: toDateLabel(now),
              malas: 1,
              totalCount: 108,
            },
            ...prev,
          ];
        }

        const updated = [...prev];
        const current = updated[existingIndex];
        updated[existingIndex] = {
          ...current,
          malas: current.malas + 1,
          totalCount: current.totalCount + 108,
        };

        // Keep today's row on top after update.
        const [today] = updated.splice(existingIndex, 1);
        return [today, ...updated];
      });

      if (Platform.OS !== 'web') {
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }

      if (source === 'timer') {
        // Timer complete -> 1s pause -> auto reset timer only.
        setCooldown(1);
      } else {
        completionLockRef.current = false;
      }
    },
    []
  );

  useEffect(() => {
    if (!isRunning) return;

    const interval = setInterval(() => {
      setSeconds(prev => prev + 1);
    }, 1000);

    return () => clearInterval(interval);
  }, [isRunning]);

  useEffect(() => {
    if (!isRunning) return;
    if (seconds < targetSeconds) return;
    void completeOneMala('timer');
  }, [completeOneMala, isRunning, seconds, targetSeconds]);

  useEffect(() => {
    if (cooldown === null) return;

    if (cooldown <= 0) {
      setCooldown(null);
      setSeconds(0);
      completionLockRef.current = false;
      return;
    }

    const timer = setTimeout(() => {
      setCooldown(prev => (prev === null ? null : prev - 1));
    }, 1000);

    return () => clearTimeout(timer);
  }, [cooldown]);

  const onTap = () => {
    if (cooldown !== null || completionLockRef.current) return;

    setCount(prev => {
      if (completionLockRef.current) return prev;

      const next = prev + 1;
      if (next % 108 === 0) {
        void completeOneMala('tap');
      }

      if (Platform.OS !== 'web') {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      }

      return next;
    });
  };

  const applyTime = () => {
    const mins = sanitizeMinutes(minutesInput);
    setMinutesInput(String(mins));
    setTargetSeconds(mins * 60);
    setIsRunning(false);
    setSeconds(0);
    setCooldown(null);
    completionLockRef.current = false;
  };

  const startSession = () => {
    if (cooldown !== null) return;

    const mins = sanitizeMinutes(minutesInput);
    setMinutesInput(String(mins));
    setTargetSeconds(mins * 60);
    setSeconds(0);
    setIsRunning(true);
  };

  const pauseSession = () => {
    setIsRunning(false);
  };

  const resetSession = () => {
    setIsRunning(false);
    setSeconds(0);
    setCooldown(null);
    completionLockRef.current = false;
  };

  const formatTime = (sec: number) => {
    const safe = Number.isFinite(sec) && sec >= 0 ? sec : 0;
    const m = Math.floor(safe / 60);
    const s = safe % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.contentContainer}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={styles.title}>🧘 Japam</Text>

      <View style={styles.center}>
        <Text style={styles.big}>{currentCount}</Text>
        <Text style={styles.label}>Count</Text>

        <View style={styles.row}>
          <Text style={styles.small}>📿 {isLoading ? '...' : totalMalas}</Text>
          <Text style={styles.small}>⏱ {formatTime(seconds)}</Text>
        </View>

      </View>

      <Pressable
        style={({ pressed }) => [
          styles.circle,
          pressed && { transform: [{ scale: 0.96 }] },
          cooldown !== null && styles.disabled,
        ]}
        onPress={onTap}
        disabled={cooldown !== null}
      />

      <View style={styles.row}>
        <TextInput
          style={styles.input}
          value={minutesInput}
          onChangeText={setMinutesInput}
          keyboardType="numeric"
          maxLength={3}
        />
        <Pressable style={styles.btn} onPress={applyTime}>
          <Text style={styles.btnText}>Set</Text>
        </Pressable>
      </View>

      <View style={styles.controls}>
        <Pressable
          style={[styles.start, cooldown !== null && styles.disabled]}
          onPress={startSession}
          disabled={cooldown !== null}
        >
          <Text style={styles.btnText}>Start</Text>
        </Pressable>

        <Pressable style={styles.pause} onPress={pauseSession}>
          <Text style={styles.btnText}>Pause</Text>
        </Pressable>

        <Pressable style={styles.reset} onPress={resetSession}>
          <Text style={styles.btnText}>Reset</Text>
        </Pressable>
      </View>

      <Text style={styles.today}>Today Malas: {history[0]?.malas ?? 0}</Text>

      <Pressable
        style={styles.historyToggle}
        onPress={() => setShowHistory(prev => !prev)}
      >
        <Text style={styles.btnText}>{showHistory ? 'Hide History' : 'History'}</Text>
      </Pressable>

      {showHistory && (
        <View style={styles.historyList}>
          <View style={styles.tableHeaderRow}>
            <Text style={[styles.tableHeaderText, styles.colDate]}>Date</Text>
            <Text style={[styles.tableHeaderText, styles.colCenter]}>Malas</Text>
            <Text style={[styles.tableHeaderText, styles.colCenter]}>Count</Text>
            <Text style={[styles.tableHeaderText, styles.colCenter]}>Cumulative</Text>
          </View>

          {historyWithCumulative.map((item, i) => (
            <View key={`${item.dateKey}-${i}`} style={styles.tableRow}>
              <Text style={[styles.tableCell, styles.colDate]}>{item.dateLabel}</Text>
              <Text style={[styles.tableCell, styles.colCenter]}>{item.malas}</Text>
              <Text style={[styles.tableCell, styles.colCenter]}>{item.totalCount}</Text>
              <Text style={[styles.tableCell, styles.colCenter]}>
                {item.cumulativeCount}
              </Text>
            </View>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f172a',
    paddingHorizontal: 20,
  },

  contentContainer: {
    paddingTop: 60,
    paddingBottom: 120,
    alignItems: 'center',
    width: '100%',
  },

  title: {
    color: 'white',
    fontSize: 24,
    marginBottom: 20,
  },

  center: {
    alignItems: 'center',
  },

  big: {
    color: 'white',
    fontSize: 52,
    fontWeight: 'bold',
  },

  label: {
    color: '#94a3b8',
    fontSize: 22,
  },

  small: {
    color: 'white',
    fontSize: 18,
  },

  circle: {
    width: 220,
    height: 220,
    borderRadius: 110,
    backgroundColor: '#6366f1',
    alignSelf: 'center',
    marginVertical: 20,
  },

  row: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 10,
    marginTop: 10,
  },

  input: {
    backgroundColor: '#1e293b',
    color: 'white',
    padding: 10,
    width: 80,
    borderRadius: 8,
    textAlign: 'center',
  },

  btn: {
    backgroundColor: '#6366f1',
    padding: 10,
    borderRadius: 8,
  },

  controls: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 10,
    marginTop: 15,
  },

  start: {
    backgroundColor: '#6366f1',
    padding: 12,
    borderRadius: 10,
    minWidth: 84,
    alignItems: 'center',
  },

  pause: {
    backgroundColor: '#475569',
    padding: 12,
    borderRadius: 10,
    minWidth: 84,
    alignItems: 'center',
  },

  reset: {
    backgroundColor: '#ef4444',
    padding: 12,
    borderRadius: 10,
    minWidth: 84,
    alignItems: 'center',
  },

  disabled: {
    opacity: 0.5,
  },

  btnText: {
    color: 'white',
    fontWeight: '600',
  },

  today: {
    color: '#94a3b8',
    marginTop: 20,
    fontSize: 18,
  },

  historyToggle: {
    marginTop: 14,
    backgroundColor: '#334155',
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: 10,
  },

  historyList: {
    marginTop: 12,
    width: '100%',
    maxWidth: 500,
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#334155',
  },

  tableHeaderRow: {
    flexDirection: 'row',
    backgroundColor: '#334155',
    paddingVertical: 10,
    paddingHorizontal: 8,
  },

  tableHeaderText: {
    color: 'white',
    fontWeight: '700',
    fontSize: 14,
  },

  tableRow: {
    flexDirection: 'row',
    backgroundColor: '#1e293b',
    paddingVertical: 10,
    paddingHorizontal: 8,
    borderTopWidth: 1,
    borderTopColor: '#334155',
  },

  tableCell: {
    color: 'white',
    fontSize: 14,
  },

  colDate: {
    flex: 2,
  },

  colCenter: {
    flex: 1,
    textAlign: 'center',
  },
});