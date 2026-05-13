import AsyncStorage from '@react-native-async-storage/async-storage';
import { Audio } from 'expo-av';
import { LinearGradient } from 'expo-linear-gradient';
import { useFocusEffect } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { Alert, Linking, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';

const SOUND_ENABLED_KEY = 'soundEnabled';
const REPETITION_SOUND_ENABLED_KEY = 'repetitionSoundEnabled';
const VIBRATION_ENABLED_KEY = 'vibrationEnabled';
const USER_ID_KEY = 'userId';
const USER_NAME_KEY = 'userName';
const TIMER_SECONDS_KEY = 'timerSeconds';
const TIMER_RUNNING_KEY = 'timerRunning';
const TIMER_TARGET_KEY = 'timerTarget';
const TIMER_MINUTES_KEY = 'timerMinutes';
const TIMER_LOOP_KEY = 'timerLoop';
const FEEDBACK_FORM_URL =
  'https://docs.google.com/forms/d/e/1FAIpQLScYFBZqgour0aN3hFFjW2hrOAkc9vVFdN0-1NPXdouZZRsHfQ/viewform?usp=publish-editor';

const getUserStorageKey = (key: string, userId: string) => `${key}:${userId}`;

export default function SettingsScreen() {
  const [repetitionSoundEnabled, setRepetitionSoundEnabled] = useState(true);
  const [vibrationEnabled, setVibrationEnabled] = useState(true);
  const [isPreviewingSound, setIsPreviewingSound] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);
  const [userName, setUserName] = useState('');

  useFocusEffect(
    useCallback(() => {
    const loadSettings = async () => {
      const savedSound = await AsyncStorage.getItem(SOUND_ENABLED_KEY);
      const savedRepetitionSound = await AsyncStorage.getItem(REPETITION_SOUND_ENABLED_KEY);
      const savedVibration = await AsyncStorage.getItem(VIBRATION_ENABLED_KEY);
      const savedUserId = await AsyncStorage.getItem(USER_ID_KEY);
      const savedUserName = await AsyncStorage.getItem(USER_NAME_KEY);

      setRepetitionSoundEnabled(
        savedRepetitionSound === null
          ? savedSound !== 'false'
          : savedRepetitionSound !== 'false'
      );
      setVibrationEnabled(savedVibration !== 'false');
      setUserId(savedUserId);
      setUserName(savedUserName || '');
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
        require('../../assets/om_complete.mp3'),
        { shouldPlay: true, volume: 0.75 }
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

  const openFeedbackForm = async () => {
    if (!FEEDBACK_FORM_URL) {
      Alert.alert(
        'Feedback form needed',
        'Please add your Google Form link in Settings.'
      );
      return;
    }

    const canOpen = await Linking.canOpenURL(FEEDBACK_FORM_URL);
    if (!canOpen) {
      Alert.alert('Unable to open form', 'Please try again later.');
      return;
    }

    await Linking.openURL(FEEDBACK_FORM_URL);
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
    }

    await AsyncStorage.removeItem(USER_NAME_KEY);
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
    Alert.alert('Logged out', 'You have been logged out.');
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
            <Pressable style={[styles.compactButton, styles.logoutButton]} onPress={logout}>
              <Text style={styles.compactButtonText}>Logout</Text>
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
        <Text style={styles.sectionTitle}>Feedback</Text>
        <View style={styles.card}>
          <View style={styles.textBlock}>
            <Text style={styles.label}>Send Feedback</Text>
            <Text style={styles.description}>Open the Google Form to share bugs or ideas.</Text>
          </View>
          <Pressable style={styles.compactButton} onPress={openFeedbackForm}>
            <Text style={styles.compactButtonText}>Open</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.infoBox}>
        <Text style={styles.infoTitle}>Settings saved automatically</Text>
        <Text style={styles.infoText}>
          These options will be applied when you return to the Japam screen.
        </Text>
      </View>
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
});
