import { LinearGradient } from 'expo-linear-gradient';
import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

const faqs = [
  {
    q: 'What is Japam?',
    a: 'Japam is the repetitive chanting of a mantra with devotion and focus.',
  },
  {
    q: 'What is a mala?',
    a: 'A mala is a string of beads used to count mantra repetitions. A full mala is usually 108 repetitions.',
  },
  {
    q: 'Why 108 count?',
    a: 'The number 108 is considered spiritually significant in many traditions and is treated as one complete chanting cycle.',
  },
  {
    q: 'How does the blue button work?',
    a: 'Each tap on the blue button increases the count by 1. When count reaches 108, it resets to 0 and adds 1 mala.',
  },
  {
    q: 'How do I use the timer?',
    a: 'Enter minutes, tap Apply, then tap Start. When the timer ends, the session is saved automatically.',
  },
  {
    q: 'What is Auto Repeat Timer?',
    a:'Auto Repeat Timer is useful when you chant by time. After the timer finishes, the app saves one mala, plays completion sound, and automatically starts the next timer. It continues until you press Stop.',
  },
  {
    q: 'Does the app save data?',
    a: 'Yes. Your data is stored locally on your device using AsyncStorage and works offline.',
  },
  {
    q: 'Can I add data manually?',
    a: 'Yes. Use the Manual tab to add japam done outside the app.',
  },
];

export default function FAQ() {
  const [open, setOpen] = useState<number | null>(0);

  return (
    <LinearGradient colors={['#05010c', '#120022', '#05010c']} style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
      <Text style={styles.title}>FAQ</Text>
      <Text style={styles.subtitle}>Frequently asked questions</Text>

      {faqs.map((item, i) => {
        const isOpen = open === i;
        return (
          <View key={item.q} style={[styles.card, isOpen && styles.cardOpen]}>
            <Pressable style={styles.questionRow} onPress={() => setOpen((p) => (p === i ? null : i))}>
              <Text style={styles.q}>{item.q}</Text>
              <Text style={styles.icon}>{isOpen ? '−' : '+'}</Text>
            </Pressable>
            {isOpen ? <Text style={styles.a}>{item.a}</Text> : null}
          </View>
        );
      })}
      </ScrollView>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: 18, paddingBottom: 120 },
  title: { color: 'white', fontSize: 30, fontWeight: '900', marginTop: 4 },
  subtitle: { color: '#cbd5e1', marginTop: 4, marginBottom: 14, fontSize: 16 },

  card: {
    backgroundColor: 'rgba(15, 23, 42, 0.72)',
    borderRadius: 14,
    marginBottom: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: 'rgba(251, 191, 36, 0.16)',
  },
  cardOpen: {
    borderColor: '#f59e0b',
    backgroundColor: 'rgba(36, 50, 75, 0.82)',
  },

  questionRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },

  q: { color: 'white', fontWeight: '700', fontSize: 17, flex: 1, paddingRight: 10 },
  icon: { color: '#a5b4fc', fontSize: 24, fontWeight: '700' },
  a: { color: '#cbd5e1', marginTop: 10, lineHeight: 24, fontSize: 16 },
});
