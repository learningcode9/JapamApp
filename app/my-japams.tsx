import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { LinearGradient } from 'expo-linear-gradient';
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  DeviceEventEmitter,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { activeJapams, archivedJapams, type Japam } from '../lib/japams';
import { loadJapamStats, japamStatsFor, type JapamStats } from '../lib/historyRepository';
import { useCurrentJapam } from '../contexts/current-japam-context';

const USER_ID_KEY = 'userId';

const ZERO_STATS: JapamStats = { todayMalas: 0, todayTotalCount: 0, lifetimeMalas: 0, lifetimeTotalCount: 0 };

type NameDialogMode = 'create' | 'rename';
type StatsScopeState = 'loading' | 'ready';

const renderStatValue = (value: string, isLoading: boolean) => {
  return (
    <View style={styles.statValueShell} testID="japam-stat-value-shell">
      {isLoading ? (
        <View style={styles.statValueSkeleton} testID="japam-stat-skeleton" />
      ) : (
        <Text style={styles.statValue}>{value}</Text>
      )}
    </View>
  );
};

export default function MyJapamsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const {
    japams,
    currentJapamId,
    isLoading,
    selectJapam,
    createJapam,
    renameJapam,
    archiveJapam,
    restoreJapam,
    deleteJapam,
  } = useCurrentJapam();

  const [statsMap, setStatsMap] = useState<Map<string | null, JapamStats>>(new Map());
  const [statsScopeState, setStatsScopeState] = useState<StatsScopeState>('loading');
  const [statsUserKey, setStatsUserKey] = useState('guest');
  const [resolvedStatsScopeKey, setResolvedStatsScopeKey] = useState<string | null>(null);
  const [resolvedJapamIds, setResolvedJapamIds] = useState<Set<string>>(new Set());
  const statsScopeStateRef = useRef<StatsScopeState>('loading');
  const latestAppliedStatsScopeKeyRef = useRef<string | null>(null);
  const latestStatsRequestRef = useRef({ generation: 0, scopeKey: 'initial' });

  useEffect(() => {
    statsScopeStateRef.current = statsScopeState;
  }, [statsScopeState]);

  const isCurrentStatsRequest = useCallback((generation: number, scopeKey: string) => {
    return (
      latestStatsRequestRef.current.generation === generation
      && latestStatsRequestRef.current.scopeKey === scopeKey
    );
  }, []);

  const getUserKeyFromScopeKey = useCallback((scopeKey: string | null) => {
    if (!scopeKey) return null;
    const separatorIndex = scopeKey.indexOf(':');
    return separatorIndex === -1 ? scopeKey : scopeKey.slice(0, separatorIndex);
  }, []);

  const loadStats = useCallback(async ({ force = false }: { force?: boolean } = {}) => {
    const requestGeneration = latestStatsRequestRef.current.generation + 1;
    latestStatsRequestRef.current = { generation: requestGeneration, scopeKey: `pending:${requestGeneration}` };

    const userId = await AsyncStorage.getItem(USER_ID_KEY);
    const userKey = userId || 'guest';
    setStatsUserKey(userKey);
    const currentJapamIds = japams.map((j) => j.id);
    const currentJapamSignature = japams.map((j) => `${j.id}:${j.archivedAt || ''}`).join('|');
    const appliedUserKey = getUserKeyFromScopeKey(latestAppliedStatsScopeKeyRef.current);
    const hasReadyStatsForUser = appliedUserKey === userKey && statsScopeStateRef.current === 'ready';

    if (isLoading) {
      const loadingScopeKey = `loading:${userKey}`;
      latestStatsRequestRef.current = { generation: requestGeneration, scopeKey: loadingScopeKey };
      if (!isCurrentStatsRequest(requestGeneration, loadingScopeKey)) return;
      if (!hasReadyStatsForUser && statsScopeStateRef.current !== 'loading') {
        setStatsScopeState('loading');
        setResolvedStatsScopeKey(null);
        setResolvedJapamIds(new Set());
      }
      return;
    }

    const statsScopeKey = `${userKey}:${currentJapamSignature}`;
    const scopeChanged = latestAppliedStatsScopeKeyRef.current !== statsScopeKey;
    const sameScopeAlreadyLoading = latestStatsRequestRef.current.scopeKey === statsScopeKey;

    if (!force && sameScopeAlreadyLoading) return;

    if (!force && !scopeChanged) {
      if (statsScopeStateRef.current === 'ready') return;
    }

    latestStatsRequestRef.current = { generation: requestGeneration, scopeKey: statsScopeKey };
    if (!isCurrentStatsRequest(requestGeneration, statsScopeKey)) return;

    if (scopeChanged && !hasReadyStatsForUser) {
      setStatsScopeState('loading');
      setResolvedStatsScopeKey(null);
      setResolvedJapamIds(new Set());
    }

    const stats = await loadJapamStats(userId);
    if (!isCurrentStatsRequest(requestGeneration, statsScopeKey)) return;

    setStatsMap(stats);
    setStatsScopeState('ready');
    latestAppliedStatsScopeKeyRef.current = statsScopeKey;
    setResolvedStatsScopeKey(statsScopeKey);
    setResolvedJapamIds(new Set(currentJapamIds));
  }, [getUserKeyFromScopeKey, isCurrentStatsRequest, isLoading, japams]);

  // Reloads stats every time this screen is focused -- matching the same useFocusEffect convention
  // already used by Timer/History elsewhere in this app. This screen never reads AsyncStorage,
  // never parses JSON, and never calls a historyStore selector itself -- it only asks
  // historyRepository for the already-computed stats and renders them.
  useFocusEffect(
    useCallback(() => {
      void loadStats();
    }, [loadStats])
  );

  useEffect(() => {
    void loadStats();
  }, [loadStats]);

  useEffect(() => {
    const refresh = () => void loadStats({ force: true });
    const historySubscription = DeviceEventEmitter.addListener('japam-history-updated', refresh);
    const statsSubscription = DeviceEventEmitter.addListener('japam-stats-updated', refresh);

    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      window.addEventListener('japam-history-updated', refresh as EventListener);
      window.addEventListener('japam-stats-updated', refresh as EventListener);
    }

    return () => {
      historySubscription.remove();
      statsSubscription.remove();
      if (Platform.OS === 'web' && typeof window !== 'undefined') {
        window.removeEventListener('japam-history-updated', refresh as EventListener);
        window.removeEventListener('japam-stats-updated', refresh as EventListener);
      }
    };
  }, [loadStats]);

  const [showNameDialog, setShowNameDialog] = useState(false);
  const [nameDialogMode, setNameDialogMode] = useState<NameDialogMode>('create');
  const [nameDialogJapamId, setNameDialogJapamId] = useState<string | null>(null);
  const [nameInput, setNameInput] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  const openCreateDialog = () => {
    setNameDialogMode('create');
    setNameDialogJapamId(null);
    setNameInput('');
    setShowNameDialog(true);
  };

  const openRenameDialog = (japam: Japam) => {
    setNameDialogMode('rename');
    setNameDialogJapamId(japam.id);
    setNameInput(japam.name);
    setShowNameDialog(true);
  };

  const closeNameDialog = () => {
    setShowNameDialog(false);
    setNameInput('');
    setNameDialogJapamId(null);
  };

  const handleSaveNameDialog = async () => {
    if (!nameInput.trim() || isSaving) return;
    setIsSaving(true);
    try {
      if (nameDialogMode === 'create') {
        const created = await createJapam(nameInput);
        if (created) {
          closeNameDialog();
          router.back();
        }
        // A blank/invalid name safely returns null from createJapam -- nothing to do, the dialog
        // just stays open (the Save button is already disabled for a blank input above).
      } else if (nameDialogJapamId) {
        await renameJapam(nameDialogJapamId, nameInput);
        closeNameDialog();
      }
    } finally {
      setIsSaving(false);
    }
  };

  const handleSelectJapam = (japamId: string) => {
    selectJapam(japamId);
    router.back();
  };

  const confirmArchive = (japam: Japam) => {
    const title = `Archive ${japam.name}?`;
    const message = 'This hides it from your list. Its history is kept completely safe and can be restored anytime.';
    if (Platform.OS === 'web') {
      if (typeof window !== 'undefined' && window.confirm(`${title}\n\n${message}`)) {
        void archiveJapam(japam.id);
      }
      return;
    }
    Alert.alert(title, message, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Archive', style: 'destructive', onPress: () => void archiveJapam(japam.id) },
    ]);
  };

  const confirmDeletePermanent = (japam: Japam) => {
    if (Platform.OS === 'web') {
      if (typeof window !== 'undefined' && window.confirm(`Delete Japam?\n\nThis will permanently delete this archived Japam. Its History will remain safe.\nThis action cannot be undone.`)) {
        void deleteJapam(japam.id);
      }
      return;
    }
    Alert.alert(
      'Delete Japam?',
      'This will permanently delete this archived Japam. Its History will remain safe.\nThis action cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => void deleteJapam(japam.id) },
      ],
    );
  };

  const visibleJapams = activeJapams(japams);
  const archivedVisibleJapams = archivedJapams(japams);
  const currentJapamSignature = japams.map((j) => `${j.id}:${j.archivedAt || ''}`).join('|');
  const currentStatsScopeKey = `${statsUserKey}:${currentJapamSignature}`;
  const showStatsLoading = statsScopeState !== 'ready';
  const shouldShowStatSkeleton = (japamId: string) => {
    if (showStatsLoading) return true;
    if (resolvedStatsScopeKey === currentStatsScopeKey) return false;
    return !resolvedJapamIds.has(japamId);
  };

  return (
    <LinearGradient colors={['#e7f5f5', '#c7e2e0', '#eef8f5']} style={styles.container}>
      <View style={[styles.headerRow, { paddingTop: insets.top + 12 }]}>
        <Pressable
          style={styles.backButton}
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Back"
          hitSlop={12}
        >
          <Ionicons name="chevron-back" size={28} color="#0f766e" />
        </Pressable>
        <Text style={styles.title}>My Japams</Text>
        <View style={styles.backButton} />
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        bounces={Platform.OS !== 'ios'}
      >
        {!isLoading && visibleJapams.length === 0 && (
          <Text style={styles.emptyText}>
            You haven&apos;t created a Japam yet. Tap + Add Japam below to get started.
          </Text>
        )}

        {visibleJapams.map((japam) => {
          const isCurrent = japam.id === currentJapamId;
          const stats = japamStatsFor(statsMap, japam.id) ?? ZERO_STATS;
          return (
            <Pressable
              key={japam.id}
              style={({ pressed }) => [
                styles.card,
                isCurrent && styles.cardCurrent,
                pressed && styles.cardPressed,
              ]}
              onPress={() => handleSelectJapam(japam.id)}
              onLongPress={() => confirmArchive(japam)}
              delayLongPress={500}
              accessibilityRole="button"
              accessibilityState={{ selected: isCurrent }}
              accessibilityLabel={`Select ${japam.name}${isCurrent ? ', currently selected' : ''}`}
              accessibilityHint="Long-press to archive this Japam"
            >
              <View style={styles.cardHeader}>
                <View style={styles.cardNameRow}>
                  {isCurrent && (
                    <Ionicons name="checkmark-circle" size={20} color="#0f766e" style={styles.checkIcon} />
                  )}
                  <Text style={styles.cardName} numberOfLines={1}>{japam.name}</Text>
                </View>
                <Pressable
                  style={styles.editButton}
                  onPress={() => openRenameDialog(japam)}
                  hitSlop={10}
                  accessibilityRole="button"
                  accessibilityLabel={`Rename ${japam.name}`}
                >
                  <Ionicons name="pencil-outline" size={18} color="#0f766e" />
                </Pressable>
              </View>

              <View style={styles.statsRow}>
                <View style={styles.statBox} testID="japam-stat-box">
                  <Text style={styles.statLabel}>Today</Text>
                  {renderStatValue(`${stats.todayMalas} malas`, shouldShowStatSkeleton(japam.id))}
                </View>
                <View style={styles.statBox} testID="japam-stat-box">
                  <Text style={styles.statLabel}>Lifetime</Text>
                  {renderStatValue(`${stats.lifetimeMalas} malas`, shouldShowStatSkeleton(japam.id))}
                </View>
              </View>
            </Pressable>
          );
        })}

        <Pressable style={styles.addButton} onPress={openCreateDialog} accessibilityRole="button" accessibilityLabel="Add Japam">
          <Ionicons name="add" size={22} color="#ffffff" />
          <Text style={styles.addButtonText}>Add Japam</Text>
        </Pressable>

        {visibleJapams.length > 0 && (
          <Text style={styles.hintText}>Long-press a Japam to archive it.</Text>
        )}

        {archivedVisibleJapams.length > 0 && (
          <>
            <Text style={styles.sectionHeading}>Archived Japams</Text>
            {archivedVisibleJapams.map((japam) => {
              const stats = japamStatsFor(statsMap, japam.id) ?? ZERO_STATS;
              return (
                <View
                  key={japam.id}
                  style={[styles.card, styles.archivedCard]}
                >
                  <View style={styles.cardHeader}>
                    <View style={styles.cardNameRow}>
                      <Ionicons name="archive-outline" size={20} color="#5f7778" style={styles.checkIcon} />
                      <Text style={styles.cardName} numberOfLines={1}>{japam.name}</Text>
                    </View>
                    <Pressable
                      style={styles.restoreButton}
                      onPress={() => void restoreJapam(japam.id)}
                      hitSlop={12}
                      accessibilityRole="button"
                      accessibilityLabel={`Restore ${japam.name}`}
                    >
                      <Ionicons name="refresh" size={16} color="#0f766e" />
                      <Text style={styles.restoreButtonText}>Restore</Text>
                    </Pressable>
                  </View>

                  <View style={styles.statsRow}>
                    <View style={styles.statBox} testID="japam-stat-box">
                      <Text style={styles.statLabel}>Today</Text>
                      {renderStatValue(`${stats.todayMalas} malas`, shouldShowStatSkeleton(japam.id))}
                    </View>
                    <View style={styles.statBox} testID="japam-stat-box">
                      <Text style={styles.statLabel}>Lifetime</Text>
                      {renderStatValue(`${stats.lifetimeMalas} malas`, shouldShowStatSkeleton(japam.id))}
                    </View>
                  </View>

                  <Pressable
                    style={styles.deleteButton}
                    onPress={() => confirmDeletePermanent(japam)}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel={`Delete ${japam.name} permanently`}
                  >
                    <Ionicons name="trash-outline" size={14} color="#b91c1c" />
                    <Text style={styles.deleteButtonText}>Delete Permanently</Text>
                  </Pressable>
                </View>
              );
            })}
            <Text style={styles.hintText}>Tap Restore to bring an archived Japam back.</Text>
          </>
        )}
      </ScrollView>

      <Modal
        visible={showNameDialog}
        transparent
        animationType="fade"
        onRequestClose={closeNameDialog}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>
              {nameDialogMode === 'create' ? 'Add Japam' : 'Rename Japam'}
            </Text>
            <Text style={styles.modalSubtitle}>
              {nameDialogMode === 'create'
                ? 'Type a name for this Japam, like a mantra you chant.'
                : 'Type the new name for this Japam.'}
            </Text>
            <TextInput
              style={styles.modalInput}
              value={nameInput}
              onChangeText={setNameInput}
              placeholder="Japam name"
              placeholderTextColor="#94a3b8"
              autoFocus
              returnKeyType="done"
              onSubmitEditing={() => void handleSaveNameDialog()}
            />
            <View style={styles.modalActions}>
              <Pressable style={styles.modalCancel} onPress={closeNameDialog} disabled={isSaving}>
                <Text style={styles.modalCancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[styles.modalSave, (!nameInput.trim() || isSaving) && styles.modalSaveDisabled]}
                onPress={() => void handleSaveNameDialog()}
                disabled={!nameInput.trim() || isSaving}
              >
                <Text style={styles.modalSaveText}>
                  {nameDialogMode === 'create' ? 'Create' : 'Save'}
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingBottom: 8,
  },
  backButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    flex: 1,
    textAlign: 'center',
    color: '#102f34',
    fontSize: 28,
    fontWeight: '900',
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    width: '100%',
    maxWidth: 640,
    alignSelf: 'center',
    paddingHorizontal: 18,
    paddingBottom: 60,
  },
  emptyText: {
    color: '#365f61',
    fontSize: 17,
    textAlign: 'center',
    marginTop: 40,
    marginBottom: 20,
    lineHeight: 24,
  },
  card: {
    backgroundColor: 'rgba(255, 255, 255, 0.85)',
    borderRadius: 18,
    borderWidth: 2,
    borderColor: 'rgba(15, 118, 110, 0.2)',
    padding: 18,
    marginTop: 14,
    minHeight: 96,
  },
  archivedCard: {
    backgroundColor: 'rgba(255, 255, 255, 0.72)',
    borderColor: 'rgba(95, 119, 120, 0.22)',
    opacity: 0.95,
  },
  cardCurrent: {
    borderColor: '#0f766e',
    borderWidth: 3,
  },
  cardPressed: {
    opacity: 0.85,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  cardNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 1,
    gap: 6,
  },
  checkIcon: {
    flexShrink: 0,
  },
  cardName: {
    color: '#102f34',
    fontSize: 22,
    fontWeight: '800',
    flexShrink: 1,
  },
  editButton: {
    padding: 8,
  },
  restoreButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 44,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: 'rgba(15, 118, 110, 0.1)',
  },
  restoreButtonText: {
    color: '#0f766e',
    fontSize: 14,
    fontWeight: '800',
  },
  deleteButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'flex-end',
    gap: 6,
    minHeight: 36,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginTop: 10,
    borderRadius: 999,
    backgroundColor: 'rgba(185, 28, 28, 0.08)',
  },
  deleteButtonText: {
    color: '#b91c1c',
    fontSize: 13,
    fontWeight: '700',
  },
  statsRow: {
    flexDirection: 'row',
    marginTop: 14,
    gap: 12,
  },
  statBox: {
    flex: 1,
    backgroundColor: 'rgba(15, 118, 110, 0.08)',
    borderRadius: 12,
    paddingVertical: 10,
    alignItems: 'center',
    minHeight: 64,
  },
  statLabel: {
    color: '#547071',
    fontSize: 13,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  statValue: {
    color: '#12383c',
    fontSize: 18,
    fontWeight: '800',
    textAlign: 'center',
  },
  statValueShell: {
    minHeight: 24,
    width: 96,
    marginTop: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  statValueSkeleton: {
    width: 72,
    height: 18,
    borderRadius: 999,
    backgroundColor: 'rgba(15, 118, 110, 0.16)',
  },
  sectionHeading: {
    color: '#102f34',
    fontSize: 20,
    fontWeight: '900',
    marginTop: 24,
    marginBottom: 8,
  },
  addButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#0f8a87',
    borderRadius: 999,
    minHeight: 54,
    marginTop: 24,
  },
  addButtonText: {
    color: '#ffffff',
    fontSize: 18,
    fontWeight: '800',
  },
  hintText: {
    color: '#5f7778',
    fontSize: 12,
    textAlign: 'center',
    marginTop: 16,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(15, 42, 42, 0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  modalCard: {
    width: '100%',
    maxWidth: 400,
    backgroundColor: '#ffffff',
    borderRadius: 20,
    padding: 24,
  },
  modalTitle: {
    fontSize: 22,
    fontWeight: '900',
    color: '#102f34',
    marginBottom: 8,
    textAlign: 'center',
  },
  modalSubtitle: {
    fontSize: 15,
    color: '#547071',
    textAlign: 'center',
    marginBottom: 18,
  },
  modalInput: {
    borderWidth: 1.5,
    borderColor: 'rgba(15, 118, 110, 0.35)',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 18,
    color: '#12383c',
    backgroundColor: 'rgba(255,255,255,0.9)',
    marginBottom: 20,
  },
  modalActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 12,
  },
  modalCancel: {
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 999,
  },
  modalCancelText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#547071',
  },
  modalSave: {
    backgroundColor: '#0f8a87',
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 999,
  },
  modalSaveDisabled: {
    opacity: 0.5,
  },
  modalSaveText: {
    fontSize: 16,
    fontWeight: '800',
    color: '#ffffff',
  },
});
