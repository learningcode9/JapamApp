/**
 * CurrentJapamContext — the single source of truth for "which Japam is currently selected."
 *
 * AsyncStorage is persistence only: the Provider loads from it once (on mount and on identity
 * change) and writes through to it on every change, but every consumer reads the SAME in-memory
 * React state via useContext, not independent per-screen storage reads. This mirrors exactly how
 * TimerContext already works in this app (contexts/timer-context.tsx) and was chosen specifically
 * to avoid the cross-instance staleness class of bug already found once in this feature's earlier
 * slot-based design (independent per-screen hooks each holding their own copy of the same value).
 *
 * Provider placement: NOT mounted anywhere yet in this commit (per Commit 4's scope) — it must
 * eventually live at the app root (app/_layout.tsx), alongside TimerProvider, exactly the same
 * lesson already documented in this project's release checklist about global long-lived providers.
 *
 * No Supabase sync here — Japams are local-only (AsyncStorage) for both guests and signed-in users
 * in this commit, matching the same starting point the earlier slot design had before any sync was
 * ever wired up.
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
import {
  activeJapams,
  archiveJapam as archiveJapamPure,
  createJapam as createJapamPure,
  renameJapam as renameJapamPure,
  restoreJapam as restoreJapamPure,
  type Japam,
} from '../lib/japams';
import {
  loadCurrentJapamId,
  loadJapams,
  saveCurrentJapamId,
  saveJapams,
} from '../lib/japamsStorage';

const USER_ID_KEY = 'userId';

type CurrentJapamContextValue = {
  /** All Japams for the current identity (active + archived). */
  japams: Japam[];
  /** The selected Japam's id, or null if none is selected (no Japams yet, or nothing chosen). */
  currentJapamId: string | null;
  /** Convenience lookup of the selected Japam object, or null. */
  currentJapam: Japam | null;
  /** True until the initial AsyncStorage load for the current identity completes. */
  isLoading: boolean;
  setCurrentJapamId: (japamId: string | null) => void;
  createJapam: (rawName: string) => Promise<Japam | null>;
  renameJapam: (japamId: string, rawName: string) => Promise<void>;
  archiveJapam: (japamId: string) => Promise<void>;
  restoreJapam: (japamId: string) => Promise<void>;
};

const CurrentJapamContext = createContext<CurrentJapamContextValue | null>(null);

export function CurrentJapamProvider({ children }: { children: ReactNode }) {
  const [japams, setJapams] = useState<Japam[]>([]);
  const [currentJapamId, setCurrentJapamIdState] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  // saveJapams/saveCurrentJapamId are fire-and-forget writes keyed by whichever identity was
  // active at call time; refresh() can run again (auth change) while an earlier write is still in
  // flight, so every mutation re-reads the CURRENT userId from storage rather than closing over a
  // possibly-stale one from render time.
  const userIdRef = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    const userId = await AsyncStorage.getItem(USER_ID_KEY);
    userIdRef.current = userId;
    const [loadedJapams, persistedCurrentId] = await Promise.all([
      loadJapams(userId),
      loadCurrentJapamId(userId),
    ]);
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
      await saveCurrentJapamId(userId, resolvedCurrentId);
    }
    setIsLoading(false);
  }, []);

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

  const setCurrentJapamId = useCallback((japamId: string | null) => {
    setCurrentJapamIdState(japamId);
    void saveCurrentJapamId(userIdRef.current, japamId);
  }, []);

  const createJapam = useCallback(async (rawName: string): Promise<Japam | null> => {
    const userId = userIdRef.current;
    const created = createJapamPure(userId, rawName);
    if (created === null) return null;
    const updated = [...japams, created];
    setJapams(updated);
    await saveJapams(userId, updated);
    // A newly created Japam becomes the current one -- there is no reason to make the user select
    // what they just created.
    setCurrentJapamId(created.id);
    return created;
  }, [japams, setCurrentJapamId]);

  const renameJapam = useCallback(async (japamId: string, rawName: string): Promise<void> => {
    const target = japams.find((j) => j.id === japamId);
    if (!target) return;
    const renamed = renameJapamPure(target, rawName);
    const updated = japams.map((j) => (j.id === japamId ? renamed : j));
    setJapams(updated);
    await saveJapams(userIdRef.current, updated);
  }, [japams]);

  const archiveJapam = useCallback(async (japamId: string): Promise<void> => {
    const target = japams.find((j) => j.id === japamId);
    if (!target) return;
    const archived = archiveJapamPure(target);
    const updated = japams.map((j) => (j.id === japamId ? archived : j));
    setJapams(updated);
    await saveJapams(userIdRef.current, updated);
    // The archived Japam can no longer be "current" -- it's hidden from the default list. Fall
    // back to the next active Japam, or null.
    if (currentJapamId === japamId) {
      const nextActive = activeJapams(updated)[0]?.id ?? null;
      setCurrentJapamId(nextActive);
    }
  }, [japams, currentJapamId, setCurrentJapamId]);

  const restoreJapam = useCallback(async (japamId: string): Promise<void> => {
    const target = japams.find((j) => j.id === japamId);
    if (!target) return;
    const restored = restoreJapamPure(target);
    const updated = japams.map((j) => (j.id === japamId ? restored : j));
    setJapams(updated);
    await saveJapams(userIdRef.current, updated);
    // Restoring is a "manage archived Japams" action, not a selection -- it deliberately does not
    // change currentJapamId.
  }, [japams]);

  const currentJapam = useMemo(
    () => japams.find((j) => j.id === currentJapamId) ?? null,
    [japams, currentJapamId],
  );

  const value = useMemo<CurrentJapamContextValue>(() => ({
    japams,
    currentJapamId,
    currentJapam,
    isLoading,
    setCurrentJapamId,
    createJapam,
    renameJapam,
    archiveJapam,
    restoreJapam,
  }), [
    japams,
    currentJapamId,
    currentJapam,
    isLoading,
    setCurrentJapamId,
    createJapam,
    renameJapam,
    archiveJapam,
    restoreJapam,
  ]);

  return <CurrentJapamContext.Provider value={value}>{children}</CurrentJapamContext.Provider>;
}

export function useCurrentJapam() {
  const context = useContext(CurrentJapamContext);
  if (!context) throw new Error('useCurrentJapam must be used inside CurrentJapamProvider');
  return context;
}
