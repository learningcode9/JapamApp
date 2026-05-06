import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

type Session = { date: string; malas: number; totalCount: number; duration: number; manual?: boolean };

export default function ManualEntry() {
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [malas, setMalas] = useState('');
  const [total, setTotal] = useState('');

  const onSave = async () => {
    let malaNum = Number(malas || 0);
    let totalNum = Number(total || 0);
    if (malaNum > 0 && totalNum <= 0) totalNum = malaNum * 108;
    if (totalNum > 0 && malaNum <= 0) malaNum = Math.floor(totalNum / 108);
    if (malaNum <= 0 || totalNum <= 0) return Alert.alert('Enter malas or total count');

    const raw = await AsyncStorage.getItem('history');
    const history: Session[] = raw ? JSON.parse(raw) : [];
    const payload: Session = { date: new Date(date).toISOString(), malas: malaNum, totalCount: totalNum, duration: 0, manual: true };
    await AsyncStorage.setItem('history', JSON.stringify([payload, ...history]));
    Alert.alert('Saved', 'Manual entry added to history');
    setMalas(''); setTotal('');
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Manual Entry</Text>
      <TextInput style={styles.input} value={date} onChangeText={setDate} placeholder="YYYY-MM-DD" placeholderTextColor="#94a3b8" />
      <TextInput style={styles.input} value={malas} onChangeText={setMalas} keyboardType="numeric" placeholder="Malas" placeholderTextColor="#94a3b8" />
      <Text style={styles.or}>OR</Text>
      <TextInput style={styles.input} value={total} onChangeText={setTotal} keyboardType="numeric" placeholder="Total count" placeholderTextColor="#94a3b8" />
      <Pressable style={styles.btn} onPress={onSave}><Text style={styles.btnText}>Save</Text></Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a', padding: 20, alignItems: 'center' },
  title: { color: 'white', fontSize: 28, fontWeight: '800', marginVertical: 24 },
  input: { width: '100%', maxWidth: 360, backgroundColor: '#1e293b', color: 'white', borderRadius: 10, padding: 12, marginTop: 10 },
  or: { color: '#94a3b8', marginTop: 12 },
  btn: { marginTop: 16, backgroundColor: '#6366f1', borderRadius: 10, paddingVertical: 12, paddingHorizontal: 22 },
  btnText: { color: 'white', fontWeight: '700' },
});