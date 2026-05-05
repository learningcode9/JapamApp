import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

const faqs = [
  ['What is Japam?', 'Japam is repetitive chanting of a mantra with devotion and focus.'],
  [
    'What is a mala?',
    'A mala is a string of beads used to count mantra repetitions, usually 108 beads.',
  ],
  [
    'Why 108 count?',
    '108 is traditionally sacred in many spiritual practices and used as a complete cycle.',
  ],
  ['Does app save data?', 'Yes. Your data is stored offline in AsyncStorage on your device.'],
  ['Can I add manually?', 'Yes. Use the Manual tab to add japam done outside the app timer/tap flow.'],
];

export default function FAQ() {
  const [open, setOpen] = useState<number | null>(0);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>FAQ</Text>

      {faqs.map(([q, a], i) => (
        <View key={q} style={styles.item}>
          <Pressable onPress={() => setOpen((prev) => (prev === i ? null : i))}>
            <Text style={styles.q}>{q}</Text>
          </Pressable>
          {open === i ? <Text style={styles.a}>{a}</Text> : null}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a', padding: 16 },
  title: { color: 'white', fontSize: 28, fontWeight: '800', marginVertical: 14 },
  item: {
    backgroundColor: '#1e293b',
    borderRadius: 12,
    marginBottom: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: '#334155',
  },
  q: { color: 'white', fontWeight: '700' },
  a: { color: '#cbd5e1', marginTop: 8, lineHeight: 22 },
});