import { LinearGradient } from 'expo-linear-gradient';
import { WEB_BOTTOM_TAB_CLEARANCE } from '../../lib/webLayout';
import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { Dimensions, LayoutAnimation, Platform, Pressable, ScrollView, StyleSheet, Text, UIManager, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

if (Platform.OS === 'android') {
  UIManager.setLayoutAnimationEnabledExperimental?.(true);
}

const FAQ_ITEMS = [
  {
    q: 'What is Timer Japam?',
    a: 'Choose a duration and start the timer. Chant continuously during the session. The app automatically counts completed malas.',
  },
  {
    q: 'What is Tap Japam?',
    a: 'After each mantra japa, tap the large circle once. The app counts up to 108 and completes one mala automatically.',
  },
  {
    q: 'What is Auto-Repeat Malas?',
    a: 'The timer automatically starts the next mala until the selected number of malas is completed.',
  },
  {
    q: 'What does Export do?',
    a: 'Export creates a CSV file of your japam history. You can save it as a personal backup or open it in Excel, Google Sheets, or Apple Numbers.',
  },
  {
    q: 'What is Manual Entry?',
    a: 'Manual Entry lets you add japam sessions that were completed outside the app.',
  },
  {
    q: 'Can I use the app offline?',
    a: "Yes. You can continue your japam without internet. Your data will sync when you're back online.",
  },
  {
    q: 'How do Groups work?',
    a: "Create a group or join using an invite code. Group members can view each other's japam progress.",
  },
  {
    q: "Why isn't sound or vibration working?",
    a: "Check your device's sound, vibration, and Do Not Disturb settings. Some phones reduce vibration in Battery Saver mode.",
  },
  {
    q: 'How do I send feedback?',
    a: 'Open Settings and tap Send Feedback to share suggestions or report issues.',
  },
] as const;

// Mirrors the isMobile threshold from _layout.tsx (screenWidth < 500).
const tabBarLayoutIsMobile = Dimensions.get('window').width < 500;

export default function FaqScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [expandedFaq, setExpandedFaq] = useState<number | null>(null);

  // Tab bar geometry: height 74 + bottom offset, matching _layout.tsx exactly.
  const tabBarSpaceFromBottom = 74 + (tabBarLayoutIsMobile
    ? Math.max(12, insets.bottom + 8)
    : Math.max(22, insets.bottom + 14));

  const toggleFaq = (index: number) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpandedFaq(prev => (prev === index ? null : index));
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
              opacity: i % 3 === 0 ? 0.72 : 0.28,
            },
          ]}
        />
      ))}
      <ScrollView
        style={[styles.scroll, Platform.OS !== 'web' && { marginBottom: tabBarSpaceFromBottom }]}
        contentContainerStyle={[
          styles.content,
          Platform.OS !== 'web' && { paddingTop: Math.max(28, insets.top + 8) },
          { paddingBottom: Platform.OS !== 'web' ? 24 : WEB_BOTTOM_TAB_CLEARANCE },
        ]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.header}>
          <Pressable
            style={({ pressed }) => [styles.backBtn, pressed && { opacity: 0.6 }]}
            onPress={() => router.back()}
            accessibilityRole="button"
            accessibilityLabel="Back to Settings"
          >
            <Text style={styles.backText}>‹ Back</Text>
          </Pressable>
          <Text style={styles.title}>FAQ</Text>
          <View style={styles.headerSpacer} />
        </View>

        {FAQ_ITEMS.map((item, index) => (
          <View key={index} style={styles.faqCard}>
            <Pressable
              style={({ pressed }) => [styles.faqHeader, pressed && styles.faqHeaderPressed]}
              onPress={() => toggleFaq(index)}
              accessibilityRole="button"
              accessibilityState={{ expanded: expandedFaq === index }}
              accessibilityLabel={item.q}
            >
              <Text style={styles.faqQuestion}>{item.q}</Text>
              <Text style={styles.faqToggle}>{expandedFaq === index ? '−' : '+'}</Text>
            </Pressable>
            {expandedFaq === index && (
              <View>
                <View style={styles.faqDivider} />
                <Text style={styles.faqAnswer}>{item.a}</Text>
              </View>
            )}
          </View>
        ))}
      </ScrollView>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scroll: { flex: 1 },
  star: { position: 'absolute', width: 2, height: 2, borderRadius: 99, backgroundColor: '#0f766e' },
  content: { width: '100%', maxWidth: 820, alignSelf: 'center', paddingHorizontal: 20, paddingTop: 28, paddingBottom: 24 },
  header: { flexDirection: 'row', alignItems: 'center', marginBottom: 24 },
  backBtn: { paddingVertical: 10, paddingRight: 12, minWidth: 72 },
  backText: { color: '#0f8a87', fontSize: 18, fontWeight: '700' },
  title: { flex: 1, color: '#102f34', fontSize: 28, fontWeight: '900', textAlign: 'center' },
  headerSpacer: { minWidth: 72 },
  faqCard: { backgroundColor: 'rgba(255, 255, 255, 0.54)', borderRadius: 20, paddingHorizontal: 18, marginBottom: 10, borderWidth: 1, borderColor: 'rgba(15, 118, 110, 0.16)', overflow: 'hidden' },
  faqHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 16, minHeight: 56 },
  faqHeaderPressed: { opacity: 0.65 },
  faqQuestion: { color: '#12383c', fontSize: 18, fontWeight: '800', flex: 1, paddingRight: 12, lineHeight: 24 },
  faqToggle: { color: '#0f8a87', fontSize: 22, fontWeight: '900', width: 28, textAlign: 'center' },
  faqDivider: { height: 1, backgroundColor: 'rgba(15, 118, 110, 0.12)', marginBottom: 14 },
  faqAnswer: { color: '#547071', fontSize: 17, lineHeight: 26, paddingBottom: 16 },
});
