/**
 * Japam Workspaces — pure, dependency-free storage-shape helpers.
 *
 * A Japam is the primary entity of this app: a user-created, user-named workspace (e.g.
 * "Gayatri", "Govinda"). There is NO catalog, NO preset mantra list, and NO cap on how many a user
 * may create — every Japam's name comes from the user, never from this module.
 *
 * These functions take and return plain Japam objects — all AsyncStorage / Supabase I/O stays in
 * the callers, keeping this module pure and unit-testable in plain Node, matching the discipline
 * already established in lib/historyStore.ts.
 *
 * Archiving, not deleting, is this app's primary way to retire a Japam a user no longer practices
 * — archivedAt hides a Japam from the default list without ever touching its history. There is no
 * delete function here; a true permanent delete (if ever added) is a separate, deliberately
 * harder-to-reach action belonging to a later commit, not this pure module.
 */

import { normalizeJapamName } from './historyStore';

export { normalizeJapamName };

export type Japam = {
  id: string;
  userId: string | null;
  name: string;
  /** Reserved for a future manual-reordering (drag-and-drop) feature. Not wired to any UI yet.
   * Null means "use createdAt order" — see sortJapams. */
  displayOrder: number | null;
  createdAt: string;
  updatedAt: string;
  /** Non-null means archived: hidden from the default list, history untouched. Never "deleted". */
  archivedAt: string | null;
};

/**
 * Client-generated UUID (v4-shaped), so a new Japam can be created instantly offline — matching
 * this app's completionId precedent (see makeCompletionId in lib/historyStore.ts) — without
 * waiting for a server round-trip. Deliberately self-contained (Math.random(), no crypto API):
 * global crypto.randomUUID() availability on React Native isn't guaranteed without an explicit
 * polyfill (see timer.tsx's own web-only gating of crypto.getRandomValues), and this id only needs
 * to avoid collision, not resist cryptographic guessing.
 */
export const createJapamId = (): string =>
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });

/**
 * Create a new Japam. Returns null (never throws) if the name normalizes to blank — the caller
 * decides how to surface that (e.g. keep an "Add Japam" dialog open) rather than this pure
 * function crashing or silently inventing a name.
 */
export const createJapam = (
  userId: string | null | undefined,
  rawName: string | null | undefined,
  options?: { id?: string; now?: string },
): Japam | null => {
  const name = normalizeJapamName(rawName);
  if (name === null) return null;
  const now = options?.now ?? new Date().toISOString();
  return {
    id: options?.id ?? createJapamId(),
    userId: userId ?? null,
    name,
    displayOrder: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  };
};

/**
 * Rename a Japam. A blank/whitespace-only name is rejected as a no-op (returns the Japam
 * unchanged) rather than clearing it — unlike the earlier slot design, a Japam has no
 * "unconfigured" state to fall back to once created, so there is nothing sensible to clear it to.
 */
export const renameJapam = (
  japam: Japam,
  rawName: string | null | undefined,
  now: string = new Date().toISOString(),
): Japam => {
  const name = normalizeJapamName(rawName);
  if (name === null) return japam;
  return { ...japam, name, updatedAt: now };
};

/** Archive: hides this Japam from the default list. Never touches its history. */
export const archiveJapam = (japam: Japam, now: string = new Date().toISOString()): Japam => ({
  ...japam,
  archivedAt: now,
  updatedAt: now,
});

/** Restore a previously archived Japam back to the default list. */
export const restoreJapam = (japam: Japam, now: string = new Date().toISOString()): Japam => ({
  ...japam,
  archivedAt: null,
  updatedAt: now,
});

/**
 * Sort order for display: explicit displayOrder first (ascending) when present, then createdAt
 * ascending (oldest/most-established Japam first) as the fallback — matches the approved
 * architecture's recommendation to default to creation order rather than alphabetical, since
 * manual drag-and-drop reordering (which would populate displayOrder) isn't implemented yet.
 * Does not mutate its input.
 */
export const sortJapams = (japams: Japam[]): Japam[] =>
  [...japams].sort((a, b) => {
    if (a.displayOrder !== null && b.displayOrder !== null && a.displayOrder !== b.displayOrder) {
      return a.displayOrder - b.displayOrder;
    }
    if (a.displayOrder !== null && b.displayOrder === null) return -1;
    if (a.displayOrder === null && b.displayOrder !== null) return 1;
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  });

/** Non-archived Japams, in display order — what the default "My Japams" list shows. */
export const activeJapams = (japams: Japam[]): Japam[] =>
  sortJapams(japams.filter((j) => j.archivedAt === null));

/** Archived Japams, in display order — shown only in a separate "Manage Archived" view. */
export const archivedJapams = (japams: Japam[]): Japam[] =>
  sortJapams(japams.filter((j) => j.archivedAt !== null));

/**
 * Resolve a display label for a japamId against the current (live) list of Japams — prefers the
 * Japam's current name so a rename is reflected everywhere immediately, falling back to the
 * generic "Japam" default (never a hardcoded mantra name) when the id is null/absent or no longer
 * matches any known Japam (e.g. legacy history, or a Japam that no longer exists).
 */
export const japamLabel = (japams: Japam[], japamId: string | null | undefined): string => {
  if (!japamId) return 'Japam';
  const match = japams.find((j) => j.id === japamId);
  return match?.name ?? 'Japam';
};
