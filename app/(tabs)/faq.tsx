import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

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
    <View style={styles.container}>
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
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a', padding: 16 },
  title: { color: 'white', fontSize: 34, fontWeight: '800', marginTop: 4 },
  subtitle: { color: '#94a3b8', marginTop: 4, marginBottom: 14, fontSize: 16 },

  card: {
    backgroundColor: '#1e293b',
    borderRadius: 14,
    marginBottom: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: '#334155',
  },
  cardOpen: {
    borderColor: '#6366f1',
    backgroundColor: '#24324b',
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