import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import { LinearGradient } from 'expo-linear-gradient';
import { useFocusEffect } from 'expo-router';
import * as Sharing from 'expo-sharing';
import React, { useCallback, useMemo, useState } from 'react';
import {
    Alert,
    Platform,
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
  created_at?: string;
  malas?: number | string;
  count?: number | string;
};

const USER_ID_KEY = 'userId';
const USER_NAME_KEY = 'userName';

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

const fetchRemoteSessions = async (
  userId: string,
  userNameForFallback?: string | null
): Promise<Session[] | null> => {
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const key = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key || !userId) return null;

  try {
    const fetchBy = async (field: 'user_id' | 'user_name', value: string) => {
      const query = new URLSearchParams({
        select: 'created_at,malas,count',
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
    const byUserName = userNameForFallback
      ? await fetchBy('user_name', userNameForFallback)
      : null;

    if (byUserId === null) return byUserName;
    if (byUserName === null) return byUserId;

    const userIdTotal = byUserId.reduce(
      (sum, item) => sum + (Number(item.totalCount) || 0),
      0
    );
    const userNameTotal = byUserName.reduce(
      (sum, item) => sum + (Number(item.totalCount) || 0),
      0
    );

    return userNameTotal > userIdTotal ? byUserName : byUserId;
  } catch (error) {
    console.log('Supabase history fetch error:', error);
    return null;
  }
};

export default function HistoryScreen() {
  const [dailyRows, setDailyRows] = useState<DailyRow[]>([]);

  const loadHistory = useCallback(async () => {
    const todayKey = getLocalDateKey();
    const currentUserId = await AsyncStorage.getItem(USER_ID_KEY);
    const currentUserName = await AsyncStorage.getItem(USER_NAME_KEY);
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
    const remoteSessions = await fetchRemoteSessions(currentUserId, currentUserName);

    if (remoteSessions !== null) {
      const filteredRemoteSessions = remoteSessions.filter((item) => {
        const dayKey = toDayKey(item.date);
        return dayKey === 'unknown' || dayKey <= todayKey;
      });

      sessions = filteredRemoteSessions;
      const otherUserSessions = cleanedSessions.filter((item) => item.userId !== currentUserId);
      await AsyncStorage.setItem('history', JSON.stringify([...filteredRemoteSessions, ...otherUserSessions]));
    }

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
      } else {
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
      }
    });

    const oldestFirstRows = [...grouped.values()].sort((a, b) => {
      if (a.dateKey === 'unknown') return 1;
      if (b.dateKey === 'unknown') return -1;

      return a.dateKey.localeCompare(b.dateKey);
    });

    let runningTotal = 0;

    const rowsWithAccumulated = oldestFirstRows.map((row) => {
      runningTotal += row.totalCount;

      return {
        ...row,
        accumulated: runningTotal,
      };
    });

    setDailyRows(rowsWithAccumulated.reverse());
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
            <Text style={styles.emptyText}>No history available</Text>
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
    backgroundColor: 'white',
  },

  content: {
    width: '100%',
    maxWidth: 980,
    alignSelf: 'center',
    paddingHorizontal: 18,
    paddingTop: 28,
    paddingBottom: 120,
  },

  header: {
    alignItems: 'center',
    marginBottom: 18,
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

  simpleSummary: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 18,
    marginBottom: 16,
    justifyContent: 'center',
  },

  summaryText: {
    color: '#cbd5e1',
    fontSize: 20,
    fontWeight: '700',
  },

  exportBtn: {
    backgroundColor: '#6366f1',
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
    backgroundColor: 'rgba(15, 23, 42, 0.72)',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(251, 191, 36, 0.18)',
    overflow: 'hidden',
  },

  tableRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 58,
    borderTopWidth: 1,
    borderTopColor: '#334155',
  },

  tableHeader: {
    backgroundColor: 'rgba(51, 65, 85, 0.82)',
    borderTopWidth: 0,
  },

  altTableRow: {
    backgroundColor: 'rgba(35, 49, 74, 0.78)',
  },

  tableCell: {
    flex: 1,
    color: 'white',
    fontSize: 18,
    paddingVertical: 14,
    paddingHorizontal: 10,
    fontWeight: '700',
  },

  dateCell: {
    flex: 1.4,
  },

  emptyRow: {
    padding: 18,
  },

  emptyText: {
    color: '#94a3b8',
    fontSize: 18,
  },
});
