import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Haptics from 'expo-haptics';
import React, { useEffect, useState } from 'react';
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

export default function Home() {
  const [count, setCount] = useState(0);
  const [mala, setMala] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const [isRunning, setIsRunning] = useState(false);
  const [minutesInput, setMinutesInput] = useState('1');
  const [targetSeconds, setTargetSeconds] = useState(60);
  const [history, setHistory] = useState<any[]>([]);

  // ================= LOAD DATA =================
  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    const saved = await AsyncStorage.getItem('history');
    if (saved) {
      setHistory(JSON.parse(saved));
    }
  };

  const saveData = async (data: any) => {
    await AsyncStorage.setItem('history', JSON.stringify(data));
  };

  // ================= TIMER =================
  useEffect(() => {
    let interval: any;

    if (isRunning) {
      interval = setInterval(() => {
        setSeconds(prev => {
          const next = prev + 1;

          // ✅ TIMER COMPLETE
          if (next >= targetSeconds) {
            clearInterval(interval);
            setIsRunning(false);

            const newSession = {
              time: targetSeconds,
              count,
              mala,
              date: new Date().toLocaleString(),
            };

            const updatedHistory = [newSession, ...history];
            setHistory(updatedHistory);
            saveData(updatedHistory);

            // vibration
            if (Platform.OS !== 'web') {
              Haptics.notificationAsync(
                Haptics.NotificationFeedbackType.Success
              );
            }

            // reset
            setTimeout(() => {
              setSeconds(0);
              setCount(0);
              setMala(0);
            }, 100);

            return 0;
          }

          return next;
        });
      }, 1000);
    }

    return () => clearInterval(interval);
  }, [isRunning]);

  // ================= TAP =================
  const onTap = () => {
    setCount(prev => {
      if (prev === 107) {
        setMala(m => m + 1);

        if (Platform.OS !== 'web') {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        }

        return 0;
      }

      return prev + 1;
    });

    if (Platform.OS !== 'web') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
  };

  // ================= SET TIME =================
  const applyTime = () => {
    const mins = parseInt(minutesInput) || 1;
    setTargetSeconds(mins * 60);

    setSeconds(0);
    setCount(0);
    setMala(0);
    setIsRunning(false);
  };

  // ================= FORMAT TIME =================
  const formatTime = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  return (
    <ScrollView style={styles.container}>
      <Text style={styles.title}>🧘 Japam</Text>

      {/* STATS */}
      <View style={styles.center}>
        <Text style={styles.big}>{count}</Text>
        <Text style={styles.label}>Count</Text>

        <View style={styles.row}>
          <Text style={styles.small}>📿 {mala}</Text>
          <Text style={styles.small}>⏱ {formatTime(seconds)}</Text>
        </View>
      </View>

      {/* TAP BUTTON */}
      <Pressable
        style={({ pressed }) => [
          styles.circle,
          pressed && { transform: [{ scale: 0.9 }] },
        ]}
        onPress={onTap}
      />

      {/* TIME INPUT */}
      <View style={styles.row}>
        <TextInput
          style={styles.input}
          value={minutesInput}
          onChangeText={setMinutesInput}
          keyboardType="numeric"
        />
        <Pressable style={styles.btn} onPress={applyTime}>
          <Text style={styles.btnText}>Set</Text>
        </Pressable>
      </View>

      {/* CONTROLS */}
      <View style={styles.controls}>
        <Pressable style={styles.start} onPress={() => setIsRunning(true)}>
          <Text style={styles.btnText}>Start</Text>
        </Pressable>

        <Pressable style={styles.pause} onPress={() => setIsRunning(false)}>
          <Text style={styles.btnText}>Pause</Text>
        </Pressable>

        <Pressable
          style={styles.reset}
          onPress={() => {
            setIsRunning(false);
            setSeconds(0);
            setCount(0);
            setMala(0);
          }}
        >
          <Text style={styles.btnText}>Reset</Text>
        </Pressable>
      </View>

      {/* TODAY */}
      <Text style={styles.today}>
        Today: {history.reduce((sum, h) => sum + h.count, 0)}
      </Text>

      {/* HISTORY */}
      {history.map((item, i) => (
        <View key={i} style={styles.card}>
          <Text style={styles.historyText}>
            ⏱ {formatTime(item.time)} • 🔢 {item.count} • 📿 {item.mala}
          </Text>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f172a',
    padding: 20,
  },

  title: {
    color: 'white',
    textAlign: 'center',
    fontSize: 24,
    marginBottom: 20,
  },

  center: {
    alignItems: 'center',
  },

  big: {
    color: 'white',
    fontSize: 42,
    fontWeight: 'bold',
  },

  label: {
    color: '#94a3b8',
  },

  small: {
    color: 'white',
    fontSize: 16,
  },

  circle: {
    width: 150,
    height: 150,
    borderRadius: 75,
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
    padding: 10,
    borderRadius: 8,
  },

  pause: {
    backgroundColor: '#475569',
    padding: 10,
    borderRadius: 8,
  },

  reset: {
    backgroundColor: '#ef4444',
    padding: 10,
    borderRadius: 8,
  },

  btnText: {
    color: 'white',
  },

  today: {
    color: '#94a3b8',
    textAlign: 'center',
    marginTop: 20,
  },

  card: {
    backgroundColor: '#1e293b',
    padding: 10,
    borderRadius: 10,
    marginTop: 10,
  },

  historyText: {
    color: 'white',
  },
});