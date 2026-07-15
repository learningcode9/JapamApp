import AsyncStorage from '@react-native-async-storage/async-storage';
import { LinearGradient } from 'expo-linear-gradient';
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import { Alert, BackHandler, DeviceEventEmitter, Dimensions, Linking, Modal, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { dedupeByCompletionId, type RawHistoryRecord } from '../../lib/historyStore';

const SOUND_ENABLED_KEY = 'soundEnabled';
const REPETITION_SOUND_ENABLED_KEY = 'repetitionSoundEnabled';
const VIBRATION_ENABLED_KEY = 'vibrationEnabled';
const USER_ID_KEY = 'userId';
const USER_NAME_KEY = 'userName';
const USER_EMAIL_KEY = 'userEmail';
const TIMER_SECONDS_KEY = 'timerSeconds';
const TIMER_RUNNING_KEY = 'timerRunning';
const TIMER_TARGET_KEY = 'timerTarget';
const TIMER_MINUTES_KEY = 'timerMinutes';
const TIMER_LOOP_KEY = 'timerLoop';
const HISTORY_KEY = 'history';
const getUserStorageKey = (key: string, userId: string) => `${key}:${userId}`;

/**
 * Combined (all-Japams) lifetime total for this user, computed directly from HISTORY_KEY --
 * matches the exact same convention as contexts/timer-context.tsx's syncLifetimeTotalToSupabase
 * (dedupe by completionId, keep this user's own positive-count records, sum totalCount). Groups
 * Dashboard / japam_user_totals stays combined, so this deliberately does NOT filter by Japam.
 * Kept independent of Tap Japam's own internal cache format on purpose -- this is a last-chance
 * flush on logout and must not depend on another screen's private storage keys.
 */
const getCombinedLifetimeTotal = async (userId: string): Promise<number> => {
  const raw = await AsyncStorage.getItem(HISTORY_KEY);
  const history: RawHistoryRecord[] = raw ? JSON.parse(raw) : [];
  return dedupeByCompletionId(history)
    .filter((r) => (r.userId || null) === userId && r.totalCount > 0)
    .reduce((sum, r) => sum + (Number(r.totalCount) || 0), 0);
};

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const { width: settingsScreenWidth } = Dimensions.get('window');
  const tabBarLayoutIsMobile = settingsScreenWidth < 500;
  const tabBarSpaceFromBottom = 74 + (tabBarLayoutIsMobile
    ? Math.max(12, insets.bottom + 8)
    : Math.max(22, insets.bottom + 14));

  const router = useRouter();
  const [repetitionSoundEnabled, setRepetitionSoundEnabled] = useState(true);
  const [vibrationEnabled, setVibrationEnabled] = useState(true);
  const [userId, setUserId] = useState<string | null>(null);
  const [userName, setUserName] = useState('');
  const [userEmail, setUserEmail] = useState('');
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const [isSyncingGoogle, setIsSyncingGoogle] = useState(false);

  useEffect(() => {
    if (!showLogoutConfirm || Platform.OS !== 'android') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      setShowLogoutConfirm(false);
      return true;
    });
    return () => sub.remove();
  }, [showLogoutConfirm]);

  const loadAuth = useCallback(async () => {
    const savedUserId = await AsyncStorage.getItem(USER_ID_KEY);
    const savedUserName = await AsyncStorage.getItem(USER_NAME_KEY);
    const savedUserEmail = await AsyncStorage.getItem(USER_EMAIL_KEY);
    setUserId(savedUserId);
    setUserName(savedUserName || '');
    setUserEmail(savedUserEmail || '');
    setIsSyncingGoogle(false);
  }, []);

  useEffect(() => {
    const sub = DeviceEventEmitter.addListener('japam-auth-updated', () => void loadAuth());
    const webHandler = () => void loadAuth();
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      window.addEventListener('japam-auth-updated', webHandler);
    }
    return () => {
      sub.remove();
      if (Platform.OS === 'web' && typeof window !== 'undefined') {
        window.removeEventListener('japam-auth-updated', webHandler);
      }
    };
  }, [loadAuth]);

  useFocusEffect(
    useCallback(() => {
      const loadSettings = async () => {
        const savedSound = await AsyncStorage.getItem(SOUND_ENABLED_KEY);
        const savedRepetitionSound = await AsyncStorage.getItem(REPETITION_SOUND_ENABLED_KEY);
        const savedVibration = await AsyncStorage.getItem(VIBRATION_ENABLED_KEY);
        const savedUserId = await AsyncStorage.getItem(USER_ID_KEY);
        const savedUserName = await AsyncStorage.getItem(USER_NAME_KEY);
        const savedUserEmail = await AsyncStorage.getItem(USER_EMAIL_KEY);

        setRepetitionSoundEnabled(
          savedRepetitionSound === null
            ? savedSound !== 'false'
            : savedRepetitionSound !== 'false'
        );
        setVibrationEnabled(savedVibration !== 'false');
        setUserId(savedUserId);
        setUserName(savedUserName || '');
        setUserEmail(savedUserEmail || '');
      };

      void loadSettings();
    }, [])
  );

  const toggleRepetitionSound = async (value: boolean) => {
    setRepetitionSoundEnabled(value);
    await AsyncStorage.multiSet([
      [REPETITION_SOUND_ENABLED_KEY, String(value)],
      [SOUND_ENABLED_KEY, String(value)],
    ]);
  };

  const toggleVibration = async (value: boolean) => {
    setVibrationEnabled(value);
    await AsyncStorage.setItem(VIBRATION_ENABLED_KEY, String(value));
  };

  const savePausedTimerState = async (currentUserId: string) => {
    try {
      const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
      const key = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
      if (!url || !key) return;

      const seconds = Number((await AsyncStorage.getItem(getUserStorageKey(TIMER_SECONDS_KEY, currentUserId))) || '0');
      const targetSeconds = Number((await AsyncStorage.getItem(getUserStorageKey(TIMER_TARGET_KEY, currentUserId))) || '60');
      const minutesInput = (await AsyncStorage.getItem(getUserStorageKey(TIMER_MINUTES_KEY, currentUserId))) || '1';
      const loopTimer = (await AsyncStorage.getItem(getUserStorageKey(TIMER_LOOP_KEY, currentUserId))) === 'true';

      await fetch(`${url}/rest/v1/japam_timer_state?on_conflict=user_id`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: key,
          Authorization: `Bearer ${key}`,
          Prefer: 'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify({
          user_id: currentUserId,
          seconds: Math.max(0, Math.floor(seconds || 0)),
          is_running: false,
          target_seconds: Math.max(60, Math.floor(targetSeconds || 60)),
          minutes_input: minutesInput,
          loop_timer: loopTimer,
          updated_at: new Date().toISOString(),
        }),
      });
    } catch (error) {
      console.log('Timer pause on logout error:', error);
    }
  };

  const logout = async () => {
    const currentUserId = userId || (await AsyncStorage.getItem(USER_ID_KEY));
    if (currentUserId) {
      await savePausedTimerState(currentUserId);
      try {
        const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
        const key = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
        if (url && key) {
          const storedTotal = await getCombinedLifetimeTotal(currentUserId);
          const storedName = await AsyncStorage.getItem(USER_NAME_KEY);
          if (storedTotal > 0) {
            await fetch(`${url}/rest/v1/japam_user_totals?on_conflict=user_id`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                apikey: key,
                Authorization: `Bearer ${key}`,
                Prefer: 'resolution=merge-duplicates,return=minimal',
              },
              body: JSON.stringify({
                user_id: currentUserId,
                user_name: storedName || 'User',
                total_count: storedTotal,
                malas: Math.floor(storedTotal / 108),
                count: storedTotal % 108,
                updated_at: new Date().toISOString(),
              }),
            });
          }
        }
      } catch (e) {
        console.log('Logout total save error:', e);
      }
    }

    await AsyncStorage.removeItem(USER_NAME_KEY);
    await AsyncStorage.removeItem(USER_EMAIL_KEY);
    await AsyncStorage.removeItem(USER_ID_KEY);
    await AsyncStorage.multiRemove([TIMER_SECONDS_KEY, TIMER_RUNNING_KEY, TIMER_TARGET_KEY, TIMER_MINUTES_KEY, TIMER_LOOP_KEY]);
    DeviceEventEmitter.emit('japam-auth-updated');
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      window.dispatchEvent(new Event('japam-auth-updated'));
    }
    setUserId(null);
    setUserName('');
    setUserEmail('');
    Alert.alert('Logged out', 'You have been logged out.');
  };

  const clearGuestData = () => {
    const doClear = async () => {
      await AsyncStorage.removeItem(USER_NAME_KEY);
      setUserName('');
      DeviceEventEmitter.emit('japam-auth-updated');
      if (Platform.OS === 'web' && typeof window !== 'undefined') {
        window.dispatchEvent(new Event('japam-auth-updated'));
      }
      router.navigate('/(tabs)/timer');
    };
    if (Platform.OS === 'web') {
      if (window.confirm('Exit Guest Mode? Your guest history will stay on this device.')) void doClear();
      return;
    }
    Alert.alert(
      'Exit Guest Mode?',
      'Your guest history will stay on this device.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Exit', style: 'destructive', onPress: () => void doClear() },
      ]
    );
  };

  const openFeedbackForm = () => {
    const formUrl = 'https://docs.google.com/forms/d/e/1FAIpQLScxRkt9Iz1JLhjMmGHC3HtUxDDQUJK0FG-qX65m5n26p3gRdw/viewform?pli=1';
    Linking.openURL(formUrl).catch(() =>
      Alert.alert("Error", "Could not open the feedback form. Please try again.")
    );
  };

  const openPrivacyPolicy = () => {
    Linking.openURL('https://mantra-japam.vercel.app/privacy').catch(() =>
      Alert.alert('Error', 'Could not open the privacy policy. Please try again.')
    );
  };

  const openDeleteAccount = () => {
    Linking.openURL('https://mantra-japam.vercel.app/delete-account').catch(() =>
      Alert.alert('Error', 'Could not open the delete account page. Please try again.')
    );
  };

  return (
    <LinearGradient colors={['#e7f5f5', '#c7e2e0', '#eef8f5']} style={styles.container}>
      {[...Array(30)].map((_, i) => (
        <View key={i} pointerEvents="none" style={[styles.star, { left: `${(i * 37 + 11) % 100}%`, top: `${(i * 53 + 7) % 100}%`, opacity: i % 3 === 0 ? 0.72 : 0.28 }]} />
      ))}
      <ScrollView
        style={[styles.scroll, Platform.OS !== 'web' && { marginBottom: tabBarSpaceFromBottom }]}
        contentContainerStyle={styles.content}
      >
        <View style={styles.header}>
          <Text style={styles.title}>Settings</Text>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Japam Options</Text>
          {!!userId && (
            <View style={styles.card}>
              <View style={styles.textBlock}>
                <Text style={styles.label}>Signed in</Text>
                <Text style={styles.description}>{userName || 'Google user'}</Text>
              </View>
              <Pressable style={styles.logoutTextButton} onPress={() => setShowLogoutConfirm(true)}>
                <Text style={styles.logoutTextButtonText}>Logout</Text>
              </Pressable>
            </View>
          )}
          {!userId && !!userName && (
            <View style={styles.card}>
              <View style={styles.textBlock}>
                <Text style={styles.label}>Guest Mode</Text>
                <Text style={styles.description}>Guest: {userName}</Text>
                <Text style={[styles.description, { fontSize: 14, marginTop: 6 }]}>
                  Your history is saved only on this phone.{'\n'}Sign in with Google to save permanently and sync across devices.
                </Text>
              </View>
              <View style={styles.guestActions}>
                <Pressable
                  style={[styles.signInButton, isSyncingGoogle && { opacity: 0.55 }]}
                  disabled={isSyncingGoogle}
                  onPress={() => {
                    setIsSyncingGoogle(true);
                    DeviceEventEmitter.emit('japam-start-google-signin');
                    setTimeout(() => setIsSyncingGoogle(false), 10000);
                  }}
                >
                  <Text style={styles.signInButtonText}>
                    {isSyncingGoogle ? 'Opening Google...' : 'Sync with Google'}
                  </Text>
                </Pressable>
                <Pressable style={styles.clearGuestButton} onPress={clearGuestData}>
                  <Text style={styles.clearGuestButtonText}>Exit Guest Mode</Text>
                </Pressable>
              </View>
            </View>
          )}

          <View style={styles.card}>
            <View style={styles.textBlock}>
              <Text style={styles.label}>Sound on Mala Completion</Text>
              <Text style={styles.description}>Play Om chime when each mala completes.</Text>
            </View>
            <Switch value={repetitionSoundEnabled} onValueChange={toggleRepetitionSound} />
          </View>

          <View style={styles.helpNote}>
            <Text style={styles.helpNoteText}>For reliable completion alerts, please enable notifications.</Text>
          </View>

          <View style={styles.card}>
            <View style={styles.textBlock}>
              <Text style={styles.label}>Vibration</Text>
              <Text style={styles.description}>Vibrate while tapping and after completion</Text>
            </View>
            <Switch value={vibrationEnabled} onValueChange={toggleVibration} />
          </View>
        </View>

        {Platform.OS === 'web' && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Help / Install App</Text>
            <View style={styles.cardStack}>
              <View style={styles.helpCard}>
                <Text style={styles.helpTitle}>Add to Home Screen</Text>
                <Text style={styles.helpSubTitle}>iPhone Safari</Text>
                <View style={styles.helpSteps}>
                  <Text style={styles.helpStep}>1. Tap Share</Text>
                  <Text style={styles.helpStep}>2. Tap Add to Home Screen</Text>
                  <Text style={styles.helpStep}>3. Tap Add</Text>
                </View>
              </View>
              <View style={styles.helpCard}>
                <Text style={styles.helpTitle}>Add to Home Screen</Text>
                <Text style={styles.helpSubTitle}>Android Chrome</Text>
                <View style={styles.helpSteps}>
                  <Text style={styles.helpStep}>1. Tap menu ⋮</Text>
                  <Text style={styles.helpStep}>2. Tap Install app</Text>
                  <Text style={styles.helpStep}>3. Confirm Install</Text>
                </View>
              </View>
            </View>
          </View>
        )}

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Feedback</Text>
          <View style={styles.card}>
            <View style={styles.textBlock}>
              <Text style={styles.label}>Send feedback</Text>
              <Text style={styles.description}>Report a bug or suggest a feature</Text>
            </View>
            <Pressable style={styles.compactButton} onPress={openFeedbackForm}>
              <Text style={styles.compactButtonText}>Open Form</Text>
            </Pressable>
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Legal</Text>
          <View style={styles.card}>
            <View style={styles.textBlock}>
              <Text style={styles.label}>Privacy Policy</Text>
              <Text style={styles.description}>View our privacy policy</Text>
            </View>
            <Pressable style={styles.compactButton} onPress={openPrivacyPolicy}>
              <Text style={styles.compactButtonText}>Open</Text>
            </Pressable>
          </View>
          <View style={styles.card}>
            <View style={styles.textBlock}>
              <Text style={styles.label}>Delete Account Request</Text>
              <Text style={styles.description}>Request deletion of your account and data</Text>
            </View>
            <Pressable style={styles.compactButton} onPress={openDeleteAccount}>
              <Text style={styles.compactButtonText}>Open</Text>
            </Pressable>
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Help</Text>
          <Pressable
            style={({ pressed }) => [styles.card, pressed && { opacity: 0.7 }]}
            onPress={() => router.push('/(tabs)/faq')}
            accessibilityRole="button"
          >
            <View style={styles.textBlock}>
              <Text style={styles.label}>FAQ</Text>
              <Text style={styles.description}>Common questions about Japam App</Text>
            </View>
            <Text style={styles.navChevron}>›</Text>
          </Pressable>
        </View>

        <View style={styles.infoBox}>
          <Text style={styles.infoTitle}>Settings saved automatically</Text>
          <Text style={styles.infoText}>These options will be applied when you return to the Japam screen.</Text>
        </View>

        <Modal visible={showLogoutConfirm} transparent animationType="fade">
          <View style={styles.confirmOverlay}>
            <View style={styles.confirmCard}>
              <Text style={styles.confirmTitle}>Logout?</Text>
              <Text style={styles.confirmText}>Are you sure you want to logout?</Text>
              <View style={styles.confirmActions}>
                <Pressable style={styles.confirmCancel} onPress={() => setShowLogoutConfirm(false)}>
                  <Text style={styles.confirmCancelText}>Cancel</Text>
                </Pressable>
                <Pressable style={styles.confirmLogout} onPress={async () => { setShowLogoutConfirm(false); await logout(); }}>
                  <Text style={styles.confirmLogoutText}>Logout</Text>
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>
      </ScrollView>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scroll: { flex: 1 },
  star: { position: 'absolute', width: 2, height: 2, borderRadius: 99, backgroundColor: '#0f766e' },
  content: { width: '100%', maxWidth: 820, alignSelf: 'center', paddingHorizontal: 20, paddingTop: 28, paddingBottom: 24 },
  header: { alignItems: 'center', marginBottom: 22 },
  title: { color: '#102f34', fontSize: 36, fontWeight: '900', textAlign: 'center' },
  section: { marginBottom: 22 },
  sectionTitle: { color: '#365f61', fontSize: 18, fontWeight: '800', marginBottom: 12, textTransform: 'uppercase', letterSpacing: 0.8 },
  card: { backgroundColor: 'rgba(255, 255, 255, 0.54)', borderRadius: 20, padding: 18, marginBottom: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderWidth: 1, borderColor: 'rgba(15, 118, 110, 0.16)' },
  textBlock: { flex: 1, paddingRight: 14 },
  label: { color: '#12383c', fontSize: 20, fontWeight: '800' },
  description: { color: '#547071', fontSize: 17, marginTop: 5, lineHeight: 24 },
  compactButton: { backgroundColor: '#0f8a87', borderRadius: 999, paddingHorizontal: 18, paddingVertical: 10 },
  compactButtonText: { color: 'white', fontSize: 15, fontWeight: '900' },
  logoutTextButton: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: 'rgba(153, 27, 27, 0.18)', backgroundColor: 'rgba(153, 27, 27, 0.06)' },
  logoutTextButtonText: { color: '#b91c1c', fontSize: 15, fontWeight: '800' },
  signInButton: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999, borderWidth: 1.5, borderColor: '#0f8a87', backgroundColor: 'transparent' },
  signInButtonText: { color: '#0f8a87', fontSize: 15, fontWeight: '800' },
  guestActions: { flexDirection: 'column', alignItems: 'flex-end', gap: 8 },
  clearGuestButton: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: 'rgba(153, 27, 27, 0.22)', backgroundColor: 'rgba(153, 27, 27, 0.06)' },
  clearGuestButtonText: { color: '#b91c1c', fontSize: 13, fontWeight: '700' },
  cardStack: { gap: 12 },
  helpNote: { backgroundColor: 'rgba(255, 255, 255, 0.5)', borderRadius: 16, paddingHorizontal: 14, paddingVertical: 12, marginBottom: 12, borderWidth: 1, borderColor: 'rgba(15, 118, 110, 0.12)' },
  helpNoteText: { color: '#547071', fontSize: 15, lineHeight: 21, fontWeight: '700' },
  helpCard: { backgroundColor: 'rgba(255, 255, 255, 0.66)', borderRadius: 20, padding: 16, borderWidth: 1, borderColor: 'rgba(15, 118, 110, 0.12)' },
  helpTitle: { color: '#12383c', fontSize: 18, fontWeight: '800', marginBottom: 6 },
  helpSubTitle: { color: '#0f8a87', fontSize: 14, fontWeight: '700', marginBottom: 10 },
  helpSteps: { gap: 4 },
  helpStep: { color: '#547071', fontSize: 15, lineHeight: 22 },
  infoBox: { backgroundColor: 'rgba(255, 255, 255, 0.42)', borderRadius: 20, padding: 16, borderWidth: 1, borderColor: 'rgba(15, 118, 110, 0.16)' },
  infoTitle: { color: '#12383c', fontSize: 20, fontWeight: '800', marginBottom: 6 },
  infoText: { color: '#547071', fontSize: 17, lineHeight: 24 },
  confirmOverlay: { flex: 1, backgroundColor: 'rgba(2, 6, 23, 0.34)', justifyContent: 'center', alignItems: 'center' },
  confirmCard: { width: '100%', maxWidth: 336, backgroundColor: 'white', borderRadius: 24, padding: 20 },
  confirmTitle: { color: '#12383c', fontSize: 21, fontWeight: '800', textAlign: 'center' },
  confirmText: { color: '#547071', fontSize: 16, textAlign: 'center', marginVertical: 10 },
  confirmActions: { flexDirection: 'row', gap: 12, marginTop: 10 },
  confirmCancel: { flex: 1, padding: 12, borderRadius: 99, backgroundColor: '#edf7f4', alignItems: 'center' },
  confirmCancelText: { color: '#12383c', fontWeight: '700' },
  confirmLogout: { flex: 1, padding: 12, borderRadius: 99, backgroundColor: 'rgba(185, 28, 28, 0.1)', alignItems: 'center' },
  confirmLogoutText: { color: '#b91c1c', fontWeight: '800' },
  navChevron: { color: '#0f8a87', fontSize: 30, fontWeight: '300', paddingLeft: 4 },
});
