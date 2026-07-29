/* eslint-disable import/first, @typescript-eslint/no-require-imports */
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

const mockLoadJapams = jest.fn();
const mockLoadCurrentJapamId = jest.fn();
const mockSaveCurrentJapamId = jest.fn();
const mockEnsureDefaultJapam = jest.fn();
const mockReconcileAllJapams = jest.fn();

jest.mock('../../lib/japamsRepository', () => ({
  loadJapams: (...args: unknown[]) => mockLoadJapams(...args),
  loadCurrentJapamId: (...args: unknown[]) => mockLoadCurrentJapamId(...args),
  saveCurrentJapamId: (...args: unknown[]) => mockSaveCurrentJapamId(...args),
  ensureDefaultJapam: (...args: unknown[]) => mockEnsureDefaultJapam(...args),
  reconcileAllJapams: (...args: unknown[]) => mockReconcileAllJapams(...args),
  createJapam: jest.fn(),
  renameJapam: jest.fn(),
  archiveJapam: jest.fn(),
  restoreJapam: jest.fn(),
  deleteJapam: jest.fn(),
}));

jest.mock('react-native', () => ({
  DeviceEventEmitter: {
    addListener: jest.fn(() => ({ remove: jest.fn() })),
    emit: jest.fn(),
  },
  Platform: {
    OS: 'android',
    select: (options: Record<string, unknown>) => options.android ?? options.default,
  },
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import React from 'react';
const renderer = require('react-test-renderer');
const { act } = renderer;
import { DeviceEventEmitter } from 'react-native';
import { CurrentJapamProvider, useCurrentJapam } from '../current-japam-context';
/* eslint-enable import/first, @typescript-eslint/no-require-imports */

type Snapshot = {
  isLoading: boolean;
  currentJapamId: string | null;
  currentJapamName: string | null;
  japamIds: string[];
};

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

const Capture = ({ onSnapshot }: { onSnapshot: (snapshot: Snapshot) => void }) => {
  const { isLoading, currentJapamId, currentJapam, japams } = useCurrentJapam();

  React.useEffect(() => {
    onSnapshot({
      isLoading,
      currentJapamId,
      currentJapamName: currentJapam?.name ?? null,
      japamIds: japams.map((j) => j.id),
    });
  }, [isLoading, currentJapamId, currentJapam, japams, onSnapshot]);

  return null;
};

const renderProvider = async (userId: string | null) => {
  const snapshots: Snapshot[] = [];
  await AsyncStorage.clear();
  if (userId !== null) {
    await AsyncStorage.setItem('userId', userId);
  }

  await act(async () => {
    renderer.create(
      React.createElement(
        CurrentJapamProvider,
        null,
        React.createElement(Capture, {
          onSnapshot: (snapshot: Snapshot) => {
            snapshots.push(snapshot);
          },
        }),
      ),
    );
    await Promise.resolve();
  });
  await flush();
  await flush();

  return { snapshots };
};

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
  mockLoadJapams.mockReset();
  mockLoadCurrentJapamId.mockReset();
  mockSaveCurrentJapamId.mockReset();
  mockEnsureDefaultJapam.mockReset();
  mockReconcileAllJapams.mockReset();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('CurrentJapamProvider refresh', () => {
  it('signed-in refresh adopts a remote canonical Japam and does not create a default', async () => {
    mockEnsureDefaultJapam.mockResolvedValue({
      japams: [
        {
          id: 'remote-canonical',
          userId: 'user-123',
          name: 'My Japam',
          displayOrder: null,
          createdAt: '2026-07-20T00:00:00.000Z',
          updatedAt: '2026-07-20T00:00:00.000Z',
          archivedAt: null,
        },
      ],
      currentJapamId: 'remote-canonical',
      created: null,
    });

    const { snapshots } = await renderProvider('user-123');

    expect(mockEnsureDefaultJapam).toHaveBeenCalledTimes(1);
    expect(mockLoadJapams).not.toHaveBeenCalled();
    expect(mockReconcileAllJapams).not.toHaveBeenCalled();
    expect(snapshots.at(-1)).toMatchObject({
      isLoading: false,
      currentJapamId: 'remote-canonical',
      currentJapamName: 'My Japam',
      japamIds: ['remote-canonical'],
    });
  });

  it('signed-in refresh repairs a stale persisted selection using the merged canonical Japam', async () => {
    mockEnsureDefaultJapam.mockResolvedValue({
      japams: [
        {
          id: 'canonical',
          userId: 'user-123',
          name: 'My Japam',
          displayOrder: null,
          createdAt: '2026-07-19T00:00:00.000Z',
          updatedAt: '2026-07-20T00:00:00.000Z',
          archivedAt: null,
        },
      ],
      currentJapamId: 'canonical',
      created: null,
    });

    const { snapshots } = await renderProvider('user-123');

    expect(mockEnsureDefaultJapam).toHaveBeenCalledTimes(1);
    expect(snapshots.at(-1)?.currentJapamId).toBe('canonical');
    expect(mockSaveCurrentJapamId).not.toHaveBeenCalled();
  });

  it('signed-in refresh persists and selects a remote-only Japam missing locally', async () => {
    mockEnsureDefaultJapam.mockResolvedValue({
      japams: [
        {
          id: 'remote-only',
          userId: 'user-123',
          name: 'My Japam',
          displayOrder: null,
          createdAt: '2026-07-22T00:00:00.000Z',
          updatedAt: '2026-07-22T00:00:00.000Z',
          archivedAt: null,
        },
      ],
      currentJapamId: 'remote-only',
      created: null,
    });

    const { snapshots } = await renderProvider('user-123');

    expect(mockEnsureDefaultJapam).toHaveBeenCalledTimes(1);
    expect(snapshots.at(-1)).toMatchObject({
      currentJapamId: 'remote-only',
      currentJapamName: 'My Japam',
      japamIds: ['remote-only'],
    });
  });

  it('signed-in refresh reconciles a local active duplicate against the older remote canonical without creating a new Japam', async () => {
    mockEnsureDefaultJapam.mockResolvedValue({
      japams: [
        {
          id: 'older-remote',
          userId: 'user-123',
          name: 'My Japam',
          displayOrder: null,
          createdAt: '2026-07-21T00:04:34.432Z',
          updatedAt: '2026-07-21T01:00:00.000Z',
          archivedAt: null,
        },
        {
          id: 'local-duplicate',
          userId: 'user-123',
          name: 'My Japam',
          displayOrder: null,
          createdAt: '2026-07-29T00:15:58.414Z',
          updatedAt: '2026-07-29T00:15:58.414Z',
          archivedAt: null,
        },
      ],
      currentJapamId: 'older-remote',
      created: null,
    });

    const { snapshots } = await renderProvider('user-123');

    expect(mockEnsureDefaultJapam).toHaveBeenCalledTimes(1);
    expect(snapshots.at(-1)).toMatchObject({
      currentJapamId: 'older-remote',
      japamIds: ['older-remote', 'local-duplicate'],
    });
  });

  it('signed-in refresh preserves a valid persisted active selection', async () => {
    mockEnsureDefaultJapam.mockResolvedValue({
      japams: [
        {
          id: 'persisted-active',
          userId: 'user-123',
          name: 'My Japam',
          displayOrder: null,
          createdAt: '2026-07-20T00:00:00.000Z',
          updatedAt: '2026-07-22T00:00:00.000Z',
          archivedAt: null,
        },
      ],
      currentJapamId: 'persisted-active',
      created: null,
    });

    const { snapshots } = await renderProvider('user-123');

    expect(mockEnsureDefaultJapam).toHaveBeenCalledTimes(1);
    expect(snapshots.at(-1)?.currentJapamId).toBe('persisted-active');
  });

  it('signed-in concurrent refreshes share the in-flight operation and do not create extra Japams', async () => {
    let resolveEnsure!: (value: {
      japams: {
        id: string;
        userId: string;
        name: string;
        displayOrder: null;
        createdAt: string;
        updatedAt: string;
        archivedAt: null;
      }[];
      currentJapamId: string | null;
      created: null;
    }) => void;

    const deferred = new Promise<{
      japams: {
        id: string;
        userId: string;
        name: string;
        displayOrder: null;
        createdAt: string;
        updatedAt: string;
        archivedAt: null;
      }[];
      currentJapamId: string | null;
      created: null;
    }>((resolve) => {
      resolveEnsure = resolve;
    });

    mockEnsureDefaultJapam.mockReturnValue(deferred as unknown as Promise<unknown>);

    const { snapshots } = await renderProvider('user-123');

    const authListener = (DeviceEventEmitter.addListener as jest.Mock).mock.calls[0]?.[1] as
      | (() => void)
      | undefined;
    expect(authListener).toBeDefined();
    expect(mockEnsureDefaultJapam).toHaveBeenCalledTimes(1);

    await act(async () => {
      authListener?.();
      authListener?.();
      await Promise.resolve();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mockEnsureDefaultJapam).toHaveBeenCalledTimes(1);

    resolveEnsure!({
      japams: [
        {
          id: 'shared',
          userId: 'user-123',
          name: 'My Japam',
          displayOrder: null,
          createdAt: '2026-07-20T00:00:00.000Z',
          updatedAt: '2026-07-20T00:00:00.000Z',
          archivedAt: null,
        },
      ],
      currentJapamId: 'shared',
      created: null,
    });
    await flush();

    expect(mockEnsureDefaultJapam).toHaveBeenCalledTimes(1);
    expect(mockReconcileAllJapams).not.toHaveBeenCalled();
    expect(snapshots.at(-1)).toMatchObject({
      currentJapamId: 'shared',
      japamIds: ['shared'],
    });
  });

  it('a later signed-in refresh retries successfully after a remote failure', async () => {
    mockEnsureDefaultJapam
      .mockRejectedValueOnce(new Error('remote unavailable'))
      .mockResolvedValueOnce({
        japams: [
          {
            id: 'retry-canonical',
            userId: 'user-123',
            name: 'My Japam',
            displayOrder: null,
            createdAt: '2026-07-20T00:00:00.000Z',
            updatedAt: '2026-07-20T00:00:00.000Z',
            archivedAt: null,
          },
        ],
        currentJapamId: 'retry-canonical',
        created: null,
      });

    const { snapshots } = await renderProvider('user-123');

    expect(mockEnsureDefaultJapam).toHaveBeenCalledTimes(1);
    expect(snapshots.at(-1)?.currentJapamId).toBeNull();

    const authListener = (DeviceEventEmitter.addListener as jest.Mock).mock.calls[0]?.[1] as
      | (() => void)
      | undefined;
    await act(async () => {
      authListener?.();
      await Promise.resolve();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(mockEnsureDefaultJapam).toHaveBeenCalledTimes(2);
    expect(snapshots.at(-1)).toMatchObject({
      currentJapamId: 'retry-canonical',
      japamIds: ['retry-canonical'],
    });
  });

  it('guest refresh remains local-only and does not call ensureDefaultJapam', async () => {
    mockLoadJapams.mockResolvedValue([
      {
        id: 'guest-local',
        userId: null,
        name: 'Guest Japam',
        displayOrder: null,
        createdAt: '2026-07-20T00:00:00.000Z',
        updatedAt: '2026-07-20T00:00:00.000Z',
        archivedAt: null,
      },
    ]);
    mockLoadCurrentJapamId.mockResolvedValue('guest-local');

    const { snapshots } = await renderProvider(null);

    expect(mockEnsureDefaultJapam).not.toHaveBeenCalled();
    expect(mockLoadJapams).toHaveBeenCalledTimes(1);
    expect(snapshots.at(-1)).toMatchObject({
      currentJapamId: 'guest-local',
      currentJapamName: 'Guest Japam',
      japamIds: ['guest-local'],
    });
  });
});
