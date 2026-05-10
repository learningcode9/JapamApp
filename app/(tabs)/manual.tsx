import AsyncStorage from '@react-native-async-storage/async-storage';
import { router } from 'expo-router';
import React, { useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

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
      
      const [date, setDate] = useState(getLocalDate());
  const [malas, setMalas] = useState('');
  const [total, setTotal] = useState('');

  const onSave = async () => {
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
    const userId = await AsyncStorage.getItem(USER_ID_KEY);
    const userName = await AsyncStorage.getItem(USER_NAME_KEY);

    const payload: Session = {
      // Important: use midday local time to avoid timezone date shifting
      date: `${date}T12:00:00`,
      malas: malaNum,
      totalCount: totalNum,
      duration: 0,
      manual: true,
      userId: userId || undefined,
    };

    await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify([payload, ...history]));

    if (userId) {
      try {
        const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
        const key = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

        if (url && key) {
          const baseBody = {
            user_name: userName || 'User',
            malas: malaNum,
            count: totalNum,
            accumulated: totalNum,
          };

          const postHistory = async (body: Record<string, unknown>) => {
            const response = await fetch(`${url}/rest/v1/japam_history`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                apikey: key,
                Authorization: `Bearer ${key}`,
                Prefer: 'return=minimal',
              },
              body: JSON.stringify(body),
            });

            if (!response.ok) {
              console.log('Supabase manual save error:', await response.text());
              return false;
            }

            return true;
          };

          const savedWithUserId = await postHistory({
            user_id: userId,
            ...baseBody,
          });

          if (!savedWithUserId) {
            await postHistory(baseBody);
          }
        }
      } catch (error) {
        console.log('Supabase manual save error:', error);
      }
    }

    Alert.alert('Saved', 'Manual entry added to history');

    setMalas('');
    setTotal('');

    router.push('/history');
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Manual Entry</Text>

      <TextInput
        style={styles.input}
        value={date}
        onChangeText={setDate}
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
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f172a',
    padding: 20,
    alignItems: 'center',
  },

  title: {
    color: 'white',
    fontSize: 28,
    fontWeight: '800',
    marginVertical: 24,
  },

  input: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: '#1e293b',
    color: 'white',
    borderRadius: 10,
    padding: 12,
    marginTop: 10,
  },

  or: {
    color: '#94a3b8',
    marginTop: 12,
  },

  btn: {
    marginTop: 16,
    backgroundColor: '#6366f1',
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 22,
  },

  btnText: {
    color: 'white',
    fontWeight: '700',
  },
});
