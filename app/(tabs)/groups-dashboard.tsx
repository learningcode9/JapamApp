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

// Highest Today's Malas first, then highest Today's Count, then alphabetical — purely a display
// order, the underlying rows from get_group_dashboard are untouched.
function sortDashboardRows(rows: GroupDashboardRow[]): GroupDashboardRow[] {
  return [...rows].sort((a, b) => {
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
          <View style={styles.tableCard}>
            <View style={[styles.tableRow, styles.tableHeader]}>
              <Text style={[styles.tableCell, styles.nameCell, styles.tableHeaderText]}>Name</Text>
              <Text style={[styles.tableCell, styles.numCell, styles.tableHeaderText]}>Today's Malas</Text>
              <Text style={[styles.tableCell, styles.numCell, styles.tableHeaderText]}>Today's Count</Text>
              <Text style={[styles.tableCell, styles.numCell, styles.tableHeaderText]}>Lifetime Count</Text>
            </View>

            {sortDashboardRows(rows).map((row, index) => (
              <View
                key={row.userId}
                style={[styles.tableRow, index % 2 === 1 && styles.altTableRow]}
              >
                <Text style={[styles.tableCell, styles.nameCell, styles.memberName]} numberOfLines={1}>
                  {row.role === 'admin' ? <Text style={styles.adminStar}>★ </Text> : null}
                  {row.userName || 'Unknown'}
                </Text>
                <Text style={[styles.tableCell, styles.numCell, styles.statValue]}>
                  {row.todayMalas}
                </Text>
                <Text style={[styles.tableCell, styles.numCell, styles.statValue]}>
                  {row.todayCount}
                </Text>
                <Text style={[styles.tableCell, styles.numCell, styles.statValue]}>
                  {row.totalCount}
                </Text>
              </View>
            ))}
          </View>
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
  tableCard: {
    backgroundColor: '#fff',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(15,118,110,0.16)',
    overflow: 'hidden',
  },
  tableRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 58,
    paddingVertical: 8,
    paddingHorizontal: 6,
    borderTopWidth: 1,
    borderTopColor: 'rgba(15,118,110,0.12)',
  },
  tableHeader: {
    backgroundColor: 'rgba(15,118,110,0.12)',
    borderTopWidth: 0,
    minHeight: 44,
  },
  altTableRow: { backgroundColor: 'rgba(15,118,110,0.04)' },
  // Every cell — Name and all three numeric columns — shares this exact height/lineHeight, with
  // no per-cell vertical padding, so there is no way for one column's box to differ from another's
  // and visibly sit higher or lower. Vertical breathing room lives on tableRow instead.
  tableCell: { height: 26, lineHeight: 26, paddingHorizontal: 2 },
  tableHeaderText: {
    fontSize: 15,
    fontWeight: '900',
    color: '#081a1c',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    textAlign: 'center',
  },
  nameCell: { flex: 1.3, textAlign: 'left' },
  numCell: { flex: 0.85, alignItems: 'center' },
  memberName: { fontSize: 17, fontWeight: '700', color: '#12383c' },
  adminStar: { color: '#c08a1e', fontSize: 15, fontWeight: '700' },
  statValue: { fontSize: 20, fontWeight: '900', color: TEAL, textAlign: 'center' },
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
