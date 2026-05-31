import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import { LinearGradient } from 'expo-linear-gradient';
import { useFocusEffect } from 'expo-router';
import * as Sharing from 'expo-sharing';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
    Alert,
    DeviceEventEmitter,
    KeyboardAvoidingView,
    Modal,
    Platform,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    View,
} from 'react-native';

type Session = {
  date: string;
  malas: number;
  totalCount: number;
  duration: number;
  manual?: boolean;
  userId?: string;
};

type DailyRow = {
  dateKey: string;
  dateLabel: string;
  malas: number;
  totalCount: number;
  accumulated: number;
  duration: number;
  manualCount: number;
  autoCount: number;
};

type RemoteHistoryRow = {
  id?: number | string;
  created_at?: string;
  malas?: number | string;
  count?: number | string;
};

const USER_ID_KEY = 'userId';

const getLocalDateKey = (date = new Date()) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');

  return `${y}-${m}-${d}`;
};

const toDayKey = (rawDate: string) => {
  if (!rawDate) return 'unknown';

  if (/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
    return rawDate;
  }

  const d = new Date(rawDate);
  if (Number.isNaN(d.getTime())) return 'unknown';

  return getLocalDateKey(d);
};

const toDayLabel = (dayKey: string) => {
  if (dayKey === 'unknown') return 'Unknown Date';

  const [year, month, day] = dayKey.split('-').map(Number);
  const d = new Date(year, month - 1, day);

  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
};

const parseHistory = (raw: string | null): Session[] => {
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const dedupeSessions = (sessions: Session[]) => {
  const exactSeen = new Set<string>();
  const nearTimerRows = new Map<string, number[]>();

  return sessions.filter((item) => {
    const date = new Date(item.date);
    if (Number.isNaN(date.getTime())) return false;

    const itemMalas = Number(item.malas) || 0;
    const totalCount = Number(item.totalCount) || itemMalas * 108;
    if (totalCount <= 0) return false;

    const dayKey = toDayKey(item.date);
    const exactKey = [
      item.userId || 'guest',
      dayKey,
      date.toISOString(),
      totalCount,
      itemMalas,
      Number(item.duration) || 0,
      item.manual ? 'manual' : 'auto',
    ].join(':');

    if (exactSeen.has(exactKey)) return false;
    exactSeen.add(exactKey);

    if (!item.manual) {
      const nearKey = [
        item.userId || 'guest',
        dayKey,
        totalCount,
        itemMalas,
      ].join(':');
      const existingTimes = nearTimerRows.get(nearKey) || [];
      const time = date.getTime();
      if (existingTimes.some((existing) => Math.abs(existing - time) < 30000)) {
        return false;
      }
      nearTimerRows.set(nearKey, [...existingTimes, time]);
    }

    return true;
  });
};

const buildDailyRows = (sessions: Session[]) => {
  const grouped = new Map<string, DailyRow>();

  dedupeSessions(sessions).forEach((item) => {
    const dayKey = toDayKey(item.date);
    const existing = grouped.get(dayKey);

    const itemMalas = Number(item.malas) || 0;
    const itemTotalCount = Number(item.totalCount) || itemMalas * 108;
    const malas = itemMalas || Math.floor(itemTotalCount / 108);
    const totalCount = itemTotalCount;
    const duration = Number(item.duration) || 0;
    const isManual = !!item.manual;

    if (existing) {
      existing.malas += malas;
      existing.totalCount += totalCount;
      existing.duration += duration;

      if (isManual) existing.manualCount += 1;
      else existing.autoCount += 1;
      return;
    }

    grouped.set(dayKey, {
      dateKey: dayKey,
      dateLabel: toDayLabel(dayKey),
      malas,
      totalCount,
      accumulated: 0,
      duration,
      manualCount: isManual ? 1 : 0,
      autoCount: isManual ? 0 : 1,
    });
  });

  const oldestFirstRows = [...grouped.values()].sort((a, b) => {
    if (a.dateKey === 'unknown') return 1;
    if (b.dateKey === 'unknown') return -1;
    return a.dateKey.localeCompare(b.dateKey);
  });

  let runningTotal = 0;
  const rowsWithAccumulated = oldestFirstRows.map((row) => {
    runningTotal += row.totalCount;
    return { ...row, accumulated: runningTotal };
  });

  return rowsWithAccumulated.reverse();
};

const fetchRemoteSessions = async (userId: string): Promise<Session[] | null> => {
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const key = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key || !userId) return null;

  try {
    const fetchBy = async (field: 'user_id' | 'user_name', value: string) => {
      const query = new URLSearchParams({
        select: 'id,created_at,malas,count',
        [field]: `eq.${value}`,
        order: 'created_at.asc',
      });

      const response = await fetch(`${url}/rest/v1/japam_history?${query.toString()}`, {
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
        },
      });

      if (!response.ok) {
        console.log('Supabase history fetch error:', await response.text());
        return null;
      }

      const rows: RemoteHistoryRow[] = await response.json();

      return rows.map((row) => {
      const malas = Number(row.malas) || 0;
      const totalCount = Number(row.count) || malas * 108;

      return {
        date: row.created_at || new Date().toISOString(),
        malas: malas || Math.floor(totalCount / 108),
        totalCount,
        duration: 0,
        manual: false,
        userId,
      };
    });
    };

    const byUserId = await fetchBy('user_id', userId);
    return byUserId;
  } catch (error) {
    console.log('Supabase history fetch error:', error);
    return null;
  }
};

