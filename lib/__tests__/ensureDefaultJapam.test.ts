jest.mock('../japamsRepository', () => ({
  loadJapams: jest.fn(),
  createJapam: jest.fn(),
}));

import { ensureDefaultJapam } from '../ensureDefaultJapam';
import * as japamsRepository from '../japamsRepository';

const mockedLoadJapams = japamsRepository.loadJapams as jest.Mock;
const mockedCreateJapam = japamsRepository.createJapam as jest.Mock;

const USER_ID = 'user-123';
const NOW = '2026-07-20T10:00:00.000Z';

const makeJapam = (overrides: Record<string, unknown> = {}) => ({
  id: 'japam-1',
  userId: USER_ID,
  name: 'Gayatri',
  syncStatus: 'synced',
  displayOrder: null,
  createdAt: NOW,
  updatedAt: NOW,
  archivedAt: null,
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe('ensureDefaultJapam', () => {
  it('no active Japams → creates a new one with the suggested name', async () => {
    mockedLoadJapams.mockResolvedValue([]);
    mockedCreateJapam.mockResolvedValue({ created: makeJapam({ name: 'My Japam' }), japams: [makeJapam({ name: 'My Japam' })] });

    const result = await ensureDefaultJapam(USER_ID, 'My Japam');

    expect(mockedLoadJapams).toHaveBeenCalledWith(USER_ID);
    expect(mockedCreateJapam).toHaveBeenCalledWith(USER_ID, 'My Japam');
    expect(result).toMatchObject({ name: 'My Japam' });
  });

  it('existing active Japam → returns it without creating', async () => {
    const existing = makeJapam({ id: 'existing-1', name: 'My Japam' });
    mockedLoadJapams.mockResolvedValue([existing]);

    const result = await ensureDefaultJapam(USER_ID, 'My Japam');

    expect(mockedCreateJapam).not.toHaveBeenCalled();
    expect(result).toMatchObject({ id: 'existing-1', name: 'My Japam' });
  });

  it('user-created same-name Japam is not silently deleted', async () => {
    const existing = makeJapam({ id: 'user-created-1', name: 'My Japam' });
    mockedLoadJapams.mockResolvedValue([existing]);

    const result = await ensureDefaultJapam(USER_ID, 'My Japam');

    expect(mockedCreateJapam).not.toHaveBeenCalled();
    expect(result?.id).toBe('user-created-1');
  });

  it('archived-only state creates one new active default Japam', async () => {
    const archived = makeJapam({ id: 'archived-1', name: 'Old Japam', archivedAt: '2026-07-01T00:00:00.000Z' });
    mockedLoadJapams.mockResolvedValue([archived]);
    mockedCreateJapam.mockResolvedValue({ created: makeJapam({ id: 'new-1', name: 'My Japam' }), japams: [archived, makeJapam({ id: 'new-1', name: 'My Japam' })] });

    const result = await ensureDefaultJapam(USER_ID, 'My Japam');

    expect(mockedCreateJapam).toHaveBeenCalledWith(USER_ID, 'My Japam');
    expect(result?.id).toBe('new-1');
  });

  it('concurrent calls create exactly one Japam', async () => {
    let resolve: () => void;
    const deferred = new Promise<void>((r) => { resolve = r; });

    mockedLoadJapams.mockImplementation(async () => {
      await deferred;
      return [];
    });
    mockedCreateJapam.mockImplementation(async () => {
      await deferred;
      return { created: makeJapam({ name: 'My Japam' }), japams: [makeJapam({ name: 'My Japam' })] };
    });

    const p1 = ensureDefaultJapam(USER_ID, 'My Japam');
    const p2 = ensureDefaultJapam(USER_ID, 'My Japam');

    resolve!();
    await Promise.all([p1, p2]);

    expect(mockedLoadJapams).toHaveBeenCalledTimes(1);
    expect(mockedCreateJapam).toHaveBeenCalledTimes(1);
  });

  it('returns null when createJapam returns null (blank name)', async () => {
    mockedLoadJapams.mockResolvedValue([]);
    mockedCreateJapam.mockResolvedValue(null);

    const result = await ensureDefaultJapam(USER_ID, '');
    expect(result).toBeNull();
  });
});
