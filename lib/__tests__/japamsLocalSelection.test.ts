import AsyncStorage from '@react-native-async-storage/async-storage';
import { type Japam } from '../japams';
import * as japamsRepository from '../japamsRepository';
import {
  currentJapamIdStorageKey,
  deletedJapamsStorageKey,
  userJapamsStorageKey,
} from '../japamsStorage';

const mockFrom = jest.fn();
const mockRpc = jest.fn();

jest.mock('../supabase', () => ({
  supabase: {
    from: (table: string) => mockFrom(table),
    rpc: (...args: unknown[]) => mockRpc(...args),
  },
}));

jest.mock('@react-native-async-storage/async-storage', () => {
  const store: Record<string, string> = {};
  return {
    default: {
      getItem: jest.fn(async (key: string) => store[key] ?? null),
      setItem: jest.fn(async (key: string, value: string) => { store[key] = value; }),
      removeItem: jest.fn(async (key: string) => { delete store[key]; }),
      clear: jest.fn(async () => { Object.keys(store).forEach(k => delete store[k]); }),
    },
    __esModule: true,
  };
});

const UID = 'user-123';

const makeJapam = (overrides: Partial<Japam> = {}): Japam => ({
  id: 'j1',
  userId: UID,
  name: 'Gayatri',
  displayOrder: null,
  createdAt: '2026-07-06T10:00:00.000Z',
  updatedAt: '2026-07-06T10:00:00.000Z',
  archivedAt: null,
  ...overrides,
});

describe('resolveLocalJapamSelection — fast-path local startup view', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    mockFrom.mockClear();
    mockRpc.mockClear();
  });

  it('resolves the cached active Japams and persisted selection without touching the network', async () => {
    await AsyncStorage.setItem(
      userJapamsStorageKey(UID),
      JSON.stringify([
        makeJapam({ id: 'j1', createdAt: '2026-07-06T10:00:00.000Z' }),
        makeJapam({ id: 'j2', createdAt: '2026-07-07T10:00:00.000Z' }),
      ]),
    );
    await AsyncStorage.setItem(currentJapamIdStorageKey(UID), 'j2');

    const result = await japamsRepository.resolveLocalJapamSelection(UID);

    expect(result.currentJapamId).toBe('j2');
    expect(result.japams.map((j) => j.id)).toEqual(['j1', 'j2']);
    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('filters out tombstoned Japams from the cached view', async () => {
    await AsyncStorage.setItem(
      userJapamsStorageKey(UID),
      JSON.stringify([
        makeJapam({ id: 'j1', createdAt: '2026-07-06T10:00:00.000Z' }),
        makeJapam({ id: 'j2', createdAt: '2026-07-07T10:00:00.000Z', archivedAt: '2026-07-08T10:00:00.000Z' }),
      ]),
    );
    await AsyncStorage.setItem(deletedJapamsStorageKey(UID), JSON.stringify(['j2']));
    await AsyncStorage.setItem(currentJapamIdStorageKey(UID), 'j1');

    const result = await japamsRepository.resolveLocalJapamSelection(UID);

    expect(result.currentJapamId).toBe('j1');
    expect(result.japams.map((j) => j.id)).toEqual(['j1']);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('preserves a stale persisted pointer when no active Japam matches', async () => {
    await AsyncStorage.setItem(
      userJapamsStorageKey(UID),
      JSON.stringify([makeJapam({ id: 'j1', archivedAt: '2026-07-08T10:00:00.000Z' })]),
    );
    await AsyncStorage.setItem(currentJapamIdStorageKey(UID), 'j1');

    const result = await japamsRepository.resolveLocalJapamSelection(UID);

    // Active-only view (archived hidden) but the persisted pointer is never wiped — the
    // reconcile owns durable selection and may repair it when remote authority is available.
    expect(result.japams).toHaveLength(0);
    expect(result.currentJapamId).toBe('j1');
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('empty cache resolves to an empty view with no selection', async () => {
    const result = await japamsRepository.resolveLocalJapamSelection(UID);

    expect(result).toEqual({ japams: [], currentJapamId: null });
    expect(mockFrom).not.toHaveBeenCalled();
  });
});
