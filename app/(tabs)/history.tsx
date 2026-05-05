import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFocusEffect } from 'expo-router';
import React, { useCallback, useMemo, useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';

type Session = {
  date: string;
  malas: number;
  totalCount: number;
  duration: number;
  manual?: boolean;
};

export default function HistoryScreen() {
  const [history, setHistory] = useState<Session[]>([]);

  useFocusEffect(
    useCallback(() => {
      void (async () => {
        const raw = await AsyncStorage.getItem('history');
        setHistory(raw ? JSON.parse(raw) : []);
      })();
    }, [])
  );

  const totalMalas = useMemo(() => history.reduce((sum, item) => sum + item.malas, 0), [history]);
  const totalCount = useMemo(
    () => history.reduce((sum, item) => sum + item.totalCount, 0),
    [history]
  );

  return (
    <View style={styles.container}>
      <Text style={styles.title}>History</Text>
      <Text style={styles.summary}>
        📿 Total malas: {totalMalas}   🔢 Total count: {totalCount}
      </Text>

      <FlatList
        data={history}
        keyExtractor={(_, i) => String(i)}
        contentContainerStyle={{ paddingBottom: 30 }}
        renderItem={({ item }) => (
          <View style={styles.card}>
            <Text style={styles.text}>Date: {new Date(item.date).toLocaleString()}</Text>
            <Text style={styles.text}>Duration: {item.duration}s</Text>
            <Text style={styles.text}>Malas: {item.malas}</Text>
            <Text style={styles.text}>Total Count: {item.totalCount}</Text>
            {item.manual ? <Text style={styles.tag}>Manual Entry</Text> : null}
          </View>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a', padding: 16 },
  title: { color: 'white', fontSize: 28, fontWeight: '800', marginVertical: 14 },
  summary: { color: '#cbd5e1', marginBottom: 12 },
  card: {
    backgroundColor: '#1e293b',
    borderRadius: 12,
    padding: 12,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#334155',
  },
  text: { color: 'white', marginBottom: 4 },
  tag: { color: '#a5b4fc', fontWeight: '700', marginTop: 6 },
});