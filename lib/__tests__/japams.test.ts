import {
  createJapam,
  createJapamId,
  renameJapam,
  archiveJapam,
  restoreJapam,
  sortJapams,
  activeJapams,
  archivedJapams,
  japamLabel,
  normalizeJapamName,
  parseStoredJapams,
  type Japam,
} from '../japams';

const UID = 'user-123';
const NOW = '2026-07-06T10:00:00.000Z';

const makeJapam = (overrides: Partial<Japam> = {}): Japam => ({
  id: 'japam-1',
  userId: UID,
  name: 'Gayatri',
  syncStatus: 'synced',
  displayOrder: null,
  createdAt: NOW,
  updatedAt: NOW,
  archivedAt: null,
  ...overrides,
});

describe('normalizeJapamName (re-exported from historyStore)', () => {
  it('trims whitespace', () => {
    expect(normalizeJapamName('  Gayatri  ')).toBe('Gayatri');
  });
  it('returns null for blank input', () => {
    expect(normalizeJapamName('')).toBeNull();
    expect(normalizeJapamName('   ')).toBeNull();
  });
});

describe('createJapamId', () => {
  it('produces a v4-shaped uuid string', () => {
    const id = createJapamId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });
  it('is different on every call (collision-avoidance, not determinism)', () => {
    const ids = new Set(Array.from({ length: 50 }, () => createJapamId()));
    expect(ids.size).toBe(50);
  });
});

describe('createJapam', () => {
  it('creates a Japam with the user-given name, trimmed', () => {
    const japam = createJapam(UID, '  Gayatri  ', { now: NOW });
    expect(japam).toMatchObject({
      userId: UID,
      name: 'Gayatri',
      syncStatus: 'pending',
      displayOrder: null,
      createdAt: NOW,
      updatedAt: NOW,
      archivedAt: null,
    });
    expect(typeof japam?.id).toBe('string');
    expect(japam?.id.length).toBeGreaterThan(0);
  });
  it('uses a caller-supplied id when given (for deterministic testing / storage-layer control)', () => {
    const japam = createJapam(UID, 'Gayatri', { id: 'fixed-id', now: NOW });
    expect(japam?.id).toBe('fixed-id');
  });
  it('generates a distinct id per call when none is supplied', () => {
    const a = createJapam(UID, 'Gayatri', { now: NOW });
    const b = createJapam(UID, 'Govinda', { now: NOW });
    expect(a?.id).not.toBe(b?.id);
  });
  it('allows a null userId (guest, local-only Japam)', () => {
    const japam = createJapam(null, 'Gayatri', { now: NOW });
    expect(japam?.userId).toBeNull();
    expect(japam?.syncStatus).toBe('synced');
  });

  describe('blank name is rejected safely, never crashes, never invents a name', () => {
    it('returns null for an empty string', () => {
      expect(createJapam(UID, '', { now: NOW })).toBeNull();
    });
    it('returns null for whitespace only', () => {
      expect(createJapam(UID, '   ', { now: NOW })).toBeNull();
    });
    it('returns null for null/undefined', () => {
      expect(createJapam(UID, null, { now: NOW })).toBeNull();
      expect(createJapam(UID, undefined, { now: NOW })).toBeNull();
    });
  });
});

describe('renameJapam', () => {
  it('renames to the trimmed new name and bumps updatedAt', () => {
    const japam = makeJapam({ updatedAt: NOW });
    const renamed = renameJapam(japam, '  Sri Gayatri  ', '2026-07-06T11:00:00.000Z');
    expect(renamed.name).toBe('Sri Gayatri');
    expect(renamed.syncStatus).toBe('pending');
    expect(renamed.updatedAt).toBe('2026-07-06T11:00:00.000Z');
    expect(renamed.id).toBe(japam.id); // identity never changes on rename
  });

  describe('blank name is rejected/ignored safely (no "unconfigured" state to fall back to)', () => {
    it('keeps the existing name when given an empty string', () => {
      const japam = makeJapam({ name: 'Gayatri' });
      expect(renameJapam(japam, '').name).toBe('Gayatri');
    });
    it('keeps the existing name when given whitespace only', () => {
      const japam = makeJapam({ name: 'Gayatri' });
      expect(renameJapam(japam, '   ').name).toBe('Gayatri');
    });
    it('does not bump updatedAt when the rename is rejected', () => {
      const japam = makeJapam({ name: 'Gayatri', updatedAt: NOW });
      const result = renameJapam(japam, '', '2026-07-06T12:00:00.000Z');
      expect(result.updatedAt).toBe(NOW);
    });
  });
});

