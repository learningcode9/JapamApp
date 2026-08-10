import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { useIsFocused } from '@react-navigation/native';
import { useFocusEffect, useLocalSearchParams, usePathname, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import {
  ActivityIndicator,
  BackHandler,
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
  getCachedGroupDashboard,
  getGroupDashboard,
  getGroupInviteCode,
  isNetworkFailure,
  leaveGroup,
  removeGroupMember,
  renameGroup,
  type GroupDashboardRow,
} from '../../lib/groupsRepository';
import { useCurrentJapam } from '../../contexts/current-japam-context';
import { supabase } from '../../lib/supabase';

// While the dashboard is focused, re-fetch this often so other members' completions show up
// without anyone needing to leave and re-enter the screen. Kept well above the Supabase round
// trip a single get_group_dashboard call takes, so a slow request never overlaps the next tick.
const AUTO_REFRESH_INTERVAL_MS = 12000;

const USER_ID_KEY = 'userId';
const TEAL = '#0F8F87';

const isBrowserOffline = (): boolean =>
  Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.onLine === false;

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

type GroupsDashboardErrorBoundaryProps = {
  children: React.ReactNode;
  onBackToGroups: () => void;
  groupIdLast4: string;
};

type GroupsDashboardErrorBoundaryState = {
  hasError: boolean;
};

/**
 * Contains unexpected render-time failures to this route. RPC and transport failures already
 * use the normal dashboard error state; this boundary prevents a malformed render payload or
 * native/render exception from leaving the dashboard as a blank route or crashing the app.
 */
class GroupsDashboardErrorBoundary extends React.Component<
  GroupsDashboardErrorBoundaryProps,
  GroupsDashboardErrorBoundaryState
> {
  state: GroupsDashboardErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): GroupsDashboardErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: unknown, errorInfo: React.ErrorInfo) {
    const err = error as { name?: string; message?: string };
    console.error('[GROUPS_DIAG] dashboard-render-error', {
      name: String(err?.name || 'unknown'),
      message: String(err?.message || error || 'unknown'),
      groupIdLast4: this.props.groupIdLast4 || 'none',
      componentStack: String(errorInfo.componentStack || '').trim(),
    });
  }

  render() {
    if (this.state.hasError) {
      return (
        <View style={styles.boundaryFallback}>
          <Ionicons name="alert-circle-outline" size={42} color={TEAL} />
          <Text style={styles.boundaryFallbackTitle}>This group could not be displayed.</Text>
          <Pressable style={styles.boundaryFallbackButton} onPress={this.props.onBackToGroups}>
            <Text style={styles.boundaryFallbackButtonText}>Back to Groups</Text>
          </Pressable>
        </View>
      );
    }

    return this.props.children;
  }
}

