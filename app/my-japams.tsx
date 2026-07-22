import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { LinearGradient } from 'expo-linear-gradient';
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useState } from 'react';
import {
  Alert,
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

  // Reloads stats every time this screen is focused -- matching the same useFocusEffect convention
  // already used by Timer/History elsewhere in this app. This screen never reads AsyncStorage,
  // never parses JSON, and never calls a historyStore selector itself -- it only asks
  // historyRepository for the already-computed stats and renders them.
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        const userId = await AsyncStorage.getItem(USER_ID_KEY);
        if (cancelled) return;
        const stats = await loadJapamStats(userId);
        if (cancelled) return;
        setStatsMap(stats);
      })();
      return () => {
        cancelled = true;
      };
    }, [])
  );

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
                <View style={styles.statBox}>
                  <Text style={styles.statLabel}>Today</Text>
                  <Text style={styles.statValue}>{stats.todayMalas} malas</Text>
                </View>
                <View style={styles.statBox}>
                  <Text style={styles.statLabel}>Lifetime</Text>
                  <Text style={styles.statValue}>{stats.lifetimeMalas} malas</Text>
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
                    <View style={styles.statBox}>
                      <Text style={styles.statLabel}>Today</Text>
                      <Text style={styles.statValue}>{stats.todayMalas} malas</Text>
                    </View>
                    <View style={styles.statBox}>
                      <Text style={styles.statLabel}>Lifetime</Text>
                      <Text style={styles.statValue}>{stats.lifetimeMalas} malas</Text>
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
    marginTop: 2,
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