describe('archiveJapam / restoreJapam', () => {
  it('archiving sets archivedAt and bumps updatedAt, never touches name/id', () => {
    const japam = makeJapam({ archivedAt: null });
    const archived = archiveJapam(japam, '2026-07-06T13:00:00.000Z');
    expect(archived.archivedAt).toBe('2026-07-06T13:00:00.000Z');
    expect(archived.syncStatus).toBe('pending');
    expect(archived.updatedAt).toBe('2026-07-06T13:00:00.000Z');
    expect(archived.name).toBe(japam.name);
    expect(archived.id).toBe(japam.id);
  });
  it('restoring clears archivedAt and bumps updatedAt', () => {
    const archived = makeJapam({ archivedAt: '2026-07-06T13:00:00.000Z' });
    const restored = restoreJapam(archived, '2026-07-06T14:00:00.000Z');
    expect(restored.archivedAt).toBeNull();
    expect(restored.syncStatus).toBe('pending');
    expect(restored.updatedAt).toBe('2026-07-06T14:00:00.000Z');
  });
});

describe('active vs archived lists', () => {
  const active1 = makeJapam({ id: 'a1', name: 'Gayatri', archivedAt: null });
  const active2 = makeJapam({ id: 'a2', name: 'Govinda', archivedAt: null });
  const archived1 = makeJapam({ id: 'r1', name: 'Old Practice', archivedAt: '2026-07-01T00:00:00.000Z' });
  const all = [active1, archived1, active2];

  it('activeJapams returns only non-archived Japams', () => {
    const result = activeJapams(all);
    expect(result.map((j) => j.id).sort()).toEqual(['a1', 'a2']);
  });
  it('archivedJapams returns only archived Japams', () => {
    const result = archivedJapams(all);
    expect(result.map((j) => j.id)).toEqual(['r1']);
  });
  it('archiving a Japam removes it from activeJapams and adds it to archivedJapams', () => {
    const justArchived = archiveJapam(active1, '2026-07-06T15:00:00.000Z');
    const updatedList = [justArchived, active2, archived1];
    expect(activeJapams(updatedList).map((j) => j.id)).toEqual(['a2']);
    expect(archivedJapams(updatedList).map((j) => j.id).sort()).toEqual(['a1', 'r1'].sort());
  });
});

describe('sortJapams: displayOrder first, then createdAt as the fallback', () => {
  it('sorts by createdAt ascending (oldest first) when no displayOrder is set (today\'s common case, since drag-and-drop is not implemented yet)', () => {
    const oldest = makeJapam({ id: 'oldest', createdAt: '2026-07-01T00:00:00.000Z' });
    const middle = makeJapam({ id: 'middle', createdAt: '2026-07-03T00:00:00.000Z' });
    const newest = makeJapam({ id: 'newest', createdAt: '2026-07-05T00:00:00.000Z' });
    const sorted = sortJapams([newest, oldest, middle]);
    expect(sorted.map((j) => j.id)).toEqual(['oldest', 'middle', 'newest']);
  });
  it('respects an explicit displayOrder when present, ascending', () => {
    const third = makeJapam({ id: 'third', displayOrder: 3, createdAt: '2026-07-01T00:00:00.000Z' });
    const first = makeJapam({ id: 'first', displayOrder: 1, createdAt: '2026-07-05T00:00:00.000Z' });
    const second = makeJapam({ id: 'second', displayOrder: 2, createdAt: '2026-07-03T00:00:00.000Z' });
    const sorted = sortJapams([third, first, second]);
    expect(sorted.map((j) => j.id)).toEqual(['first', 'second', 'third']);
  });
  it('does not mutate the input array', () => {
    const list = [makeJapam({ id: 'b', createdAt: '2026-07-05T00:00:00.000Z' }), makeJapam({ id: 'a', createdAt: '2026-07-01T00:00:00.000Z' })];
    const original = [...list];
    sortJapams(list);
    expect(list).toEqual(original);
  });
});

