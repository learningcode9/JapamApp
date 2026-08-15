/* eslint-disable import/first, @typescript-eslint/no-require-imports */
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

const mockLoadJapams = jest.fn();
const mockLoadCurrentJapamId = jest.fn();
const mockSaveCurrentJapamId = jest.fn();
const mockEnsureDefaultJapam = jest.fn();
const mockReconcileAllJapams = jest.fn();
const mockRestoreJapam = jest.fn();
const mockLoadLocalJapams = jest.fn();
const mockLoadLocalCurrentJapamId = jest.fn();

jest.mock('../../lib/japamsRepository', () => ({
  loadJapams: (...args: unknown[]) => mockLoadJapams(...args),
  loadCurrentJapamId: (...args: unknown[]) => mockLoadCurrentJapamId(...args),
  saveCurrentJapamId: (...args: unknown[]) => mockSaveCurrentJapamId(...args),
  ensureDefaultJapam: (...args: unknown[]) => mockEnsureDefaultJapam(...args),
  reconcileAllJapams: (...args: unknown[]) => mockReconcileAllJapams(...args),
  createJapam: jest.fn(),
  renameJapam: jest.fn(),
  archiveJapam: jest.fn(),
  restoreJapam: (...args: unknown[]) => mockRestoreJapam(...args),
  deleteJapam: jest.fn(),
}));

