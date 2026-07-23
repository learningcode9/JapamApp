/**
 * CurrentJapamContext — the single source of truth for "which Japam is currently selected."
 *
 * This Context owns RUNTIME STATE only (the in-memory Japams list, which one is selected, loading
 * status) and delegates every persistence concern to lib/japamsRepository.ts. It never touches
 * AsyncStorage directly and never imports lib/japams.ts's pure create/rename/archive/restore
 * functions directly either — those are called INSIDE the repository. This split means: when
 * Supabase sync is added later, it is added entirely inside the repository file, and this Context
 * (and every screen that uses it) does not change at all.
 *
 * Every consumer reads the SAME in-memory React state via useContext, not independent per-screen
 * storage reads — this mirrors exactly how TimerContext already works in this app
 * (contexts/timer-context.tsx) and was chosen specifically to avoid the cross-instance staleness
 * class of bug already found once in this feature's earlier slot-based design (independent
 * per-screen hooks each holding their own copy of the same value).
 *
 * Provider placement: NOT mounted anywhere yet in this commit — it must eventually live at the app
 * root (app/_layout.tsx), alongside TimerProvider, exactly the same lesson already documented in
 * this project's release checklist about global long-lived providers.
 *
 * No raw state setter is exposed. selectJapam is the only way to change the current selection —
 * this keeps "select" a meaningful app action (easy to find every call site of, easy to extend
 * later, e.g. to validate the id or emit an event) rather than an anonymous state mutation any
 * screen could call for any reason.
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { DeviceEventEmitter, Platform } from 'react-native';
import { createDefaultJapamCreationCoordinator } from '../lib/defaultJapamCreationCoordinator';
import { activeJapams, type Japam } from '../lib/japams';
import * as japamsRepository from '../lib/japamsRepository';

const USER_ID_KEY = 'userId';

type CurrentJapamContextValue = {
  /** All Japams for the current identity (active + archived). */
  japams: Japam[];
  /** The selected Japam's id, or null if none is selected (no Japams yet, or nothing chosen). */
  currentJapamId: string | null;
  /** Convenience lookup of the selected Japam object, or null. */
  currentJapam: Japam | null;
  /** True until the initial load for the current identity completes. */
  isLoading: boolean;
  selectJapam: (japamId: string | null) => void;
  createJapam: (rawName: string) => Promise<Japam | null>;
  renameJapam: (japamId: string, rawName: string) => Promise<void>;
  archiveJapam: (japamId: string) => Promise<void>;
  restoreJapam: (japamId: string) => Promise<void>;
  deleteJapam: (japamId: string) => Promise<void>;
};

const CurrentJapamContext = createContext<CurrentJapamContextValue | null>(null);

