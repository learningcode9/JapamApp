import AsyncStorage from '@react-native-async-storage/async-storage';
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
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
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
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f172a',
  },

  content: {
    paddingHorizontal: 20,
    paddingTop: 32,
    paddingBottom: 120,
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
    backgroundColor: '#1e293b',
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: '#334155',
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
    backgroundColor: '#172554',
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: '#1d4ed8',
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