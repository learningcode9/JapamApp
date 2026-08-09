import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useRef, useState } from 'react';
import {
  ActivityIndicator,
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
import {
  attachGroupMembershipToJapam,
  createGroup,
  getCachedMyGroups,
  getCachedMyUnassignedGroups,
  getMyGroups,
  getMyUnassignedGroups,
  isNetworkFailure,
  joinGroupByInviteCode,
  type CreateGroupResult,
  type MyGroup,
} from '../../lib/groupsRepository';
import { useCurrentJapam } from '../../contexts/current-japam-context';

const USER_ID_KEY = 'userId';
const USER_NAME_KEY = 'userName';
const TEAL = '#0F8F87';

export default function GroupsScreen() {
  const router = useRouter();
  const { currentJapamId, currentJapam, isLoading: japamLoading } = useCurrentJapam();

  const [userId, setUserId] = useState<string | null>(null);
  const [userName, setUserName] = useState('');
  const [loading, setLoading] = useState(true);
  const [groups, setGroups] = useState<MyGroup[]>([]);
  const [unassignedGroups, setUnassignedGroups] = useState<MyGroup[]>([]);
  const [listError, setListError] = useState('');
  const [attachError, setAttachError] = useState('');

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createName, setCreateName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const [createdGroup, setCreatedGroup] = useState<CreateGroupResult | null>(null);

  const [showJoinModal, setShowJoinModal] = useState(false);
  const [joinCode, setJoinCode] = useState('');
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState('');

  // Stale-response guard: only the response for the CURRENTLY selected workspace may populate
  // the list, so a slow Workspace-A response can never overwrite Workspace-B state after a
  // switch (the server also scopes, but the client must never render cross-workspace data).
  const requestJapamRef = useRef<string | null>(null);
  const loadPromiseRef = useRef<Promise<void> | null>(null);
  const loadInFlightKeyRef = useRef<string | null>(null);
  const lastLoadedKeyRef = useRef<string | null>(null);
  const settledLoadKeyRef = useRef<string | null>(null);
  const currentLoadKey = `${userId ?? 'guest'}:${currentJapamId ?? 'none'}`;
  const initialLoading = settledLoadKeyRef.current !== currentLoadKey;
  const backgroundRefreshing = !initialLoading && (loading || japamLoading);
  const isInteractionLoading = initialLoading || backgroundRefreshing;

  const loadGroups = useCallback(async (options?: { force?: boolean }) => {
    const force = options?.force ?? false;
    const savedUserId = await AsyncStorage.getItem(USER_ID_KEY);
    const savedUserName = (await AsyncStorage.getItem(USER_NAME_KEY)) || '';
    const loadKey = `${savedUserId ?? 'guest'}:${currentJapamId ?? 'none'}`;

    if (loadPromiseRef.current && loadInFlightKeyRef.current === loadKey) {
      return loadPromiseRef.current;
    }

    if (!force && lastLoadedKeyRef.current === loadKey) {
      setUserId(savedUserId);
      setUserName(savedUserName);
      return;
    }

    const promise = (async () => {
      setUserId(savedUserId);
      setUserName(savedUserName);

      if (!savedUserId || !currentJapamId) {
        setGroups([]);
        setUnassignedGroups([]);
        // Clear the in-flight marker too, so a slow response from a previously selected workspace
        // can never repopulate the list after the user deselects/leaves the workspace.
        requestJapamRef.current = null;
        lastLoadedKeyRef.current = loadKey;
        settledLoadKeyRef.current = loadKey;
        setLoading(false);
        return;
      }

      setLoading(true);
      setListError('');
      setAttachError('');
      requestJapamRef.current = currentJapamId;

      // Local-first: render the last-known cached lists immediately (pure AsyncStorage reads that
      // never hit the network), so an offline cold start opens instantly instead of hanging on the
      // remote RPCs (whose supabase getSession() triggers a network token refresh for a near-expiry
      // session that stalls offline). The remote reconciliation below then replaces this with fresh
      // data in the background.
      const [cachedGroups, cachedUnassigned] = await Promise.all([
        getCachedMyGroups(savedUserId, currentJapamId),
        getCachedMyUnassignedGroups(),
      ]);
      const hasCache = cachedGroups !== null || cachedUnassigned !== null;
      if (requestJapamRef.current === currentJapamId) {
        setGroups(cachedGroups ?? []);
        setUnassignedGroups(cachedUnassigned ?? []);
        lastLoadedKeyRef.current = loadKey;
        settledLoadKeyRef.current = loadKey;
        setLoading(false);
      }

      try {
        const [result, unassigned] = await Promise.all([
          getMyGroups(savedUserId, currentJapamId),
          getMyUnassignedGroups(),
        ]);
        if (requestJapamRef.current !== currentJapamId) return;
        setGroups(result);
        setUnassignedGroups(unassigned);
        lastLoadedKeyRef.current = loadKey;
      } catch (error: any) {
        if (requestJapamRef.current !== currentJapamId) return;
        // A server-side (RLS/authorization/data) error must surface even when the cache was shown —
        // the user is never left looking at stale groups while being denied access server-side. A
        // pure transport failure keeps the cached list already rendered (offline), with no error.
        if (!(hasCache && isNetworkFailure(error))) {
          setListError(error?.message || 'Could not load your groups.');
        }
      } finally {
        if (requestJapamRef.current === currentJapamId) {
          settledLoadKeyRef.current = loadKey;
          setLoading(false);
        }
      }
    })();

    loadPromiseRef.current = promise;
    loadInFlightKeyRef.current = loadKey;
    promise.finally(() => {
      if (loadPromiseRef.current === promise) {
        loadPromiseRef.current = null;
        loadInFlightKeyRef.current = null;
      }
    });
    return promise;
  }, [currentJapamId]);

  useFocusEffect(
    useCallback(() => {
      void loadGroups({ force: true });
    }, [loadGroups])
  );

  const openGroupDashboard = (groupId: string, groupName: string) => {
    router.push({
      pathname: '/groups-dashboard',
      params: { groupId, groupName },
    });
  };

  const handleAttachGroup = async (groupId: string) => {
    if (!currentJapamId) return;
    setAttachError('');
    const outcome = await attachGroupMembershipToJapam(groupId, currentJapamId);
    if (outcome.kind === 'error') {
      setAttachError(outcome.message || 'Could not attach this group to the selected Japam.');
      return;
    }
    await loadGroups({ force: true });
  };

  const handleCreateSubmit = async () => {
    const name = createName.trim();
    if (!name) {
      setCreateError('Please enter a group name.');
      return;
    }
    if (!userId || !currentJapamId) {
      setCreateError('Select a Japam first — groups are tied to the selected Japam.');
      return;
    }
    setCreating(true);
    setCreateError('');
    try {
      const result = await createGroup(name, userId, userName, currentJapamId);
      setCreateName('');
      await loadGroups({ force: true });
      // Show the success view (invite code + Share) instead of navigating immediately — the
      // user decides when to leave, after optionally sharing the code.
      setCreatedGroup(result);
    } catch (error: any) {
      setCreateError(error?.message || 'Could not create the group. Please try again.');
    } finally {
      setCreating(false);
    }
  };

  const handleShareInviteCode = async () => {
    if (!createdGroup) return;
    try {
      // Share.share opens the OS share sheet — the user picks WhatsApp/SMS/etc. themselves;
      // nothing is ever sent automatically.
      await Share.share({
        message: `Join my Japam group.\nInvite code: ${createdGroup.inviteCode}`,
      });
    } catch {
      // User dismissed the share sheet or it failed — no error state needed, they can retry.
    }
  };

  const closeCreateModal = () => {
    setShowCreateModal(false);
    setCreateError('');
    setCreatedGroup(null);
  };

  const handleGoToCreatedGroup = () => {
    if (!createdGroup) return;
    const { groupId, groupName } = createdGroup;
    setShowCreateModal(false);
    setCreatedGroup(null);
    openGroupDashboard(groupId, groupName);
  };

  const handleJoinSubmit = async () => {
    const code = joinCode.trim().toUpperCase();
    if (!code) {
      setJoinError('Please enter an invite code.');
      return;
    }
    if (!userId || !currentJapamId) {
      setJoinError('Select a Japam first — joined groups are tied to the selected Japam.');
      return;
    }
    setJoining(true);
    setJoinError('');
    try {
      const outcome = await joinGroupByInviteCode(code, userId, userName, currentJapamId);
      if (outcome.kind === 'notFound') {
        setJoinError('No group found with that code.');
        return;
      }
      if (outcome.kind === 'inactive') {
        setJoinError('This group is no longer active.');
        return;
      }
      if (outcome.kind === 'error') {
        setJoinError(outcome.message || 'Could not join the group. Please try again.');
        return;
      }
      setShowJoinModal(false);
      setJoinCode('');
      await loadGroups({ force: true });
      openGroupDashboard(outcome.groupId, outcome.groupName);
    } finally {
      setJoining(false);
    }
  };

  if (!userId) {
    return (
      <LinearGradient colors={['#e7f5f5', '#c7e2e0', '#eef8f5']} style={styles.signInContainer}>
        <Ionicons name="people-outline" size={48} color={TEAL} />
        <Text style={styles.signInTitle}>Sign in required</Text>
        <Text style={styles.signInBody}>
          Groups require a Google account. Please sign in with Google from another tab to use
          Family Japam Groups.
        </Text>
      </LinearGradient>
    );
  }

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <Text style={styles.header}>Groups</Text>

        <View style={styles.workspaceBanner}>
          <Ionicons name="layers-outline" size={16} color={TEAL} />
          <Text style={styles.workspaceBannerText}>
            {currentJapam
              ? `Showing groups for: ${currentJapam.name}`
              : japamLoading
                ? 'Loading your selected Japam...'
                : 'Select a Japam to manage your groups'}
          </Text>
        </View>

        <View style={styles.actionsRow}>
          <Pressable
            style={[styles.primaryButton, (!currentJapamId || isInteractionLoading) && styles.disabledButton]}
            disabled={!currentJapamId || isInteractionLoading}
            onPress={() => setShowCreateModal(true)}
          >
            <Text style={styles.primaryButtonText}>Create Group</Text>
          </Pressable>
          <Pressable
            style={[styles.secondaryButton, (!currentJapamId || isInteractionLoading) && styles.disabledButton]}
            disabled={!currentJapamId || isInteractionLoading}
            onPress={() => setShowJoinModal(true)}
          >
            <Text style={styles.secondaryButtonText}>Join Group</Text>
          </Pressable>
        </View>

        {initialLoading ? (
          <ActivityIndicator color={TEAL} style={styles.loadingSpinner} />
        ) : listError ? (
          <Text style={styles.errorText}>{listError}</Text>
        ) : !currentJapamId ? (
          <Text style={styles.emptyText}>
            Groups are tied to the Japam you&apos;ve selected. Open the My Japams tab and pick a Japam to
            see its groups.
          </Text>
        ) : groups.length === 0 && unassignedGroups.length === 0 ? (
          <Text style={styles.emptyText}>
            You&apos;re not in any groups for this Japam yet. Create one or join with an invite code.
          </Text>
        ) : (
          <>
            {groups.map((group) => (
              <Pressable
                key={group.groupId}
                style={styles.groupRow}
                onPress={() => openGroupDashboard(group.groupId, group.name)}
              >
                <View style={styles.groupRowText}>
                  <Text style={styles.groupName}>{group.name}</Text>
                  {group.role === 'admin' && <Text style={styles.adminBadge}>Admin</Text>}
                </View>
                <Ionicons name="chevron-forward" size={20} color={TEAL} />
              </Pressable>
            ))}

            {unassignedGroups.length > 0 ? (
              <View style={styles.unassignedSection}>
                <Text style={styles.unassignedTitle}>Unassigned Groups</Text>
                <Text style={styles.unassignedHint}>
                  These groups aren&apos;t tied to a Japam yet. Attach them to{' '}
                  {currentJapam?.name ?? 'this Japam'} to see them here and on the dashboard.
                </Text>
                {attachError ? <Text style={styles.errorText}>{attachError}</Text> : null}
                {unassignedGroups.map((group) => (
                  <View key={group.groupId} style={styles.unassignedRow}>
                    <View style={styles.groupRowText}>
                      <Text style={styles.groupName}>{group.name}</Text>
                      {group.role === 'admin' && <Text style={styles.adminBadge}>Admin</Text>}
                    </View>
                    <Pressable
                      style={styles.attachButton}
                      onPress={() => handleAttachGroup(group.groupId)}
                    >
                      <Text style={styles.attachButtonText}>Attach</Text>
                    </Pressable>
                  </View>
                ))}
              </View>
            ) : null}
          </>
        )}
      </ScrollView>

      {/* Create Group modal */}
      <Modal visible={showCreateModal} transparent animationType="fade" onRequestClose={closeCreateModal}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Pressable style={styles.modalClose} onPress={closeCreateModal}>
              <Text style={styles.modalCloseText}>×</Text>
            </Pressable>
            {createdGroup ? (
              <>
                <Text style={styles.modalTitle}>Group Created</Text>
                <Text style={styles.modalSubtitle}>{createdGroup.groupName}</Text>
                <View style={styles.inviteCodeBox}>
                  <Text style={styles.inviteCodeLabel}>Invite code</Text>
                  <Text style={styles.inviteCodeValue}>{createdGroup.inviteCode}</Text>
                </View>
                <Pressable style={styles.modalSecondaryButton} onPress={handleShareInviteCode}>
                  <Text style={styles.secondaryButtonText}>Share Invite Code</Text>
                </Pressable>
                <Pressable
                  style={[styles.modalPrimaryButton, styles.spacedButton]}
                  onPress={handleGoToCreatedGroup}
                >
                  <Text style={styles.primaryButtonText}>Go to Group</Text>
                </Pressable>
              </>
            ) : (
              <>
                <Text style={styles.modalTitle}>Create a Group</Text>
                <Text style={styles.modalSubtitle}>Start a Family Japam group and invite others.</Text>
                <TextInput
                  style={styles.textInput}
                  placeholder="Group name"
                  value={createName}
                  onChangeText={setCreateName}
                  maxLength={40}
                  autoFocus
                />
                {createError ? <Text style={styles.errorText}>{createError}</Text> : null}
                <Pressable
                  style={[styles.modalPrimaryButton, (creating || !createName.trim()) && styles.disabledButton]}
                  disabled={creating || !createName.trim()}
                  onPress={handleCreateSubmit}
                >
                  {creating ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryButtonText}>Create</Text>}
                </Pressable>
              </>
            )}
          </View>
        </View>
      </Modal>

      {/* Join Group modal */}
      <Modal visible={showJoinModal} transparent animationType="fade" onRequestClose={() => setShowJoinModal(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Pressable style={styles.modalClose} onPress={() => setShowJoinModal(false)}>
              <Text style={styles.modalCloseText}>×</Text>
            </Pressable>
            <Text style={styles.modalTitle}>Join a Group</Text>
            <Text style={styles.modalSubtitle}>Enter the invite code shared with you.</Text>
            <TextInput
              style={[styles.textInput, styles.codeInput]}
              placeholder="Invite code"
              value={joinCode}
              onChangeText={(text) => setJoinCode(text.toUpperCase())}
              autoCapitalize="characters"
              maxLength={8}
              autoFocus
            />
            {joinError ? <Text style={styles.errorText}>{joinError}</Text> : null}
            <Pressable
              style={[styles.modalPrimaryButton, (joining || !joinCode.trim()) && styles.disabledButton]}
              disabled={joining || !joinCode.trim()}
              onPress={handleJoinSubmit}
            >
              {joining ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryButtonText}>Join</Text>}
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5fafa' },
  scrollContent: { padding: 20, paddingBottom: Platform.OS === 'web' ? 20 : 100 },
  header: { fontSize: 24, fontWeight: '900', color: '#12383c', marginBottom: 16 },
  actionsRow: { flexDirection: 'row', gap: 12, marginBottom: 20 },
  primaryButton: {
    flex: 1,
    backgroundColor: TEAL,
    minHeight: 52,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
  },
  primaryButtonText: { color: '#fff', fontWeight: '900', fontSize: 16 },
  secondaryButton: {
    flex: 1,
    backgroundColor: '#f8fafc',
    minHeight: 52,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#dbeceb',
  },
  secondaryButtonText: { color: '#0f172a', fontWeight: '900', fontSize: 16 },
  disabledButton: { opacity: 0.5 },
  workspaceBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(15,143,135,0.10)',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginBottom: 14,
  },
  workspaceBannerText: { fontSize: 14, fontWeight: '600', color: '#12383c', flex: 1 },
  unassignedSection: {
    marginTop: 18,
    borderTopWidth: 1,
    borderTopColor: 'rgba(15,118,110,0.15)',
    paddingTop: 14,
  },
  unassignedTitle: { fontSize: 16, fontWeight: '800', color: '#12383c', marginBottom: 4 },
  unassignedHint: { fontSize: 13, lineHeight: 19, color: '#365f61', marginBottom: 10 },
  unassignedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#f2faf8',
    borderRadius: 14,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: 'rgba(15,118,110,0.12)',
  },
  attachButton: {
    backgroundColor: TEAL,
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 9,
  },
  attachButtonText: { color: '#fff', fontWeight: '800', fontSize: 14 },
  loadingSpinner: { marginTop: 24 },
  emptyText: { color: '#365f61', fontSize: 15, lineHeight: 22, textAlign: 'center', marginTop: 24 },
  errorText: { color: '#b91c1c', fontSize: 14, marginBottom: 12, textAlign: 'center' },
  groupRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#fff',
    borderRadius: 14,
    paddingVertical: 16,
    paddingHorizontal: 16,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: 'rgba(15,118,110,0.12)',
  },
  groupRowText: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  groupName: { fontSize: 17, fontWeight: '700', color: '#12383c' },
  adminBadge: {
    fontSize: 11,
    fontWeight: '800',
    color: TEAL,
    backgroundColor: 'rgba(15,143,135,0.12)',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
  },
  signInContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
  signInTitle: { fontSize: 20, fontWeight: '900', color: '#12383c', marginTop: 16, marginBottom: 8 },
  signInBody: { fontSize: 15, lineHeight: 22, color: '#365f61', textAlign: 'center' },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(7,32,34,0.52)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingVertical: 24,
  },
  modalCard: {
    width: '100%',
    maxWidth: 380,
    maxHeight: '88%',
    backgroundColor: '#f8ffff',
    borderRadius: 22,
    paddingHorizontal: 24,
    paddingTop: 26,
    paddingBottom: 22,
    borderWidth: 1,
    borderColor: 'rgba(15,118,110,0.18)',
  },
  modalClose: { position: 'absolute', right: 14, top: 10, zIndex: 10 },
  modalCloseText: { color: '#547071', fontSize: 28, fontWeight: '800' },
  modalTitle: { color: '#12383c', fontSize: 24, fontWeight: '900', marginBottom: 8, textAlign: 'center' },
  modalSubtitle: { color: '#365f61', fontSize: 14, lineHeight: 20, textAlign: 'center', marginBottom: 18 },
  textInput: {
    borderWidth: 1,
    borderColor: '#dbeceb',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    marginBottom: 14,
    backgroundColor: '#fff',
  },
  codeInput: { textAlign: 'center', fontWeight: '900', letterSpacing: 2 },
  inviteCodeBox: {
    backgroundColor: 'rgba(15,143,135,0.08)',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(15,118,110,0.18)',
    paddingVertical: 16,
    alignItems: 'center',
    marginBottom: 16,
  },
  inviteCodeLabel: { fontSize: 12, color: '#547071', marginBottom: 4 },
  inviteCodeValue: { fontSize: 28, fontWeight: '900', color: TEAL, letterSpacing: 3 },
  modalPrimaryButton: {
    width: '100%',
    minHeight: 52,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
    backgroundColor: TEAL,
  },
  modalSecondaryButton: {
    width: '100%',
    minHeight: 52,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#dbeceb',
  },
  spacedButton: { marginTop: 10 },
});
