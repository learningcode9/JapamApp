import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  DeviceEventEmitter,
  Dimensions,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  deleteGroup,
  getGroupDashboard,
  getGroupInviteCode,
  leaveGroup,
  removeGroupMember,
  renameGroup,
  type GroupDashboardRow,
} from '../../lib/groupsRepository';

// While the dashboard is focused, re-fetch this often so other members' completions show up
// without anyone needing to leave and re-enter the screen. Kept well above the Supabase round
// trip a single get_group_dashboard call takes, so a slow request never overlaps the next tick.
const AUTO_REFRESH_INTERVAL_MS = 12000;

const USER_ID_KEY = 'userId';
const TEAL = '#0F8F87';

// Same width-based breakpoint convention as history.tsx — five columns (Name, Today Malas,
// Today Count, Total Malas, Total Count) need noticeably tighter sizing on small phones than
// the previous four-column layout did, without letting any text become unreadably tiny or
// forcing horizontal scrolling.
const { width: DASHBOARD_SCREEN_WIDTH } = Dimensions.get('window');
const isNarrowPhone = DASHBOARD_SCREEN_WIDTH < 380;
const isTablet = DASHBOARD_SCREEN_WIDTH >= 768;
const tabBarLayoutIsMobile = DASHBOARD_SCREEN_WIDTH < 500;

