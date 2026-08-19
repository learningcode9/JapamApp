/* eslint-disable import/first, @typescript-eslint/no-require-imports */
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

const mockLoadHistoryForUser = jest.fn();
const mockApplyLegacyHistoryBackfill = jest.fn();
const mockIsComplete = jest.fn();
const mockMarkComplete = jest.fn();
const mockEnsureDefaultJapam = jest.fn();
const mockCreateJapam = jest.fn();
let mockCurrentJapamState = {
  isLoading: false,
};

jest.mock('../../lib/historyRepository', () => ({
  loadHistoryForUser: (...args: unknown[]) => mockLoadHistoryForUser(...args),
  applyLegacyHistoryBackfill: (...args: unknown[]) => mockApplyLegacyHistoryBackfill(...args),
}));

jest.mock('../../lib/legacyHistoryBackfillStorage', () => ({
  isLegacyHistoryBackfillComplete: (...args: unknown[]) => mockIsComplete(...args),
  markLegacyHistoryBackfillComplete: (...args: unknown[]) => mockMarkComplete(...args),
}));

jest.mock('../../lib/japamsRepository', () => ({
  ensureDefaultJapam: (...args: unknown[]) => mockEnsureDefaultJapam(...args),
  createJapam: (...args: unknown[]) => mockCreateJapam(...args),
}));

jest.mock('../../contexts/current-japam-context', () => ({
  useCurrentJapam: () => ({
    isLoading: mockCurrentJapamState.isLoading,
  }),
}));

