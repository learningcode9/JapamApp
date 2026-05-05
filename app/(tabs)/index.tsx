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
  dateKey: string;
  dateLabel: string;
  malas: number;
  totalCount: number;
};

const HISTORY_KEY = 'history';
const JAPAM_NAME_KEY = 'japam_name';

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
      dateKey?: unknown;
      dateLabel?: unknown;
      date?: unknown;
      mala?: unknown;
      malas?: unknown;
      totalCount?: unknown;
      count?: unknown;
    };

    let safeDate: Date | null = null;
    if (
      typeof rawItem.dateKey === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/.test(rawItem.dateKey)
    ) {
      safeDate = new Date(`${rawItem.dateKey}T00:00:00`);
    } else if (typeof rawItem.date === 'string') {
      const parsed = new Date(rawItem.date);
      if (!Number.isNaN(parsed.getTime())) safeDate = parsed;
    } else if (typeof rawItem.dateLabel === 'string') {
      const parsed = new Date(rawItem.dateLabel);
      if (!Number.isNaN(parsed.getTime())) safeDate = parsed;
    }

    if (!safeDate) return;

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
  const [japamName, setJapamName] = useState('Japam');
  const [pendingJapamName, setPendingJapamName] = useState('Japam');

  const [isLoading, setIsLoading] = useState(true);
  const [cooldown, setCooldown] = useState<number | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  const completionLockRef = useRef(false);

  const totalMalas = useMemo(
    () => history.reduce((sum, item) => sum + item.malas, 0),
    [history]
  );
  const currentCount = useMemo(() => count, [count]);

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
        const [savedHistory, savedName] = await Promise.all([
          AsyncStorage.getItem(HISTORY_KEY),
          AsyncStorage.getItem(JAPAM_NAME_KEY),
        ]);

        const parsed = savedHistory ? (JSON.parse(savedHistory) as unknown) : [];
        setHistory(normalizeHistory(parsed));

        if (savedName && savedName.trim().length > 0) {
          setJapamName(savedName.trim());
          setPendingJapamName(savedName.trim());
        }
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

        const [today] = updated.splice(existingIndex, 1);
        return [today, ...updated];
      });

      if (Platform.OS !== 'web') {
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
      }

      if (source === 'timer') {
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
      if (next >= 108) {
        void completeOneMala('tap');

        if (Platform.OS !== 'web') {
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        }

        return 0;
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

  const saveJapamName = async () => {
    const trimmed = pendingJapamName.trim();
    const safeName = trimmed.length > 0 ? trimmed : 'Japam';
    setJapamName(safeName);
    setPendingJapamName(safeName);
    await AsyncStorage.setItem(JAPAM_NAME_KEY, safeName);
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
      <Text style={styles.title}>🧘 {japamName}</Text>

      {pendingJapamName !== japamName ? (
        <View style={styles.nameRow}>
          <TextInput
            style={styles.nameInput}
            value={pendingJapamName}
            onChangeText={setPendingJapamName}
            placeholder="Japam name"
            placeholderTextColor="#94a3b8"
            maxLength={24}
          />
          <Pressable style={styles.btn} onPress={() => void saveJapamName()}>
            <Text style={styles.btnText}>Save</Text>
          </Pressable>
        </View>
      ) : (
        <Pressable style={styles.editNameBtn} onPress={() => setPendingJapamName('')}>
          <Text style={styles.editNameText}>Change Japam Name</Text>
        </Pressable>
      )}

      <View style={styles.center}>
        <Text style={styles.big}>{currentCount}</Text>
        <Text style={styles.label}>Current Count</Text>

        <View style={styles.row}>
          <Text style={styles.small}>⏱ {formatTime(seconds)}</Text>
          <Text style={styles.small}>📿 {isLoading ? '...' : totalMalas} malas</Text>
          <Text style={styles.small}>🔢 {isLoading ? '...' : totalMalas * 108} total</Text>
        </View>
        <Text style={styles.helperText}>Tap count resets at 108 (1 mala)</Text>
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

      <Text style={styles.inputLabel}>Session duration (minutes)</Text>
      <View style={styles.row}>
        <TextInput
          style={styles.input}
          value={minutesInput}
          onChangeText={setMinutesInput}
          keyboardType="numeric"
          maxLength={3}
        />
        <Pressable style={styles.btn} onPress={applyTime}>
          <Text style={styles.btnText}>Apply</Text>
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
      </View>

      <Pressable style={styles.historyToggle} onPress={() => setShowHistory(prev => !prev)}>
        <Text style={styles.btnText}>{showHistory ? 'Hide History' : 'Show History'}</Text>
      </Pressable>

      {showHistory && (
        <View style={styles.historyWrap}>
          <View style={styles.historyList}>
            <View style={styles.tableHeaderRow}>
              <Text style={[styles.tableHeaderText, styles.colDate]}>Date</Text>
              <Text style={[styles.tableHeaderText, styles.colCenter]}>Malas</Text>
              <Text style={[styles.tableHeaderText, styles.colCenter]}>Count</Text>
              <Text style={[styles.tableHeaderText, styles.colCenter]}>Cumulative</Text>
            </View>

            {historyWithCumulative.length === 0 ? (
              <View style={styles.emptyRow}>
                <Text style={styles.emptyText}>No history yet.</Text>
              </View>
            ) : (
              historyWithCumulative.map((item, i) => (
                <View key={`${item.dateKey}-${i}`} style={styles.tableRow}>
                  <Text style={[styles.tableCell, styles.colDate]}>{item.dateLabel}</Text>
                  <Text style={[styles.tableCell, styles.colCenter]}>{item.malas}</Text>
                  <Text style={[styles.tableCell, styles.colCenter]}>{item.totalCount}</Text>
                  <Text style={[styles.tableCell, styles.colCenter]}>
                    {item.cumulativeCount}
                  </Text>
                </View>
              ))
            )}
          </View>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f172a',
    paddingHorizontal: 16,
  },

  contentContainer: {
    paddingTop: 56,
    paddingBottom: 80,
    alignItems: 'center',
    width: '100%',
  },

  title: {
    color: 'white',
    fontSize: 28,
    marginBottom: 14,
    fontWeight: '700',
  },

  nameRow: {
    width: '100%',
    maxWidth: 420,
    flexDirection: 'row',
    gap: 10,
    marginBottom: 20,
  },

  nameInput: {
    flex: 1,
    backgroundColor: '#1e293b',
    color: 'white',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },

  center: {
    alignItems: 'center',
  },

  big: {
    color: 'white',
    fontSize: 56,
    fontWeight: '800',
  },

  label: {
    color: '#94a3b8',
    fontSize: 18,
  },

  small: {
    color: 'white',
    fontSize: 16,
  },

  helperText: {
    color: '#94a3b8',
    marginTop: 8,
    fontSize: 13,
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
    width: 90,
    borderRadius: 8,
    textAlign: 'center',
  },

  inputLabel: {
    color: '#94a3b8',
    marginTop: 4,
    fontSize: 13,
  },

  btn: {
    backgroundColor: '#6366f1',
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 8,
  },

  controls: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 10,
    marginTop: 15,
    marginBottom: 8,
  },

  start: {
    backgroundColor: '#6366f1',
    padding: 12,
    borderRadius: 10,
    minWidth: 100,
    alignItems: 'center',
  },

  pause: {
    backgroundColor: '#475569',
    padding: 12,
    borderRadius: 10,
    minWidth: 100,
    alignItems: 'center',
  },

  disabled: {
    opacity: 0.5,
  },

  btnText: {
    color: 'white',
    fontWeight: '600',
  },

  editNameBtn: {
    marginBottom: 20,
    backgroundColor: '#1e293b',
    borderWidth: 1,
    borderColor: '#334155',
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 8,
  },

  editNameText: {
    color: '#cbd5e1',
    fontWeight: '600',
  },

  historyWrap: {
    marginTop: 16,
    width: '100%',
    alignItems: 'center',
  },

  historyToggle: {
    marginTop: 16,
    backgroundColor: '#334155',
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: 10,
  },

  historyList: {
    marginTop: 8,
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
    fontSize: 13,
  },

  tableRow: {
    flexDirection: 'row',
    backgroundColor: '#1e293b',
    paddingVertical: 10,
    paddingHorizontal: 8,
    borderTopWidth: 1,
    borderTopColor: '#334155',
  },

  emptyRow: {
    backgroundColor: '#1e293b',
    paddingVertical: 18,
    alignItems: 'center',
  },

  emptyText: {
    color: '#94a3b8',
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