import AsyncStorage from '@react-native-async-storage/async-storage';
import { LinearGradient } from 'expo-linear-gradient';
import React, { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Switch, Text, View } from 'react-native';

const SOUND_ENABLED_KEY = 'soundEnabled';
const VIBRATION_ENABLED_KEY = 'vibrationEnabled';
const TIMER_ALERT_ENABLED_KEY = 'timerAlertEnabled';


export default function SettingsScreen() {
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [vibrationEnabled, setVibrationEnabled] = useState(true);
  const [timerAlertEnabled, setTimerAlertEnabled] = useState(true);
  

  useEffect(() => {
    const loadSettings = async () => {
      const savedSound = await AsyncStorage.getItem(SOUND_ENABLED_KEY);
      const savedVibration = await AsyncStorage.getItem(VIBRATION_ENABLED_KEY);
      const savedTimerAlert = await AsyncStorage.getItem(TIMER_ALERT_ENABLED_KEY);
     

      setSoundEnabled(savedSound !== 'false');
      setVibrationEnabled(savedVibration !== 'false');
      setTimerAlertEnabled(savedTimerAlert !== 'false');
     
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

  const toggleTimerAlert = async (value: boolean) => {
    setTimerAlertEnabled(value);
    await AsyncStorage.setItem(TIMER_ALERT_ENABLED_KEY, String(value));
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
        <Text style={styles.omMark}>ॐ</Text>
      <Text style={styles.title}>Settings</Text>
      <Text style={styles.subtitle}>Sound and vibration preferences.</Text>
      </View>
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

        <View style={styles.card}>
          <View style={styles.textBlock}>
            <Text style={styles.label}>Lock Screen Timer Alert</Text>
            <Text style={styles.description}>
              Show a native phone notification while the timer is running
            </Text>
          </View>

          <Switch value={timerAlertEnabled} onValueChange={toggleTimerAlert} />
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