export default function GroupsDashboardScreen() {
  const insets = useSafeAreaInsets();
  const tabBarSpaceFromBottom = 74 + (tabBarLayoutIsMobile
    ? Math.max(12, insets.bottom + 8)
    : Math.max(22, insets.bottom + 14));

  const router = useRouter();
  const returnToGroups = useCallback(() => {
    router.replace('/groups');
  }, [router]);
  const isFocused = useIsFocused();
  const pathname = usePathname();
  const { currentJapamId } = useCurrentJapam();
  const params = useLocalSearchParams<{ groupId?: string; groupName?: string }>();
  const groupId = params.groupId || '';
  const groupName = params.groupName || 'Group';
  const [displayGroupName, setDisplayGroupName] = useState(groupName);

  const [userId, setUserId] = useState<string | null>(null);
  // undefined means Supabase has not finished restoring the persisted session yet. A stored
  // userId alone is not enough to authorize the RPC: the request must carry a real access token.
  const [authSession, setAuthSession] = useState<Session | null | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<GroupDashboardRow[]>([]);
  const [cacheHydrated, setCacheHydrated] = useState(false);
  const [hasCachedData, setHasCachedData] = useState(false);
  const [dashboardReady, setDashboardReady] = useState(false);
  const [isOffline, setIsOffline] = useState(isBrowserOffline);
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

  // Delete and Leave are mutually exclusive actions. Keeping them in one state prevents a stale
  // Leave modal from remaining mounted when an admin chooses Delete from the menu.
  const [groupExitModal, setGroupExitModal] = useState<'delete' | 'leave' | null>(null);
  const [deleteError, setDeleteError] = useState('');
  const [deleting, setDeleting] = useState(false);

  const [leaveError, setLeaveError] = useState('');
  const [leaving, setLeaving] = useState(false);

  // Overlap guard — the 12s interval, the two event listeners, and the initial focus-triggered
  // load can all fire close together; this ensures only one get_group_dashboard request is ever
  // in flight at a time, exactly like the same pattern already used by syncPendingHistory.
  const loadInFlightRef = useRef(false);
  const dashboardLoadGenerationRef = useRef(0);
  const authSessionRef = useRef<Session | null | undefined>(undefined);
  const requestAuthUserRef = useRef<string | null>(null);
  const authGenerationRef = useRef(0);

  // Stale-response guard for the dashboard's own workspace scope — only the response for the
  // CURRENTLY selected Japam may render. currentJapamIdRef tracks the LATEST render's selected
  // Japam (not a closure copy), so a slow Workspace-A request that resolves after the user
  // switched away — even one whose load started before the switch — is rejected and can never
  // paint Workspace-A rows into Workspace-B state.
  const requestJapamRef = useRef<string | null>(null);
  const currentJapamIdRef = useRef<string | null>(currentJapamId);
  // Async dashboard loads can finish after this screen blurs to another tab. Keep the latest
  // focus/path state in a ref so their mismatch callback can never replace the route that is now
  // active (especially /history) with /groups.
  const dashboardRouteStateRef = useRef({ isFocused, pathname });
  dashboardRouteStateRef.current = { isFocused, pathname };
  // The Japam this dashboard is currently scoped to (set once a load has successfully rendered
  // that workspace's roster). While it is null (nothing loaded yet) no navigation happens.
  const loadedForJapamRef = useRef<string | null>(null);
  const workspaceGenerationRef = useRef(0);
  const previousJapamIdRef = useRef(currentJapamId);
  const workspaceSwitchPendingRef = useRef(false);

  useFocusEffect(
    useCallback(() => {
      if (Platform.OS !== 'android') return undefined;

      const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
        returnToGroups();
        return true;
      });

      return () => subscription.remove();
    }, [returnToGroups])
  );

  useEffect(() => {
    currentJapamIdRef.current = currentJapamId;
  }, [currentJapamId]);

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
      return undefined;
    }
    const updateOfflineState = () => {
      const nextOffline = isBrowserOffline();
      setIsOffline(nextOffline);
      if (nextOffline) setLoading(false);
    };
    window.addEventListener('offline', updateOfflineState);
    window.addEventListener('online', updateOfflineState);
    return () => {
      window.removeEventListener('offline', updateOfflineState);
      window.removeEventListener('online', updateOfflineState);
    };
  }, []);

  // Hydrate the exact user/group/workspace cache before starting auth restoration. This keeps a
  // cached dashboard visible even if Supabase session restoration or the remote RPC stalls.
  useEffect(() => {
    let cancelled = false;
    setCacheHydrated(false);
    setHasCachedData(false);
    setDashboardReady(false);
    setRows([]);
    setError('');

    const hydrateCache = async () => {
      if (!groupId || !currentJapamId) {
        if (!cancelled) {
          setCacheHydrated(true);
          setLoading(false);
        }
        return;
      }

      const savedUserId = await AsyncStorage.getItem(USER_ID_KEY);
      if (cancelled) return;
      setUserId(savedUserId);
      if (!savedUserId) {
        setCacheHydrated(true);
        setLoading(false);
        return;
      }

      const cached = await getCachedGroupDashboard(groupId, savedUserId, currentJapamId);
      if (cancelled) return;
      const hasCache = cached !== null;
      setHasCachedData(hasCache);
      if (cached !== null) {
        setRows(cached);
        setDashboardReady(true);
        setLoading(false);
        loadedForJapamRef.current = currentJapamId;
      }
      setCacheHydrated(true);
    };

    void hydrateCache();
    return () => {
      cancelled = true;
    };
  }, [currentJapamId, groupId]);

  const clearDashboardForLogout = useCallback(() => {
    authGenerationRef.current += 1;
    dashboardLoadGenerationRef.current += 1;
    authSessionRef.current = null;
    requestAuthUserRef.current = null;
    loadInFlightRef.current = false;
    workspaceSwitchPendingRef.current = false;
    setAuthSession(null);
    setUserId(null);
    setRows([]);
    setHasCachedData(false);
    setDashboardReady(false);
    setError('');
    setInviteCode(null);
    setLoading(false);
    loadedForJapamRef.current = null;
    requestJapamRef.current = null;
  }, []);

  useEffect(() => {
    if (!cacheHydrated || isOffline) {
      if (cacheHydrated && isOffline) setLoading(false);
      return undefined;
    }
    let mounted = true;

    const applySession = (session: Session | null) => {
      if (!mounted) return;
      if (!session?.access_token) {
        clearDashboardForLogout();
        return;
      }
      if (authSessionRef.current?.user?.id !== session.user?.id) {
        authGenerationRef.current += 1;
      }
      authSessionRef.current = session;
      setAuthSession(session);
    };

    const { data: authListener } = supabase.auth.onAuthStateChange((_event, session) => {
      applySession(session);
    });

    void supabase.auth.getSession().then(({ data }) => {
      applySession(data.session ?? null);
    });

    return () => {
      mounted = false;
      authListener.subscription.unsubscribe();
    };
  }, [cacheHydrated, clearDashboardForLogout, isOffline]);

  // The dashboard shows this group through the VIEWER's membership, which is tied to the Japam
  // they created/joined the group under (get_group_dashboard scopes by the caller's own
  // membership japam_id). If they switch their selected Japam elsewhere, this group no longer
  // belongs to the active workspace — bounce back to the list so it reloads for the new workspace
  // instead of showing a stale/incorrect dashboard. The comparison covers both a loaded roster
  // and an in-flight request, and is run from both the effect below and the end of every load, so
  // a switch at any moment (including mid-flight) navigates away rather than leaving a spinner.
  const leaveIfWorkspaceMismatch = useCallback(() => {
    const { isFocused: routeIsFocused, pathname: activePathname } = dashboardRouteStateRef.current;
    if (!routeIsFocused || activePathname !== '/groups-dashboard') return;
    const scopedFor = loadedForJapamRef.current ?? requestJapamRef.current;
    if (scopedFor !== null && currentJapamIdRef.current !== scopedFor) {
      router.replace('/groups');
    }
  }, [router]);

  useEffect(() => {
    leaveIfWorkspaceMismatch();
  }, [currentJapamId, isFocused, pathname, leaveIfWorkspaceMismatch]);

  useEffect(() => {
    if (previousJapamIdRef.current === currentJapamId) return;
    previousJapamIdRef.current = currentJapamId;
    workspaceGenerationRef.current += 1;
    dashboardLoadGenerationRef.current += 1;
    loadInFlightRef.current = false;
    if (loadedForJapamRef.current !== null || requestJapamRef.current !== null) {
      workspaceSwitchPendingRef.current = true;
    }
    loadedForJapamRef.current = null;
    requestJapamRef.current = null;
    setHasCachedData(false);
    setDashboardReady(false);
    setRows([]);
    setError('');
    setInviteCode(null);
    setLoading(false);
  }, [currentJapamId]);

  useEffect(() => {
    if (pathname !== '/groups-dashboard') {
      workspaceSwitchPendingRef.current = false;
    }
  }, [pathname]);

  useEffect(() => {
    setDisplayGroupName(groupName);
    setRenameInput(groupName);
  }, [groupName]);

  // Background refreshes (interval ticks, event-driven re-fetches) update the table data silently
  // — only the very first load for this screen shows the full-screen spinner. Without this, the
  // table would flash back to a loading state every ~12s or after every completion, which is far
  // more disruptive than the staleness this feature is meant to fix.
  const load = useCallback(async (options?: { silent?: boolean }) => {
    const { isFocused: routeIsFocused, pathname: activePathname } = dashboardRouteStateRef.current;
    if (!routeIsFocused || activePathname !== '/groups-dashboard' || workspaceSwitchPendingRef.current) {
      return;
    }
    if (!cacheHydrated) return;
    if (isOffline) {
      if (!options?.silent) setLoading(false);
      return;
    }
    if (loadInFlightRef.current) return;
    loadInFlightRef.current = true;
    const requestLoadGeneration = dashboardLoadGenerationRef.current;
    const requestWorkspaceGeneration = workspaceGenerationRef.current;
    const silent = options?.silent ?? false;
    try {
      const session = authSession;
      if (session === undefined) return;
      if (!session?.access_token || !session.user?.id) {
        return;
      }

      const { data: currentSessionData } = await supabase.auth.getSession();
      const currentSession = currentSessionData.session;
      if (!currentSession?.access_token || !currentSession.user?.id) {
        clearDashboardForLogout();
        return;
      }

      if (authSessionRef.current?.user?.id !== currentSession.user.id) {
        authGenerationRef.current += 1;
      }
      const requestGeneration = authGenerationRef.current;
      const requestUserId = currentSession.user.id;
      authSessionRef.current = currentSession;
      requestAuthUserRef.current = currentSession.user.id;
      const savedUserId = await AsyncStorage.getItem(USER_ID_KEY);
      setUserId(savedUserId);

      if (!savedUserId || savedUserId !== requestUserId || !groupId || !currentJapamId) {
        if (!silent) setLoading(false);
        return;
      }

      if (!silent && !dashboardReady) setLoading(true);
      setError('');
      const requestJapamId = currentJapamId;
      requestJapamRef.current = requestJapamId;
      const isRequestCurrent = () => (
        dashboardLoadGenerationRef.current === requestLoadGeneration
        && workspaceGenerationRef.current === requestWorkspaceGeneration
        && authGenerationRef.current === requestGeneration
        && authSessionRef.current?.user?.id === requestUserId
        && currentJapamIdRef.current === requestJapamId
        && dashboardRouteStateRef.current.isFocused
        && dashboardRouteStateRef.current.pathname === '/groups-dashboard'
      );
      try {
        const { start, end } = getLocalTodayBoundsIso();
        const result = await getGroupDashboard(groupId, savedUserId, start, end, requestJapamId);
        if (!isRequestCurrent()) return;
        setRows(result);
        setDashboardReady(true);
        setIsOffline(false);
        loadedForJapamRef.current = requestJapamId;
      } catch (err: any) {
        if (!isRequestCurrent()) return;
        if (isNetworkFailure(err)) {
          setIsOffline(true);
          setError('');
        } else if (!silent) {
          setError(err?.message || 'Could not load this group.');
        }
      } finally {
        if (!isRequestCurrent()) return;
        if (!silent) setLoading(false);
        leaveIfWorkspaceMismatch();
      }
    } finally {
      if (dashboardLoadGenerationRef.current === requestLoadGeneration) {
        loadInFlightRef.current = false;
      }
    }
  }, [authSession, cacheHydrated, clearDashboardForLogout, currentJapamId, dashboardReady, groupId, isOffline, leaveIfWorkspaceMismatch]);

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

  // Refresh immediately only after this device's completion is confirmed in Supabase. Personal
  // History still receives local-first events, but those events can precede the remote upsert and
  // must not cause the server-backed dashboard to reload prematurely. Polling above still picks
  // up completions from other devices.
  useEffect(() => {
    const syncedSub = DeviceEventEmitter.addListener('japam-history-remote-synced', () => {
      void load({ silent: true });
    });

    return () => {
      syncedSub.remove();
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
    setGroupExitModal('delete');
  };

  const openLeaveModal = () => {
    setLeaveError('');
    setGroupExitModal('leave');
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
    setGroupExitModal(null);
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
    setGroupExitModal(null);
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

  const groupIdLast4 = groupId ? groupId.slice(-4) : 'none';

  return (
    <View style={styles.container}>
      <GroupsDashboardErrorBoundary
        key={groupId}
        onBackToGroups={returnToGroups}
        groupIdLast4={groupIdLast4}
      >
        <>
          <View style={[styles.headerRow, { paddingTop: Math.max(16, insets.top + 8) }]}>
            <Pressable style={styles.backButton} onPress={returnToGroups}>
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
        {isOffline && hasCachedData ? (
          <Text style={styles.offlineText}>You&apos;re offline. Showing saved group data.</Text>
        ) : null}
        {loading && !dashboardReady && !isOffline ? (
          <ActivityIndicator color={TEAL} style={styles.loadingSpinner} />
        ) : error ? (
          <Text style={styles.errorText}>{error}</Text>
        ) : isOffline && !hasCachedData ? (
          <Text style={styles.offlineText}>You&apos;re offline. No saved group data is available yet.</Text>
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
              onPress={openLeaveModal}
            >
              <Ionicons name="exit-outline" size={20} color="#b42318" />
              <Text style={styles.leaveGroupText}>Leave Group</Text>
            </Pressable>
          </>
        )}
          </ScrollView>
        </>
      </GroupsDashboardErrorBoundary>

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

      <Modal visible={groupExitModal === 'delete'} transparent animationType="fade" onRequestClose={() => setGroupExitModal(null)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Delete group?</Text>
            <Text style={styles.modalBody}>
              This will permanently delete {displayGroupName} and remove all members from the group. Personal Japam history will stay safe.
            </Text>
            {deleteError ? <Text style={styles.modalError}>{deleteError}</Text> : null}
            <View style={styles.modalActions}>
              <Pressable style={styles.modalSecondaryButton} onPress={() => setGroupExitModal(null)} disabled={deleting}>
                <Text style={styles.modalSecondaryText}>Cancel</Text>
              </Pressable>
              <Pressable style={styles.dangerButton} onPress={handleDeleteGroup} disabled={deleting}>
                <Text style={styles.dangerButtonText}>{deleting ? 'Deleting...' : 'Delete'}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={groupExitModal === 'leave'} transparent animationType="fade" onRequestClose={() => setGroupExitModal(null)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Leave group?</Text>
            <Text style={styles.modalBody}>
              You will no longer see this group. Your personal Japam history and totals will not be affected.
            </Text>
            {leaveError ? <Text style={styles.modalError}>{leaveError}</Text> : null}
            <View style={styles.modalActions}>
              <Pressable style={styles.modalSecondaryButton} onPress={() => setGroupExitModal(null)} disabled={leaving}>
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
  scrollContent: { padding: 20, paddingBottom: 20 },
  loadingSpinner: { marginTop: 24 },
  offlineText: { color: '#365f61', fontSize: 14, lineHeight: 20, textAlign: 'center', marginTop: 14 },
  errorText: { color: '#b91c1c', fontSize: 14, textAlign: 'center', marginTop: 24 },
  emptyText: { color: '#365f61', fontSize: 15, lineHeight: 22, textAlign: 'center', marginTop: 24 },
  tableCard: {
    backgroundColor: '#fff',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(15,118,110,0.16)',
    overflow: 'hidden',
  },
  boundaryFallback: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    backgroundColor: '#f5fafa',
  },
  boundaryFallbackTitle: {
    marginTop: 12,
    color: '#12383c',
    fontSize: 17,
    fontWeight: '700',
    lineHeight: 24,
    textAlign: 'center',
  },
  boundaryFallbackButton: {
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 18,
    minHeight: 44,
    paddingHorizontal: 18,
    borderRadius: 14,
    backgroundColor: TEAL,
  },
  boundaryFallbackButtonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '800',
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