const saveToSupabase = async (
  userId: string,
  malas: number,
  totalCount: number,
  dateKey: string,
): Promise<boolean> => {
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const key = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return false;

  try {
    const body = {
      user_id: userId,
      malas,
      count: totalCount,
      created_at: `${dateKey}T12:00:00.000Z`,
    };
    const res = await fetch(`${url}/rest/v1/japam_history`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: key,
        Authorization: `Bearer ${key}`,
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch (err) {
    console.log('Supabase manual entry save error:', err);
    return false;
  }
};

export default function HistoryScreen() {
  const [dailyRows, setDailyRows] = useState<DailyRow[]>([]);
  const [showManualModal, setShowManualModal] = useState(false);
  const [manualDate, setManualDate] = useState('');
  const [manualMalas, setManualMalas] = useState('');
  const [manualCount, setManualCount] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  const openManualModal = () => {
    setManualDate(getLocalDateKey());
    setManualMalas('');
    setManualCount('');
    setShowManualModal(true);
  };

  const onMalasChange = (val: string) => {
    setManualMalas(val);
    const n = parseInt(val, 10);
    if (!Number.isNaN(n) && n >= 0) {
      setManualCount(String(n * 108));
    } else if (val === '') {
      setManualCount('');
    }
  };

  const onCountChange = (val: string) => {
    setManualCount(val);
    const n = parseInt(val, 10);
    if (!Number.isNaN(n) && n >= 0) {
      setManualMalas(String(Math.floor(n / 108)));
    } else if (val === '') {
      setManualMalas('');
    }
  };

  const saveManualEntry = async () => {
    const currentUserId = await AsyncStorage.getItem(USER_ID_KEY);
    if (!currentUserId) {
      Alert.alert('Please sign in', 'Please sign in to save history.');
      return;
    }

    if (!manualDate || !/^\d{4}-\d{2}-\d{2}$/.test(manualDate)) {
      Alert.alert('Invalid date', 'Please enter a valid date in YYYY-MM-DD format.');
      return;
    }

    const malas = parseInt(manualMalas, 10) || 0;
    const totalCount = parseInt(manualCount, 10) || 0;

    if (malas <= 0 && totalCount <= 0) {
      Alert.alert('Invalid entry', 'Please enter Total Malas or Total Count.');
      return;
    }

    const finalMalas = malas > 0 ? malas : Math.floor(totalCount / 108);
    const finalCount = totalCount > 0 ? totalCount : malas * 108;

    setIsSaving(true);
    try {
      const supabaseOk = await saveToSupabase(currentUserId, finalMalas, finalCount, manualDate);

      if (!supabaseOk) {
        const newSession: Session = {
          date: manualDate,
          malas: finalMalas,
          totalCount: finalCount,
          duration: 0,
          manual: true,
          userId: currentUserId,
        };
        const raw = await AsyncStorage.getItem('history');
        const existing = parseHistory(raw);
        await AsyncStorage.setItem('history', JSON.stringify([...existing, newSession]));
      }

      setShowManualModal(false);
      await loadHistory();

      DeviceEventEmitter.emit('japam-stats-updated');
      if (Platform.OS === 'web' && typeof window !== 'undefined') {
        window.dispatchEvent(new Event('japam-stats-updated'));
      }

      Alert.alert('Saved', 'Manual entry saved.');
    } catch (err) {
      console.log('Manual entry save error:', err);
      Alert.alert('Could not save manual entry', 'Something went wrong. Please try again.');
    } finally {
      setIsSaving(false);
    }
  };

  const loadHistory = useCallback(async () => {
    const todayKey = getLocalDateKey();
    const currentUserId = await AsyncStorage.getItem(USER_ID_KEY);
    const raw = await AsyncStorage.getItem('history');
    const allSessions = parseHistory(raw);

    if (!currentUserId) {
      setDailyRows([]);
      return;
    }

    const cleanedSessions = allSessions.filter((item) => {
      const dayKey = toDayKey(item.date);
      return dayKey === 'unknown' || dayKey <= todayKey;
    });

    if (cleanedSessions.length !== allSessions.length) {
      await AsyncStorage.setItem('history', JSON.stringify(cleanedSessions));
    }

    let sessions = dedupeSessions(cleanedSessions.filter((item) => item.userId === currentUserId));
    const remoteSessions = await fetchRemoteSessions(currentUserId);

    if (remoteSessions !== null) {
      const filteredRemoteSessions = remoteSessions.filter((item) => {
        const dayKey = toDayKey(item.date);
        return dayKey === 'unknown' || dayKey <= todayKey;
      });

      const localUserSessions = cleanedSessions.filter((item) => item.userId === currentUserId);
      const mergedMap = new Map<string, Session>();
      [...filteredRemoteSessions, ...localUserSessions].forEach((session) => {
        const key = `${session.date}-${session.totalCount}-${session.malas}`;
        mergedMap.set(key, session);
      });
      sessions = dedupeSessions([...mergedMap.values()]).sort(
        (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
      );
      const otherUserSessions = cleanedSessions.filter((item) => item.userId !== currentUserId);
      await AsyncStorage.setItem('history', JSON.stringify([...sessions, ...otherUserSessions]));

      // Notify Home screen to re-sync stats from the updated local history
      DeviceEventEmitter.emit('japam-stats-updated');
      if (Platform.OS === 'web' && typeof window !== 'undefined') {
        window.dispatchEvent(new Event('japam-stats-updated'));
      }
    }

    setDailyRows(buildDailyRows(sessions));
  }, []);

  useFocusEffect(
    useCallback(() => {
      void loadHistory();
    }, [loadHistory])
  );

  useEffect(() => {
    const onHistoryUpdated = () => {
      void loadHistory();
    };

    const subscription = DeviceEventEmitter.addListener('japam-history-updated', onHistoryUpdated);

    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      window.addEventListener('japam-history-updated', onHistoryUpdated as EventListener);
    }

    return () => {
      subscription.remove();
      if (Platform.OS === 'web' && typeof window !== 'undefined') {
        window.removeEventListener('japam-history-updated', onHistoryUpdated as EventListener);
      }
    };
  }, [loadHistory]);

  const totalMalas = useMemo(
    () => dailyRows.reduce((sum, row) => sum + row.malas, 0),
    [dailyRows]
  );

  const totalCount = useMemo(
    () => dailyRows.reduce((sum, row) => sum + row.totalCount, 0),
    [dailyRows]
  );

  const exportHistory = async () => {
    try {
      if (dailyRows.length === 0) {
        Alert.alert('No history', 'There is no history to export yet.');
        return;
      }

      const lines = ['Date,Malas,Count,Accumulated'];

      dailyRows.forEach((row) => {
        lines.push(
          `${row.dateKey},${row.malas},${row.totalCount},${row.accumulated}`
        );
      });

      const csvContent = lines.join('\n');

      if (Platform.OS === 'web') {
        const blob = new Blob([csvContent], {
          type: 'text/csv;charset=utf-8;',
        });

        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');

        link.href = url;
        link.download = 'japam-history.csv';
        document.body.appendChild(link);
        link.click();

        document.body.removeChild(link);
        URL.revokeObjectURL(url);

        return;
      }

      const fileUri = FileSystem.documentDirectory + 'japam-history.csv';

      await FileSystem.writeAsStringAsync(fileUri, csvContent, {
        encoding: FileSystem.EncodingType.UTF8,
      });

      const available = await Sharing.isAvailableAsync();

      if (!available) {
        Alert.alert('Sharing unavailable', 'Sharing is not available on this device.');
        return;
      }

      await Sharing.shareAsync(fileUri, {
        mimeType: 'text/csv',
        dialogTitle: 'Export Japam History',
        UTI: 'public.comma-separated-values-text',
      });
    } catch (error) {
      console.log('Export error:', error);
      Alert.alert('Export failed', 'Something went wrong while exporting history.');
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
      
      <Text style={styles.title}>History</Text>
      
      </View>
      <View style={styles.simpleSummary}>
        <Text style={styles.summaryText}>📿 Total Malas: {totalMalas}</Text>
        <Text style={styles.summaryText}>🔢 Total Count: {totalCount}</Text>
      </View>

      <View style={styles.actionRow}>
        <Pressable style={styles.exportBtn} onPress={exportHistory}>
          <Text style={styles.exportBtnText}>⬇ Export</Text>
        </Pressable>
        <Pressable style={styles.addBtn} onPress={openManualModal}>
          <Text style={styles.addBtnText}>+ Manual Entry</Text>
        </Pressable>
      </View>

      <Modal
        visible={showManualModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowManualModal(false)}
      >
        <KeyboardAvoidingView
          style={styles.modalOverlay}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Add Manual Entry</Text>

            <Text style={styles.modalLabel}>Date (YYYY-MM-DD)</Text>
            <TextInput
              style={styles.modalInput}
              value={manualDate}
              onChangeText={setManualDate}
              placeholder="2025-01-01"
              placeholderTextColor="#8aacae"
              maxLength={10}
            />

            <Text style={styles.modalLabel}>Total Malas</Text>
            <TextInput
              style={styles.modalInput}
              value={manualMalas}
              onChangeText={onMalasChange}
              placeholder="e.g. 3"
              placeholderTextColor="#8aacae"
              keyboardType="numeric"
              maxLength={5}
            />

            <Text style={styles.modalLabel}>Total Count</Text>
            <TextInput
              style={styles.modalInput}
              value={manualCount}
              onChangeText={onCountChange}
              placeholder="e.g. 324"
              placeholderTextColor="#8aacae"
              keyboardType="numeric"
              maxLength={7}
            />

            <View style={styles.modalActions}>
              <Pressable style={styles.modalCancel} onPress={() => setShowManualModal(false)} disabled={isSaving}>
                <Text style={styles.modalCancelText}>Cancel</Text>
              </Pressable>
              <Pressable style={[styles.modalSave, isSaving && { opacity: 0.6 }]} onPress={saveManualEntry} disabled={isSaving}>
                <Text style={styles.modalSaveText}>{isSaving ? 'Saving…' : 'Save'}</Text>
              </Pressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <View style={styles.tableCard}>
        <View style={[styles.tableRow, styles.tableHeader]}>
          <Text style={[styles.tableCell, styles.dateCell]}>Date</Text>
          <Text style={styles.tableCell}>Malas</Text>
          <Text style={styles.tableCell}>Count</Text>
          <Text style={styles.tableCell}>Total</Text>
        </View>

        {dailyRows.length === 0 ? (
          <View style={styles.emptyRow}>
            <Text style={styles.emptyText}>No Japam history yet</Text>
          </View>
        ) : (
          dailyRows.map((row, index) => (
            <View
              key={`${row.dateKey}-${index}`}
              style={[styles.tableRow, index % 2 === 1 && styles.altTableRow]}
            >
              <Text style={[styles.tableCell, styles.dateCell]}>
                {row.dateLabel}
              </Text>
              <Text style={styles.tableCell}>{row.malas}</Text>
              <Text style={styles.tableCell}>{row.totalCount}</Text>
              <Text style={styles.tableCell}>{row.accumulated}</Text>
            </View>
          ))
        )}
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
    maxWidth: 980,
    alignSelf: 'center',
    paddingHorizontal: 18,
    paddingTop: 28,
    paddingBottom: 140,
  },

  header: {
    alignItems: 'center',
    marginBottom: 18,
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

  simpleSummary: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 18,
    marginBottom: 16,
    justifyContent: 'center',
  },

  summaryText: {
    color: '#12383c',
    fontSize: 20,
    fontWeight: '700',
  },

  actionRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 10,
    marginBottom: 14,
  },

  exportBtn: {
    backgroundColor: '#0f8a87',
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 999,
  },

  exportBtnText: {
    color: 'white',
    fontSize: 14,
    fontWeight: '800',
  },

  addBtn: {
    backgroundColor: '#2563eb',
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 999,
  },

  addBtnText: {
    color: 'white',
    fontSize: 14,
    fontWeight: '800',
  },

  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },

  modalCard: {
    backgroundColor: '#fff',
    borderRadius: 20,
    padding: 24,
    width: '100%',
    maxWidth: 380,
  },

  modalTitle: {
    fontSize: 22,
    fontWeight: '900',
    color: '#102f34',
    marginBottom: 18,
    textAlign: 'center',
  },

  modalLabel: {
    fontSize: 14,
    fontWeight: '700',
    color: '#365f61',
    marginBottom: 6,
    marginTop: 10,
  },

  modalInput: {
    borderWidth: 1.5,
    borderColor: 'rgba(15,118,110,0.3)',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 16,
    color: '#102f34',
    backgroundColor: '#f5fafa',
  },

  modalActions: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 22,
    justifyContent: 'flex-end',
  },

  modalCancel: {
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: 999,
    backgroundColor: 'rgba(15,118,110,0.1)',
  },

  modalCancelText: {
    color: '#0f766e',
    fontSize: 15,
    fontWeight: '700',
  },

  modalSave: {
    paddingVertical: 10,
    paddingHorizontal: 24,
    borderRadius: 999,
    backgroundColor: '#0f8a87',
  },

  modalSaveText: {
    color: 'white',
    fontSize: 15,
    fontWeight: '800',
  },

  tableCard: {
    backgroundColor: 'rgba(255, 255, 255, 0.52)',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(15, 118, 110, 0.16)',
    overflow: 'hidden',
  },

  tableRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 58,
    borderTopWidth: 1,
    borderTopColor: 'rgba(15, 118, 110, 0.16)',
  },

  tableHeader: {
    backgroundColor: 'rgba(15, 118, 110, 0.18)',
    borderTopWidth: 0,
  },

  altTableRow: {
    backgroundColor: 'rgba(255, 255, 255, 0.34)',
  },

  tableCell: {
    flex: 1,
    color: '#12383c',
    fontSize: 18,
    paddingVertical: 14,
    paddingHorizontal: 8,
    fontWeight: '700',
  },
  dateCell: {
    flex: 1.4,
  },

  emptyRow: {
    padding: 18,
  },

  emptyText: {
    color: '#547071',
    fontSize: 18,
  },
});
