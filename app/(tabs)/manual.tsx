import AsyncStorage from '@react-native-async-storage/async-storage';
import { LinearGradient } from 'expo-linear-gradient';
import { router, useFocusEffect } from 'expo-router';
import React, { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';


type Session = {
  date: string;
  malas: number;
  totalCount: number;
  duration: number;
  manual?: boolean;
  userId?: string;
};

const HISTORY_KEY = 'history';
const USER_ID_KEY = 'userId';
const USER_NAME_KEY = 'userName';

const clampNumber = (value: string, min: number, max: number) => {
  const parsed = Math.floor(Number(value) || min);
  return String(Math.min(max, Math.max(min, parsed)));
};

export default function ManualEntry() {
  const getLocalDateParts = () => {
    const d = new Date();
    return {
      year: String(d.getFullYear()),
      month: String(d.getMonth() + 1).padStart(2, '0'),
      day: String(d.getDate()).padStart(2, '0'),
    };
  };

  const today = getLocalDateParts();
  const [dateText, setDateText] = useState(`${today.year}-${today.month}-${today.day}`);
  const [year, setYear] = useState(today.year);
  const [month, setMonth] = useState(today.month);
  const [day, setDay] = useState(today.day);
  const [malas, setMalas] = useState('');
  const [total, setTotal] = useState('');
  const [userId, setUserId] = useState<string | null>(null);
  useFocusEffect(
    React.useCallback(() => {
      AsyncStorage.getItem(USER_ID_KEY).then(setUserId);
    }, [])
  );

  const adjustDatePart = (part: 'year' | 'month' | 'day', amount: number) => {
    setDateText('');

    if (part === 'year') {
      setYear((current) => clampNumber(String((Number(current) || Number(today.year)) + amount), 2020, 2100));
      return;
    }

    if (part === 'month') {
      setMonth((current) => clampNumber(String((Number(current) || Number(today.month)) + amount), 1, 12).padStart(2, '0'));
      return;
    }

    const safeYear = Number(year) || Number(today.year);
    const safeMonth = Number(month) || Number(today.month);
    const daysInMonth = new Date(safeYear, safeMonth, 0).getDate();
    setDay((current) => clampNumber(String((Number(current) || Number(today.day)) + amount), 1, daysInMonth).padStart(2, '0'));
  };

  const onSave = async () => {
    const userId = await AsyncStorage.getItem(USER_ID_KEY);

    // onSave లో — alert బదులు:
if (!userId) {
    Alert.alert(
      'Login Required',
      'Please sign in with Google to save your japam history.',
      [
        { text: 'Cancel', style: 'cancel' },
        { 
          text: 'Go to Sign In', 
          onPress: () => router.push('/') // main tab కి
        }
      ]
    );
    return;
  }

    const typedDateMatch = dateText.trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    const inputYear = typedDateMatch?.[1] || year;
    const inputMonth = typedDateMatch?.[2] || month;
    const inputDay = typedDateMatch?.[3] || day;

    const normalizedYear = clampNumber(inputYear, 2020, 2100);
    const normalizedMonth = clampNumber(inputMonth, 1, 12).padStart(2, '0');
    const daysInMonth = new Date(Number(normalizedYear), Number(normalizedMonth), 0).getDate();
    const normalizedDay = clampNumber(inputDay, 1, daysInMonth).padStart(2, '0');
    const selectedDate = `${normalizedYear}-${normalizedMonth}-${normalizedDay}`;
    const selectedDateTime = `${selectedDate}T12:00:00`;

    setDateText(selectedDate);
    setYear(normalizedYear);
    setMonth(normalizedMonth);
    setDay(normalizedDay);

    const malaInput = Number(malas || 0);
    const totalInput = Number(total || 0);

    let malaNum = 0;
    let totalNum = 0;

    if (malaInput > 0) {
      malaNum = malaInput;
      totalNum = malaInput * 108;
    } else if (totalInput > 0) {
      totalNum = totalInput;
      malaNum = Number((totalInput / 108).toFixed(2));
    } else {
      Alert.alert('Please enter malas or total count');
      return;
    }

    const raw = await AsyncStorage.getItem(HISTORY_KEY);
    const history: Session[] = raw ? JSON.parse(raw) : [];
    const userName = await AsyncStorage.getItem(USER_NAME_KEY);

    const payload: Session = {
      date: selectedDateTime,
      malas: malaNum,
      totalCount: totalNum,
      duration: 0,
      manual: true,
      userId,
    };

    await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify([payload, ...history]));

    try {
      const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
      const key = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

      if (url && key) {
        const response = await fetch(`${url}/rest/v1/japam_history`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey: key,
            Authorization: `Bearer ${key}`,
            Prefer: 'return=minimal',
          },
          body: JSON.stringify({
            user_id: userId,
            user_name: userName || 'User',
            malas: malaNum,
            count: totalNum,
            accumulated: totalNum,
            type: 'Manual',
            created_at: selectedDateTime,
          }),
        });

        if (!response.ok) {
          console.log('Supabase manual save error:', await response.text());
          Alert.alert(
            'Saved locally',
            'Your entry was saved on this device, but cloud sync failed.'
          );
        }
      }
    } catch (error) {
      console.log('Supabase manual save error:', error);
      Alert.alert(
        'Saved locally',
        'Your entry was saved on this device, but cloud sync failed.'
      );
    }

    Alert.alert('Saved', 'Manual entry added to history');

    setMalas('');
    setTotal('');

    router.push('/history');
  };

  return (
    <LinearGradient colors={['#05010c', '#120022', '#05010c']} style={styles.container}>
      {[...Array(30)].map((_, i) => (
        <View
          key={i}
          pointerEvents="none"
          style={[
            styles.star,
            {
              left: `${(i * 37 + 11) % 100}%`,
              top: `${(i * 53 + 7) % 100}%`,
              opacity: i % 3 === 0 ? 0.75 : 0.32,
            },
          ]}
        />
      ))}
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
      <View style={styles.panel}>
  

  <Text style={styles.title}>Manual Entry</Text>

  <Text style={styles.subtitle}>
    Add Japam completed outside the app
  </Text>

  {!userId && (
    <Text style={styles.loginHint}>
      Sign in with Google from the Japam screen to save entries.
    </Text>
  
)}

      <Text style={styles.fieldLabel}>Completed Date</Text>
      <TextInput
        style={styles.input}
        value={dateText}
        onChangeText={setDateText}
        placeholder="YYYY-MM-DD"
        placeholderTextColor="#94a3b8"
      />
      <Text style={styles.dateHelp}>Type date above or choose year, month, and day below.</Text>
      <View style={styles.dateRow}>
        <View style={styles.dateField}>
          <Text style={styles.dateLabel}>Year</Text>
          <View style={styles.dateInputRow}>
            <Pressable style={styles.dateStep} onPress={() => adjustDatePart('year', -1)}>
              <Text style={styles.dateStepText}>−</Text>
            </Pressable>
            <TextInput
              style={styles.dateInput}
              value={year}
              onChangeText={(value) => {
                setYear(value);
                setDateText('');
              }}
              keyboardType="numeric"
              maxLength={4}
              placeholder="2026"
              placeholderTextColor="#94a3b8"
            />
            <Pressable style={styles.dateStep} onPress={() => adjustDatePart('year', 1)}>
              <Text style={styles.dateStepText}>+</Text>
            </Pressable>
          </View>
        </View>

        <View style={styles.dateField}>
          <Text style={styles.dateLabel}>Month</Text>
          <View style={styles.dateInputRow}>
            <Pressable style={styles.dateStep} onPress={() => adjustDatePart('month', -1)}>
              <Text style={styles.dateStepText}>−</Text>
            </Pressable>
            <TextInput
              style={styles.dateInput}
              value={month}
              onChangeText={(value) => {
                setMonth(value);
                setDateText('');
              }}
              keyboardType="numeric"
              maxLength={2}
              placeholder="05"
              placeholderTextColor="#94a3b8"
            />
            <Pressable style={styles.dateStep} onPress={() => adjustDatePart('month', 1)}>
              <Text style={styles.dateStepText}>+</Text>
            </Pressable>
          </View>
        </View>

        <View style={styles.dateField}>
          <Text style={styles.dateLabel}>Day</Text>
          <View style={styles.dateInputRow}>
            <Pressable style={styles.dateStep} onPress={() => adjustDatePart('day', -1)}>
              <Text style={styles.dateStepText}>−</Text>
            </Pressable>
            <TextInput
              style={styles.dateInput}
              value={day}
              onChangeText={(value) => {
                setDay(value);
                setDateText('');
              }}
              keyboardType="numeric"
              maxLength={2}
              placeholder="12"
              placeholderTextColor="#94a3b8"
            />
            <Pressable style={styles.dateStep} onPress={() => adjustDatePart('day', 1)}>
              <Text style={styles.dateStepText}>+</Text>
            </Pressable>
          </View>
        </View>
      </View>

      <TextInput
        style={styles.input}
        value={malas}
        onChangeText={setMalas}
        keyboardType="numeric"
        placeholder="Malas"
        placeholderTextColor="#94a3b8"
      />

      <Text style={styles.or}>OR</Text>

      <TextInput
        style={styles.input}
        value={total}
        onChangeText={setTotal}
        keyboardType="numeric"
        placeholder="Total count"
        placeholderTextColor="#94a3b8"
      />

      <Pressable style={styles.btn} onPress={onSave}>
        <Text style={styles.btnText}>Save</Text>
      </Pressable>
      </View>
      </ScrollView>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },

  scroll: {
    flex: 1,
    width: '100%',
  },

  scrollContent: {
    flexGrow: 1,
    padding: 18,
    alignItems: 'center',
    justifyContent: 'center',
    paddingBottom: 120,
  },

  star: {
    position: 'absolute',
    width: 2,
    height: 2,
    borderRadius: 99,
    backgroundColor: 'white',
  },

  panel: {
    width: '100%',
    maxWidth: 560,
    alignItems: 'center',
    backgroundColor: 'rgba(15, 23, 42, 0.66)',
    borderWidth: 1,
    borderColor: 'rgba(251, 191, 36, 0.18)',
    borderRadius: 18,
    padding: 26,
  },

  fieldLabel: {
    width: '100%',
    maxWidth: 360,
    color: '#f8fafc',
    fontSize: 18,
    fontWeight: '800',
    marginTop: 6,
    marginBottom: 8,
  },

  dateRow: {
    width: '100%',
    maxWidth: 360,
    flexDirection: 'row',
    gap: 10,
    marginBottom: 4,
  },

  dateHelp: {
    width: '100%',
    maxWidth: 360,
    color: '#94a3b8',
    fontSize: 14,
    lineHeight: 20,
    marginTop: 6,
    marginBottom: 10,
  },

  dateField: {
    flex: 1,
  },

  dateLabel: {
    color: '#cbd5e1',
    fontSize: 14,
    fontWeight: '800',
    marginBottom: 6,
  },

  dateInput: {
    flex: 1,
    backgroundColor: '#1e293b',
    color: 'white',
    paddingVertical: 12,
    paddingHorizontal: 4,
    textAlign: 'center',
    fontSize: 18,
    fontWeight: '800',
  },

  dateInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    overflow: 'hidden',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#334155',
    backgroundColor: '#1e293b',
  },

  dateStep: {
    width: 34,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    backgroundColor: '#334155',
  },

  dateStepText: {
    color: 'white',
    fontSize: 20,
    fontWeight: '900',
  },

  omMark: {
    color: '#fbbf24',
    fontSize: 48,
    fontWeight: '700',
    marginBottom: 4,
    textShadowColor: 'rgba(251,191,36,0.65)',
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 18,
  },

  title: {
    color: 'white',
    fontSize: 36,
    fontWeight: '900',
    marginBottom: 6,
  },

  subtitle: {
    color: '#cbd5e1',
    fontSize: 18,
    marginBottom: 14,
    textAlign: 'center',
  },

  input: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: '#1e293b',
    color: 'white',
    borderRadius: 10,
    padding: 14,
    marginTop: 10,
    borderWidth: 1,
    borderColor: '#334155',
  },

  or: {
    color: '#cbd5e1',
    marginTop: 12,
    fontSize: 18,
  },

  btn: {
    marginTop: 16,
    backgroundColor: '#7c3aed',
    borderRadius: 10,
    paddingVertical: 14,
    paddingHorizontal: 28,
  },

  btnText: {
    color: 'white',
    fontWeight: '900',
    fontSize: 20,
  },
  loginHint: {
    color: '#cbd5e1',
    fontSize: 15,
    textAlign: 'center',
    marginBottom: 18,
    lineHeight: 22,
    maxWidth: 320,
  },
  
});
