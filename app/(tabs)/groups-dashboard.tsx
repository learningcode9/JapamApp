import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, DeviceEventEmitter, Dimensions, Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import { getGroupDashboard, getGroupInviteCode, type GroupDashboardRow } from '../../lib/groupsRepository';

// While the dashboard is focused, re-fetch this often so other members' completions show up
// without anyone needing to leave and re-enter the screen. Kept well above the Supabase round
// trip a single get_group_dashboard call takes, so a slow request never overlaps the next tick.
const AUTO_REFRESH_INTERVAL_MS = 12000;

const USER_ID_KEY = 'userId';
const TEAL = '#0F8F87';

// Same width-based breakpoint convention as history.tsx — five columns (Name, Today's Malas,
// Today's Count, Lifetime Malas, Lifetime Count) need noticeably tighter sizing on small phones
// than the previous four-column layout did, without letting any text become unreadably tiny or
// forcing horizontal scrolling.
const { width: DASHBOARD_SCREEN_WIDTH } = Dimensions.get('window');
const isNarrowPhone = DASHBOARD_SCREEN_WIDTH < 380;
const isTablet = DASHBOARD_SCREEN_WIDTH >= 768;

const HEADER_FONT_SIZE = isTablet ? 16 : isNarrowPhone ? 11 : 13;
const VALUE_FONT_SIZE = isTablet ? 19 : isNarrowPhone ? 15 : 17;
const NAME_FONT_SIZE = isTablet ? 17 : isNarrowPhone ? 15 : 16;
const CELL_PADDING_H = isNarrowPhone ? 1 : isTablet ? 4 : 2;
const NAME_CELL_FLEX = isTablet ? 1.3 : isNarrowPhone ? 0.95 : 1.0;
// Count columns hold larger numbers than their matching Malas columns (count is always malas×108
// at minimum), so they get slightly more width — same proportion already used for the Today
// pair, now applied consistently to the Lifetime pair too. Lifetime columns get noticeably more
// share than Today's — "Lifetime Malas"/"Lifetime Count" are the longest header labels, and
// without enough width the word "Lifetime" itself was wrapping mid-word ("LIFE"/"TIME") instead
// of breaking cleanly between "Lifetime" and "Malas"/"Count".
const TODAY_MALAS_FLEX = isNarrowPhone ? 0.5 : isTablet ? 0.75 : 0.62;
const TODAY_COUNT_FLEX = isNarrowPhone ? 0.6 : isTablet ? 0.85 : 0.7;
const LIFETIME_MALAS_FLEX = isNarrowPhone ? 0.7 : isTablet ? 0.95 : 0.85;
const LIFETIME_COUNT_FLEX = isNarrowPhone ? 0.85 : isTablet ? 1.1 : 0.95;

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
  const [inviteCode, setInviteCode] = useState<string | null>(null);
  const [copyLabel, setCopyLabel] = useState('Copy');

  // Overlap guard — the 12s interval, the two event listeners, and the initial focus-triggered
  // load can all fire close together; this ensures only one get_group_dashboard request is ever
  // in flight at a time, exactly like the same pattern already used by syncPendingHistory.
  const loadInFlightRef = useRef(false);

  // Background refreshes (interval ticks, event-driven re-fetches) update the table data silently
  // — only the very first load for this screen shows the full-screen spinner. Without this, the
  // table would flash back to a loading state every ~12s or after every completion, which is far
  // more disruptive than the staleness this feature is meant to fix.
  const load = useCallback(async (options?: { silent?: boolean }) => {
    if (loadInFlightRef.current) return;
    loadInFlightRef.current = true;
    const silent = options?.silent ?? false;
    try {
      const savedUserId = await AsyncStorage.getItem(USER_ID_KEY);
      setUserId(savedUserId);

      if (!savedUserId || !groupId) {
        if (!silent) setLoading(false);
        return;
      }

      if (!silent) setLoading(true);
      setError('');
      try {
        const { start, end } = getLocalTodayBoundsIso();
        const result = await getGroupDashboard(groupId, savedUserId, start, end);
        setRows(result);
      } catch (err: any) {
        if (!silent) setError(err?.message || 'Could not load this group.');
      } finally {
        if (!silent) setLoading(false);
      }
    } finally {
      loadInFlightRef.current = false;
    }
  }, [groupId]);

  useFocusEffect(
    useCallback(() => {
      void load();

      // Background refresh while focused — picks up other members' completions once their data
      // has synced to Supabase, without requiring the viewer to leave and re-enter the screen.
      // Scoped to focus only (per requirement): no point polling Supabase for a screen no one is
      // looking at.
      const intervalId = setInterval(() => {
        void load({ silent: true });
      }, AUTO_REFRESH_INTERVAL_MS);

      return () => clearInterval(intervalId);
    }, [load])
  );

  // Immediate refresh when THIS device records a completion. Deliberately NOT scoped to focus —
  // completing a mala always requires navigating to Timer/Tap Japam first, which blurs this
  // screen (Expo Router tabs keep it mounted, just unfocused); a focus-gated listener would be
  // torn down at exactly the moment the event it's waiting for fires. Mount-scoped instead, so the
  // dashboard is already fresh the instant the viewer switches back to this tab — no manual
  // refresh, no waiting for the next interval tick.
  useEffect(() => {
    const historySub = DeviceEventEmitter.addListener('japam-history-updated', () => {
      void load({ silent: true });
    });
    const statsSub = DeviceEventEmitter.addListener('japam-stats-updated', () => {
      void load({ silent: true });
    });

    return () => {
      historySub.remove();
      statsSub.remove();
    };
  }, [load]);

  // The dashboard rows already tell us the current viewer's own role in this group (no separate
  // "am I admin" call needed) — find their own row by userId.
  const isAdmin = rows.some((row) => row.userId === userId && row.role === 'admin');

  // Lazy, one-time fetch — the invite code never changes once a group is created, so there's no
  // need to re-fetch it on every 12s refresh tick the way the roster/stats are. Only admins ever
  // call this (get_group_invite_code itself also enforces that server-side); re-fetches only if
  // the viewer becomes admin or switches to a different group while this screen stays mounted.
  useEffect(() => {
    if (!isAdmin || !userId || !groupId) {
      setInviteCode(null);
      return;
    }
    let cancelled = false;
    getGroupInviteCode(groupId, userId)
      .then((code) => {
        if (!cancelled) setInviteCode(code);
      })
      .catch(() => {
        // Non-fatal — the invite code section just won't render; the rest of the dashboard
        // (roster/stats) is unaffected.
      });
    return () => {
      cancelled = true;
    };
  }, [isAdmin, userId, groupId]);

  const handleCopyInviteCode = async () => {
    if (!inviteCode) return;
    await Clipboard.setStringAsync(inviteCode);
    setCopyLabel('Copied!');
    setTimeout(() => setCopyLabel('Copy'), 1500);
  };

  const handleShareInviteCode = async () => {
    if (!inviteCode) return;
    try {
      await Share.share({
        message: `Join my Japam group.\nInvite code: ${inviteCode}`,
      });
    } catch {
      // User dismissed the share sheet or it failed — no error state needed, they can retry.
    }
  };

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
        {isAdmin && inviteCode ? (
          <View style={styles.inviteCodeRow}>
            <Text style={styles.inviteCodeText} numberOfLines={1}>
              Invite Code: <Text style={styles.inviteCodeValue}>{inviteCode}</Text>
            </Text>
            <Pressable style={styles.inviteCodeButton} onPress={handleCopyInviteCode}>
              <Text style={styles.inviteCodeButtonText}>{copyLabel}</Text>
            </Pressable>
            <Pressable style={styles.inviteCodeButton} onPress={handleShareInviteCode}>
              <Text style={styles.inviteCodeButtonText}>Share</Text>
            </Pressable>
          </View>
        ) : null}
        {loading ? (
          <ActivityIndicator color={TEAL} style={styles.loadingSpinner} />
        ) : error ? (
          <Text style={styles.errorText}>{error}</Text>
        ) : rows.length === 0 ? (
          <Text style={styles.emptyText}>No members found for this group.</Text>
        ) : (
          <View style={styles.tableCard}>
            <View style={[styles.tableRow, styles.tableHeader]}>
              <Text style={[styles.tableHeaderCell, styles.tableHeaderText, styles.nameCell]}>Name</Text>
              <Text style={[styles.tableHeaderCell, styles.todayMalasCell, styles.tableHeaderText]}>Today Mala</Text>
              <Text style={[styles.tableHeaderCell, styles.todayCountCell, styles.tableHeaderText]}>Today Count</Text>
              <Text style={[styles.tableHeaderCell, styles.lifetimeMalasCell, styles.tableHeaderText]}>Lifetime Malas</Text>
              <Text style={[styles.tableHeaderCell, styles.lifetimeCountCell, styles.tableHeaderText]}>Lifetime Count</Text>
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
                <Text style={[styles.tableCell, styles.todayMalasCell, styles.statValue]}>
                  {row.todayMalas}
                </Text>
                <Text style={[styles.tableCell, styles.todayCountCell, styles.statValue]}>
                  {row.todayCount}
                </Text>
                <Text style={[styles.tableCell, styles.lifetimeMalasCell, styles.statValue]}>
                  {row.totalMalas}
                </Text>
                <Text style={[styles.tableCell, styles.lifetimeCountCell, styles.statValue]}>
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
    minHeight: 36,
  },
  altTableRow: { backgroundColor: 'rgba(15,118,110,0.04)' },
  // Every DATA cell — Name and all four numeric columns — shares this exact height/lineHeight,
  // with no per-cell vertical padding, so there is no way for one column's box to differ from
  // another's and visibly sit higher or lower. Vertical breathing room lives on tableRow instead.
  tableCell: { height: 26, lineHeight: 26, paddingHorizontal: CELL_PADDING_H },
  // Header cells size naturally instead of using the data rows' fixed height — on narrow phones
  // five columns' worth of labels may wrap to two lines, which is fine; there's no fixed height
  // to overflow here, unlike the data rows above.
  tableHeaderCell: { paddingVertical: 6, paddingHorizontal: CELL_PADDING_H },
  tableHeaderText: {
    fontSize: HEADER_FONT_SIZE,
    fontWeight: '900',
    color: '#081a1c',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
    textAlign: 'center',
  },
  nameCell: { flex: NAME_CELL_FLEX, textAlign: 'left' },
  todayMalasCell: { flex: TODAY_MALAS_FLEX, alignItems: 'center', textAlign: 'center' },
  todayCountCell: { flex: TODAY_COUNT_FLEX, alignItems: 'center', textAlign: 'center' },
  lifetimeMalasCell: { flex: LIFETIME_MALAS_FLEX, alignItems: 'center', textAlign: 'center' },
  lifetimeCountCell: { flex: LIFETIME_COUNT_FLEX, alignItems: 'center', textAlign: 'center' },
  memberName: { fontSize: NAME_FONT_SIZE, fontWeight: '700', color: '#12383c' },
  adminStar: { color: '#c08a1e', fontSize: 15, fontWeight: '700' },
  statValue: { fontSize: VALUE_FONT_SIZE, fontWeight: '900', color: TEAL, textAlign: 'center' },
  inviteCodeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(15,143,135,0.08)',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(15,118,110,0.18)',
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: 16,
    gap: 8,
  },
  inviteCodeText: { flex: 1, fontSize: 14, color: '#365f61', fontWeight: '600' },
  inviteCodeValue: { color: TEAL, fontWeight: '900', letterSpacing: 1 },
  inviteCodeButton: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: 'rgba(15,118,110,0.18)',
    borderRadius: 8,
    paddingVertical: 6,
    paddingHorizontal: 10,
  },
  inviteCodeButtonText: { color: TEAL, fontWeight: '800', fontSize: 13 },
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
