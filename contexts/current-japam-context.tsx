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
import { hydrateHistoryForUserDetails } from '../lib/historyRepository';
import { LEGACY_USER_ID_KEY } from '../lib/anonymousAuth';

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
  const hydrationInFlight = useRef<{ userId: string; promise: Promise<void> } | null>(null);
  const refresh = useCallback(async () => {
    setIsLoading(true);
    const userId = await AsyncStorage.getItem(USER_ID_KEY);
    userIdRef.current = userId;
    if (!userId) {
      const loadedJapams = await japamsRepository.loadJapams(userId);
      const persistedCurrentId = await japamsRepository.loadCurrentJapamId(userId);
      setJapams(loadedJapams);
      // Guest/local-only behavior stays unchanged: select from the local cache only.
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
      return;
    }

    // Signed-in startup always reconciles remote/local state through the repository helper and
    // uses the returned merged list plus canonical selection directly.
    const result = await coordinator.ensureCreation(userId, () =>
      japamsRepository.ensureDefaultJapam(userId),
    );
    if (!result) {
      setIsLoading(false);
      return;
    }

    setJapams(result.japams);
    setCurrentJapamIdState(result.currentJapamId);

    const entry = (() => {
      const existing = hydrationInFlight.current;
      if (existing && existing.userId === userId) {
        return existing;
      }
      const promise = (async () => {
        try {
          const legacyUserId = await AsyncStorage.getItem(LEGACY_USER_ID_KEY);
          await hydrateHistoryForUserDetails(userId, legacyUserId);
        } catch {
          // Don't block ready state on hydration failure
        }
      })();
      const created = { userId, promise };
      hydrationInFlight.current = created;
      return created;
    })();

    await entry.promise;

    if (hydrationInFlight.current !== entry) {
      return;
    }

    if (userIdRef.current !== userId) {
      hydrationInFlight.current = null;
      return;
    }

    hydrationInFlight.current = null;
    DeviceEventEmitter.emit('japam-stats-updated');
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      window.dispatchEvent(new Event('japam-stats-updated'));
    }
    setIsLoading(false);
  }, [coordinator]);

  useEffect(() => {
    void refresh();
    const authHandler = () => void refresh();
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      window.addEventListener('japam-auth-updated', authHandler);
      return () => window.removeEventListener('japam-auth-updated', authHandler);
    }
    const authSub = DeviceEventEmitter.addListener('japam-auth-updated', authHandler);
    return () => authSub.remove();
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
    if (updated.find((j) => j.id === japamId)?.archivedAt === null) {
      selectJapam(japamId);
    }
  }, [selectJapam]);

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
