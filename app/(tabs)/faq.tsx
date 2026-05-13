import { LinearGradient } from 'expo-linear-gradient';
import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

const faqs = [
    {
      q: 'What is Japam?',
      a: 'Japam is the repetitive chanting of a mantra with devotion, focus, and spiritual intention.',
    },
    {
      q: 'What is a mala?',
      a: 'A mala is a string of prayer beads used to count mantra repetitions. One full mala usually contains 108 chants.',
    },
    {
      q: 'Why is 108 important?',
      a: 'The number 108 is spiritually significant in many traditions and is treated as one complete cycle of chanting.',
    },
    {
      q: 'How does the count circle work?',
      a: 'Each tap on the calm progress circle increases the count by 1. When the count reaches 108, the app completes one mala and starts the next cycle.',
    },
    {
      q: 'How do I use the timer?',
      a: 'Enter the number of minutes and tap Start. When the timer finishes, one mala is automatically added to your progress.',
    },
    {
      q: 'What is Auto Repeat Timer?',
      a: 'Auto Repeat Timer is useful for continuous chanting sessions. After each timer completes, the app automatically adds one mala and starts the next session until paused.',
    },
    {
      q: 'Does the app save my progress?',
      a: 'Yes. After signing in, your japam count, timer progress, and history sync across devices using cloud storage.',
    },
    {
      q: 'Can I add Japam manually?',
      a: 'Yes. Open the Manual tab to add malas or counts completed outside the app.',
    },
    {
      q: 'Does the app work offline?',
      a: 'Yes. Basic japam counting works offline. When internet is available, your progress syncs automatically.',
    },
  ];

export default function FAQ() {
  const [open, setOpen] = useState<number | null>(0);

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
              opacity: i % 3 === 0 ? 0.72 : 0.28,
            },
          ]}
        />
      ))}
      <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.header}>
  

  <Text style={styles.title}>Learn</Text>

  <Text style={styles.subtitle}>
    Guidance for your Japam journey
  </Text>
</View>

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
  star: {
    position: 'absolute',
    width: 2,
    height: 2,
    borderRadius: 99,
    backgroundColor: '#0f766e',
  },
  content: {
    width: '100%',
    maxWidth: 820,
    alignSelf: 'center',
    padding: 20,
    paddingTop: 28,
    paddingBottom: 140,
  },
  header: { alignItems: 'center', marginBottom: 18 },
  title: { color: '#102f34', fontSize: 36, fontWeight: '900', marginTop: 4, textAlign: 'center' },
  subtitle: { color: '#365f61', marginTop: 4, fontSize: 18, textAlign: 'center' },

  card: {
    backgroundColor: 'rgba(255, 255, 255, 0.54)',
    borderRadius: 20,
    marginBottom: 10,
    paddingHorizontal: 16,
    paddingVertical: 15,
    borderWidth: 1,
    borderColor: 'rgba(15, 118, 110, 0.16)',
  },
  cardOpen: {
    borderColor: '#0f766e',
    backgroundColor: 'rgba(255, 255, 255, 0.72)',
  },

  questionRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },

  q: { color: '#12383c', fontWeight: '800', fontSize: 20, flex: 1, paddingRight: 10 },
  icon: { color: '#0f766e', fontSize: 30, fontWeight: '700' },
  a: { color: '#365f61', marginTop: 12, lineHeight: 29, fontSize: 18 },
 
});
