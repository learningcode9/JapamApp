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

export default function ManualEntry() {
  const getLocalDate = () => {
    const d = new Date();
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');

    return `${year}-${month}-${day}`;
  };

  const [dateText, setDateText] = useState(getLocalDate());
  const [malas, setMalas] = useState('');
  const [total, setTotal] = useState('');
  const [userId, setUserId] = useState<string | null>(null);
  useFocusEffect(
    React.useCallback(() => {
      AsyncStorage.getItem(USER_ID_KEY).then(setUserId);
    }, [])
  );

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
    if (!typedDateMatch) {
      Alert.alert('Invalid date', 'Please enter date as YYYY-MM-DD');
      return;
    }

    const selectedYear = Number(typedDateMatch[1]);
    const selectedMonth = Number(typedDateMatch[2]);
    const selectedDay = Number(typedDateMatch[3]);
    const selectedDate = `${typedDateMatch[1]}-${typedDateMatch[2].padStart(2, '0')}-${typedDateMatch[3].padStart(2, '0')}`;
    const selectedDateValue = new Date(selectedYear, selectedMonth - 1, selectedDay, 12);
    const isValidDate =
      selectedDateValue.getFullYear() === selectedYear &&
      selectedDateValue.getMonth() === selectedMonth - 1 &&
      selectedDateValue.getDate() === selectedDay;

    if (!isValidDate) {
      Alert.alert('Invalid date', 'Please enter a valid date');
      return;
    }

    const selectedDateTime = `${selectedDate}T12:00:00`;

    setDateText(selectedDate);

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
    <LinearGradient colors={['#e7f5f5', '#c7e2e0', '#eef8f5']} style={styles.container}>
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
    backgroundColor: '#0f766e',
  },

  panel: {
    width: '100%',
    maxWidth: 560,
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.56)',
    borderWidth: 1,
    borderColor: 'rgba(15, 118, 110, 0.16)',
    borderRadius: 24,
    padding: 26,
  },

  fieldLabel: {
    width: '100%',
    maxWidth: 360,
    color: '#12383c',
    fontSize: 18,
    fontWeight: '800',
    marginTop: 6,
    marginBottom: 8,
  },

  title: {
    color: '#102f34',
    fontSize: 36,
    fontWeight: '900',
    marginBottom: 6,
  },

  subtitle: {
    color: '#365f61',
    fontSize: 18,
    marginBottom: 14,
    textAlign: 'center',
  },

  input: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: 'rgba(255,255,255,0.68)',
    color: '#12383c',
    borderRadius: 12,
    padding: 14,
    marginTop: 10,
    borderWidth: 1,
    borderColor: 'rgba(15,118,110,0.16)',
  },

  or: {
    color: '#547071',
    marginTop: 12,
    fontSize: 18,
  },

  btn: {
    marginTop: 16,
    backgroundColor: '#0f8a87',
    borderRadius: 999,
    paddingVertical: 14,
    paddingHorizontal: 28,
  },

  btnText: {
    color: 'white',
    fontWeight: '900',
    fontSize: 20,
  },
  loginHint: {
    color: '#365f61',
    fontSize: 15,
    textAlign: 'center',
    marginBottom: 18,
    lineHeight: 22,
    maxWidth: 320,
  },
  
});
