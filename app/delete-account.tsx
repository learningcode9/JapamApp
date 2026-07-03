import { LinearGradient } from 'expo-linear-gradient';
import { SafeAreaView, ScrollView, StyleSheet, Text, View } from 'react-native';

const sections = [
  {
    title: 'App Name',
    items: ['Mantra Japam'],
  },
  {
    title: 'Contact Email',
    items: ['mantrajapamapp@gmail.com'],
  },
  {
    title: 'Instructions',
    items: [
      '1. Send an email to mantrajapamapp@gmail.com with subject "Delete My Account".',
      '2. Include the Google account email used in Mantra Japam.',
      '3. We will delete the account and associated Japam data.',
    ],
  },
  {
    title: 'Data Deleted',
    items: [
      'User profile',
      'Japam history',
      'Mala counts',
      'Timer sessions',
      'Streaks',
      'Manual entries',
    ],
  },
  {
    title: 'Data Retained',
    items: ['None except records required by law.'],
  },
];

export default function DeleteAccountScreen() {
  return (
    <LinearGradient colors={['#eef8f6', '#d7ece8', '#f7fbf9']} style={styles.root}>
      <SafeAreaView style={styles.safeArea}>
        <ScrollView
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.header}>
            <Text style={styles.eyebrow}>Mantra Japam</Text>
            <Text style={styles.title}>Delete Account Request</Text>
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
