import AsyncStorage from '@react-native-async-storage/async-storage';
import { Audio } from 'expo-av';
import * as Haptics from 'expo-haptics';
import { useFocusEffect } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  Dimensions,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  Vibration,
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
const LAST_OPEN_DATE_KEY = 'lastOpenDate';

const SOUND_ENABLED_KEY = 'soundEnabled';
const VIBRATION_ENABLED_KEY = 'vibrationEnabled';
const USER_NAME_KEY = 'userName';
const screenWidth = Dimensions.get('window').width;
const isMobile = screenWidth < 500;

export default function JapamMain() {
  const [count, setCount] = useState(0);
  const [malas, setMalas] = useState(0);
  const [total, setTotal] = useState(0);

  const [seconds, setSeconds] = useState(0);
  const [minutesInput, setMinutesInput] = useState('1');
  const [targetSeconds, setTargetSeconds] = useState(60);
  const [isRunning, setIsRunning] = useState(false);
  const [loopTimer, setLoopTimer] = useState(false);

  const [japamName, setJapamName] = useState('Japam');
  const [nameInput, setNameInput] = useState('');
  const [showNameEditor, setShowNameEditor] = useState(false);

  const [userName, setUserName] = useState('');
  const [userNameInput, setUserNameInput] = useState('');
  const [showUserModal, setShowUserModal] = useState(false);

  const [quote, setQuote] = useState('');
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [vibrationEnabled, setVibrationEnabled] = useState(true);
  const pressAnim = useRef(new Animated.Value(0)).current;

  const fade = useRef(new Animated.Value(0)).current;
  const glowAnim = useRef(new Animated.Value(0)).current;

  useFocusEffect(
    useCallback(() => {
      const loadSettings = async () => {
        const savedSound = await AsyncStorage.getItem(SOUND_ENABLED_KEY);
        const savedVibration = await AsyncStorage.getItem(VIBRATION_ENABLED_KEY);

        setSoundEnabled(savedSound !== 'false');
        setVibrationEnabled(savedVibration !== 'false');
      };

      loadSettings();
    }, [])
  );

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
      const today = new Date().toISOString().split('T')[0];

      const rawHistory = await AsyncStorage.getItem(HISTORY_KEY);
      const history: Session[] = rawHistory ? JSON.parse(rawHistory) : [];

      const todayHistoryTotal = history
        .filter((item) => {
          const itemDate = new Date(item.date).toISOString().split('T')[0];
          return itemDate === today;
        })
        .reduce((sum, item) => sum + (Number(item.totalCount) || 0), 0);

      const lastOpenDate =
        (await AsyncStorage.getItem(LAST_OPEN_DATE_KEY)) || '';

      const savedCount = Number(
        (await AsyncStorage.getItem(COUNT_KEY)) || '0'
      );

      const savedMalas = Number(
        (await AsyncStorage.getItem(MALAS_KEY)) || '0'
      );

      const savedTotal = Number(
        (await AsyncStorage.getItem(TOTAL_KEY)) || '0'
      );

      const savedName = await AsyncStorage.getItem(JAPAM_NAME_KEY);
      const savedUserName = await AsyncStorage.getItem(USER_NAME_KEY);

      if (lastOpenDate && lastOpenDate !== today) {
        const previousTotal = savedTotal || savedMalas * 108 + savedCount;

        if (previousTotal > 0) {
          const existingForLastDate = history
            .filter((item) => {
              const itemDate = new Date(item.date).toISOString().split('T')[0];
              return itemDate === lastOpenDate;
            })
            .reduce((sum, item) => sum + (Number(item.totalCount) || 0), 0);

          const missingTotal = Math.max(0, previousTotal - existingForLastDate);

          if (missingTotal > 0) {
            const extraSession: Session = {
              date: `${lastOpenDate}T12:00:00.000Z`,
              malas: Math.floor(missingTotal / 108),
              totalCount: missingTotal,
              duration: 0,
              manual: true,
            };

            await AsyncStorage.setItem(
              HISTORY_KEY,
              JSON.stringify([extraSession, ...history])
            );
          }
        }

        setCount(0);
        setMalas(0);
        setTotal(0);

        await AsyncStorage.setItem(COUNT_KEY, '0');
        await AsyncStorage.setItem(MALAS_KEY, '0');
        await AsyncStorage.setItem(TOTAL_KEY, '0');
        await AsyncStorage.setItem(LAST_OPEN_DATE_KEY, today);
      } else {
        const restoredTotal = Math.max(
          savedTotal,
          todayHistoryTotal,
          savedMalas * 108 + savedCount
        );

        const restoredMalas = Math.floor(restoredTotal / 108);
        const restoredCount = restoredTotal % 108;

        setCount(restoredCount);
        setMalas(restoredMalas);
        setTotal(restoredTotal);

        await AsyncStorage.setItem(LAST_OPEN_DATE_KEY, today);
        await AsyncStorage.setItem(COUNT_KEY, String(restoredCount));
        await AsyncStorage.setItem(MALAS_KEY, String(restoredMalas));
        await AsyncStorage.setItem(TOTAL_KEY, String(restoredTotal));
      }

      if (savedName) {
        setJapamName(savedName);
        setNameInput(savedName);
      }

      if (savedUserName) {
        setUserName(savedUserName);
        setUserNameInput(savedUserName);
      } else {
        setShowUserModal(true);
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

  const playCompleteSound = async () => {
    try {
      const { sound } = await Audio.Sound.createAsync(
        require('../../assets/notification.wav'),
        { shouldPlay: true, volume: 1.0 }
      );

      setTimeout(async () => {
        await sound.unloadAsync();
      }, 3000);
    } catch (error) {
      console.log('Sound error:', error);
    }
  };

  const saveSession = async (
    duration: number,
    sessionMalas: number,
    sessionTotal: number
  ) => {
    const raw = await AsyncStorage.getItem(HISTORY_KEY);
    const history: Session[] = raw ? JSON.parse(raw) : [];

    const session: Session = {
      date: new Date().toISOString(),
      malas: sessionMalas,
      totalCount: sessionTotal,
      duration,
      manual: false,
    };

    await AsyncStorage.setItem(
      HISTORY_KEY,
      JSON.stringify([session, ...history])
    );
  };

  const playCompletionAnimation = () => {
    glowAnim.setValue(0);

    Animated.sequence([
      Animated.timing(glowAnim, {
        toValue: 1,
        duration: 300,
        useNativeDriver: false,
      }),
      Animated.timing(glowAnim, {
        toValue: 0,
        duration: 300,
        useNativeDriver: false,
      }),
      Animated.timing(glowAnim, {
        toValue: 1,
        duration: 300,
        useNativeDriver: false,
      }),
      Animated.timing(glowAnim, {
        toValue: 0,
        duration: 500,
        useNativeDriver: false,
      }),
    ]).start();
  };

  const tapFeedback = () => {
    if (Platform.OS !== 'web' && vibrationEnabled) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
  };

  const completeFeedback = async () => {
    playCompletionAnimation();

    if (Platform.OS !== 'web' && vibrationEnabled) {
      await Haptics.notificationAsync(
        Haptics.NotificationFeedbackType.Success
      );

      Vibration.vibrate([0, 400, 150, 400, 150, 700]);
    }

    if (soundEnabled) {
      void playCompleteSound();
    }
  };

  const handleUndo = () => {
    setTotal((prevTotal) => {
      const newTotal = Math.max(0, prevTotal - 1);

      setMalas(Math.floor(newTotal / 108));
      setCount(newTotal % 108);

      return newTotal;
    });
  };
  const playPressAnimation = () => {
    pressAnim.setValue(0);
  
    Animated.sequence([
      Animated.timing(pressAnim, {
        toValue: 1,
        duration: 120,
        useNativeDriver: true,
      }),
      Animated.timing(pressAnim, {
        toValue: 0,
        duration: 260,
        useNativeDriver: true,
      }),
    ]).start();
  };
  const handleTap = () => {
    playPressAnimation();
    tapFeedback();

    setTotal((prevTotal) => {
      const newTotal = prevTotal + 1;
      const newMalas = Math.floor(newTotal / 108);
      const newCount = newTotal % 108;

      setMalas(newMalas);
      setCount(newCount);

      if (newCount === 0) {
        saveSession(0, 1, 108);
        completeFeedback();
      }

      return newTotal;
    });
  };

  const handleStart = () => {
    const mins = Math.max(1, Math.floor(Number(minutesInput) || 1));

    setMinutesInput(String(mins));
    setTargetSeconds(mins * 60);
    setSeconds(0);
    setIsRunning(true);
  };

  const handlePause = () => {
    setIsRunning(false);
  };

  const handleStop = () => {
    setIsRunning(false);
    setSeconds(0);
  };

  const completeTimerSession = () => {
    setTotal((prevTotal) => {
      const newTotal = prevTotal + 108;

      setMalas(Math.floor(newTotal / 108));
      setCount(newTotal % 108);

      return newTotal;
    });

    saveSession(targetSeconds, 1, 108);
    completeFeedback();

    if (loopTimer) {
      setSeconds(0);
      setIsRunning(true);
    } else {
      setSeconds(0);
      setIsRunning(false);
    }
  };

  const saveJapamName = async () => {
    const name = nameInput.trim();

    if (!name) return;

    setJapamName(name);
    setShowNameEditor(false);

    await AsyncStorage.setItem(JAPAM_NAME_KEY, name);
  };

  const saveUserName = async () => {
    const name = userNameInput.trim();

    if (!name) return;

    setUserName(name);
    setShowUserModal(false);

    await AsyncStorage.setItem(USER_NAME_KEY, name);
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
      <View style={styles.topBar}>
      <View style={styles.headerCenter}>
  <Pressable onPress={openRename}>
    <Text style={styles.title}>🧘 {japamName}</Text>
  </Pressable>

  {!!userName && (
  <View
    style={[
      styles.userBadge,
      isMobile
        ? styles.mobileUserBadge
        : styles.desktopUserBadge,
    ]}
  >
    <Text style={styles.userBadgeText}>🙏 {userName}</Text>
  </View>
)}

  <Text style={styles.renameHint}>Tap name to rename</Text>
</View>
      
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

      <View style={styles.progressBarBackground}>
        <View
          style={[
            styles.progressBarFill,
            {
              width: `${(count / 108) * 100}%`,
            },
          ]}
        />
      </View>

      <Text style={styles.progressText}>{count} / 108</Text>
      

      <View style={styles.metricsRow}>
        <Text style={styles.metricText}>📿 {malas} malas</Text>

        <Text style={[styles.metricText, isRunning && styles.timerRunningText]}>
          ⏱ {formatTime(seconds)}
        </Text>

        <Text style={styles.metricText}>Total {total}</Text>
      </View>

      <Animated.View
  style={[
    styles.circleGlow,
    {
      shadowOpacity: glowAnim.interpolate({
        inputRange: [0, 1],
        outputRange: [0.25, 0.9],
      }),
      transform: [
        {
          scale: glowAnim.interpolate({
            inputRange: [0, 1],
            outputRange: [1, 1.08],
          }),
        },
      ],
    },
  ]}
>
  <Pressable
    onPress={handleTap}
    style={({ pressed }) => [
      styles.circle,
      pressed && styles.circlePressed,
    ]}
  >
    <Animated.View
      style={[
        styles.innerBead,
        {
          opacity: pressAnim.interpolate({
            inputRange: [0, 1],
            outputRange: [0, 1],
          }),
          transform: [
            {
              scale: pressAnim.interpolate({
                inputRange: [0, 1],
                outputRange: [0.4, 1.25],
              }),
            },
          ],
        },
      ]}
    />
  </Pressable>
</Animated.View>
<Pressable style={styles.undoBtn} onPress={handleUndo}>
  <Text style={styles.undoText}>Undo last tap</Text>
</Pressable>

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

      <View style={styles.autoRepeatRow}>
        <Text style={styles.autoRepeatText}>Auto Repeat Timer</Text>
        <Switch value={loopTimer} onValueChange={setLoopTimer} />
      </View>

      <View style={styles.row}>
        <Pressable style={styles.btn} onPress={handleStart}>
          <Text style={styles.btnText}>Start</Text>
        </Pressable>

        <Pressable style={[styles.btn, styles.gray]} onPress={handlePause}>
          <Text style={styles.btnText}>Pause</Text>
        </Pressable>

        <Pressable style={[styles.btn, styles.red]} onPress={handleStop}>
          <Text style={styles.btnText}>Stop</Text>
        </Pressable>
      </View>

      <Modal visible={showUserModal} transparent animationType="fade">
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Welcome 🙏</Text>

            <Text style={styles.modalSubtitle}>
              What should we call you?
            </Text>

            <TextInput
              style={styles.modalInput}
              value={userNameInput}
              onChangeText={setUserNameInput}
              placeholder="Enter your name"
              placeholderTextColor="#94a3b8"
            />

            <Pressable style={styles.modalButton} onPress={saveUserName}>
              <Text style={styles.modalButtonText}>Continue</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
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
    paddingTop: 34,
    paddingBottom: 120,
  },

  topBar: {
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  
  headerCenter: {
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    marginBottom: 8,
  },

  userBadge: {
    backgroundColor: '#1e293b',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#334155',
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 6,
    elevation: 4,
  },
  desktopUserBadge: {
    position: 'absolute',
    right: 45,
    top: 12,
  },
  
  mobileUserBadge: {
    marginTop: 10,
  },
  
  userBadgeText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '800',
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
    fontSize: 16,
    maxWidth: 560,
  },

  dateText: {
    color: '#94a3b8',
    fontSize: 14,
    marginBottom: 4,
  },

  big: {
    color: 'white',
    fontSize: 68,
    fontWeight: '900',
    marginTop: 0,
  },

  progressBarBackground: {
    width: 220,
    height: 6,
    backgroundColor: '#1e293b',
    borderRadius: 999,
    overflow: 'hidden',
    marginBottom: 8,
    alignSelf: 'center',
  },

  progressBarFill: {
    height: '100%',
    backgroundColor: '#6366f1',
    borderRadius: 999,
  },

  progressText: {
    color: '#94a3b8',
    fontSize: 13,
    marginBottom: 8,
  },

  metricsRow: {
    width: '100%',
    maxWidth: 440,
    flexDirection: 'row',
    justifyContent: 'space-evenly',
    alignItems: 'center',
    marginTop: 6,
    marginBottom: 2,
  },

  metricText: {
    color: '#e2e8f0',
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
  },

  timerRunningText: {
    fontSize: 24,
    color: 'white',
    fontWeight: '900',
  },

  circleGlow: {
    borderRadius: 100,
    shadowColor: '#818cf8',
    shadowRadius: 18,
    elevation: 10,
  },

  circle: {
    width: 190,
    height: 190,
    borderRadius: 95,
    backgroundColor: '#6366f1',
    alignSelf: 'center',
    marginTop: 14,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 12,
    elevation: 6,
  },

  circlePressed: {
    transform: [{ scale: 0.96 }],
  },

  undoBtn: {
    backgroundColor: '#334155',
    paddingVertical: 9,
    paddingHorizontal: 17,
    borderRadius: 999,
    marginBottom: 10,
  },

  undoText: {
    color: 'white',
    fontSize: 14,
    fontWeight: '700',
  },

  inputLabel: {
    color: '#94a3b8',
    fontSize: 13,
    marginBottom: 6,
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

  autoRepeatRow: {
    width: 220,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    marginTop: 10,
  },

  autoRepeatText: {
    color: '#cbd5e1',
    fontSize: 15,
    fontWeight: '700',
  },

  row: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 10,
  },

  btn: {
    backgroundColor: '#6366f1',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 10,
    minWidth: 86,
    alignItems: 'center',
  },

  gray: {
    backgroundColor: '#475569',
  },

  red: {
    backgroundColor: '#991b1b',
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
    fontSize: 16,
  },

  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.65)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
  },

  modalCard: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: '#1e293b',
    borderRadius: 20,
    padding: 24,
    borderWidth: 1,
    borderColor: '#334155',
  },

  modalTitle: {
    color: 'white',
    fontSize: 24,
    fontWeight: '800',
    marginBottom: 8,
    textAlign: 'center',
  },

  modalSubtitle: {
    color: '#cbd5e1',
    fontSize: 15,
    textAlign: 'center',
    marginBottom: 18,
  },

  modalInput: {
    backgroundColor: '#0f172a',
    color: 'white',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 18,
    fontSize: 16,
  },

  modalButton: {
    backgroundColor: '#6366f1',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },

  modalButtonText: {
    color: 'white',
    fontWeight: '800',
    fontSize: 16,
  },
  innerBead: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: 'rgba(255,255,255,0.35)',
    alignSelf: 'center',
    marginTop: 78,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.55)',
  },
  
});