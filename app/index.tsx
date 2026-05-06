import { getRandomQuote } from '@/constants/quotes';
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

export default function LandingPage() {
  const quote = getRandomQuote();

  return (
    <View style={styles.container}>
      <Text style={styles.title}>🧘 Japam Tracker</Text>
      <Text style={styles.subtitle}>Track your daily mantra practice</Text>

      <View style={styles.quoteCard}>
        <Text style={styles.quoteTitle}>Daily Quote</Text>
        <Text style={styles.quote}>“{quote}”</Text>
      </View>

      <Pressable style={styles.primaryBtn} onPress={() => router.push('/(tabs)')}>
        <Text style={styles.btnText}>Start Japam</Text>
      </Pressable>

      <Pressable style={styles.secondaryBtn} onPress={() => router.push('/(tabs)/manual')}>
        <Text style={styles.btnText}>Manual Entry</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f172a',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },

  title: {
    color: 'white',
    fontSize: 34,
    fontWeight: '800',
    textAlign: 'center',
    marginBottom: 14,
  },

  subtitle: {
    color: '#cbd5e1',
    fontSize: 17,
    textAlign: 'center',
    marginBottom: 24,
  },

  quoteCard: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: '#1e293b',
    borderColor: '#334155',
    borderWidth: 1,
    borderRadius: 16,
    padding: 18,
    marginBottom: 20,
  },

  quoteTitle: {
    color: '#a5b4fc',
    fontWeight: '700',
    marginBottom: 8,
  },

  quote: {
    color: '#e2e8f0',
    fontSize: 15,
  },

  primaryBtn: {
    width: '100%',
    maxWidth: 460,
    backgroundColor: '#6366f1',
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
    marginTop: 10,
  },

  secondaryBtn: {
    width: '100%',
    maxWidth: 460,
    backgroundColor: '#334155',
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
    marginTop: 14,
  },

  btnText: {
    color: 'white',
    fontWeight: '800',
    fontSize: 16,
  },
});