jest.mock('../../lib/japamsStorage', () => ({
  loadJapams: (...args: unknown[]) => mockLoadLocalJapams(...args),
  loadCurrentJapamId: (...args: unknown[]) => mockLoadLocalCurrentJapamId(...args),
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
import { DeviceEventEmitter, Platform } from 'react-native';
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

const Control = ({
  onReady,
}: {
  onReady: (value: ReturnType<typeof useCurrentJapam>) => void;
}) => {
  const value = useCurrentJapam();

  React.useEffect(() => {
    onReady(value);
  }, [onReady, value]);

  return null;
};

const renderProvider = async (
  userId: string | null,
  onReady?: (value: ReturnType<typeof useCurrentJapam>) => void,
  options: { clearStorage?: boolean } = {},
) => {
  const snapshots: Snapshot[] = [];
  if (options.clearStorage !== false) {
    await AsyncStorage.clear();
  }
  if (userId !== null) {
    await AsyncStorage.setItem('userId', userId);
  }

  await act(async () => {
    renderer.create(
      React.createElement(
        CurrentJapamProvider,
        null,
        React.createElement(React.Fragment, null,
          React.createElement(Capture, {
            onSnapshot: (snapshot: Snapshot) => {
              snapshots.push(snapshot);
            },
          }),
          onReady
            ? React.createElement(Control, {
                onReady,
              })
            : null,
        ),
      ),
    );
    await Promise.resolve();
  });
  await flush();
  await flush();

  return { snapshots };
};

const makeJapam = (id: string, userId = 'user-123') => ({
  id,
  userId,
  name: `Japam ${id}`,
  displayOrder: null,
  createdAt: '2026-07-20T00:00:00.000Z',
  updatedAt: '2026-07-20T00:00:00.000Z',
  archivedAt: null,
});

const makeReconcileResult = (
  japams: ReturnType<typeof makeJapam>[],
  currentJapamId: string | null,
) => ({ japams, currentJapamId, created: null });

beforeEach(async () => {
  jest.clearAllMocks();
  (Platform as { OS: string }).OS = 'android';
  await AsyncStorage.clear();
  mockLoadJapams.mockReset();
  mockLoadCurrentJapamId.mockReset();
  mockSaveCurrentJapamId.mockReset();
  mockEnsureDefaultJapam.mockReset();
  mockReconcileAllJapams.mockReset();
  mockRestoreJapam.mockReset();
  mockLoadJapams.mockResolvedValue([]);
  mockLoadCurrentJapamId.mockResolvedValue(null);
  mockLoadLocalJapams.mockReset();
  mockLoadLocalCurrentJapamId.mockReset();
  mockLoadLocalJapams.mockResolvedValue([]);
  mockLoadLocalCurrentJapamId.mockResolvedValue(null);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('CurrentJapamProvider refresh', () => {
  it('handles one logical web auth event through only the canonical window listener', async () => {
    const originalWindow = global.window;
    let webAuthHandler: (() => void) | undefined;
    const addEventListener = jest.fn((event: string, handler: () => void) => {
      if (event === 'japam-auth-updated') webAuthHandler = handler;
    });
    const removeEventListener = jest.fn();
    (Platform as { OS: string }).OS = 'web';
    global.window = { addEventListener, removeEventListener } as unknown as Window & typeof globalThis;
    mockEnsureDefaultJapam.mockResolvedValue({
      japams: [
        {
          id: 'web-current',
          userId: 'user-123',
          name: 'My Japam',
          displayOrder: null,
          createdAt: '2026-07-20T00:00:00.000Z',
          updatedAt: '2026-07-20T00:00:00.000Z',
          archivedAt: null,
        },
      ],
      currentJapamId: 'web-current',
      created: null,
    });

    try {
      await renderProvider('user-123');
      expect(DeviceEventEmitter.addListener).not.toHaveBeenCalledWith(
        'japam-auth-updated',
        expect.any(Function),
      );
      expect(addEventListener).toHaveBeenCalledTimes(1);
      expect(mockEnsureDefaultJapam).toHaveBeenCalledTimes(1);

      await act(async () => {
        webAuthHandler?.();
        await Promise.resolve();
      });
      await flush();

      expect(mockEnsureDefaultJapam).toHaveBeenCalledTimes(2);
    } finally {
      global.window = originalWindow;
      (Platform as { OS: string }).OS = 'android';
    }
  });

  it('preserves sequential A to B to A account reconciliation', async () => {
    const resultFor = (userId: string) => ({
      japams: [
        {
          id: `japam-${userId}`,
          userId,
          name: `Japam ${userId}`,
          displayOrder: null,
          createdAt: '2026-07-20T00:00:00.000Z',
          updatedAt: '2026-07-20T00:00:00.000Z',
          archivedAt: null,
        },
      ],
      currentJapamId: `japam-${userId}`,
      created: null,
    });
    mockEnsureDefaultJapam.mockImplementation(async (userId: string) => resultFor(userId));

    const { snapshots } = await renderProvider('A');
    const authListener = (DeviceEventEmitter.addListener as jest.Mock).mock.calls[0]?.[1] as
      | (() => void)
      | undefined;

    await AsyncStorage.setItem('userId', 'B');
    await act(async () => {
      authListener?.();
      await Promise.resolve();
    });
    await flush();
    expect(snapshots.at(-1)?.currentJapamId).toBe('japam-B');

    await AsyncStorage.setItem('userId', 'A');
    await act(async () => {
      authListener?.();
      await Promise.resolve();
    });
    await flush();

    expect(mockEnsureDefaultJapam.mock.calls.map(([userId]) => userId)).toEqual(['A', 'B', 'A']);
    expect(snapshots.at(-1)?.currentJapamId).toBe('japam-A');
  });

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

  it('restore makes the canonical Japam current so a fresh refresh reopens it', async () => {
    mockEnsureDefaultJapam.mockResolvedValue({
      japams: [
        {
          id: 'restored-canonical',
          userId: 'user-123',
          name: 'My Japam',
          displayOrder: null,
          createdAt: '2026-07-19T00:00:00.000Z',
          updatedAt: '2026-07-20T00:00:00.000Z',
          archivedAt: '2026-07-22T00:00:00.000Z',
        },
      ],
      currentJapamId: null,
      created: null,
    });
    mockRestoreJapam.mockResolvedValue([
      {
        id: 'restored-canonical',
        userId: 'user-123',
        name: 'My Japam',
        displayOrder: null,
        createdAt: '2026-07-19T00:00:00.000Z',
        updatedAt: '2026-07-23T00:00:00.000Z',
        archivedAt: null,
      },
    ]);

    let api: ReturnType<typeof useCurrentJapam> | null = null;
    const first = await renderProvider('user-123', (value) => {
      api = value;
    });

    await act(async () => {
      await api!.restoreJapam('restored-canonical');
      await Promise.resolve();
    });

    expect(mockRestoreJapam).toHaveBeenCalledWith('user-123', 'restored-canonical');
    expect(mockSaveCurrentJapamId).toHaveBeenCalledWith('user-123', 'restored-canonical');
    expect(first.snapshots.at(-1)).toMatchObject({
      currentJapamId: 'restored-canonical',
      japamIds: ['restored-canonical'],
    });

    mockEnsureDefaultJapam.mockResolvedValue({
      japams: [
        {
          id: 'restored-canonical',
          userId: 'user-123',
          name: 'My Japam',
          displayOrder: null,
          createdAt: '2026-07-19T00:00:00.000Z',
          updatedAt: '2026-07-23T00:00:00.000Z',
          archivedAt: null,
        },
      ],
      currentJapamId: 'restored-canonical',
      created: null,
    });

    const second = await renderProvider('user-123', undefined, { clearStorage: false });
    expect(second.snapshots.at(-1)).toMatchObject({
      currentJapamId: 'restored-canonical',
      japamIds: ['restored-canonical'],
    });
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

  it('signed-in offline startup resolves immediately from the local cache while the remote reconcile is pending', async () => {
    mockLoadLocalJapams.mockResolvedValue([
      {
        id: 'cached-japam',
        userId: 'user-123',
        name: 'Cached Japam',
        displayOrder: null,
        createdAt: '2026-07-20T00:00:00.000Z',
        updatedAt: '2026-07-20T00:00:00.000Z',
        archivedAt: null,
      },
    ]);
    mockLoadLocalCurrentJapamId.mockResolvedValue('cached-japam');
    mockLoadJapams.mockImplementation(() => new Promise(() => {}));
    mockLoadCurrentJapamId.mockImplementation(() => new Promise(() => {}));
    mockEnsureDefaultJapam.mockImplementation(() => new Promise(() => {}));

    const { snapshots } = await renderProvider('user-123');

    expect(mockLoadJapams).not.toHaveBeenCalled();
    expect(mockLoadCurrentJapamId).not.toHaveBeenCalled();
    expect(mockLoadLocalJapams).toHaveBeenCalledWith('user-123');
    expect(mockLoadLocalCurrentJapamId).toHaveBeenCalledWith('user-123');
    expect(mockEnsureDefaultJapam).toHaveBeenCalledTimes(1);
    expect(snapshots.at(-1)).toMatchObject({
      isLoading: false,
      currentJapamId: 'cached-japam',
      currentJapamName: 'Cached Japam',
      japamIds: ['cached-japam'],
    });
  });

  it('does not expose null when a same-user local selection misses before reconciliation confirms it', async () => {
    const workspaceA = makeJapam('workspace-a');
    const reconcileResult = makeReconcileResult([workspaceA], 'workspace-a');
    mockLoadLocalJapams.mockResolvedValue([workspaceA]);
    mockLoadLocalCurrentJapamId.mockResolvedValue('workspace-a');
    mockEnsureDefaultJapam.mockResolvedValue(reconcileResult);

    const { snapshots } = await renderProvider('user-123');
    const snapshotsBeforeRefresh = snapshots.length;
    const authListener = (DeviceEventEmitter.addListener as jest.Mock).mock.calls[0]?.[1] as
      | (() => void)
      | undefined;

    mockLoadLocalJapams.mockResolvedValue([]);
    mockLoadLocalCurrentJapamId.mockResolvedValue(null);
    mockEnsureDefaultJapam.mockResolvedValue(reconcileResult);
    await act(async () => {
      authListener?.();
      await Promise.resolve();
    });
    await flush();

    expect(snapshots.slice(snapshotsBeforeRefresh).map((snapshot) => snapshot.currentJapamId))
      .not.toContain(null);
    expect(snapshots.at(-1)?.currentJapamId).toBe('workspace-a');
  });

  it('allows null after reconciliation confirms there are no active Japams', async () => {
    const workspaceA = makeJapam('workspace-a');
    mockLoadLocalJapams.mockResolvedValue([workspaceA]);
    mockLoadLocalCurrentJapamId.mockResolvedValue('workspace-a');
    mockEnsureDefaultJapam.mockResolvedValue(makeReconcileResult([workspaceA], 'workspace-a'));

    const { snapshots } = await renderProvider('user-123');
    const snapshotsBeforeRefresh = snapshots.length;
    const authListener = (DeviceEventEmitter.addListener as jest.Mock).mock.calls[0]?.[1] as
      | (() => void)
      | undefined;

    mockLoadLocalJapams.mockResolvedValue([]);
    mockLoadLocalCurrentJapamId.mockResolvedValue(null);
    mockEnsureDefaultJapam.mockResolvedValue(makeReconcileResult([], null));
    await act(async () => {
      authListener?.();
      await Promise.resolve();
    });
    await flush();

    expect(snapshots.slice(snapshotsBeforeRefresh).map((snapshot) => snapshot.currentJapamId))
      .toContain(null);
    expect(snapshots.at(-1)?.currentJapamId).toBeNull();
  });

  it('clears the selection on logout', async () => {
    const workspaceA = makeJapam('workspace-a');
    mockLoadLocalJapams.mockResolvedValue([workspaceA]);
    mockLoadLocalCurrentJapamId.mockResolvedValue('workspace-a');
    mockEnsureDefaultJapam.mockResolvedValue(makeReconcileResult([workspaceA], 'workspace-a'));

    const { snapshots } = await renderProvider('user-123');
    const authListener = (DeviceEventEmitter.addListener as jest.Mock).mock.calls[0]?.[1] as
      | (() => void)
      | undefined;
    await AsyncStorage.removeItem('userId');

    await act(async () => {
      authListener?.();
      await Promise.resolve();
    });
    await flush();

    expect(snapshots.at(-1)?.currentJapamId).toBeNull();
    expect(mockEnsureDefaultJapam).toHaveBeenCalledTimes(1);
  });

  it('does not inherit a previous selection for a different user', async () => {
    const workspaceA = makeJapam('workspace-a', 'user-a');
    const workspaceB = makeJapam('workspace-b', 'user-b');
    mockLoadLocalJapams.mockResolvedValue([workspaceA]);
    mockLoadLocalCurrentJapamId.mockResolvedValue('workspace-a');
    mockEnsureDefaultJapam.mockResolvedValue(makeReconcileResult([workspaceA], 'workspace-a'));

    const { snapshots } = await renderProvider('user-a');
    const snapshotsBeforeRefresh = snapshots.length;
    const authListener = (DeviceEventEmitter.addListener as jest.Mock).mock.calls[0]?.[1] as
      | (() => void)
      | undefined;
    await AsyncStorage.setItem('userId', 'user-b');
    mockLoadLocalJapams.mockResolvedValue([]);
    mockLoadLocalCurrentJapamId.mockResolvedValue(null);
    mockEnsureDefaultJapam.mockResolvedValue(makeReconcileResult([workspaceB], 'workspace-b'));

    await act(async () => {
      authListener?.();
      await Promise.resolve();
    });
    await flush();

    const settledSnapshots = snapshots.slice(snapshotsBeforeRefresh)
      .filter((snapshot) => !snapshot.isLoading);
    expect(settledSnapshots.map((snapshot) => snapshot.currentJapamId))
      .not.toContain('workspace-a');
    expect(snapshots.at(-1)?.currentJapamId).toBe('workspace-b');
  });

  it('keeps an explicit selection made during reconciliation', async () => {
    const workspaceA = makeJapam('workspace-a');
    let resolveEnsure!: (value: ReturnType<typeof makeReconcileResult>) => void;
    const deferred = new Promise<ReturnType<typeof makeReconcileResult>>((resolve) => {
      resolveEnsure = resolve;
    });
    mockLoadLocalJapams.mockResolvedValue([workspaceA]);
    mockLoadLocalCurrentJapamId.mockResolvedValue('workspace-a');
    mockEnsureDefaultJapam.mockReturnValue(deferred);

    let api: ReturnType<typeof useCurrentJapam> | null = null;
    const { snapshots } = await renderProvider('user-123', (value) => {
      api = value;
    });
    const authListener = (DeviceEventEmitter.addListener as jest.Mock).mock.calls[0]?.[1] as
      | (() => void)
      | undefined;
    mockLoadLocalJapams.mockResolvedValue([]);
    mockLoadLocalCurrentJapamId.mockResolvedValue(null);

    await act(async () => {
      authListener?.();
      await Promise.resolve();
      api!.selectJapam('explicit-choice');
      await Promise.resolve();
    });
    resolveEnsure!(makeReconcileResult([workspaceA], 'workspace-a'));
    await flush();

    expect(snapshots.at(-1)?.currentJapamId).toBe('explicit-choice');
  });

  it('a selection made while the startup reconcile is pending is never reverted by its late result', async () => {
    let resolveEnsure!: (value: {
      japams: { id: string; userId: string; name: string; displayOrder: null; createdAt: string; updatedAt: string; archivedAt: null }[];
      currentJapamId: string | null;
      created: null;
    }) => void;
    const deferred = new Promise<{
      japams: { id: string; userId: string; name: string; displayOrder: null; createdAt: string; updatedAt: string; archivedAt: null }[];
      currentJapamId: string | null;
      created: null;
    }>((resolve) => {
      resolveEnsure = resolve;
    });
    mockLoadLocalJapams.mockResolvedValue([
      {
        id: 'cached-japam',
        userId: 'user-123',
        name: 'Cached Japam',
        displayOrder: null,
        createdAt: '2026-07-20T00:00:00.000Z',
        updatedAt: '2026-07-20T00:00:00.000Z',
        archivedAt: null,
      },
    ]);
    mockLoadLocalCurrentJapamId.mockResolvedValue('cached-japam');
    mockEnsureDefaultJapam.mockReturnValue(deferred as unknown as Promise<unknown>);

    let api: ReturnType<typeof useCurrentJapam> | null = null;
    const { snapshots } = await renderProvider('user-123', (value) => {
      api = value;
    });

    await act(async () => {
      api!.selectJapam('user-choice');
      await Promise.resolve();
    });
    expect(snapshots.at(-1)?.currentJapamId).toBe('user-choice');

    resolveEnsure!({
      japams: [{
        id: 'reconcile-result',
        userId: 'user-123',
        name: 'Reconcile Japam',
        displayOrder: null,
        createdAt: '2026-07-20T00:00:00.000Z',
        updatedAt: '2026-07-20T00:00:00.000Z',
        archivedAt: null,
      }],
      currentJapamId: 'reconcile-result',
      created: null,
    });
    await flush();

    expect(snapshots.at(-1)).toMatchObject({
      currentJapamId: 'user-choice',
      japamIds: ['reconcile-result'],
    });
  });

  it('an older shared reconciliation cannot overwrite a selection before a newer refresh', async () => {
    let resolveEnsure!: (value: {
      japams: { id: string; userId: string; name: string; displayOrder: null; createdAt: string; updatedAt: string; archivedAt: null }[];
      currentJapamId: string | null;
      created: null;
    }) => void;
    const deferred = new Promise<{
      japams: { id: string; userId: string; name: string; displayOrder: null; createdAt: string; updatedAt: string; archivedAt: null }[];
      currentJapamId: string | null;
      created: null;
    }>((resolve) => {
      resolveEnsure = resolve;
    });
    mockLoadLocalJapams.mockResolvedValue([
      {
        id: 'cached-japam',
        userId: 'user-123',
        name: 'Cached Japam',
        displayOrder: null,
        createdAt: '2026-07-20T00:00:00.000Z',
        updatedAt: '2026-07-20T00:00:00.000Z',
        archivedAt: null,
      },
    ]);
    mockLoadLocalCurrentJapamId.mockResolvedValue('cached-japam');
    mockEnsureDefaultJapam.mockReturnValue(deferred as unknown as Promise<unknown>);

    let api: ReturnType<typeof useCurrentJapam> | null = null;
    const { snapshots } = await renderProvider('user-123', (value) => {
      api = value;
    });
    const authListener = (DeviceEventEmitter.addListener as jest.Mock).mock.calls[0]?.[1] as
      | (() => void)
      | undefined;

    await act(async () => {
      api!.selectJapam('user-choice');
      await Promise.resolve();
      authListener?.();
      await Promise.resolve();
    });
    await flush();

    expect(mockEnsureDefaultJapam).toHaveBeenCalledTimes(1);

    resolveEnsure!({
      japams: [{
        id: 'old-reconcile-result',
        userId: 'user-123',
        name: 'Old Reconcile Japam',
        displayOrder: null,
        createdAt: '2026-07-20T00:00:00.000Z',
        updatedAt: '2026-07-20T00:00:00.000Z',
        archivedAt: null,
      }],
      currentJapamId: 'old-reconcile-result',
      created: null,
    });
    await flush();

    expect(snapshots.at(-1)).toMatchObject({
      currentJapamId: 'user-choice',
      japamIds: ['old-reconcile-result'],
    });
  });

  it('a newer account refresh cannot be overwritten by an older reconciliation result', async () => {
    let resolveOld!: (value: unknown) => void;
    let resolveNew!: (value: unknown) => void;
    const oldReconcile = new Promise((resolve) => { resolveOld = resolve; });
    const newReconcile = new Promise((resolve) => { resolveNew = resolve; });
    mockEnsureDefaultJapam
      .mockReturnValueOnce(oldReconcile)
      .mockReturnValueOnce(newReconcile);

    const { snapshots } = await renderProvider('user-old');
    const authListener = (DeviceEventEmitter.addListener as jest.Mock).mock.calls[0]?.[1] as
      | (() => void)
      | undefined;
    await AsyncStorage.setItem('userId', 'user-new');
    await act(async () => {
      authListener?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    resolveNew!({
      japams: [{
        id: 'new-result',
        userId: 'user-new',
        name: 'New Japam',
        displayOrder: null,
        createdAt: '2026-07-20T00:00:00.000Z',
        updatedAt: '2026-07-20T00:00:00.000Z',
        archivedAt: null,
      }],
      currentJapamId: 'new-result',
      created: null,
    });
    await flush();
    resolveOld!({
      japams: [{
        id: 'old-result',
        userId: 'user-old',
        name: 'Old Japam',
        displayOrder: null,
        createdAt: '2026-07-20T00:00:00.000Z',
        updatedAt: '2026-07-20T00:00:00.000Z',
        archivedAt: null,
      }],
      currentJapamId: 'old-result',
      created: null,
    });
    await flush();

    expect(snapshots.at(-1)).toMatchObject({
      currentJapamId: 'new-result',
      japamIds: ['new-result'],
    });
  });
});