export function CurrentJapamProvider({ children }: { children: ReactNode }) {
  const [japams, setJapams] = useState<Japam[]>([]);
  const [currentJapamId, setCurrentJapamIdState] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  // Repository calls are keyed by whichever identity was active at call time; refresh() can run
  // again (auth change) while an earlier write is still in flight, so every action re-reads the
  // CURRENT userId from this ref rather than closing over a possibly-stale one from render time.
  const userIdRef = useRef<string | null>(null);
  // Per-user in-flight creation coordinator. Uses a Map keyed by userId so A→B→A rapid auth
  // switches never overwrite a still-in-flight entry — each user's creation promise and waiter
  // count lives independently and is cleaned up only when that user's last caller exits.
  const coordinator = useMemo(() => createDefaultJapamCreationCoordinator(), []);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    const userId = await AsyncStorage.getItem(USER_ID_KEY);
    userIdRef.current = userId;
    let loadedJapams = await japamsRepository.loadJapams(userId);

    // Auto-create a real "My Japam" record for users with zero active Japams.
    // This ensures Timer, Tap Japam, History, and Stats always have a real Japam ID to use
    // instead of falling through to null.
    if (activeJapams(loadedJapams).length === 0 && userId) {
      await coordinator.ensureCreation(userId, () =>
        japamsRepository.createJapam(userId, 'My Japam'),
      );
      // Re-read from storage after creation settles. This is the ONLY way every caller gets the
      // true persisted state — the promise's resolved value is unused precisely because it could
      // be stale for late-arriving waiters.
      loadedJapams = await japamsRepository.loadJapams(userId);
    }

    const persistedCurrentId = await japamsRepository.loadCurrentJapamId(userId);
    setJapams(loadedJapams);
    // Auto-reopen the last selected Japam, per the approved architecture -- but only if it still
    // exists and is not archived. Otherwise fall back to the first active Japam, or null (empty
    // state / no Japams yet) if there are none.
    const active = activeJapams(loadedJapams);
    const persistedStillActive = persistedCurrentId
      ? active.find((j) => j.id === persistedCurrentId)
      : undefined;
    const resolvedCurrentId = persistedStillActive?.id ?? active[0]?.id ?? null;
    setCurrentJapamIdState(resolvedCurrentId);
    if (resolvedCurrentId !== persistedCurrentId) {
      await japamsRepository.saveCurrentJapamId(userId, resolvedCurrentId);
    }
    setIsLoading(false);
    if (userId) {
      void japamsRepository.reconcileAllJapams(userId);
    }
  }, [coordinator]);

  useEffect(() => {
    void refresh();
    const authSub = DeviceEventEmitter.addListener('japam-auth-updated', () => void refresh());
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      window.addEventListener('japam-auth-updated', refresh as EventListener);
    }
    return () => {
      authSub.remove();
      if (Platform.OS === 'web' && typeof window !== 'undefined') {
        window.removeEventListener('japam-auth-updated', refresh as EventListener);
      }
    };
  }, [refresh]);

  const selectJapam = useCallback((japamId: string | null) => {
    const fromJapamId = currentJapamId;
    // Emit BEFORE the state change so the timer context can save the current Japam's timer
    // state (including a running timer's position) to the FROM Japam's per-Japam slot.
    DeviceEventEmitter.emit('japam-will-switch', { fromJapamId, toJapamId: japamId });
    setCurrentJapamIdState(japamId);
    void japamsRepository.saveCurrentJapamId(userIdRef.current, japamId);
    // Emit AFTER the state change so the timer context can load the TO Japam's timer state.
    DeviceEventEmitter.emit('japam-did-switch', { japamId });
  }, [currentJapamId]);

  const createJapam = useCallback(async (rawName: string): Promise<Japam | null> => {
    const result = await japamsRepository.createJapam(userIdRef.current, rawName);
    if (result === null) return null;
    setJapams(result.japams);
    // A newly created Japam becomes the current one -- there is no reason to make the user select
    // what they just created.
    selectJapam(result.created.id);
    return result.created;
  }, [selectJapam]);

  const renameJapam = useCallback(async (japamId: string, rawName: string): Promise<void> => {
    const updated = await japamsRepository.renameJapam(userIdRef.current, japamId, rawName);
    setJapams(updated);
  }, []);

  const archiveJapam = useCallback(async (japamId: string): Promise<void> => {
    const updated = await japamsRepository.archiveJapam(userIdRef.current, japamId);
    setJapams(updated);
    // The archived Japam can no longer be "current" -- it's hidden from the default list. Fall
    // back to the next active Japam, or null. This is a runtime-selection decision, so it lives
    // here in the Context, not in the repository.
    if (currentJapamId === japamId) {
      const nextActive = activeJapams(updated)[0]?.id ?? null;
      selectJapam(nextActive);
    }
  }, [currentJapamId, selectJapam]);

  const restoreJapam = useCallback(async (japamId: string): Promise<void> => {
    const updated = await japamsRepository.restoreJapam(userIdRef.current, japamId);
    setJapams(updated);
    // Restoring is a "manage archived Japams" action, not a selection -- it deliberately does not
    // change currentJapamId.
  }, []);

  const deleteJapam = useCallback(async (japamId: string): Promise<void> => {
    const updated = await japamsRepository.deleteJapam(userIdRef.current, japamId);
    setJapams(updated);
    // If the deleted Japam was the current selection, fall back to the next active one.
    if (currentJapamId === japamId) {
      const nextActive = activeJapams(updated)[0]?.id ?? null;
      selectJapam(nextActive);
    }
  }, [currentJapamId, selectJapam]);

  const currentJapam = useMemo(
    () => japams.find((j) => j.id === currentJapamId) ?? null,
    [japams, currentJapamId],
  );

  const value = useMemo<CurrentJapamContextValue>(() => ({
    japams,
    currentJapamId,
    currentJapam,
    isLoading,
    selectJapam,
    createJapam,
    renameJapam,
    archiveJapam,
    restoreJapam,
    deleteJapam,
  }), [
    japams,
    currentJapamId,
    currentJapam,
    isLoading,
    selectJapam,
    createJapam,
    renameJapam,
    archiveJapam,
    restoreJapam,
    deleteJapam,
  ]);

  return <CurrentJapamContext.Provider value={value}>{children}</CurrentJapamContext.Provider>;
}

export function useCurrentJapam() {
  const context = useContext(CurrentJapamContext);
  if (!context) throw new Error('useCurrentJapam must be used inside CurrentJapamProvider');
  return context;
}
