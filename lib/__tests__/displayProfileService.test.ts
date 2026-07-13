jest.mock('../displayProfileRepository', () => ({
  resetMyDisplayProfileToProvider: jest.fn(),
  upsertMyDisplayProfile: jest.fn(),
}));

import {
  resetMyDisplayProfileToProvider as resetProfileRepositoryToProvider,
  upsertMyDisplayProfile,
} from '../displayProfileRepository';
import {
  MAX_DISPLAY_NAME_LENGTH,
  resetMyDisplayProfileToProvider,
  saveMyDisplayProfile,
} from '../displayProfileService';

const mockedUpsert = upsertMyDisplayProfile as jest.Mock;
const mockedReset = resetProfileRepositoryToProvider as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('saveMyDisplayProfile', () => {
  it('normalizes a manual name before delegating to the sole profile repository path', async () => {
    mockedUpsert.mockResolvedValue({ kind: 'updated', profile: {} });

    await saveMyDisplayProfile({ displayName: '  Subbarao  ', nameSource: 'manual' });

    expect(mockedUpsert).toHaveBeenCalledWith('Subbarao', 'manual');
  });

  it('passes provider seed and refresh through the ordinary self-scoped path', async () => {
    mockedUpsert.mockResolvedValue({ kind: 'updated', profile: {} });

    await saveMyDisplayProfile({ displayName: 'Bellam', nameSource: 'provider' });
    await saveMyDisplayProfile({ displayName: 'Bellam Reddy', nameSource: 'provider' });

    expect(mockedUpsert).toHaveBeenNthCalledWith(1, 'Bellam', 'provider');
    expect(mockedUpsert).toHaveBeenNthCalledWith(2, 'Bellam Reddy', 'provider');
    expect(mockedReset).not.toHaveBeenCalled();
  });

  it('uses the distinct explicit reset path rather than treating it as a provider refresh', async () => {
    mockedReset.mockResolvedValue({ kind: 'updated', profile: {} });

    await resetMyDisplayProfileToProvider('Google Name');

    expect(mockedReset).toHaveBeenCalledWith('Google Name');
    expect(mockedUpsert).not.toHaveBeenCalled();
  });

  it('rejects an empty name without calling the repository', async () => {
    await expect(saveMyDisplayProfile({ displayName: '   ', nameSource: 'manual' })).resolves.toEqual({
      kind: 'error',
      message: 'Display name must not be empty.',
    });
    expect(mockedUpsert).not.toHaveBeenCalled();
  });

  it('rejects an oversized name without calling the repository', async () => {
    await expect(
      saveMyDisplayProfile({ displayName: 'A'.repeat(MAX_DISPLAY_NAME_LENGTH + 1), nameSource: 'provider' })
    ).resolves.toEqual({
      kind: 'error',
      message: 'Display name must be 80 characters or fewer.',
    });
    expect(mockedUpsert).not.toHaveBeenCalled();
  });

  it('rejects an invalid runtime name source without calling the repository', async () => {
    await expect(
      saveMyDisplayProfile({ displayName: 'Bellam', nameSource: 'legacy' as never })
    ).resolves.toEqual({
      kind: 'error',
      message: 'Display name source must be provider or manual.',
    });
    expect(mockedUpsert).not.toHaveBeenCalled();
  });
});