jest.mock('react-native', () => ({
  Alert: {
    alert: jest.fn(),
  },
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import React from 'react';
const renderer = require('react-test-renderer');
const { act } = renderer;
import LegacyHistoryBackfillRunner from '../LegacyHistoryBackfillRunner';
/* eslint-enable import/first, @typescript-eslint/no-require-imports */

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
  mockCurrentJapamState = {
    isLoading: false,
  };
  await AsyncStorage.setItem('userId', 'user-123');
  mockIsComplete.mockResolvedValue(false);
  mockLoadHistoryForUser.mockResolvedValue([
    {
      date: '2026-01-01T00:00:00.000Z',
      malas: 1,
      totalCount: 108,
      duration: 60,
      manual: false,
      userId: 'user-123',
      syncStatus: 'synced',
      japamId: null,
      japamName: null,
      completionId: 'legacy-1',
    },
  ]);
  mockMarkComplete.mockResolvedValue(undefined);
  mockApplyLegacyHistoryBackfill.mockResolvedValue({ needsBackfill: true });
});

const renderRunner = async () => {
  let tree: any;
  await act(async () => {
    tree = renderer.create(React.createElement(LegacyHistoryBackfillRunner));
    await Promise.resolve();
  });
  await flush();
  return tree;
};

describe('LegacyHistoryBackfillRunner default Japam routing', () => {
  it('uses the shared ensureDefaultJapam helper and reuses the resolved canonical Japam', async () => {
    mockEnsureDefaultJapam.mockResolvedValue({
      japams: [
        {
          id: 'canonical-1',
          userId: 'user-123',
          name: 'My Japam',
          displayOrder: null,
          createdAt: '2026-07-20T00:00:00.000Z',
          updatedAt: '2026-07-20T00:00:00.000Z',
          archivedAt: null,
        },
      ],
      currentJapamId: 'canonical-1',
      created: null,
    });

    await renderRunner();

    expect(mockEnsureDefaultJapam).toHaveBeenCalledTimes(1);
    expect(mockCreateJapam).not.toHaveBeenCalled();
    expect(mockApplyLegacyHistoryBackfill).toHaveBeenCalledWith(
      'user-123',
      'canonical-1',
      'My Japam',
      expect.objectContaining({
        onlyCompletionIds: new Set(['legacy-1']),
      })
    );
    expect(mockMarkComplete).toHaveBeenCalledWith('user-123');
  });

  it('reuses an existing active manual Japam when one is already present', async () => {
    mockEnsureDefaultJapam.mockResolvedValue({
      japams: [
        {
          id: 'manual-1',
          userId: 'user-123',
          name: 'Govinda',
          displayOrder: null,
          createdAt: '2026-07-19T00:00:00.000Z',
          updatedAt: '2026-07-20T00:00:00.000Z',
          archivedAt: null,
        },
      ],
      currentJapamId: 'manual-1',
      created: null,
    });

    await renderRunner();

    expect(mockCreateJapam).not.toHaveBeenCalled();
    expect(mockApplyLegacyHistoryBackfill).toHaveBeenCalledWith(
      'user-123',
      'manual-1',
      'Govinda',
      expect.objectContaining({
        onlyCompletionIds: new Set(['legacy-1']),
      })
    );
  });

  it.each([null, ''])('signed-out/auth-not-ready state is a no-op for userId %p', async (userId) => {
    mockCurrentJapamState.isLoading = true;
    if (userId === null) {
      await AsyncStorage.removeItem('userId');
    } else {
      await AsyncStorage.setItem('userId', userId);
    }

    await renderRunner();

    expect(mockEnsureDefaultJapam).not.toHaveBeenCalled();
    expect(mockLoadHistoryForUser).not.toHaveBeenCalled();
    expect(mockApplyLegacyHistoryBackfill).not.toHaveBeenCalled();
    expect(mockMarkComplete).not.toHaveBeenCalled();
    expect(mockCreateJapam).not.toHaveBeenCalled();
    expect(await AsyncStorage.getItem('legacyHistoryBackfillComplete:guest')).toBeNull();
    expect(await AsyncStorage.getItem('userJapams:guest')).toBeNull();
  });

  it('retries and processes the authenticated identity once auth becomes available', async () => {
    mockCurrentJapamState.isLoading = true;
    await AsyncStorage.removeItem('userId');

    mockEnsureDefaultJapam.mockResolvedValue({
      japams: [
        {
          id: 'canonical-1',
          userId: 'user-123',
          name: 'My Japam',
          displayOrder: null,
          createdAt: '2026-07-20T00:00:00.000Z',
          updatedAt: '2026-07-20T00:00:00.000Z',
          archivedAt: null,
        },
      ],
      currentJapamId: 'canonical-1',
      created: null,
    });

    const tree = await renderRunner();

    expect(mockEnsureDefaultJapam).not.toHaveBeenCalled();
    expect(mockLoadHistoryForUser).not.toHaveBeenCalled();
    expect(mockMarkComplete).not.toHaveBeenCalled();

    await AsyncStorage.setItem('userId', 'user-123');
    mockCurrentJapamState.isLoading = false;
    await act(async () => {
      tree.update(React.createElement(LegacyHistoryBackfillRunner));
      await Promise.resolve();
    });
    await flush();

    expect(mockEnsureDefaultJapam).toHaveBeenCalledTimes(1);
    expect(mockLoadHistoryForUser).toHaveBeenCalledWith('user-123');
    expect(mockApplyLegacyHistoryBackfill).toHaveBeenCalledWith(
      'user-123',
      'canonical-1',
      'My Japam',
      expect.objectContaining({
        onlyCompletionIds: new Set(['legacy-1']),
      })
    );
    expect(mockMarkComplete).toHaveBeenCalledWith('user-123');
  });
});

describe('LegacyHistoryBackfillRunner local snapshot must not skip the remote backfill', () => {
  const canonicalJapam = {
    id: 'canonical-1',
    userId: 'user-123',
    name: 'My Japam',
    displayOrder: null,
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-07-20T00:00:00.000Z',
    archivedAt: null,
  };

  const mockCanonicalResolution = () => {
    mockEnsureDefaultJapam.mockResolvedValue({
      japams: [canonicalJapam],
      currentJapamId: 'canonical-1',
      created: null,
    });
  };

  it('runs the remote backfill when local history is empty but remote rows may still exist', async () => {
    // The local AsyncStorage snapshot has NO rows yet (the History screen's remote merge has not
    // populated it at startup), so a local-only plan reports "nothing to reassign". The remote
    // japam_history may still hold eligible null-japamId rows, so the runner must STILL reach
    // applyLegacyHistoryBackfill -- whose remote half derives its eligible set from the
    // authoritative remote rows.
    mockLoadHistoryForUser.mockResolvedValue([]);
    mockCanonicalResolution();
    mockApplyLegacyHistoryBackfill.mockResolvedValue({ needsBackfill: false });

    await renderRunner();

    expect(mockApplyLegacyHistoryBackfill).toHaveBeenCalledTimes(1);
    expect(mockApplyLegacyHistoryBackfill).toHaveBeenCalledWith(
      'user-123',
      'canonical-1',
      'My Japam',
      expect.objectContaining({ onlyCompletionIds: new Set() })
    );
    expect(mockMarkComplete).toHaveBeenCalledWith('user-123');
  });

  it('runs the remote backfill when local rows are all assigned but remote may still have null rows', async () => {
    // Local snapshot holds only already-assigned rows, so a local-only plan reports
    // needsBackfill:false. That cannot prove the authoritative remote japam_history is clean --
    // this device may never have downloaded its rows -- so the runner must still reach
    // applyLegacyHistoryBackfill instead of marking complete from the local snapshot alone.
    mockLoadHistoryForUser.mockResolvedValue([
      {
        date: '2026-01-01T00:00:00.000Z',
        malas: 1,
        totalCount: 108,
        duration: 60,
        manual: false,
        userId: 'user-123',
        syncStatus: 'synced',
        japamId: 'canonical-1',
        japamName: 'My Japam',
        completionId: 'assigned-1',
      },
    ]);
    mockCanonicalResolution();
    mockApplyLegacyHistoryBackfill.mockResolvedValue({ needsBackfill: false });

    await renderRunner();

    expect(mockApplyLegacyHistoryBackfill).toHaveBeenCalledTimes(1);
    expect(mockMarkComplete).toHaveBeenCalledWith('user-123');
  });
});