describe('japamLabel: display label resolution, no hardcoded mantra names', () => {
  const gayatri = makeJapam({ id: 'j1', name: 'Gayatri' });
  const govinda = makeJapam({ id: 'j2', name: 'Govinda' });
  const list = [gayatri, govinda];

  it('returns the matching Japam\'s current name', () => {
    expect(japamLabel(list, 'j1')).toBe('Gayatri');
    expect(japamLabel(list, 'j2')).toBe('Govinda');
  });
  it('reflects a rename immediately (looks up the live list, not a snapshot)', () => {
    const renamed = renameJapam(gayatri, 'Sri Gayatri');
    const updatedList = [renamed, govinda];
    expect(japamLabel(updatedList, 'j1')).toBe('Sri Gayatri');
  });
  it('falls back to the generic "Japam" default for a null/undefined japamId (legacy row) -- never a preset mantra name', () => {
    expect(japamLabel(list, null)).toBe('Japam');
    expect(japamLabel(list, undefined)).toBe('Japam');
  });
  it('falls back to "Japam" for an id that matches no known Japam (e.g. a deleted Japam) -- never invents or guesses a name', () => {
    expect(japamLabel(list, 'nonexistent-id')).toBe('Japam');
  });
  it('never returns a hardcoded mantra name anywhere in this module\'s own fallback text', () => {
    // The ONLY built-in string this module ever produces on its own is the generic noun "Japam" --
    // every other piece of text comes from the user's own createJapam/renameJapam input.
    expect(japamLabel([], 'anything')).toBe('Japam');
    expect(japamLabel([], null)).toBe('Japam');
  });
});

describe('parseStoredJapams: safely reconstruct a Japams list from a raw AsyncStorage read', () => {
  it('returns [] for a missing key (null)', () => {
    expect(parseStoredJapams(null)).toEqual([]);
  });
  it('returns [] for undefined', () => {
    expect(parseStoredJapams(undefined)).toEqual([]);
  });
  it('returns [] for an empty string', () => {
    expect(parseStoredJapams('')).toEqual([]);
  });
  it('returns [] for malformed JSON rather than throwing', () => {
    expect(parseStoredJapams('{not valid json')).toEqual([]);
  });
  it('returns [] for valid JSON that is not an array', () => {
    expect(parseStoredJapams('{"id":"x"}')).toEqual([]);
  });
  it('reconstructs a previously-saved Japams list', () => {
    const raw = JSON.stringify([
      makeJapam({ id: 'j1', name: 'Gayatri' }),
      makeJapam({ id: 'j2', name: 'Govinda', archivedAt: '2026-07-01T00:00:00.000Z' }),
    ]);
    const result = parseStoredJapams(raw);
    expect(result).toHaveLength(2);
    expect(result.find((j) => j.id === 'j1')?.name).toBe('Gayatri');
    expect(result.find((j) => j.id === 'j2')?.archivedAt).toBe('2026-07-01T00:00:00.000Z');
  });
  it('backward-compatible: an existing stored Japam without syncStatus loads as pending for authenticated users', () => {
    const raw = JSON.stringify([{ id: 'j1', userId: UID, name: 'Gayatri', createdAt: NOW, updatedAt: NOW, archivedAt: null }]);
    const result = parseStoredJapams(raw);
    expect(result[0].syncStatus).toBe('pending');
  });
  it('trims a stored name via normalizeJapamName', () => {
    const raw = JSON.stringify([makeJapam({ id: 'j1', name: '  Gayatri  ' })]);
    expect(parseStoredJapams(raw)[0].name).toBe('Gayatri');
  });
  it('skips an item with a blank/missing name rather than inventing one', () => {
    const raw = JSON.stringify([
      { id: 'j1', name: '', createdAt: NOW, updatedAt: NOW },
      makeJapam({ id: 'j2', name: 'Govinda' }),
    ]);
    const result = parseStoredJapams(raw);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('j2');
  });
  it('skips an item with a missing/non-string id', () => {
    const raw = JSON.stringify([
      { name: 'No Id', createdAt: NOW, updatedAt: NOW },
      makeJapam({ id: 'j2', name: 'Govinda' }),
    ]);
    const result = parseStoredJapams(raw);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('j2');
  });
  it('defaults an invalid/missing displayOrder to null', () => {
    const raw = JSON.stringify([{ id: 'j1', name: 'Gayatri', createdAt: NOW, updatedAt: NOW, displayOrder: 'not-a-number' }]);
    expect(parseStoredJapams(raw)[0].displayOrder).toBeNull();
  });
  it('preserves a valid numeric displayOrder', () => {
    const raw = JSON.stringify([makeJapam({ id: 'j1', name: 'Gayatri', displayOrder: 2 })]);
    expect(parseStoredJapams(raw)[0].displayOrder).toBe(2);
  });
  it('defaults a missing/invalid archivedAt to null', () => {
    const raw = JSON.stringify([{ id: 'j1', name: 'Gayatri', createdAt: NOW, updatedAt: NOW, archivedAt: 12345 }]);
    expect(parseStoredJapams(raw)[0].archivedAt).toBeNull();
  });
  it('defaults a missing/non-string userId to null (e.g. a guest-created Japam)', () => {
    const raw = JSON.stringify([{ id: 'j1', name: 'Gayatri', createdAt: NOW, updatedAt: NOW }]);
    expect(parseStoredJapams(raw)[0].userId).toBeNull();
  });
});
