import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { getDailyQuote } from '@/constants/quotes';

export default function Landing() {
  const quote = getDailyQuote();

  return (
    <LinearGradient colors={['#020617', '#0f172a', '#1e1b4b']} style={styles.container}>
      <View style={styles.card}>
        <Text style={styles.title}>🧘 Japam Tracker</Text>
        <Text style={styles.subtitle}>Track your daily mantra practice</Text>

        <View style={styles.quoteBox}>
          <Text style={styles.quoteTitle}>Daily Quote</Text>
          <Text style={styles.quoteText}>“{quote}”</Text>
        </View>

        <Pressable style={styles.button} onPress={() => router.push('/(tabs)')}>
          <Text style={styles.buttonText}>Start Japam</Text>
        </Pressable>

        <Pressable style={[styles.button, styles.secondary]} onPress={() => router.push('/(tabs)/manual')}>
          <Text style={styles.buttonText}>Manual Entry</Text>
        </Pressable>
      </View>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 20 },
  card: { width: '100%', maxWidth: 420, alignItems: 'center', gap: 14 },
  title: { color: 'white', fontSize: 34, fontWeight: '800', textAlign: 'center' },
  subtitle: { color: '#cbd5e1', fontSize: 16, textAlign: 'center' },
  quoteBox: { backgroundColor: '#1e293b', borderColor: '#334155', borderWidth: 1, borderRadius: 16, padding: 16 },
  quoteTitle: { color: '#a5b4fc', fontWeight: '700', marginBottom: 8 },
  quoteText: { color: '#e2e8f0', textAlign: 'center', lineHeight: 24 },
  button: { width: '100%', backgroundColor: '#6366f1', borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  secondary: { backgroundColor: '#334155' },
  buttonText: { color: 'white', fontWeight: '700', fontSize: 16 },
});