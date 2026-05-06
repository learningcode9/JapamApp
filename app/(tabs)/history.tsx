import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFocusEffect } from 'expo-router';
import React, { useCallback, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

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
  accumulatedTotal?: number;
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
  return d.toLocaleDateString();
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

        // Accumulated total should be calculated from oldest to newest
        let runningTotal = 0;

        const rowsWithAccumulated = [...latestFirstRows]
          .reverse()
          .map((row) => {
            runningTotal += row.totalCount;
            return {
              ...row,
              accumulatedTotal: runningTotal,
            };
          })
          .reverse();

        setDailyRows(rowsWithAccumulated);
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

  return (
    <View style={styles.container}>
      <Text style={styles.title}>History</Text>

      <Text style={styles.summary}>
        📿 Total malas: {totalMalas}   Total count: {totalCount}
      </Text>

      <ScrollView horizontal style={styles.tableWrapper} showsHorizontalScrollIndicator={false}>
        <View>
          <View style={[styles.row, styles.headerRow]}>
            <Text style={[styles.cell, styles.headerText, styles.dateCol]}>Date</Text>
            <Text style={[styles.cell, styles.headerText, styles.durationCol]}>Duration</Text>
            <Text style={[styles.cell, styles.headerText, styles.smallCol]}>Malas</Text>
            <Text style={[styles.cell, styles.headerText, styles.countCol]}>Count</Text>
            <Text style={[styles.cell, styles.headerText, styles.accumCol]}>Accumulated</Text>
            <Text style={[styles.cell, styles.headerText, styles.typeCol]}>Type</Text>
          </View>

          {dailyRows.length === 0 ? (
            <View style={[styles.row, styles.emptyRow]}>
              <Text style={styles.emptyText}>No history available</Text>
            </View>
          ) : (
            dailyRows.map((row, i) => {
              const type =
                row.manualCount > 0 && row.autoCount > 0
                  ? 'Mixed'
                  : row.manualCount > 0
                  ? 'Manual'
                  : 'Auto';

              return (
                <View
                  key={`${row.dateKey}-${i}`}
                  style={[styles.row, i % 2 ? styles.altRow : null]}
                >
                  <Text style={[styles.cell, styles.dateCol]}>{row.dateLabel}</Text>
                  <Text style={[styles.cell, styles.durationCol]}>
                    {formatDuration(row.duration)}
                  </Text>
                  <Text style={[styles.cell, styles.smallCol]}>{row.malas}</Text>
                  <Text style={[styles.cell, styles.countCol]}>{row.totalCount}</Text>
                  <Text style={[styles.cell, styles.accumCol]}>
                    {row.accumulatedTotal}
                  </Text>
                  <Text style={[styles.cell, styles.typeCol]}>{type}</Text>
                </View>
              );
            })
          )}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f172a',
    padding: 16,
  },

  title: {
    color: 'white',
    fontSize: 34,
    fontWeight: '800',
    marginVertical: 10,
  },

  summary: {
    color: '#cbd5e1',
    marginBottom: 12,
    fontSize: 17,
  },

  tableWrapper: {
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 12,
    backgroundColor: '#1e293b',
  },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: '#334155',
    minHeight: 52,
  },

  headerRow: {
    borderTopWidth: 0,
    backgroundColor: '#334155',
  },

  altRow: {
    backgroundColor: '#23314a',
  },

  cell: {
    color: 'white',
    fontSize: 15,
    paddingHorizontal: 10,
    paddingVertical: 12,
  },

  headerText: {
    fontWeight: '800',
    color: '#e2e8f0',
    fontSize: 18,
  },

  dateCol: {
    width: 180,
  },

  durationCol: {
    width: 110,
  },

  smallCol: {
    width: 80,
  },

  countCol: {
    width: 100,
  },

  accumCol: {
    width: 150,
  },

  typeCol: {
    width: 110,
  },

  emptyRow: {
    justifyContent: 'center',
  },

  emptyText: {
    color: '#94a3b8',
    padding: 16,
  },
});