const HEADER_FONT_SIZE = isTablet ? 16 : isNarrowPhone ? 11 : 13;
const VALUE_FONT_SIZE = isTablet ? 19 : isNarrowPhone ? 15 : 17;
const NAME_FONT_SIZE = isTablet ? 17 : isNarrowPhone ? 15 : 16;
const CELL_PADDING_H = isNarrowPhone ? 1 : isTablet ? 4 : 2;
const NAME_CELL_FLEX = isTablet ? 1.3 : isNarrowPhone ? 0.95 : 1.0;
// All four stat columns share one flex value instead of each having its own, so the numeric
// VALUES line up as an even grid instead of the old "staircase" of mismatched column widths.
// Bumped up from the original 0.68/0.79/0.92 — even a single word like "Malas" still wrapped
// into "MALA"/"S" at large Android accessibility font sizes on a normal-width phone. Flex shares
// don't need to sum to anything in particular; raising this proportionally narrows Name's share
// a little, which Name has the headroom for (short member names in practice).
const STAT_CELL_FLEX = isNarrowPhone ? 0.78 : isTablet ? 1.05 : 0.9;

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
  const insets = useSafeAreaInsets();
  const tabBarSpaceFromBottom = 74 + (tabBarLayoutIsMobile
    ? Math.max(12, insets.bottom + 8)
    : Math.max(22, insets.bottom + 14));

  const router = useRouter();
  const params = useLocalSearchParams<{ groupId?: string; groupName?: string }>();
  const groupId = params.groupId || '';
  const groupName = params.groupName || 'Group';
  const [displayGroupName, setDisplayGroupName] = useState(groupName);

  const [userId, setUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<GroupDashboardRow[]>([]);
  const [error, setError] = useState('');
  const [inviteCode, setInviteCode] = useState<string | null>(null);
  const [copyLabel, setCopyLabel] = useState('Copy');
  const [showAdminMenu, setShowAdminMenu] = useState(false);

  const [showRenameModal, setShowRenameModal] = useState(false);
  const [renameInput, setRenameInput] = useState(groupName);
  const [renameError, setRenameError] = useState('');
  const [renaming, setRenaming] = useState(false);

  const [showRemoveMembersModal, setShowRemoveMembersModal] = useState(false);
  const [memberToRemove, setMemberToRemove] = useState<GroupDashboardRow | null>(null);
  const [removeError, setRemoveError] = useState('');
  const [removing, setRemoving] = useState(false);

  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [deleting, setDeleting] = useState(false);

  const [showLeaveModal, setShowLeaveModal] = useState(false);
  const [leaveError, setLeaveError] = useState('');
  const [leaving, setLeaving] = useState(false);

  // Overlap guard — the 12s interval, the two event listeners, and the initial focus-triggered
  // load can all fire close together; this ensures only one get_group_dashboard request is ever
  // in flight at a time, exactly like the same pattern already used by syncPendingHistory.
  const loadInFlightRef = useRef(false);

  useEffect(() => {
    setDisplayGroupName(groupName);
    setRenameInput(groupName);
  }, [groupName]);

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

  const openRenameModal = () => {
    setRenameInput(displayGroupName);
    setRenameError('');
    setShowAdminMenu(false);
    setShowRenameModal(true);
  };

  const handleRenameGroup = async () => {
    if (!userId) return;
    const trimmedName = renameInput.trim();
    if (!trimmedName) {
      setRenameError('Please enter a group name.');
      return;
    }
    setRenaming(true);
    setRenameError('');
    const outcome = await renameGroup(groupId, userId, trimmedName);
    setRenaming(false);
    if (outcome.kind !== 'success') {
      setRenameError(outcome.message || 'Could not rename this group.');
      return;
    }
    setDisplayGroupName(outcome.name);
    setShowRenameModal(false);
  };

  const openRemoveMembersModal = () => {
    setMemberToRemove(null);
    setRemoveError('');
    setShowAdminMenu(false);
    setShowRemoveMembersModal(true);
  };

  const requestRemoveMember = (member: GroupDashboardRow) => {
    setRemoveError('');
    setMemberToRemove(member);
  };

  const handleRemoveMember = async () => {
    if (!userId || !memberToRemove) return;
    setRemoving(true);
    setRemoveError('');
    const outcome = await removeGroupMember(groupId, userId, memberToRemove.userId);
    setRemoving(false);
    if (outcome.kind !== 'success') {
      setRemoveError(outcome.message || 'Could not remove this member.');
      return;
    }
    setMemberToRemove(null);
    await load({ silent: true });
  };

  const openDeleteModal = () => {
    setDeleteError('');
    setShowAdminMenu(false);
    setShowDeleteModal(true);
  };

  const handleDeleteGroup = async () => {
    if (!userId) return;
    setDeleting(true);
    setDeleteError('');
    const outcome = await deleteGroup(groupId, userId);
    setDeleting(false);
    if (outcome.kind !== 'success') {
      setDeleteError(outcome.message || 'Could not delete this group.');
      return;
    }
    setShowDeleteModal(false);
    router.replace('/groups');
  };

  const handleLeaveGroup = async () => {
    if (!userId) return;
    setLeaving(true);
    setLeaveError('');
    const outcome = await leaveGroup(groupId, userId);
    setLeaving(false);
    if (outcome.kind !== 'success') {
      if (outcome.kind === 'lastAdmin') {
        setLeaveError('You are the last admin of this group.\nDelete the group before leaving.');
      } else {
        setLeaveError(outcome.message || 'Could not leave this group.');
      }
      return;
    }
    setShowLeaveModal(false);
    router.replace('/groups');
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
      <View style={[styles.headerRow, { paddingTop: Math.max(16, insets.top + 8) }]}>
        <Pressable style={styles.backButton} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={24} color={TEAL} />
        </Pressable>
        <Text style={styles.header} numberOfLines={1}>{displayGroupName}</Text>
        {isAdmin ? (
          <Pressable
            style={styles.adminMenuButton}
            onPress={() => setShowAdminMenu((visible) => !visible)}
            accessibilityRole="button"
            accessibilityLabel="Open group admin menu"
          >
            <Ionicons name="ellipsis-horizontal" size={22} color={TEAL} />
          </Pressable>
        ) : null}
      </View>

      <ScrollView
        style={Platform.OS !== 'web' ? { marginBottom: tabBarSpaceFromBottom } : undefined}
        contentContainerStyle={styles.scrollContent}
      >
        {isAdmin && showAdminMenu ? (
          <View style={styles.adminMenuCard}>
            <Pressable style={styles.adminMenuItem} onPress={openRenameModal}>
              <Ionicons name="create-outline" size={20} color={TEAL} />
              <Text style={styles.adminMenuItemText}>Rename Group</Text>
            </Pressable>
            <Pressable style={styles.adminMenuItem} onPress={openRemoveMembersModal}>
              <Ionicons name="person-remove-outline" size={20} color={TEAL} />
              <Text style={styles.adminMenuItemText}>Remove Members</Text>
            </Pressable>
            <Pressable style={styles.adminMenuItem} onPress={openDeleteModal}>
              <Ionicons name="trash-outline" size={20} color="#b42318" />
              <Text style={styles.deleteMenuItemText}>Delete Group</Text>
            </Pressable>
          </View>
        ) : null}

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
          <>
            <View style={styles.tableCard}>
              <View style={[styles.tableRow, styles.tableHeader]}>
                <Text
                  style={[styles.tableHeaderCell, styles.tableHeaderText, styles.nameCell]}
                  maxFontSizeMultiplier={1.4}
                  numberOfLines={1}
                  adjustsFontSizeToFit
                  minimumFontScale={0.75}
                >
                  Name
                </Text>
                <View style={[styles.tableHeaderCell, styles.todayMalasCell]}>
                  <Text style={styles.tableHeaderText} maxFontSizeMultiplier={1.4} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>Today</Text>
                  <Text style={styles.tableHeaderText} maxFontSizeMultiplier={1.4} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>Malas</Text>
                </View>
                <View style={[styles.tableHeaderCell, styles.todayCountCell]}>
                  <Text style={styles.tableHeaderText} maxFontSizeMultiplier={1.4} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>Today</Text>
                  <Text style={styles.tableHeaderText} maxFontSizeMultiplier={1.4} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>Count</Text>
                </View>
                <View style={[styles.tableHeaderCell, styles.lifetimeMalasCell]}>
                  <Text style={styles.tableHeaderText} maxFontSizeMultiplier={1.4} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>Total</Text>
                  <Text style={styles.tableHeaderText} maxFontSizeMultiplier={1.4} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>Malas</Text>
                </View>
                <View style={[styles.tableHeaderCell, styles.lifetimeCountCell]}>
                  <Text style={styles.tableHeaderText} maxFontSizeMultiplier={1.4} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>Total</Text>
                  <Text style={styles.tableHeaderText} maxFontSizeMultiplier={1.4} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>Count</Text>
                </View>
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
            <Pressable
              style={styles.leaveGroupButton}
              onPress={() => {
                setLeaveError('');
                setShowLeaveModal(true);
              }}
            >
              <Ionicons name="exit-outline" size={20} color="#b42318" />
              <Text style={styles.leaveGroupText}>Leave Group</Text>
            </Pressable>
          </>
        )}
      </ScrollView>

      <Modal visible={showRenameModal} transparent animationType="fade" onRequestClose={() => setShowRenameModal(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Rename Group</Text>
            <Text style={styles.modalBody}>Choose a simple name everyone in the group will recognize.</Text>
            <TextInput
              value={renameInput}
              onChangeText={setRenameInput}
              style={styles.textInput}
              placeholder="Group name"
              maxLength={40}
              autoFocus
            />
            {renameError ? <Text style={styles.modalError}>{renameError}</Text> : null}
            <View style={styles.modalActions}>
              <Pressable style={styles.modalSecondaryButton} onPress={() => setShowRenameModal(false)} disabled={renaming}>
                <Text style={styles.modalSecondaryText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[styles.modalPrimaryButton, (renaming || !renameInput.trim()) && styles.disabledButton]}
                onPress={handleRenameGroup}
                disabled={renaming || !renameInput.trim()}
              >
                <Text style={styles.modalPrimaryText}>{renaming ? 'Saving...' : 'Save'}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <Modal
        visible={showRemoveMembersModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowRemoveMembersModal(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Remove Members</Text>
            <Text style={styles.modalBody}>Select a member to remove from this group.</Text>
            {removeError ? <Text style={styles.modalError}>{removeError}</Text> : null}
            <ScrollView style={styles.memberList} contentContainerStyle={styles.memberListContent}>
              {sortDashboardRows(rows).filter((row) => row.userId !== userId).map((row) => (
                <Pressable
                  key={row.userId}
                  style={styles.memberActionRow}
                  onPress={() => requestRemoveMember(row)}
                >
                  <View style={styles.memberActionTextWrap}>
                    <Text style={styles.memberActionName} numberOfLines={1}>{row.userName || 'Unknown'}</Text>
                    <Text style={styles.memberActionRole}>{row.role === 'admin' ? 'Admin' : 'Member'}</Text>
                  </View>
                  <Ionicons name="remove-circle-outline" size={24} color="#b42318" />
                </Pressable>
              ))}
            </ScrollView>
            <Pressable style={styles.fullWidthSoftButton} onPress={() => setShowRemoveMembersModal(false)} disabled={removing}>
              <Text style={styles.modalSecondaryText}>Done</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      <Modal visible={!!memberToRemove} transparent animationType="fade" onRequestClose={() => setMemberToRemove(null)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Remove member?</Text>
            <Text style={styles.modalBody}>
              {memberToRemove?.userName || 'This member'} will lose access to this group. Their personal Japam history will not be deleted.
            </Text>
            {removeError ? <Text style={styles.modalError}>{removeError}</Text> : null}
            <View style={styles.modalActions}>
              <Pressable style={styles.modalSecondaryButton} onPress={() => setMemberToRemove(null)} disabled={removing}>
                <Text style={styles.modalSecondaryText}>Cancel</Text>
              </Pressable>
              <Pressable style={styles.dangerButton} onPress={handleRemoveMember} disabled={removing}>
                <Text style={styles.dangerButtonText}>{removing ? 'Removing...' : 'Remove'}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={showDeleteModal} transparent animationType="fade" onRequestClose={() => setShowDeleteModal(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Delete group?</Text>
            <Text style={styles.modalBody}>
              This will permanently delete {displayGroupName} and remove all members from the group. Personal Japam history will stay safe.
            </Text>
            {deleteError ? <Text style={styles.modalError}>{deleteError}</Text> : null}
            <View style={styles.modalActions}>
              <Pressable style={styles.modalSecondaryButton} onPress={() => setShowDeleteModal(false)} disabled={deleting}>
                <Text style={styles.modalSecondaryText}>Cancel</Text>
              </Pressable>
              <Pressable style={styles.dangerButton} onPress={handleDeleteGroup} disabled={deleting}>
                <Text style={styles.dangerButtonText}>{deleting ? 'Deleting...' : 'Delete'}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={showLeaveModal} transparent animationType="fade" onRequestClose={() => setShowLeaveModal(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Leave group?</Text>
            <Text style={styles.modalBody}>
              You will no longer see this group. Your personal Japam history and totals will not be affected.
            </Text>
            {leaveError ? <Text style={styles.modalError}>{leaveError}</Text> : null}
            <View style={styles.modalActions}>
              <Pressable style={styles.modalSecondaryButton} onPress={() => setShowLeaveModal(false)} disabled={leaving}>
                <Text style={styles.modalSecondaryText}>Cancel</Text>
              </Pressable>
              <Pressable style={styles.dangerButton} onPress={handleLeaveGroup} disabled={leaving}>
                <Text style={styles.dangerButtonText}>{leaving ? 'Leaving...' : 'Leave'}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
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
  adminMenuButton: {
    width: 42,
    height: 42,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: 'rgba(15,118,110,0.16)',
  },
  scrollContent: { padding: 20, paddingBottom: Platform.OS !== 'web' ? 20 : 100 },
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
  // Header cells size naturally instead of using the data rows' fixed height — each stat header
  // is two stacked single-word Text siblings (see JSX/comment below), so this just needs to fit
  // two short lines, never a variable/unpredictable wrap.
  tableHeaderCell: { paddingVertical: 6, paddingHorizontal: CELL_PADDING_H },
  // Two attempts before this one relied on RN's own text layout to keep each header to two lines
  // (first: a two-word phrase wrapping at the word boundary; then: a single Text with an explicit
  // '\n' plus numberOfLines/adjustsFontSizeToFit/minimumFontScale). Both still mid-word-split on a
  // real Samsung device at large accessibility font sizes ("Malas" -> "MALA"/"S") — Android's
  // adjustsFontSizeToFit shrink-to-fit is unreliable once a Text has more than one line, explicit
  // '\n' or not, so it never reliably stepped in before RN's wrap fallback kicked in.
  // Fix: stopped relying on text layout entirely. Each stat header is now two SEPARATE single-word
  // Text siblings stacked in a View (see JSX) — "Today" and "Malas" as two independent numberOfLines={1}
  // Texts, not one Text with a line break. A single-line Text's adjustsFontSizeToFit is the
  // well-supported case on both platforms, so each word independently shrinks to fit its column
  // instead of ever wrapping — there's no second line for RN to wrap *into* within a given Text.
  // letterSpacing tightened from 0.3 to keep uppercase text narrower for the same reason.
  tableHeaderText: {
    fontSize: HEADER_FONT_SIZE,
    lineHeight: HEADER_FONT_SIZE * 1.2,
    fontWeight: '900',
    color: '#081a1c',
    textTransform: 'uppercase',
    letterSpacing: 0.1,
    textAlign: 'center',
  },
  nameCell: { flex: NAME_CELL_FLEX, textAlign: 'left' },
  todayMalasCell: { flex: STAT_CELL_FLEX, alignItems: 'center' },
  todayCountCell: { flex: STAT_CELL_FLEX, alignItems: 'center' },
  lifetimeMalasCell: { flex: STAT_CELL_FLEX, alignItems: 'center' },
  lifetimeCountCell: { flex: STAT_CELL_FLEX, alignItems: 'center' },
  memberName: { fontSize: NAME_FONT_SIZE, fontWeight: '700', color: '#12383c' },
  adminStar: { color: '#c08a1e', fontSize: 15, fontWeight: '700' },
  statValue: { fontSize: VALUE_FONT_SIZE, fontWeight: '900', color: TEAL, textAlign: 'center' },
  leaveGroupButton: {
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 20,
    paddingVertical: 12,
    paddingHorizontal: 18,
    borderRadius: 16,
    backgroundColor: 'rgba(180,35,24,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(180,35,24,0.16)',
  },
  leaveGroupText: { color: '#b42318', fontSize: 15, fontWeight: '900' },
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
  adminMenuCard: {
    backgroundColor: '#fff',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(15,118,110,0.16)',
    marginBottom: 16,
    overflow: 'hidden',
  },
  adminMenuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderTopWidth: 1,
    borderTopColor: 'rgba(15,118,110,0.08)',
  },
  adminMenuItemText: { fontSize: 15, fontWeight: '800', color: '#12383c' },
  deleteMenuItemText: { fontSize: 15, fontWeight: '800', color: '#b42318' },
  modalOverlay: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(8,26,28,0.32)',
    padding: 22,
  },
  modalCard: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: '#f8fefe',
    borderRadius: 24,
    padding: 22,
    borderWidth: 1,
    borderColor: 'rgba(15,118,110,0.14)',
  },
  modalTitle: { fontSize: 22, fontWeight: '900', color: '#12383c', textAlign: 'center' },
  modalBody: {
    fontSize: 15,
    lineHeight: 22,
    color: '#365f61',
    textAlign: 'center',
    marginTop: 10,
    marginBottom: 18,
  },
  textInput: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: 'rgba(15,118,110,0.18)',
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    color: '#12383c',
    fontWeight: '700',
  },
  modalError: { color: '#b91c1c', fontSize: 14, textAlign: 'center', marginTop: 12 },
  modalActions: { flexDirection: 'row', gap: 12, marginTop: 20 },
  modalSecondaryButton: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
    borderRadius: 16,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: 'rgba(15,118,110,0.14)',
  },
  modalSecondaryText: { color: '#365f61', fontWeight: '900', fontSize: 15 },
  modalPrimaryButton: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
    borderRadius: 16,
    backgroundColor: TEAL,
  },
  modalPrimaryText: { color: '#fff', fontWeight: '900', fontSize: 15 },
  disabledButton: { opacity: 0.55 },
  memberList: { maxHeight: 310 },
  memberListContent: { gap: 8 },
  memberActionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(15,118,110,0.12)',
    paddingVertical: 12,
    paddingHorizontal: 14,
    gap: 12,
  },
  memberActionTextWrap: { flex: 1 },
  memberActionName: { fontSize: 16, fontWeight: '900', color: '#12383c' },
  memberActionRole: { fontSize: 13, fontWeight: '700', color: '#5F7F80', marginTop: 2 },
  fullWidthSoftButton: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
    borderRadius: 16,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: 'rgba(15,118,110,0.14)',
    marginTop: 16,
  },
  dangerButton: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
    borderRadius: 16,
    backgroundColor: 'rgba(180,35,24,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(180,35,24,0.18)',
  },
  dangerButtonText: { color: '#b42318', fontWeight: '900', fontSize: 15 },
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
