import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useState } from 'react';
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
  createGroup,
  getMyGroups,
  joinGroupByInviteCode,
  type CreateGroupResult,
  type MyGroup,
} from '../../lib/groupsRepository';
import { repairLegacyStoredUserId } from '../../lib/anonymousAuth';

const USER_ID_KEY = 'userId';
const USER_NAME_KEY = 'userName';
const TEAL = '#0F8F87';

export default function GroupsScreen() {
  const router = useRouter();

  const [userId, setUserId] = useState<string | null>(null);
  const [userName, setUserName] = useState('');
  const [loading, setLoading] = useState(true);
  const [groups, setGroups] = useState<MyGroup[]>([]);
  const [listError, setListError] = useState('');

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createName, setCreateName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const [createdGroup, setCreatedGroup] = useState<CreateGroupResult | null>(null);

  const [showJoinModal, setShowJoinModal] = useState(false);
  const [joinCode, setJoinCode] = useState('');
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState('');

  const loadGroups = useCallback(async () => {
    await repairLegacyStoredUserId();
    const savedUserId = await AsyncStorage.getItem(USER_ID_KEY);
    const savedUserName = (await AsyncStorage.getItem(USER_NAME_KEY)) || '';
    setUserId(savedUserId);
    setUserName(savedUserName);

    if (!savedUserId) {
      setGroups([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    setListError('');
    try {
      const result = await getMyGroups(savedUserId);
      setGroups(result);
    } catch (error: any) {
      setListError(error?.message || 'Could not load your groups.');
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void loadGroups();
    }, [loadGroups])
  );

  const openGroupDashboard = (groupId: string, groupName: string) => {
    router.push({
      pathname: '/groups-dashboard',
      params: { groupId, groupName },
    });
  };

  const handleCreateSubmit = async () => {
    const name = createName.trim();
    if (!name) {
      setCreateError('Please enter a group name.');
      return;
    }
    if (!userId) return;
    setCreating(true);
    setCreateError('');
    try {
      const result = await createGroup(name, userId, userName);
      setCreateName('');
      await loadGroups();
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
    if (!userId) return;
    setJoining(true);
    setJoinError('');
    try {
      const outcome = await joinGroupByInviteCode(code, userName);
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
      await loadGroups();
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
        <Text style={styles.header}>Family Japam Groups</Text>

        <View style={styles.actionsRow}>
          <Pressable style={styles.primaryButton} onPress={() => setShowCreateModal(true)}>
            <Text style={styles.primaryButtonText}>Create Group</Text>
          </Pressable>
          <Pressable style={styles.secondaryButton} onPress={() => setShowJoinModal(true)}>
            <Text style={styles.secondaryButtonText}>Join Group</Text>
          </Pressable>
        </View>

        {loading ? (
          <ActivityIndicator color={TEAL} style={styles.loadingSpinner} />
        ) : listError ? (
          <Text style={styles.errorText}>{listError}</Text>
        ) : groups.length === 0 ? (
          <Text style={styles.emptyText}>
            You're not in any groups yet. Create one or join with an invite code.
          </Text>
        ) : (
          groups.map((group) => (
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
          ))
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
