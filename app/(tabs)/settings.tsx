import AsyncStorage from '@react-native-async-storage/async-storage';
import { Audio } from 'expo-av';
import { LinearGradient } from 'expo-linear-gradient';
import { useFocusEffect } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { Alert, Linking, Modal, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

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
const getUserStorageKey = (key: string, userId: string) => `${key}:${userId}`;

export default function SettingsScreen() {
  const [repetitionSoundEnabled, setRepetitionSoundEnabled] = useState(true);
  const [vibrationEnabled, setVibrationEnabled] = useState(true);
  const [isPreviewingSound, setIsPreviewingSound] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);
  const [userName, setUserName] = useState('');
  const [userEmail, setUserEmail] = useState('');
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const [showFeedbackModal, setShowFeedbackModal] = useState(false);
  const [feedbackType, setFeedbackType] = useState('General');
  const [feedbackMessage, setFeedbackMessage] = useState('');
  const [isSendingFeedback, setIsSendingFeedback] = useState(false);

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

  const previewSound = async () => {
    if (isPreviewingSound) return;

    setIsPreviewingSound(true);

    try {
      const { sound } = await Audio.Sound.createAsync(
        require('../../assets/soft_tibetan_bowl.wav'),
        { shouldPlay: true, volume: 0.55 }
      );

      sound.setOnPlaybackStatusUpdate((status) => {
        if (status.isLoaded && status.didJustFinish) {
          sound.setOnPlaybackStatusUpdate(null);
          sound.unloadAsync().catch(console.log);
          setIsPreviewingSound(false);
        }
      });

      setTimeout(() => {
        sound.unloadAsync().catch(console.log);
        setIsPreviewingSound(false);
      }, 3000);
    } catch (error) {
      console.log('Preview sound error:', error);
      setIsPreviewingSound(false);
      Alert.alert('Preview unavailable', 'Unable to play the sound right now.');
    }
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

      const seconds = Number(
        (await AsyncStorage.getItem(getUserStorageKey(TIMER_SECONDS_KEY, currentUserId))) ||
          (await AsyncStorage.getItem(TIMER_SECONDS_KEY)) ||
          '0'
      );
      const targetSeconds = Number(
        (await AsyncStorage.getItem(getUserStorageKey(TIMER_TARGET_KEY, currentUserId))) ||
          (await AsyncStorage.getItem(TIMER_TARGET_KEY)) ||
          '60'
      );
      const minutesInput =
        (await AsyncStorage.getItem(getUserStorageKey(TIMER_MINUTES_KEY, currentUserId))) ||
        (await AsyncStorage.getItem(TIMER_MINUTES_KEY)) ||
        '1';
      const loopTimer =
        ((await AsyncStorage.getItem(getUserStorageKey(TIMER_LOOP_KEY, currentUserId))) ||
          (await AsyncStorage.getItem(TIMER_LOOP_KEY))) === 'true';

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

      // Save latest count to Supabase before clearing session
      try {
        const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
        const key = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
        if (url && key) {
          const storedTotal = Number((await AsyncStorage.getItem(getUserStorageKey('totalCount', currentUserId))) || '0');
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
    await AsyncStorage.multiRemove([
      TIMER_SECONDS_KEY,
      TIMER_RUNNING_KEY,
      TIMER_TARGET_KEY,
      TIMER_MINUTES_KEY,
      TIMER_LOOP_KEY,
    ]);
    setUserId(null);
    setUserName('');
    setUserEmail('');
    Alert.alert('Logged out', 'You have been logged out.');
  };

  const sendFeedback = async () => {
    if (!feedbackMessage.trim()) {
      Alert.alert('Empty message', 'Please write a message before sending.');
      return;
    }

    setIsSendingFeedback(true);
    try {
      const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
      const key = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
      if (!url || !key) throw new Error('Supabase not configured');

      const currentUserId = userId || (await AsyncStorage.getItem(USER_ID_KEY));
      const currentUserName = userName || (await AsyncStorage.getItem(USER_NAME_KEY)) || null;
      const currentUserEmail = userEmail || (await AsyncStorage.getItem(USER_EMAIL_KEY)) || null;

      const res = await fetch(`${url}/rest/v1/feedback`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: key,
          Authorization: `Bearer ${key}`,
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({
          user_id: currentUserId || null,
          user_name: currentUserName,
          user_email: currentUserEmail,
          feedback_type: feedbackType,
          message: feedbackMessage.trim(),
          platform: Platform.OS,
          created_at: new Date().toISOString(),
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        console.log('Feedback insert error:', errText);
        throw new Error(errText || 'Insert failed');
      }

      setFeedbackMessage('');
      setFeedbackType('General');
      setShowFeedbackModal(false);
      Alert.alert('Thank you for your feedback', 'Your feedback helps improve the app.');
    } catch (error) {
      console.log('Send feedback error:', error);
      Alert.alert('Error', 'Could not send feedback. Please try again.');
    } finally {
      setIsSendingFeedback(false);
    }
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
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
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

        <View style={styles.card}>
          <View style={styles.textBlock}>
            <Text style={styles.label}>Sound on each repetition</Text>
            <Text style={styles.description}>
              Play a soft chime after each mala completes
            </Text>
          </View>

          <Switch value={repetitionSoundEnabled} onValueChange={toggleRepetitionSound} />
        </View>

        <View style={styles.card}>
          <View style={styles.textBlock}>
            <Text style={styles.label}>Preview sound</Text>
            <Text style={styles.description}>
              Hear the soft chime used after each completed mala
            </Text>
          </View>

          <Pressable style={styles.compactButton} onPress={() => void previewSound()}>
            <Text style={styles.compactButtonText}>
              {isPreviewingSound ? 'Playing' : 'Preview'}
            </Text>
          </Pressable>
        </View>

        <View style={styles.card}>
          <View style={styles.textBlock}>
            <Text style={styles.label}>Vibration</Text>
            <Text style={styles.description}>
              Vibrate while tapping and after completion
            </Text>
          </View>

          <Switch value={vibrationEnabled} onValueChange={toggleVibration} />
        </View>

      </View>

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

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Feedback</Text>
        <View style={styles.card}>
          <View style={styles.textBlock}>
            <Text style={styles.label}>Send feedback</Text>
            <Text style={styles.description}>Report a bug or suggest a feature</Text>
          </View>
          <Pressable style={styles.compactButton} onPress={() => setShowFeedbackModal(true)}>
            <Text style={styles.compactButtonText}>Send</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.infoBox}>
        <Text style={styles.infoTitle}>Settings saved automatically</Text>
        <Text style={styles.infoText}>
          These options will be applied when you return to the Japam screen.
        </Text>
      </View>

      <Modal visible={showFeedbackModal} transparent animationType="fade">
        <View style={styles.feedbackOverlay}>
          <View style={styles.feedbackCard}>
            <Text style={styles.feedbackTitle}>Send Feedback</Text>
            <Text style={styles.feedbackSubtitle}>Let us know how we can improve</Text>

            <View style={styles.feedbackField}>
              <Text style={styles.feedbackLabel}>Type</Text>
              <View style={styles.feedbackTypeRow}>
                {['General', 'Bug', 'Feature'].map((t) => (
                  <Pressable
                    key={t}
                    style={[styles.feedbackTypeChip, feedbackType === t && styles.feedbackTypeChipActive]}
                    onPress={() => setFeedbackType(t)}
                  >
                    <Text style={[styles.feedbackTypeChipText, feedbackType === t && styles.feedbackTypeChipTextActive]}>{t}</Text>
                  </Pressable>
                ))}
              </View>
            </View>

            <View style={styles.feedbackField}>
              <Text style={styles.feedbackLabel}>Message</Text>
              <TextInput
                style={[styles.feedbackInput, styles.feedbackMessageInput]}
                value={feedbackMessage}
                onChangeText={setFeedbackMessage}
                placeholder="Describe your feedback..."
                placeholderTextColor="#7f9798"
                multiline
                numberOfLines={4}
                textAlignVertical="top"
              />
            </View>

            <View style={styles.feedbackActions}>
              <Pressable style={styles.feedbackCancel} onPress={() => { setShowFeedbackModal(false); setFeedbackMessage(''); }}>
                <Text style={styles.feedbackCancelText}>Cancel</Text>
              </Pressable>
              <Pressable style={styles.feedbackSubmit} onPress={() => void sendFeedback()} disabled={isSendingFeedback}>
                <Text style={styles.feedbackSubmitText}>{isSendingFeedback ? 'Sending...' : 'Send'}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={showLogoutConfirm} transparent animationType="fade">
        <View style={styles.confirmOverlay}>
          <View style={styles.confirmCard}>
            <Text style={styles.confirmTitle}>Logout?</Text>
            <Text style={styles.confirmText}>Are you sure you want to logout?</Text>
            <View style={styles.confirmActions}>
              <Pressable style={styles.confirmCancel} onPress={() => setShowLogoutConfirm(false)}>
                <Text style={styles.confirmCancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={styles.confirmLogout}
                onPress={async () => {
                  setShowLogoutConfirm(false);
                  await logout();
                }}
              >
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
  container: {
    flex: 1,
  },

  scroll: {
    flex: 1,
  },

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
    paddingHorizontal: 20,
    paddingTop: 28,
    paddingBottom: 140,
  },

  header: {
    alignItems: 'center',
    marginBottom: 22,
  },

  title: {
    color: '#102f34',
    fontSize: 36,
    fontWeight: '900',
    marginBottom: 4,
    textAlign: 'center',
  },

  subtitle: {
    color: '#365f61',
    fontSize: 18,
    textAlign: 'center',
  },

  section: {
    marginBottom: 22,
  },

  sectionTitle: {
    color: '#365f61',
    fontSize: 18,
    fontWeight: '800',
    marginBottom: 12,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },

  card: {
    backgroundColor: 'rgba(255, 255, 255, 0.54)',
    borderRadius: 20,
    padding: 18,
    marginBottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: 'rgba(15, 118, 110, 0.16)',
  },

  textBlock: {
    flex: 1,
    paddingRight: 14,
  },

  label: {
    color: '#12383c',
    fontSize: 20,
    fontWeight: '800',
  },

  description: {
    color: '#547071',
    fontSize: 17,
    marginTop: 5,
    lineHeight: 24,
  },

  compactButton: {
    backgroundColor: '#0f8a87',
    borderRadius: 999,
    paddingHorizontal: 18,
    paddingVertical: 10,
  },

  logoutButton: {
    backgroundColor: '#991b1b',
  },

  logoutTextButton: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(153, 27, 27, 0.18)',
    backgroundColor: 'rgba(153, 27, 27, 0.06)',
  },

  logoutTextButtonText: {
    color: '#b91c1c',
    fontSize: 15,
    fontWeight: '800',
  },

  compactButtonText: {
    color: 'white',
    fontSize: 15,
    fontWeight: '900',
  },

  infoBox: {
    backgroundColor: 'rgba(255, 255, 255, 0.42)',
    borderRadius: 20,
    padding: 16,
    borderWidth: 1,
    borderColor: 'rgba(15, 118, 110, 0.16)',
  },

  infoTitle: {
    color: '#12383c',
    fontSize: 20,
    fontWeight: '800',
    marginBottom: 6,
  },

  infoText: {
    color: '#547071',
    fontSize: 17,
    lineHeight: 24,
  },

  feedbackOverlay: {
    flex: 1,
    backgroundColor: 'rgba(2, 6, 23, 0.36)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 18,
  },

  feedbackCard: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: 'rgba(255, 255, 255, 0.97)',
    borderRadius: 24,
    paddingHorizontal: 18,
    paddingTop: 20,
    paddingBottom: 18,
    borderWidth: 1,
    borderColor: 'rgba(15, 118, 110, 0.12)',
    shadowColor: '#0f766e',
    shadowOpacity: 0.12,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 },
    elevation: 10,
  },

  feedbackTitle: {
    color: '#12383c',
    fontSize: 22,
    fontWeight: '800',
    textAlign: 'center',
  },

  feedbackSubtitle: {
    color: '#547071',
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
    marginTop: 6,
    marginBottom: 16,
  },

  feedbackField: {
    marginBottom: 12,
  },

  feedbackLabel: {
    color: '#12383c',
    fontSize: 14,
    fontWeight: '700',
    marginBottom: 6,
  },

  feedbackInput: {
    backgroundColor: '#f7fbfa',
    borderWidth: 1,
    borderColor: 'rgba(15, 118, 110, 0.14)',
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: '#12383c',
    fontSize: 16,
  },

  feedbackMessageInput: {
    minHeight: 112,
  },

  feedbackTypeRow: {
    flexDirection: 'row',
    gap: 8,
    flexWrap: 'wrap',
  },

  feedbackTypeChip: {
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#edf7f4',
    borderWidth: 1,
    borderColor: 'rgba(15, 118, 110, 0.10)',
  },

  feedbackTypeChipActive: {
    backgroundColor: 'rgba(15, 143, 135, 0.12)',
    borderColor: 'rgba(15, 143, 135, 0.28)',
  },

  feedbackTypeChipText: {
    color: '#547071',
    fontSize: 13,
    fontWeight: '700',
  },

  feedbackTypeChipTextActive: {
    color: '#0F8F87',
  },

  feedbackActions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 4,
  },

  feedbackCancel: {
    flex: 1,
    minHeight: 46,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#edf7f4',
  },

  feedbackCancelText: {
    color: '#12383c',
    fontSize: 15,
    fontWeight: '700',
  },

  feedbackSubmit: {
    flex: 1,
    minHeight: 46,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#0F8F87',
  },

  feedbackSubmitText: {
    color: 'white',
    fontSize: 15,
    fontWeight: '800',
  },

  cardStack: {
    gap: 12,
  },

  helpCard: {
    backgroundColor: 'rgba(255, 255, 255, 0.66)',
    borderRadius: 20,
    padding: 16,
    borderWidth: 1,
    borderColor: 'rgba(15, 118, 110, 0.12)',
    shadowColor: '#0f766e',
    shadowOpacity: 0.04,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },

  helpTitle: {
    color: '#12383c',
    fontSize: 18,
    fontWeight: '800',
    marginBottom: 6,
  },

  helpSubTitle: {
    color: '#0f8a87',
    fontSize: 14,
    fontWeight: '700',
    marginBottom: 10,
  },

  helpSteps: {
    gap: 4,
  },

  helpStep: {
    color: '#547071',
    fontSize: 15,
    lineHeight: 22,
  },

  confirmOverlay: {
    flex: 1,
    backgroundColor: 'rgba(2, 6, 23, 0.34)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 18,
  },

  confirmCard: {
    width: '100%',
    maxWidth: 336,
    backgroundColor: 'rgba(255, 255, 255, 0.96)',
    borderRadius: 24,
    paddingHorizontal: 18,
    paddingTop: 20,
    paddingBottom: 16,
    borderWidth: 1,
    borderColor: 'rgba(15, 118, 110, 0.12)',
    shadowColor: '#0f766e',
    shadowOpacity: 0.12,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 },
    elevation: 10,
  },

  confirmTitle: {
    color: '#12383c',
    fontSize: 21,
    fontWeight: '800',
    marginBottom: 6,
    textAlign: 'center',
  },

  confirmText: {
    color: '#547071',
    fontSize: 16,
    lineHeight: 22,
    marginBottom: 18,
    textAlign: 'center',
  },

  confirmActions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
  },

  confirmCancel: {
    flex: 1,
    minHeight: 46,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: '#edf7f4',
    alignItems: 'center',
    justifyContent: 'center',
  },

  confirmCancelText: {
    color: '#12383c',
    fontSize: 15,
    fontWeight: '700',
  },

  confirmLogout: {
    flex: 1,
    minHeight: 46,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: 'rgba(185, 28, 28, 0.08)',
    alignItems: 'center',
    justifyContent: 'center',
  },

  confirmLogoutText: {
    color: '#b91c1c',
    fontSize: 15,
    fontWeight: '800',
  },
});
