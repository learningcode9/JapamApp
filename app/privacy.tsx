import { LinearGradient } from 'expo-linear-gradient';
import { SafeAreaView, ScrollView, StyleSheet, Text, View } from 'react-native';

const sections = [
  {
    title: 'Information We Collect',
    items: [
      'Name and email address from Google Sign-In',
      'Japam activity including mala counts, timer sessions, streaks, and manual entries',
    ],
  },
  {
    title: 'How We Use Information',
    items: ['Sync data across devices', 'Maintain history and statistics', 'Provide app functionality'],
  },
  {
    title: 'Data Sharing',
    items: ['We do not sell, rent, or share personal information with third parties'],
  },
  {
    title: 'Data Security',
    items: ['All communication is encrypted using HTTPS'],
  },
  {
    title: 'Data Deletion',
    items: [
      'Users may request deletion of their account and associated data by contacting the developer',
    ],
  },
  {
    title: "Children's Privacy",
    items: ['This application does not knowingly collect personal information from children'],
  },
  {
    title: 'Contact',
    items: ['developer email placeholder'],
  },
];

export default function PrivacyPolicyScreen() {
  return (
    <LinearGradient colors={['#eef8f6', '#d7ece8', '#f7fbf9']} style={styles.root}>
      <SafeAreaView style={styles.safeArea}>
        <ScrollView
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.header}>
            <Text style={styles.eyebrow}>Mantra Japam</Text>
            <Text style={styles.title}>Privacy Policy</Text>
            <Text style={styles.updated}>Last Updated: June 2026</Text>
          </View>

          <View style={styles.card}>
            {sections.map((section) => (
              <View key={section.title} style={styles.section}>
                <Text style={styles.sectionTitle}>{section.title}</Text>
                {section.items.map((item) => (
                  <View key={item} style={styles.itemRow}>
                    <Text style={styles.dash}>-</Text>
                    <Text style={styles.itemText}>{item}</Text>
                  </View>
                ))}
              </View>
            ))}
          </View>
        </ScrollView>
      </SafeAreaView>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#eef8f6',
  },
  safeArea: {
    flex: 1,
  },
  content: {
    width: '100%',
    maxWidth: 720,
    alignSelf: 'center',
    paddingHorizontal: 22,
    paddingTop: 34,
    paddingBottom: 42,
  },
  header: {
    alignItems: 'center',
    marginBottom: 22,
  },
  eyebrow: {
    color: '#0F8F87',
    fontSize: 14,
    fontWeight: '800',
    letterSpacing: 0,
    marginBottom: 8,
  },
  title: {
    color: '#063B3B',
    fontSize: 36,
    fontWeight: '900',
    letterSpacing: 0,
    textAlign: 'center',
  },
  updated: {
    color: '#5F7F80',
    fontSize: 15,
    fontWeight: '700',
    marginTop: 10,
    textAlign: 'center',
  },
  card: {
    backgroundColor: 'rgba(255,255,255,0.82)',
    borderRadius: 28,
    paddingHorizontal: 22,
    paddingVertical: 24,
    shadowColor: '#0F8F87',
    shadowOpacity: 0.12,
    shadowRadius: 22,
    shadowOffset: { width: 0, height: 12 },
    elevation: 4,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.9)',
  },
  section: {
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(15,143,135,0.12)',
  },
  sectionTitle: {
    color: '#063B3B',
    fontSize: 19,
    fontWeight: '900',
    letterSpacing: 0,
    marginBottom: 10,
  },
  itemRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 8,
  },
  dash: {
    color: '#0F8F87',
    fontSize: 16,
    fontWeight: '900',
    lineHeight: 23,
  },
  itemText: {
    flex: 1,
    color: '#315f60',
    fontSize: 16,
    fontWeight: '600',
    lineHeight: 23,
  },
});
