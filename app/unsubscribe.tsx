import { useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { SafeAreaView, StyleSheet, Text, View } from 'react-native';
import { buildUnsubscribeEndpoint } from '../lib/unsubscribe';

type UnsubscribeState = 'loading' | 'success' | 'error';

export default function UnsubscribeScreen() {
  const { token } = useLocalSearchParams<{ token?: string | string[] }>();
  const [state, setState] = useState<UnsubscribeState>('loading');

  useEffect(() => {
    const resolvedToken = Array.isArray(token) ? token[0] : token;
    const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;

    if (!resolvedToken || !supabaseUrl) {
      setState('error');
      return;
    }

    let cancelled = false;
    fetch(buildUnsubscribeEndpoint(supabaseUrl, resolvedToken))
      .then(response => {
        if (!response.ok) throw new Error(`unsubscribe request failed: ${response.status}`);
        if (!cancelled) setState('success');
      })
      .catch(() => {
        if (!cancelled) setState('error');
      });

    return () => {
      cancelled = true;
    };
  }, [token]);

  const isLoading = state === 'loading';
  const isSuccess = state === 'success';

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.card}>
        <Text style={styles.eyebrow}>Mantra Japam</Text>
        <Text style={styles.title}>
          {isLoading
            ? 'Updating your email preferences…'
            : isSuccess
              ? 'You are unsubscribed'
              : 'Unable to update preferences'}
        </Text>
        <Text style={styles.message}>
          {isLoading
            ? 'Please wait a moment.'
            : isSuccess
              ? 'You will no longer receive Japam campaign emails.'
              : 'This unsubscribe link is invalid or could not be completed. Please try again later.'}
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#edf7f4',
    justifyContent: 'center',
    padding: 24,
  },
  card: {
    alignSelf: 'center',
    width: '100%',
    maxWidth: 560,
    padding: 32,
    borderRadius: 20,
    backgroundColor: '#ffffff',
  },
  eyebrow: {
    color: '#0F8F87',
    fontSize: 14,
    fontWeight: '800',
    marginBottom: 10,
  },
  title: {
    color: '#063B3B',
    fontSize: 28,
    fontWeight: '800',
    lineHeight: 36,
  },
  message: {
    color: '#315f60',
    fontSize: 16,
    lineHeight: 24,
    marginTop: 14,
  },
});
