import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  appendCompletion,
  buildSupabaseHistoryPayload,
  lastUsedJapamNameKey,
  markSynced,
  normalizeJapamName,
  toLocalDayKey,
} from '../../lib/historyStore';
import { LinearGradient } from 'expo-linear-gradient';
import { router, useFocusEffect } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { Alert, DeviceEventEmitter, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';


type Session = {
  date: string;
  malas: number;
  totalCount: number;
  duration: number;
  manual?: boolean;
  userId?: string;
};

type ManualSyncInput = {
  userId: string;
  userName: string;
  malaNum: number;
  totalNum: number;
  selectedDateTime: string;
  completionId: string;
};

const HISTORY_KEY = 'history';
const USER_ID_KEY = 'userId';
const USER_NAME_KEY = 'userName';
const USER_EMAIL_KEY = 'userEmail';

const getStoredUserMeta = async () => {
  const [storedName, storedEmail] = await Promise.all([
    AsyncStorage.getItem(USER_NAME_KEY),
    AsyncStorage.getItem(USER_EMAIL_KEY),
  ]);
  const userName = (storedName || storedEmail || 'Unknown User').trim() || 'Unknown User';
  return { userName, userEmail: storedEmail || undefined };
};

const backfillMissingUserNames = async (userId: string, userName: string) => {
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const key = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key || !userId || !userName) return;

  try {
    const query = new URLSearchParams({ user_id: `eq.${userId}` });
    query.append('or', '(user_name.is.null,user_name.eq.)');
    const response = await fetch(`${url}/rest/v1/japam_history?${query.toString()}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        apikey: key,
        Authorization: `Bearer ${key}`,
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ user_name: userName }),
    });

    if (!response.ok) {
      console.log('Supabase user_name backfill error:', await response.text());
    }
  } catch (error) {
    console.log('Supabase user_name backfill error:', error);
  }
};

const syncManualEntryToSupabase = async ({
  userId,
  userName,
  malaNum,
  totalNum,
  selectedDateTime,
  completionId,
}: ManualSyncInput) => {
  console.log('[Manual] MANUAL_SYNC_START completionId=%s malas=%d count=%d', completionId, malaNum, totalNum);
  try {
    const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
    const key = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

    if (!url || !key) {
      console.log('[Manual] MANUAL_SYNC_FAILED reason=no-supabase-config (stays pending)');
      return;
    }

    const payload = buildSupabaseHistoryPayload({
      date: selectedDateTime,
      malas: malaNum,
      totalCount: totalNum,
      duration: 0,
      manual: true,
      userId,
      userName,
      completionId,
      syncStatus: 'pending',
    }, userId, userName);
    console.log(
      '[SYNC_PAYLOAD_CREATED_AT] source=manual completionId=%s created_at=%s localDay=%s',
      payload.completion_id,
      payload.created_at,
      toLocalDayKey(payload.created_at)
    );

    const response = await fetch(`${url}/rest/v1/japam_history?on_conflict=completion_id`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: key,
        Authorization: `Bearer ${key}`,
        Prefer: 'return=minimal,resolution=merge-duplicates',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      console.log('[SYNC_FAILED] source=manual completionId=%s status=%d (stays pending)', completionId, response.status);
      console.log('Supabase manual save error:', await response.text());
      return;
    }

    await backfillMissingUserNames(userId, userName);

    try {
      const latestRaw = await AsyncStorage.getItem(HISTORY_KEY);
      const latest = latestRaw ? JSON.parse(latestRaw) : [];
      await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(markSynced(latest, [completionId])));
      console.log('[MARK_SYNCED] source=manual completionId=%s', completionId);
    } catch {}
    console.log('[SYNC_SUCCESS] source=manual completionId=%s', completionId);
  } catch (error) {
    console.log('[Manual] MANUAL_SYNC_FAILED reason=network (stays pending)');
    console.log('Supabase manual save error:', error);
  }
};

export default function ManualEntry() {
  const getLocalDate = () => {
    const d = new Date();
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');

    return `${year}-${month}-${day}`;
  };

  const [dateText, setDateText] = useState(getLocalDate());
  const [malas, setMalas] = useState('');
  const [total, setTotal] = useState('');
  const [japamNameEntry, setJapamNameEntry] = useState('');
  const [userId, setUserId] = useState<string | null>(null);
  useFocusEffect(
    React.useCallback(() => {
      AsyncStorage.getItem(USER_ID_KEY).then(setUserId);
    }, [])
  );

  // Prefill "Current Japam" with whatever was last typed for THE CURRENT user/guest — a
  // convenience so a user chanting the same japam daily doesn't retype it every session. Never a
  // default: leaving it blank this session does not erase the remembered value (see onSave
  // below).
  //
  // Uses useFocusEffect (re-runs every time this screen gains focus), not a mount-only effect:
  // Manual Entry has no sign-in UI of its own, so an identity change can only happen by
  // navigating to another screen (Timer/Home/Tap), signing in/out there, then navigating back
  // here — which refocuses this screen and correctly re-checks. A mount-only effect would leave a
  // previous user's remembered name visible — and silently saved onto — the next signed-in user's
  // entry. Always setting the value (even to '' when the new identity has no remembered name) is
  // the fix; only setting it when truthy is what caused the leak.
  useFocusEffect(
    useCallback(() => {
      (async () => {
        const uid = await AsyncStorage.getItem(USER_ID_KEY);
        const stored = await AsyncStorage.getItem(lastUsedJapamNameKey(uid));
        setJapamNameEntry(stored || '');
      })();
    }, [])
  );

  const onSave = async () => {
    const userId = await AsyncStorage.getItem(USER_ID_KEY);
    console.log('[Manual] MANUAL_SAVE_START hasUser=%s', Boolean(userId));

    // onSave లో — alert బదులు:
if (!userId) {
    Alert.alert(
      'Login Required',
      'Please sign in with Google to save your japam history.',
      [
        { text: 'Cancel', style: 'cancel' },
        { 
          text: 'Go to Sign In', 
          onPress: () => router.push('/') // main tab కి
        }
      ]
    );
    return;
  }

    const typedDateMatch = dateText.trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (!typedDateMatch) {
      Alert.alert('Invalid date', 'Please enter date as YYYY-MM-DD');
      return;
    }

    const selectedYear = Number(typedDateMatch[1]);
    const selectedMonth = Number(typedDateMatch[2]);
    const selectedDay = Number(typedDateMatch[3]);
    const selectedDate = `${typedDateMatch[1]}-${typedDateMatch[2].padStart(2, '0')}-${typedDateMatch[3].padStart(2, '0')}`;
    const selectedDateValue = new Date(selectedYear, selectedMonth - 1, selectedDay, 12);
    const isValidDate =
      selectedDateValue.getFullYear() === selectedYear &&
      selectedDateValue.getMonth() === selectedMonth - 1 &&
      selectedDateValue.getDate() === selectedDay;

    if (!isValidDate) {
      Alert.alert('Invalid date', 'Please enter a valid date');
      return;
    }

    // Unique timestamp per entry (selected day + current time-of-day) so multiple manual entries
    // on the SAME date don't share a completion_id (= userId:epochMs). The old fixed noon made every
    // same-date manual entry collide -> dedup/upsert collapsed them ("Saved" but no change).
    const nowParts = new Date();
    const selectedDateTime = new Date(
      selectedYear, selectedMonth - 1, selectedDay,
      nowParts.getHours(), nowParts.getMinutes(), nowParts.getSeconds(), nowParts.getMilliseconds()
    ).toISOString();

    setDateText(selectedDate);

    const malaInput = Number(malas || 0);
    const totalInput = Number(total || 0);

    let malaNum = 0;
    let totalNum = 0;

    if (malaInput > 0) {
      malaNum = malaInput;
      totalNum = malaInput * 108;
    } else if (totalInput > 0) {
      totalNum = totalInput;
      malaNum = Number((totalInput / 108).toFixed(2));
    } else {
      Alert.alert('Please enter malas or total count');
      return;
    }

    const raw = await AsyncStorage.getItem(HISTORY_KEY);
    const history: Session[] = raw ? JSON.parse(raw) : [];
    const { userName, userEmail } = await getStoredUserMeta();

    // Save locally first with a stable completionId + syncStatus (offline-first, dedup-safe).
    const updatedHistory = appendCompletion(history, {
      date: selectedDateTime,
      malas: malaNum,
      totalCount: totalNum,
      duration: 0,
      manual: true,
      userId: userId || undefined,
      userName,
      userEmail,
      japamName: japamNameEntry,
    });
    const newCompletionId = updatedHistory[0].completionId;
    try {
      await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(updatedHistory));
      console.log('[OFFLINE_SAVE_ACCEPTED] source=manual completionId=%s malas=%d count=%d userId=%s userName=%s localDay=%s',
        newCompletionId, malaNum, totalNum, userId, userName, toLocalDayKey(selectedDateTime));
    } catch (err) {
      console.log('[Manual] MANUAL_HISTORY_SAVE_FAILED', err);
      Alert.alert('Save failed', 'Could not save the entry on this device.');
      return;
    }

    // Convenience-only prefill for next time — never erase the remembered value on a blank entry
    // (the user might just be skipping the name this once, not un-naming their practice).
    const normalizedJapamName = normalizeJapamName(japamNameEntry);
    if (normalizedJapamName !== null) {
      await AsyncStorage.setItem(lastUsedJapamNameKey(userId), normalizedJapamName).catch(() => {});
    }

    // Refresh History + Main stats immediately — same event the timer/tap completion path emits.
    // Without this the screens keep showing stale counts until a manual re-focus.
    DeviceEventEmitter.emit('japam-stats-updated');
    DeviceEventEmitter.emit('japam-history-updated', { userId: userId || 'guest' });
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      window.dispatchEvent(new Event('japam-stats-updated'));
      window.dispatchEvent(new Event('japam-history-updated'));
    }
    console.log('[Manual] MANUAL_STATS_EVENT_DISPATCHED');

    void syncManualEntryToSupabase({
      userId,
      userName,
      malaNum,
      totalNum,
      selectedDateTime,
      completionId: newCompletionId,
    });

    Alert.alert('Saved', 'Manual entry added to history');

    setMalas('');
    setTotal('');

    router.push('/history');
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
              opacity: i % 3 === 0 ? 0.75 : 0.32,
            },
          ]}
        />
      ))}
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
      <View style={styles.panel}>
  

  <Text style={styles.title}>Manual Entry</Text>

  <Text style={styles.subtitle}>
    Add Japam completed outside the app
  </Text>

  {!userId && (
    <Text style={styles.loginHint}>
      Sign in with Google from the Japam screen to save entries.
    </Text>
  
)}

      <Text style={styles.fieldLabel}>Completed Date</Text>
      <TextInput
        style={styles.input}
        value={dateText}
        onChangeText={setDateText}
        placeholder="YYYY-MM-DD"
        placeholderTextColor="#94a3b8"
      />

      <TextInput
        style={styles.input}
        value={malas}
        onChangeText={setMalas}
        keyboardType="numeric"
        placeholder="Malas"
        placeholderTextColor="#94a3b8"
      />

      <Text style={styles.or}>OR</Text>

      <TextInput
        style={styles.input}
        value={total}
        onChangeText={setTotal}
        keyboardType="numeric"
        placeholder="Total count"
        placeholderTextColor="#94a3b8"
      />

      <Text style={styles.fieldLabel}>Current Japam (Optional)</Text>
      <TextInput
        style={styles.input}
        value={japamNameEntry}
        onChangeText={setJapamNameEntry}
        placeholder="e.g. Gayatri"
        placeholderTextColor="#94a3b8"
      />

      <Pressable style={styles.btn} onPress={onSave}>
        <Text style={styles.btnText}>Save</Text>
      </Pressable>
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
    width: '100%',
  },

  scrollContent: {
    flexGrow: 1,
    padding: 18,
    alignItems: 'center',
    justifyContent: 'center',
    paddingBottom: 140,
  },

  star: {
    position: 'absolute',
    width: 2,
    height: 2,
    borderRadius: 99,
    backgroundColor: '#0f766e',
  },

  panel: {
    width: '100%',
    maxWidth: 560,
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.56)',
    borderWidth: 1,
    borderColor: 'rgba(15, 118, 110, 0.16)',
    borderRadius: 24,
    padding: 26,
  },

  fieldLabel: {
    width: '100%',
    maxWidth: 360,
    color: '#12383c',
    fontSize: 18,
    fontWeight: '800',
    marginTop: 6,
    marginBottom: 8,
  },

  title: {
    color: '#102f34',
    fontSize: 36,
    fontWeight: '900',
    marginBottom: 6,
  },

  subtitle: {
    color: '#365f61',
    fontSize: 18,
    marginBottom: 14,
    textAlign: 'center',
  },

  input: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: 'rgba(255,255,255,0.68)',
    color: '#12383c',
    borderRadius: 12,
    padding: 14,
    marginTop: 10,
    borderWidth: 1,
    borderColor: 'rgba(15,118,110,0.16)',
  },

  or: {
    color: '#547071',
    marginTop: 12,
    fontSize: 18,
  },

  btn: {
    marginTop: 16,
    backgroundColor: '#0f8a87',
    borderRadius: 999,
    paddingVertical: 14,
    paddingHorizontal: 28,
  },

  btnText: {
    color: 'white',
    fontWeight: '900',
    fontSize: 20,
  },
  loginHint: {
    color: '#365f61',
    fontSize: 15,
    textAlign: 'center',
    marginBottom: 18,
    lineHeight: 22,
    maxWidth: 320,
  },
  
});
