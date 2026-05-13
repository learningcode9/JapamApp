import AsyncStorage from '@react-native-async-storage/async-storage';
import { LinearGradient } from 'expo-linear-gradient';
import { useFocusEffect } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { Alert, Linking, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

const SOUND_ENABLED_KEY = 'soundEnabled';
const VIBRATION_ENABLED_KEY = 'vibrationEnabled';
const JAPAM_NAME_KEY = 'japamName';
const USER_ID_KEY = 'userId';
const USER_NAME_KEY = 'userName';
const FEEDBACK_FORM_URL =
  'https://docs.google.com/forms/d/e/1FAIpQLScYFBZqgour0aN3hFFjW2hrOAkc9vVFdN0-1NPXdouZZRsHfQ/viewform?usp=publish-editor';

const getUserStorageKey = (key: string, userId: string) => `${key}:${userId}`;

export default function SettingsScreen() {
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [vibrationEnabled, setVibrationEnabled] = useState(true);
  const [japamName, setJapamName] = useState('');
  const [japamNameInput, setJapamNameInput] = useState('');
  const [isEditingJapamName, setIsEditingJapamName] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);
  const [userName, setUserName] = useState('');

  useFocusEffect(
    useCallback(() => {
    const loadSettings = async () => {
      const savedSound = await AsyncStorage.getItem(SOUND_ENABLED_KEY);
      const savedVibration = await AsyncStorage.getItem(VIBRATION_ENABLED_KEY);
      const savedUserId = await AsyncStorage.getItem(USER_ID_KEY);
      const savedUserName = await AsyncStorage.getItem(USER_NAME_KEY);
      const savedJapamName = savedUserId
        ? await AsyncStorage.getItem(getUserStorageKey(JAPAM_NAME_KEY, savedUserId))
        : await AsyncStorage.getItem(JAPAM_NAME_KEY);

      setSoundEnabled(savedSound !== 'false');
      setVibrationEnabled(savedVibration !== 'false');
      setUserId(savedUserId);
      setUserName(savedUserName || '');
      setJapamName(savedJapamName || 'Japam');
      setJapamNameInput(savedJapamName || 'Japam');
      setIsEditingJapamName(false);
    };

    void loadSettings();
  }, [])
  );

  const toggleSound = async (value: boolean) => {
    setSoundEnabled(value);
    await AsyncStorage.setItem(SOUND_ENABLED_KEY, String(value));
  };

  const toggleVibration = async (value: boolean) => {
    setVibrationEnabled(value);
    await AsyncStorage.setItem(VIBRATION_ENABLED_KEY, String(value));
  };

  const saveJapamName = async () => {
    const name = japamNameInput.trim();
    if (!name) {
      Alert.alert('Enter japam name');
      return;
    }

    if (userId) {
      await AsyncStorage.setItem(getUserStorageKey(JAPAM_NAME_KEY, userId), name);
    } else {
      await AsyncStorage.setItem(JAPAM_NAME_KEY, name);
    }

    try {
      const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
      const key = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

      if (url && key && userId) {
        const encodedUserId = encodeURIComponent(userId);
        const headers = {
          'Content-Type': 'application/json',
          apikey: key,
          Authorization: `Bearer ${key}`,
        };

        const checkResponse = await fetch(
          `${url}/rest/v1/user_profiles?user_id=eq.${encodedUserId}&select=id`,
          { headers }
        );
        const rows = await checkResponse.json();

        if (rows.length > 0) {
          await fetch(`${url}/rest/v1/user_profiles?user_id=eq.${encodedUserId}`, {
            method: 'PATCH',
            headers,
            body: JSON.stringify({
              user_name: userName || 'User',
              japam_name: name,
              updated_at: new Date().toISOString(),
            }),
          });
        } else {
          await fetch(`${url}/rest/v1/user_profiles`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              user_id: userId,
              user_name: userName || 'User',
              japam_name: name,
            }),
          });
        }
      }

      Alert.alert('Saved', 'Japam name updated.');
    } catch (error) {
      console.log('Japam name save error:', error);
      Alert.alert('Saved locally', 'Japam name was saved on this device.');
    }

    setJapamName(name);
    setJapamNameInput(name);
    setIsEditingJapamName(false);
  };

  const cancelJapamNameEdit = () => {
    setJapamNameInput(japamName);
    setIsEditingJapamName(false);
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

  return (
    <LinearGradient colors={['#05010c', '#120022', '#05010c']} style={styles.container}>
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
      <Text style={styles.subtitle}>Japam name, sound, vibration, and feedback.</Text>
      </View>
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Japam Options</Text>

        <View style={styles.cardStack}>
          <Pressable
            style={styles.nameRow}
            onPress={() => setIsEditingJapamName(true)}
          >
            <View style={styles.textBlock}>
              <Text style={styles.label}>Japam Name</Text>
              <Text style={styles.description}>{japamName || 'Japam'}</Text>
            </View>
            <Text style={styles.changeText}>Change</Text>
          </Pressable>

          {isEditingJapamName && (
            <View style={styles.inlineEditor}>
              <TextInput
                style={styles.input}
                value={japamNameInput}
                onChangeText={setJapamNameInput}
                placeholder="Enter japam name"
                placeholderTextColor="#94a3b8"
              />
              <View style={styles.inlineActions}>
                <Pressable style={styles.smallButton} onPress={saveJapamName}>
                  <Text style={styles.smallButtonText}>Save</Text>
                </Pressable>
                <Pressable style={[styles.smallButton, styles.secondaryButton]} onPress={cancelJapamNameEdit}>
                  <Text style={styles.smallButtonText}>Cancel</Text>
                </Pressable>
              </View>
            </View>
          )}
        </View>

        <View style={styles.card}>
          <View style={styles.textBlock}>
            <Text style={styles.label}>Completion Sound</Text>
            <Text style={styles.description}>
              Play sound when one mala or timer session is completed
            </Text>
          </View>

          <Switch value={soundEnabled} onValueChange={toggleSound} />
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
    backgroundColor: 'white',
  },

  content: {
    width: '100%',
    maxWidth: 820,
    alignSelf: 'center',
    paddingHorizontal: 20,
    paddingTop: 28,
    paddingBottom: 120,
  },

  header: {
    alignItems: 'center',
    marginBottom: 22,
  },

  omMark: {
    color: '#fbbf24',
    fontSize: 48,
    fontWeight: '700',
    marginBottom: 2,
    textShadowColor: 'rgba(251,191,36,0.65)',
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 18,
  },

  title: {
    color: 'white',
    fontSize: 36,
    fontWeight: '900',
    marginBottom: 4,
    textAlign: 'center',
  },

  subtitle: {
    color: '#cbd5e1',
    fontSize: 18,
    textAlign: 'center',
  },

  section: {
    marginBottom: 22,
  },

  sectionTitle: {
    color: '#cbd5e1',
    fontSize: 18,
    fontWeight: '800',
    marginBottom: 12,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },

  card: {
    backgroundColor: 'rgba(15, 23, 42, 0.72)',
    borderRadius: 16,
    padding: 18,
    marginBottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: 'rgba(251, 191, 36, 0.16)',
  },

  cardStack: {
    backgroundColor: 'rgba(15, 23, 42, 0.72)',
    borderRadius: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: 'rgba(251, 191, 36, 0.16)',
    overflow: 'hidden',
  },

  nameRow: {
    padding: 18,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },

  changeText: {
    color: '#fbbf24',
    fontSize: 16,
    fontWeight: '900',
  },

  inlineEditor: {
    borderTopWidth: 1,
    borderTopColor: 'rgba(251, 191, 36, 0.14)',
    paddingHorizontal: 18,
    paddingBottom: 18,
  },

  inlineActions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 10,
  },

  textBlock: {
    flex: 1,
    paddingRight: 14,
  },

  label: {
    color: 'white',
    fontSize: 20,
    fontWeight: '800',
  },

  description: {
    color: '#94a3b8',
    fontSize: 17,
    marginTop: 5,
    lineHeight: 24,
  },

  input: {
    backgroundColor: '#1e293b',
    color: 'white',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 13,
    borderWidth: 1,
    borderColor: '#334155',
    marginTop: 12,
    fontSize: 17,
    fontWeight: '700',
  },

  smallButton: {
    flex: 1,
    backgroundColor: '#7c3aed',
    borderRadius: 10,
    paddingVertical: 11,
    alignItems: 'center',
  },

  secondaryButton: {
    backgroundColor: '#475569',
  },

  smallButtonText: {
    color: 'white',
    fontSize: 15,
    fontWeight: '900',
  },

  compactButton: {
    backgroundColor: '#7c3aed',
    borderRadius: 10,
    paddingHorizontal: 18,
    paddingVertical: 10,
  },

  compactButtonText: {
    color: 'white',
    fontSize: 15,
    fontWeight: '900',
  },

  infoBox: {
    backgroundColor: 'rgba(23, 37, 84, 0.72)',
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: 'rgba(96, 165, 250, 0.34)',
  },

  infoTitle: {
    color: 'white',
    fontSize: 20,
    fontWeight: '800',
    marginBottom: 6,
  },

  infoText: {
    color: '#bfdbfe',
    fontSize: 17,
    lineHeight: 24,
  },
});
