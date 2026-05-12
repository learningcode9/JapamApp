import AsyncStorage from '@react-native-async-storage/async-storage';
import { LinearGradient } from 'expo-linear-gradient';
import React, { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Switch, Text, View } from 'react-native';

const SOUND_ENABLED_KEY = 'soundEnabled';
const VIBRATION_ENABLED_KEY = 'vibrationEnabled';


export default function SettingsScreen() {
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [vibrationEnabled, setVibrationEnabled] = useState(true);
  

  useEffect(() => {
    const loadSettings = async () => {
      const savedSound = await AsyncStorage.getItem(SOUND_ENABLED_KEY);
      const savedVibration = await AsyncStorage.getItem(VIBRATION_ENABLED_KEY);
     

      setSoundEnabled(savedSound !== 'false');
      setVibrationEnabled(savedVibration !== 'false');
     
    };

    loadSettings();
  }, []);

  const toggleSound = async (value: boolean) => {
    setSoundEnabled(value);
    await AsyncStorage.setItem(SOUND_ENABLED_KEY, String(value));
  };

  const toggleVibration = async (value: boolean) => {
    setVibrationEnabled(value);
    await AsyncStorage.setItem(VIBRATION_ENABLED_KEY, String(value));
  };

  

  return (
    <LinearGradient colors={['#05010c', '#120022', '#05010c']} style={styles.container}>
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Settings</Text>
      <Text style={styles.subtitle}>Sound and vibration preferences.</Text>
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Japam Options</Text>

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

  content: {
    paddingHorizontal: 20,
    paddingTop: 32,
    paddingBottom: 120,
  },

  title: {
    color: 'white',
    fontSize: 30,
    fontWeight: '900',
    marginBottom: 4,
  },

  subtitle: {
    color: '#cbd5e1',
    fontSize: 14,
    marginBottom: 18,
  },

  section: {
    marginBottom: 22,
  },

  sectionTitle: {
    color: '#cbd5e1',
    fontSize: 15,
    fontWeight: '800',
    marginBottom: 12,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },

  card: {
    backgroundColor: 'rgba(15, 23, 42, 0.72)',
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: 'rgba(251, 191, 36, 0.16)',
  },

  textBlock: {
    flex: 1,
    paddingRight: 14,
  },

  label: {
    color: 'white',
    fontSize: 17,
    fontWeight: '800',
  },

  description: {
    color: '#94a3b8',
    fontSize: 13,
    marginTop: 5,
    lineHeight: 18,
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
    fontSize: 16,
    fontWeight: '800',
    marginBottom: 6,
  },

  infoText: {
    color: '#bfdbfe',
    fontSize: 14,
    lineHeight: 20,
  },
});
