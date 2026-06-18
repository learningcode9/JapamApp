import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { getGroupDashboard, type GroupDashboardRow } from '../../lib/groupsRepository';

const USER_ID_KEY = 'userId';
const TEAL = '#0F8F87';

// Local-day boundary, matching the same "viewer's local calendar day" definition used
// throughout the rest of this app (see lib/historyStore.ts's toLocalDayKey/todayStatsFor) —
// not a UTC day, since get_group_dashboard's today_start/today_end are caller-supplied for
// exactly this reason (the database can't know the viewing device's timezone).
function getLocalTodayBoundsIso(): { start: string; end: string } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  return { start: start.toISOString(), end: end.toISOString() };
}

function formatLastUpdated(iso: string | null): string {
  if (!iso) return 'Never';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Never';
  return date.toLocaleString();
}

// Active-today members first (most malas/count today first), then everyone else alphabetically
// — purely a display order, the underlying rows from get_group_dashboard are untouched.
function sortDashboardRows(rows: GroupDashboardRow[]): GroupDashboardRow[] {
  return [...rows].sort((a, b) => {
    const aActive = a.todayMalas > 0;
    const bActive = b.todayMalas > 0;
    if (aActive !== bActive) return aActive ? -1 : 1;
    if (b.todayMalas !== a.todayMalas) return b.todayMalas - a.todayMalas;
    if (b.todayCount !== a.todayCount) return b.todayCount - a.todayCount;
    return (a.userName || '').localeCompare(b.userName || '');
  });
}

export default function GroupsDashboardScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ groupId?: string; groupName?: string }>();
  const groupId = params.groupId || '';
  const groupName = params.groupName || 'Group';

  const [userId, setUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<GroupDashboardRow[]>([]);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const savedUserId = await AsyncStorage.getItem(USER_ID_KEY);
    setUserId(savedUserId);

    if (!savedUserId || !groupId) {
      setLoading(false);
      return;
    }

    setLoading(true);
    setError('');
    try {
      const { start, end } = getLocalTodayBoundsIso();
      const result = await getGroupDashboard(groupId, savedUserId, start, end);
      setRows(result);
    } catch (err: any) {
      setError(err?.message || 'Could not load this group.');
    } finally {
      setLoading(false);
    }
  }, [groupId]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load])
  );

  if (!userId) {
    return (
      <View style={styles.signInContainer}>
        <Ionicons name="people-outline" size={48} color={TEAL} />
        <Text style={styles.signInTitle}>Sign in required</Text>
        <Text style={styles.signInBody}>
          Groups require a Google account. Please sign in with Google from another tab to view
          this group.
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <Pressable style={styles.backButton} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={24} color={TEAL} />
        </Pressable>
        <Text style={styles.header} numberOfLines={1}>{groupName}</Text>
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent}>
        {loading ? (
          <ActivityIndicator color={TEAL} style={styles.loadingSpinner} />
        ) : error ? (
          <Text style={styles.errorText}>{error}</Text>
        ) : rows.length === 0 ? (
          <Text style={styles.emptyText}>No members found for this group.</Text>
        ) : (
          sortDashboardRows(rows).map((row) => {
            const isActiveToday = row.todayMalas > 0;
            return (
              <View key={row.userId} style={styles.memberCard}>
                <View style={styles.memberHeaderRow}>
                  <Text style={styles.memberName}>{row.userName || 'Unknown'}</Text>
                  {row.role === 'admin' && <Text style={styles.adminBadge}>Admin</Text>}
                  {isActiveToday && <Text style={styles.activeTodayBadge}>Active today</Text>}
                </View>

                <Text style={styles.sectionLabel}>Today</Text>
                <View style={styles.statsRow}>
                  <View style={styles.statBlock}>
                    <Text style={styles.statValue}>{row.todayMalas}</Text>
                    <Text style={styles.statLabel}>Malas</Text>
                  </View>
                  <View style={styles.statBlock}>
                    <Text style={styles.statValue}>{row.todayCount}</Text>
                    <Text style={styles.statLabel}>Count</Text>
                  </View>
                </View>

                <Text style={[styles.sectionLabel, styles.sectionLabelSpaced]}>All Time</Text>
                <View style={styles.statsRow}>
                  <View style={styles.statBlock}>
                    <Text style={styles.statValue}>{row.totalMalas}</Text>
                    <Text style={styles.statLabel}>Malas</Text>
                  </View>
                  <View style={styles.statBlock}>
                    <Text style={styles.statValue}>{row.totalCount}</Text>
                    <Text style={styles.statLabel}>Count</Text>
                  </View>
                </View>

                <Text style={styles.lastUpdated}>Last updated: {formatLastUpdated(row.lastUpdated)}</Text>
              </View>
            );
          })
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5fafa' },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingTop: 16,
    paddingBottom: 8,
    gap: 8,
  },
  backButton: { padding: 6 },
  header: { fontSize: 20, fontWeight: '900', color: '#12383c', flex: 1 },
  scrollContent: { padding: 20, paddingBottom: 100 },
  loadingSpinner: { marginTop: 24 },
  errorText: { color: '#b91c1c', fontSize: 14, textAlign: 'center', marginTop: 24 },
  emptyText: { color: '#365f61', fontSize: 15, lineHeight: 22, textAlign: 'center', marginTop: 24 },
  memberCard: {
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: 'rgba(15,118,110,0.12)',
  },
  memberHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  memberName: { fontSize: 17, fontWeight: '700', color: '#12383c' },
  adminBadge: {
    fontSize: 11,
    fontWeight: '800',
    color: TEAL,
    backgroundColor: 'rgba(15,143,135,0.12)',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
  },
  activeTodayBadge: {
    fontSize: 11,
    fontWeight: '800',
    color: '#0f766e',
    backgroundColor: 'rgba(15,143,135,0.18)',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
  },
  sectionLabel: {
    fontSize: 13,
    fontWeight: '800',
    color: '#547071',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  sectionLabelSpaced: { marginTop: 14 },
  statsRow: { flexDirection: 'row', gap: 28, marginBottom: 4 },
  statBlock: { minWidth: 80 },
  statValue: { fontSize: 30, fontWeight: '900', color: TEAL, lineHeight: 34 },
  statLabel: { fontSize: 14, fontWeight: '700', color: '#365f61', marginTop: 2 },
  lastUpdated: { fontSize: 12, color: '#547071', marginTop: 14 },
  signInContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
    backgroundColor: '#f5fafa',
  },
  signInTitle: { fontSize: 20, fontWeight: '900', color: '#12383c', marginTop: 16, marginBottom: 8 },
  signInBody: { fontSize: 15, lineHeight: 22, color: '#365f61', textAlign: 'center' },
});
