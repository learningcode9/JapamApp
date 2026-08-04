/* eslint-disable import/first, @typescript-eslint/no-require-imports */
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

const mockHydrateHistoryForUserDetails = jest.fn();

const mockLoadJapams = jest.fn();
const mockLoadCurrentJapamId = jest.fn();
const mockSaveCurrentJapamId = jest.fn();
const mockEnsureDefaultJapam = jest.fn();
const mockReconcileAllJapams = jest.fn();
const mockRestoreJapam = jest.fn();

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

jest.mock('../../lib/historyRepository', () => ({
  hydrateHistoryForUserDetails: (...args: unknown[]) => mockHydrateHistoryForUserDetails(...args),
}));

jest.mock('../../lib/anonymousAuth', () => ({
  LEGACY_USER_ID_KEY: 'legacyUserId',
}));

(global as Record<string, unknown>).window ??= typeof window !== 'undefined'
  ? window
  : { dispatchEvent: jest.fn(), addEventListener: jest.fn(), removeEventListener: jest.fn() };

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

beforeEach(async () => {
  jest.clearAllMocks();
  (Platform as { OS: string }).OS = 'android';
  await AsyncStorage.clear();
  mockHydrateHistoryForUserDetails.mockReset();
  mockLoadJapams.mockReset();
  mockLoadCurrentJapamId.mockReset();
  mockSaveCurrentJapamId.mockReset();
  mockEnsureDefaultJapam.mockReset();
  mockReconcileAllJapams.mockReset();
  mockRestoreJapam.mockReset();
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
    global.window = { addEventListener, removeEventListener, dispatchEvent: jest.fn() } as unknown as Window & typeof globalThis;
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
    mockHydrateHistoryForUserDetails.mockResolvedValue({
      records: [],
      hydrationSucceeded: true,
      localRecordCount: 0,
      hadLocalTombstones: false,
      scopedLocalTombstoneApplied: false,
      localStateAuthoritativelyChanged: false,
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
});

describe('CurrentJapamProvider cold-start history hydration', () => {
  const signedInResult = {
    japams: [
      {
        id: 'canonical',
        userId: 'user-123',
        name: 'My Japam',
        displayOrder: null,
        createdAt: '2026-07-20T00:00:00.000Z',
        updatedAt: '2026-07-20T00:00:00.000Z',
        archivedAt: null,
      },
    ],
    currentJapamId: 'canonical',
    created: null,
  };

  const hydratedSuccessResult = {
    records: [],
    hydrationSucceeded: true,
    localRecordCount: 0,
    hadLocalTombstones: false,
    scopedLocalTombstoneApplied: false,
    localStateAuthoritativelyChanged: false,
  };

  const hydratedFailureResult = {
    records: [],
    hydrationSucceeded: false,
    localRecordCount: 0,
    hadLocalTombstones: false,
    scopedLocalTombstoneApplied: false,
    localStateAuthoritativelyChanged: false,
  };

  it('isLoading remains true until authenticated History hydration finishes', async () => {
    let resolveHydration!: (value: typeof hydratedSuccessResult) => void;
    const deferredHydration = new Promise<typeof hydratedSuccessResult>((resolve) => {
      resolveHydration = resolve;
    });
    mockEnsureDefaultJapam.mockResolvedValue(signedInResult);
    mockHydrateHistoryForUserDetails.mockReturnValue(deferredHydration);

    const { snapshots } = await renderProvider('user-123');

    expect(mockEnsureDefaultJapam).toHaveBeenCalledTimes(1);
    const loadingSnapshots = snapshots.filter((s) => s.isLoading);
    expect(loadingSnapshots.length).toBeGreaterThan(0);

    resolveHydration!(hydratedSuccessResult);
    await flush();

    expect(snapshots.at(-1)?.isLoading).toBe(false);
    expect(mockHydrateHistoryForUserDetails).toHaveBeenCalledWith('user-123', null);
  });

  it('fresh local storage + populated remote History is available before ready state', async () => {
    mockEnsureDefaultJapam.mockResolvedValue(signedInResult);
    mockHydrateHistoryForUserDetails.mockResolvedValue(hydratedSuccessResult);

    const emitSpy = jest.spyOn(DeviceEventEmitter, 'emit');

    await renderProvider('user-123');

    const hydrateCallOrder = mockHydrateHistoryForUserDetails.mock.invocationCallOrder[0];
    const emitCallIndices = Array.from(emitSpy.mock.calls.entries())
      .filter(([, args]) => args[0] === 'japam-stats-updated')
      .map(([i]) => emitSpy.mock.invocationCallOrder[i]);

    expect(hydrateCallOrder).toBeDefined();
    expect(emitCallIndices.length).toBeGreaterThan(0);
    emitCallIndices.forEach((orderIdx) => {
      expect(orderIdx).toBeGreaterThan(hydrateCallOrder);
    });

    emitSpy.mockRestore();
  });

  it('visiting History is not required for other screens to update', async () => {
    mockEnsureDefaultJapam.mockResolvedValue(signedInResult);
    mockHydrateHistoryForUserDetails.mockResolvedValue(hydratedSuccessResult);

    const emitSpy = jest.spyOn(DeviceEventEmitter, 'emit');

    await renderProvider('user-123');

    const statsEvents = emitSpy.mock.calls.filter(([event]) => event === 'japam-stats-updated');
    expect(statsEvents.length).toBeGreaterThanOrEqual(1);

    emitSpy.mockRestore();
  });

  it('no false zero render while hydration is pending', async () => {
    mockEnsureDefaultJapam.mockResolvedValue(signedInResult);
    mockHydrateHistoryForUserDetails.mockResolvedValue(hydratedSuccessResult);

    const { snapshots } = await renderProvider('user-123');

    const lastLoadingIdx = snapshots.findLastIndex((s) => s.isLoading);
    const firstReadyIdx = snapshots.findIndex((s) => !s.isLoading);
    const loadingSnapshots = snapshots.slice(0, firstReadyIdx);
    expect(loadingSnapshots.every((s) => s.isLoading)).toBe(true);
    expect(firstReadyIdx).toBe(lastLoadingIdx + 1);
  });

  it('failed remote hydration preserves local totals', async () => {
    mockEnsureDefaultJapam.mockResolvedValue(signedInResult);
    mockHydrateHistoryForUserDetails.mockResolvedValue(hydratedFailureResult);

    const emitSpy = jest.spyOn(DeviceEventEmitter, 'emit');

    const { snapshots } = await renderProvider('user-123');

    expect(snapshots.at(-1)?.isLoading).toBe(false);
    expect(snapshots.at(-1)?.currentJapamId).toBe('canonical');

    const statsEvents = emitSpy.mock.calls.filter(([event]) => event === 'japam-stats-updated');
    expect(statsEvents.length).toBeGreaterThanOrEqual(1);

    emitSpy.mockRestore();
  });

  it('guest flow remains local-only and does not call hydrateHistoryForUserDetails', async () => {
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
    mockHydrateHistoryForUserDetails.mockResolvedValue(hydratedSuccessResult);

    const { snapshots } = await renderProvider(null);

    expect(mockHydrateHistoryForUserDetails).not.toHaveBeenCalled();
    expect(mockEnsureDefaultJapam).not.toHaveBeenCalled();
    expect(snapshots.at(-1)?.isLoading).toBe(false);
  });

  it('concurrent refreshes dedupe History hydration', async () => {
    let resolveHydration!: (value: typeof hydratedSuccessResult) => void;
    const deferredHydration = new Promise<typeof hydratedSuccessResult>((resolve) => {
      resolveHydration = resolve;
    });
    mockEnsureDefaultJapam.mockResolvedValue(signedInResult);
    mockHydrateHistoryForUserDetails.mockReturnValue(deferredHydration);

    const { snapshots } = await renderProvider('user-123');

    const authListener = (DeviceEventEmitter.addListener as jest.Mock).mock.calls[0]?.[1] as
      | (() => void)
      | undefined;
    expect(authListener).toBeDefined();
    expect(mockHydrateHistoryForUserDetails).toHaveBeenCalledTimes(1);

    await act(async () => {
      authListener?.();
      authListener?.();
      await Promise.resolve();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    resolveHydration!(hydratedSuccessResult);
    await flush();

    expect(mockHydrateHistoryForUserDetails).toHaveBeenCalledTimes(1);
    expect(snapshots.at(-1)?.isLoading).toBe(false);
  });

  describe('identity-switch hydration', () => {
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

    let deferredHydrationA: Promise<void> | undefined;
    let resolveHydrationA!: () => void;
    let deferredHydrationB: Promise<void> | undefined;
    let resolveHydrationB!: () => void;

    const setupSlowHydrationA = () => {
      let aResolve!: () => void;
      deferredHydrationA = new Promise<void>((resolve) => {
        aResolve = resolve;
      });
      resolveHydrationA = aResolve;
      let firstCall = true;
      mockHydrateHistoryForUserDetails.mockImplementation((userId: string) => {
        if (userId === 'A' && firstCall) {
          firstCall = false;
          return deferredHydrationA;
        }
        if (userId === 'B') {
          let bResolve!: () => void;
          deferredHydrationB = new Promise<void>((resolve) => {
            bResolve = resolve;
          });
          resolveHydrationB = bResolve;
          return deferredHydrationB;
        }
        return Promise.resolve(hydratedSuccessResult);
      });
      mockEnsureDefaultJapam.mockImplementation(async (userId: string) => resultFor(userId));
    };

    beforeEach(() => {
      deferredHydrationA = undefined;
      deferredHydrationB = undefined;
    });

    it('A. slow User A hydration -> switch to User B', async () => {
      setupSlowHydrationA();
      const { snapshots } = await renderProvider('A');

      const authListener = (DeviceEventEmitter.addListener as jest.Mock).mock.calls[0]?.[1] as
        | (() => void)
        | undefined;
      expect(authListener).toBeDefined();

      await AsyncStorage.setItem('userId', 'B');
      await act(async () => {
        authListener?.();
        await Promise.resolve();
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      resolveHydrationA!();
      await flush();

      const bCalls = mockHydrateHistoryForUserDetails.mock.calls.filter(
        ([userId]) => userId === 'B',
      );
      expect(bCalls).toHaveLength(1);

      if (resolveHydrationB) {
        resolveHydrationB();
        await flush();
      }

      const finalSnapshot = snapshots.at(-1);
      expect(finalSnapshot?.currentJapamId).toBe('japam-B');
      expect(finalSnapshot?.isLoading).toBe(false);
    });

    it('B. B hydrate called exactly once with B ID', async () => {
      setupSlowHydrationA();
      await renderProvider('A');

      const authListener = (DeviceEventEmitter.addListener as jest.Mock).mock.calls[0]?.[1] as
        | (() => void)
        | undefined;

      await AsyncStorage.setItem('userId', 'B');
      await act(async () => {
        authListener?.();
        await Promise.resolve();
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      resolveHydrationA!();
      await flush();

      const bCalls = mockHydrateHistoryForUserDetails.mock.calls.filter(
        ([userId]) => userId === 'B',
      );
      expect(bCalls).toHaveLength(1);
    });

    it('C. A finishing first does not set final ready state for B', async () => {
      setupSlowHydrationA();
      const { snapshots } = await renderProvider('A');

      const authListener = (DeviceEventEmitter.addListener as jest.Mock).mock.calls[0]?.[1] as
        | (() => void)
        | undefined;

      await AsyncStorage.setItem('userId', 'B');
      await act(async () => {
        authListener?.();
        await Promise.resolve();
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      const snapshotsAfterBStart = [...snapshots];

      resolveHydrationA!();
      await flush();

      const aCompleteSnapshots = snapshots.slice(snapshotsAfterBStart.length);
      const readyFromA = aCompleteSnapshots.find((s) => !s.isLoading);
      expect(readyFromA).toBeUndefined();
    });

    it('D. final stats event belongs to current B hydration', async () => {
      setupSlowHydrationA();
      const emitSpy = jest.spyOn(DeviceEventEmitter, 'emit');

      await renderProvider('A');

      const authListener = (DeviceEventEmitter.addListener as jest.Mock).mock.calls[0]?.[1] as
        | (() => void)
        | undefined;

      await AsyncStorage.setItem('userId', 'B');
      await act(async () => {
        authListener?.();
        await Promise.resolve();
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      const emitCallCountBefore = emitSpy.mock.calls.length;

      resolveHydrationA!();
      await flush();

      const emitAfterAComplete = emitSpy.mock.calls
        .slice(emitCallCountBefore)
        .filter(([event]) => event === 'japam-stats-updated');
      expect(emitAfterAComplete.length).toBe(0);

      const bCalls = mockHydrateHistoryForUserDetails.mock.calls.filter(
        ([userId]) => userId === 'B',
      );
      expect(bCalls).toHaveLength(1);

      emitSpy.mockRestore();
    });

    it('E. rapid same-user refresh still dedupes', async () => {
      mockEnsureDefaultJapam.mockImplementation(async (userId: string) => resultFor(userId));
      let hydrationResolve!: () => void;
      const deferredHydration = new Promise<void>((resolve) => {
        hydrationResolve = resolve;
      });
      mockHydrateHistoryForUserDetails.mockReturnValue(
        deferredHydration.then(() => hydratedSuccessResult),
      );

      await renderProvider('B');

      const authListener = (DeviceEventEmitter.addListener as jest.Mock).mock.calls[0]?.[1] as
        | (() => void)
        | undefined;

      await act(async () => {
        authListener?.();
        authListener?.();
        await Promise.resolve();
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      hydrationResolve!();
      await flush();

      expect(mockHydrateHistoryForUserDetails).toHaveBeenCalledTimes(1);
    });
  });

  describe('hydration cleanup guards', () => {
    it('A. failed hydration -> later same-user refresh invokes hydration again', async () => {
      mockEnsureDefaultJapam.mockImplementation(async (userId: string) => ({
        japams: [
          {
            id: 'retry-1',
            userId,
            name: 'Japam',
            displayOrder: null,
            createdAt: '2026-07-20T00:00:00.000Z',
            updatedAt: '2026-07-20T00:00:00.000Z',
            archivedAt: null,
          },
        ],
        currentJapamId: 'retry-1',
        created: null,
      }));

      mockHydrateHistoryForUserDetails
        .mockRejectedValueOnce(new Error('network'))
        .mockResolvedValue(hydratedSuccessResult);

      const { snapshots } = await renderProvider('B');
      expect(snapshots.at(-1)?.isLoading).toBe(false);

      const authListener = (DeviceEventEmitter.addListener as jest.Mock).mock.calls[0]?.[1] as
        | (() => void)
        | undefined;

      await act(async () => {
        authListener?.();
        await Promise.resolve();
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(mockHydrateHistoryForUserDetails).toHaveBeenCalledTimes(2);
    });

    it('B. successful hydration -> later auth refresh is allowed to call hydration again', async () => {
      mockEnsureDefaultJapam.mockImplementation(async (userId: string) => ({
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
      }));
      mockHydrateHistoryForUserDetails.mockResolvedValue(hydratedSuccessResult);

      const { snapshots } = await renderProvider('B');
      expect(snapshots.at(-1)?.isLoading).toBe(false);

      const authListener = (DeviceEventEmitter.addListener as jest.Mock).mock.calls[0]?.[1] as
        | (() => void)
        | undefined;

      await act(async () => {
        authListener?.();
        await Promise.resolve();
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(mockHydrateHistoryForUserDetails).toHaveBeenCalledTimes(2);
    });

    it('C. A completes while B pending -> A does not clear B entry', async () => {
      let resolveA!: () => void;
      const deferredA = new Promise<void>((resolve) => {
        resolveA = resolve;
      });
      let resolveB!: () => void;
      const deferredB = new Promise<void>((resolve) => {
        resolveB = resolve;
      });

      let aFirstCall = true;
      mockHydrateHistoryForUserDetails.mockImplementation((userId: string) => {
        if (userId === 'A' && aFirstCall) {
          aFirstCall = false;
          return deferredA.then(() => hydratedSuccessResult);
        }
        if (userId === 'B') {
          return deferredB.then(() => hydratedSuccessResult);
        }
        return Promise.resolve(hydratedSuccessResult);
      });

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

      await renderProvider('A');

      const authListener = (DeviceEventEmitter.addListener as jest.Mock).mock.calls[0]?.[1] as
        | (() => void)
        | undefined;

      await AsyncStorage.setItem('userId', 'B');
      await act(async () => {
        authListener?.();
        await Promise.resolve();
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      const callCountBeforeAResolves = mockHydrateHistoryForUserDetails.mock.calls.length;

      resolveA();
      await flush();

      expect(mockHydrateHistoryForUserDetails.mock.calls.length).toBe(callCountBeforeAResolves);

      resolveB();
      await flush();
    });

    it('D. B still completes, emits one stats event, and sets ready', async () => {
      let resolveA!: () => void;
      const deferredA = new Promise<void>((resolve) => {
        resolveA = resolve;
      });
      let resolveB!: () => void;
      const deferredB = new Promise<void>((resolve) => {
        resolveB = resolve;
      });

      let aFirstCall = true;
      mockHydrateHistoryForUserDetails.mockImplementation((userId: string) => {
        if (userId === 'A' && aFirstCall) {
          aFirstCall = false;
          return deferredA.then(() => hydratedSuccessResult);
        }
        if (userId === 'B') {
          return deferredB.then(() => hydratedSuccessResult);
        }
        return Promise.resolve(hydratedSuccessResult);
      });

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

      const emitSpy = jest.spyOn(DeviceEventEmitter, 'emit');
      const { snapshots } = await renderProvider('A');

      const authListener = (DeviceEventEmitter.addListener as jest.Mock).mock.calls[0]?.[1] as
        | (() => void)
        | undefined;

      await AsyncStorage.setItem('userId', 'B');
      await act(async () => {
        authListener?.();
        await Promise.resolve();
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      resolveA();
      await flush();

      resolveB();
      await flush();

      const statsAfterBStart = emitSpy.mock.calls.filter(
        ([event]) => event === 'japam-stats-updated',
      );
      expect(statsAfterBStart.length).toBe(1);

      const finalSnapshot = snapshots.at(-1);
      expect(finalSnapshot?.isLoading).toBe(false);
      expect(finalSnapshot?.currentJapamId).toBe('japam-B');

      emitSpy.mockRestore();
    });

    it('E. same-user refreshes while the promise is pending still dedupe', async () => {
      let hydrationResolve!: () => void;
      const deferredHydration = new Promise<void>((resolve) => {
        hydrationResolve = resolve;
      });

      mockHydrateHistoryForUserDetails.mockReturnValue(
        deferredHydration.then(() => hydratedSuccessResult),
      );
      mockEnsureDefaultJapam.mockImplementation(async (userId: string) => ({
        japams: [
          {
            id: 'dedupe-cleanup',
            userId,
            name: 'Japam',
            displayOrder: null,
            createdAt: '2026-07-20T00:00:00.000Z',
            updatedAt: '2026-07-20T00:00:00.000Z',
            archivedAt: null,
          },
        ],
        currentJapamId: 'dedupe-cleanup',
        created: null,
      }));

      await renderProvider('B');

      const authListener = (DeviceEventEmitter.addListener as jest.Mock).mock.calls[0]?.[1] as
        | (() => void)
        | undefined;

      await act(async () => {
        authListener?.();
        authListener?.();
        await Promise.resolve();
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      hydrationResolve!();
      await flush();

      expect(mockHydrateHistoryForUserDetails).toHaveBeenCalledTimes(1);
    });
  });

  describe('B→A→B stale-entry race', () => {
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

    let resolveHydrationB1!: () => void;
    let resolveHydrationB2!: () => void;
    let bCallCount = 0;

    const setupBABA = () => {
      bCallCount = 0;
      let aResolveB1!: () => void;
      const deferredB1 = new Promise<void>((resolve) => {
        aResolveB1 = resolve;
      });
      resolveHydrationB1 = aResolveB1;

      let aResolveB2!: () => void;
      const deferredB2 = new Promise<void>((resolve) => {
        aResolveB2 = resolve;
      });
      resolveHydrationB2 = aResolveB2;

      mockHydrateHistoryForUserDetails.mockImplementation((userId: string) => {
        if (userId === 'B') {
          bCallCount++;
          if (bCallCount === 1) {
            return deferredB1.then(() => hydratedSuccessResult);
          }
          return deferredB2.then(() => hydratedSuccessResult);
        }
        return Promise.resolve(hydratedSuccessResult);
      });

      mockEnsureDefaultJapam.mockImplementation(async (userId: string) => resultFor(userId));
    };

    it('old B hydration-1 completing does not finalize B state when B hydration-2 is current', async () => {
      setupBABA();
      const emitSpy = jest.spyOn(DeviceEventEmitter, 'emit');
      const { snapshots } = await renderProvider('B');

      const authListener = (DeviceEventEmitter.addListener as jest.Mock).mock.calls[0]?.[1] as
        | (() => void)
        | undefined;
      expect(authListener).toBeDefined();

      await AsyncStorage.setItem('userId', 'A');
      await act(async () => {
        authListener?.();
        await Promise.resolve();
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      await AsyncStorage.setItem('userId', 'B');
      await act(async () => {
        authListener?.();
        await Promise.resolve();
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      const emitBeforeB1Resolve = emitSpy.mock.calls.filter(
        ([event]) => event === 'japam-stats-updated',
      ).length;

      resolveHydrationB1();
      await flush();

      const emitAfterB1 = emitSpy.mock.calls.filter(
        ([event]) => event === 'japam-stats-updated',
      ).length;
      expect(emitAfterB1).toBe(emitBeforeB1Resolve);

      const lastAfterB1 = snapshots.at(-1);
      expect(lastAfterB1?.isLoading).toBe(true);

      resolveHydrationB2();
      await flush();

      const emitAfterB2 = emitSpy.mock.calls.filter(
        ([event]) => event === 'japam-stats-updated',
      ).length;
      expect(emitAfterB2).toBe(emitAfterB1 + 1);

      const finalSnapshot = snapshots.at(-1);
      expect(finalSnapshot?.isLoading).toBe(false);
      expect(finalSnapshot?.currentJapamId).toBe('japam-B');

      emitSpy.mockRestore();
    });

    it('B hydration-2 entry remains intact after old B hydration-1 resolves', async () => {
      setupBABA();

      await renderProvider('B');

      const authListener = (DeviceEventEmitter.addListener as jest.Mock).mock.calls[0]?.[1] as
        | (() => void)
        | undefined;

      await AsyncStorage.setItem('userId', 'A');
      await act(async () => {
        authListener?.();
        await Promise.resolve();
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      await AsyncStorage.setItem('userId', 'B');
      await act(async () => {
        authListener?.();
        await Promise.resolve();
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      const callCountBeforeB1 = mockHydrateHistoryForUserDetails.mock.calls.length;

      resolveHydrationB1();
      await flush();

      expect(mockHydrateHistoryForUserDetails.mock.calls.length).toBe(callCountBeforeB1);

      resolveHydrationB2();
      await flush();
    });

    it('after B→A→B full sequence, retry invokes hydration again', async () => {
      setupBABA();

      const { snapshots } = await renderProvider('B');

      const authListener = (DeviceEventEmitter.addListener as jest.Mock).mock.calls[0]?.[1] as
        | (() => void)
        | undefined;

      await AsyncStorage.setItem('userId', 'A');
      await act(async () => {
        authListener?.();
        await Promise.resolve();
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      await AsyncStorage.setItem('userId', 'B');
      await act(async () => {
        authListener?.();
        await Promise.resolve();
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      resolveHydrationB1();
      await flush();
      resolveHydrationB2();
      await flush();

      expect(snapshots.at(-1)?.isLoading).toBe(false);

      mockHydrateHistoryForUserDetails.mockResolvedValue(hydratedSuccessResult);

      await act(async () => {
        authListener?.();
        await Promise.resolve();
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await flush();

      const bCallsAfterRetry = mockHydrateHistoryForUserDetails.mock.calls.filter(
        ([userId]) => userId === 'B',
      ).length;
      expect(bCallsAfterRetry).toBeGreaterThanOrEqual(3);
    });
  });
});
