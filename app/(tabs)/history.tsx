import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import { useFocusEffect } from 'expo-router';
import * as Sharing from 'expo-sharing';
import React, { useCallback, useMemo, useState } from 'react';
import { Alert, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

type Session = {
  date: string;
  malas: number;
  totalCount: number;
  duration: number;
  manual?: boolean;
};

type DailyRow = {
  dateKey: string;
  dateLabel: string;
  malas: number;
  totalCount: number;
  duration: number;
  manualCount: number;
  autoCount: number;
};

const toDayKey = (rawDate: string) => {
  const d = new Date(rawDate);
  if (Number.isNaN(d.getTime())) return 'unknown';

  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');

  return `${y}-${m}-${day}`;
};

const toDayLabel = (dayKey: string) => {
  if (dayKey === 'unknown') return 'Unknown Date';

  const d = new Date(`${dayKey}T00:00:00`);
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
};

const formatDuration = (sec: number) => {
  const safe = Number.isFinite(sec) && sec >= 0 ? sec : 0;
  const m = Math.floor(safe / 60);
  const s = safe % 60;

  return `${m}:${String(s).padStart(2, '0')}`;
};

export default function HistoryScreen() {
  const [dailyRows, setDailyRows] = useState<DailyRow[]>([]);

  useFocusEffect(
    useCallback(() => {
      void (async () => {
        const raw = await AsyncStorage.getItem('history');
        const sessions: Session[] = raw ? JSON.parse(raw) : [];

        const grouped = new Map<string, DailyRow>();

        sessions.forEach((item) => {
          const dayKey = toDayKey(item.date);
          const existing = grouped.get(dayKey);

          const malas = Number(item.malas) || 0;
          const totalCount = Number(item.totalCount) || malas * 108;
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
              duration,
              manualCount: isManual ? 1 : 0,
              autoCount: isManual ? 0 : 1,
            });
          }
        });

        const latestFirstRows = [...grouped.values()].sort((a, b) => {
          if (a.dateKey === 'unknown') return 1;
          if (b.dateKey === 'unknown') return -1;

          return b.dateKey.localeCompare(a.dateKey);
        });

        setDailyRows(latestFirstRows);
      })();
    }, [])
  );

  const totalMalas = useMemo(
    () => dailyRows.reduce((sum, r) => sum + r.malas, 0),
    [dailyRows]
  );

  const totalCount = useMemo(
    () => dailyRows.reduce((sum, r) => sum + r.totalCount, 0),
    [dailyRows]
  );

  const exportHistory = async () => {
    try {
      if (dailyRows.length === 0) {
        Alert.alert('No history', 'There is no history to export yet.');
        return;
      }
  
      const lines = ['Date,Malas,Count,Accumulated,Type'];
  
      dailyRows.forEach((row) => {
        const type =
          row.manualCount > 0 && row.autoCount > 0
            ? 'Mixed'
            : row.manualCount > 0
            ? 'Saved'
            : 'Completed';
  
        lines.push(
          `${row.dateKey},${row.malas},${row.totalCount},${row.totalCount},${type}`
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
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.simpleSummary}>
        <Text style={styles.summaryText}>📿 Total Malas: {totalMalas}</Text>
        <Text style={styles.summaryText}>🔢 Total Count: {totalCount}</Text>
      </View>

      <Pressable style={styles.exportBtn} onPress={exportHistory}>
        <Text style={styles.exportBtnText}>Export History</Text>
      </Pressable>

      <View style={styles.tableCard}>
        <View style={[styles.tableRow, styles.tableHeader]}>
          <Text style={[styles.tableCell, styles.dateCell]}>Date</Text>
          <Text style={styles.tableCell}>Malas</Text>
          <Text style={styles.tableCell}>Count</Text>
          <Text style={styles.tableCell}>Accumulated</Text>
          <Text style={styles.tableCell}>Type</Text>
        </View>

        {dailyRows.length === 0 ? (
          <View style={styles.emptyRow}>
            <Text style={styles.emptyText}>No history available</Text>
          </View>
        ) : (
          dailyRows.map((row, index) => {
            const type =
              row.manualCount > 0 && row.autoCount > 0
                ? 'Mixed'
                : row.manualCount > 0
                ? 'Saved'
                : 'Completed';

            return (
              <View
                key={`${row.dateKey}-${index}`}
                style={[
                  styles.tableRow,
                  index % 2 === 1 && styles.altTableRow,
                ]}
              >
                <Text style={[styles.tableCell, styles.dateCell]}>
                  {row.dateLabel}
                </Text>
                <Text style={styles.tableCell}>{row.malas}</Text>
                <Text style={styles.tableCell}>{row.totalCount}</Text>
                <Text style={styles.tableCell}>{row.totalCount}</Text>
                <Text style={styles.tableCell}>{type}</Text>
              </View>
            );
          })
        )}
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
    paddingHorizontal: 18,
    paddingTop: 24,
    paddingBottom: 120,
  },

  simpleSummary: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 18,
    marginBottom: 16,
  },

  summaryText: {
    color: '#cbd5e1',
    fontSize: 16,
    fontWeight: '700',
  },

  exportBtn: {
    backgroundColor: '#6366f1',
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: 10,
    alignSelf: 'flex-start',
    marginBottom: 14,
  },

  exportBtnText: {
    color: 'white',
    fontSize: 15,
    fontWeight: '700',
  },

  tableCard: {
    backgroundColor: '#1e293b',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#334155',
    overflow: 'hidden',
  },

  tableRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 48,
    borderTopWidth: 1,
    borderTopColor: '#334155',
  },

  tableHeader: {
    backgroundColor: '#334155',
    borderTopWidth: 0,
  },

  altTableRow: {
    backgroundColor: '#23314a',
  },

  tableCell: {
    flex: 1,
    color: 'white',
    fontSize: 14,
    paddingVertical: 12,
    paddingHorizontal: 8,
    fontWeight: '600',
  },

  dateCell: {
    flex: 1.4,
  },

  emptyRow: {
    padding: 18,
  },

  emptyText: {
    color: '#94a3b8',
    fontSize: 15,
  },
});