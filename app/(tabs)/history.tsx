import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import { LinearGradient } from 'expo-linear-gradient';
import { useFocusEffect } from 'expo-router';
import * as Sharing from 'expo-sharing';
import { Ionicons } from '@expo/vector-icons';
import React, { useCallback, useMemo, useState } from 'react';
import {
    Alert,
    DeviceEventEmitter,
    Platform,
    Modal,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
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
const HISTORY_KEY = 'history';
const TOTAL_KEY = 'totalCount';
const MALAS_KEY = 'malas';
const COUNT_KEY = 'count';
const LAST_TOTAL_KEY = 'lastTotal';
const HISTORY_SYNC_VERSION_KEY = 'historyStatsSyncVersion';
const getUserStorageKey = (key: string, userId: string) => `${key}:${userId}`;

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

const buildDailyRows = (sessions: Session[]) => {
  const grouped = new Map<string, DailyRow>();

  sessions.forEach((item) => {
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

export default function HistoryScreen() {
  const [dailyRows, setDailyRows] = useState<DailyRow[]>([]);
  const [deleteTarget, setDeleteTarget] = useState<DailyRow | null>(null);

  const saveUserTotalToSupabase = useCallback(
    async (userId: string, totalValue: number) => {
      const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
      const key = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
      if (!url || !key || !userId) return;

      const safeTotal = Math.max(0, Math.floor(Number(totalValue) || 0));
      const savedUserName = await AsyncStorage.getItem('userName');

      const response = await fetch(`${url}/rest/v1/japam_user_totals?on_conflict=user_id`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: key,
          Authorization: `Bearer ${key}`,
          Prefer: 'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify({
          user_id: userId,
          user_name: savedUserName || 'User',
          total_count: safeTotal,
          malas: Math.floor(safeTotal / 108),
          count: safeTotal % 108,
          updated_at: new Date().toISOString(),
        }),
      });

      if (!response.ok) {
        console.log('Supabase total update error:', await response.text());
      }
    },
    []
  );

  const deleteDayFromSupabase = useCallback(
    async (userId: string, dayKey: string): Promise<boolean> => {
      const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
      const key = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
      if (!url || !key || !userId) return false;

      const [year, month, day] = dayKey.split('-').map(Number);
      const localStart = new Date(year, month - 1, day, 0, 0, 0, 0);
      const localEnd = new Date(year, month - 1, day + 1, 0, 0, 0, 0);
      const dayStart = localStart.toISOString();
      const dayEnd = localEnd.toISOString();
      const encodedUserId = encodeURIComponent(userId);

      console.log('Deleting day:', dayKey);
      console.log('Delete range:', dayStart, dayEnd);

      const query = new URLSearchParams({
        user_id: `eq.${encodedUserId}`,
        created_at: `gte.${dayStart}`,
      });
      query.append('created_at', `lt.${dayEnd}`);

      const response = await fetch(`${url}/rest/v1/japam_history?${query.toString()}`, {
        method: 'DELETE',
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
        },
      });

      console.log('Delete response:', response.status);

      if (!response.ok) {
        console.log('Supabase delete error:', await response.text());
        return false;
      }

      return true;
    },
    []
  );

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

    let sessions = cleanedSessions.filter((item) => item.userId === currentUserId);
    const remoteSessions = await fetchRemoteSessions(currentUserId);

    if (remoteSessions !== null) {
      const filteredRemoteSessions = remoteSessions.filter((item) => {
        const dayKey = toDayKey(item.date);
        return dayKey === 'unknown' || dayKey <= todayKey;
      });

      sessions = filteredRemoteSessions;
      const otherUserSessions = cleanedSessions.filter((item) => item.userId !== currentUserId);
      await AsyncStorage.setItem('history', JSON.stringify([...filteredRemoteSessions, ...otherUserSessions]));
    }

    setDailyRows(buildDailyRows(sessions));
  }, []);

  const refreshHomeStatsFromLocalHistory = useCallback(async (currentUserId: string) => {
    const raw = await AsyncStorage.getItem(HISTORY_KEY);
    const allSessions = parseHistory(raw);
    const todayKey = getLocalDateKey();

    const userTodayTotal = allSessions
      .filter((item) => item.userId === currentUserId && toDayKey(item.date) === todayKey)
      .reduce((sum, item) => sum + (Number(item.totalCount) || 0), 0);

    const nextMalas = Math.floor(userTodayTotal / 108);
    const nextCount = userTodayTotal % 108;

    await AsyncStorage.multiSet([
      [TOTAL_KEY, String(userTodayTotal)],
      [MALAS_KEY, String(nextMalas)],
      [COUNT_KEY, String(nextCount)],
      [LAST_TOTAL_KEY, String(userTodayTotal)],
      [getUserStorageKey(TOTAL_KEY, currentUserId), String(userTodayTotal)],
      [getUserStorageKey(MALAS_KEY, currentUserId), String(nextMalas)],
      [getUserStorageKey(COUNT_KEY, currentUserId), String(nextCount)],
      [HISTORY_SYNC_VERSION_KEY, String(Date.now())],
    ]);

    await saveUserTotalToSupabase(currentUserId, userTodayTotal);

    DeviceEventEmitter.emit('japam-history-updated', {
      userId: currentUserId,
      todayTotal: userTodayTotal,
    });
  }, [saveUserTotalToSupabase]);

  const handleDeleteDay = useCallback((row: DailyRow) => {
    setDeleteTarget(row);
  }, []);

  useFocusEffect(
    useCallback(() => {
      void loadHistory();
    }, [loadHistory])
  );

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

      <Pressable style={styles.exportBtn} onPress={exportHistory}>
      <Text style={styles.exportBtnText}>⬇ Export</Text>
      </Pressable>

      <View style={styles.tableCard}>
        <View style={[styles.tableRow, styles.tableHeader]}>
          <Text style={[styles.tableCell, styles.dateCell]}>Date</Text>
          <Text style={styles.tableCell}>Malas</Text>
          <Text style={styles.tableCell}>Count</Text>
          <Text style={styles.tableCell}>Accumulated</Text>
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
              <View style={styles.rowActionCell}>
                <Pressable
                  style={({ pressed }) => [
                    styles.deleteIconBtn,
                    pressed && styles.deleteIconBtnPressed,
                  ]}
                  onPress={() => handleDeleteDay(row)}
                  hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                  pressRetentionOffset={{ top: 18, bottom: 18, left: 18, right: 18 }}
                  accessibilityRole="button"
                  accessibilityLabel={`Delete history for ${row.dateLabel}`}
                >
                  <Ionicons name="trash-outline" size={16} color="#b91c1c" />
                </Pressable>
              </View>
            </View>
          ))
        )}
      </View>

      <Modal visible={!!deleteTarget} transparent animationType="fade" onRequestClose={() => setDeleteTarget(null)}>
        <View style={styles.confirmOverlay}>
          <View style={styles.confirmCard}>
            <Text style={styles.confirmTitle}>Delete this history?</Text>
            <Text style={styles.confirmText}>This action cannot be undone.</Text>
            <View style={styles.confirmActions}>
              <Pressable style={styles.confirmCancel} onPress={() => setDeleteTarget(null)}>
                <Text style={styles.confirmCancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={styles.confirmDelete}
                onPress={async () => {
                  const target = deleteTarget;
                  setDeleteTarget(null);
                  if (!target) return;
                  const currentUserId = await AsyncStorage.getItem(USER_ID_KEY);
                  if (!currentUserId) return;

                  const deleted = await deleteDayFromSupabase(currentUserId, target.dateKey);
                  if (!deleted) {
                    Alert.alert('Delete failed. Please try again.');
                    return;
                  }

                  const raw = await AsyncStorage.getItem(HISTORY_KEY);
                  const allSessions = parseHistory(raw);

                  const keptSessions = allSessions.filter((item) => {
                    if (item.userId !== currentUserId) return true;
                    return toDayKey(item.date) !== target.dateKey;
                  });

                  await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(keptSessions));
                  await refreshHomeStatsFromLocalHistory(currentUserId);
                  await loadHistory();
                  Alert.alert('History deleted');
                }}
              >
                <Text style={styles.confirmDeleteText}>Delete</Text>
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

  exportBtn: {
    backgroundColor: '#0f8a87',
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 999,
    alignSelf: 'center',
    marginBottom: 14,
  },

  exportBtnText: {
    color: 'white',
    fontSize: 14,
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
  rowActionCell: {
    width: 56,
    alignItems: 'center',
    justifyContent: 'center',
    paddingRight: 8,
    overflow: 'visible',
    zIndex: 2,
  },
  deleteIconBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(220, 38, 38, 0.08)',
    borderWidth: 1,
    borderColor: 'rgba(185, 28, 28, 0.12)',
    elevation: 1,
  },
  deleteIconBtnPressed: {
    opacity: 0.8,
    transform: [{ scale: 0.96 }],
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
    maxWidth: 340,
    backgroundColor: 'rgba(255, 255, 255, 0.97)',
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
    gap: 10,
  },

  confirmCancel: {
    flex: 1,
    minHeight: 46,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#edf7f4',
  },

  confirmCancelText: {
    color: '#12383c',
    fontSize: 15,
    fontWeight: '700',
  },

  confirmDelete: {
    flex: 1,
    minHeight: 46,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(185, 28, 28, 0.08)',
  },

  confirmDeleteText: {
    color: '#b91c1c',
    fontSize: 15,
    fontWeight: '800',
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
