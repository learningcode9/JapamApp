/* eslint-disable import/first, @typescript-eslint/no-require-imports */

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('@react-native-google-signin/google-signin', () => ({ GoogleSignin: {} }));
jest.mock('expo-auth-session/providers/google', () => ({ useAuthRequest: () => [{}, null, jest.fn()] }));
jest.mock('expo-auth-session', () => ({ ResponseType: { IdToken: 'id_token' } }));
jest.mock('expo-router', () => ({ useFocusEffect: jest.fn() }));
jest.mock('expo-web-browser', () => ({ maybeCompleteAuthSession: jest.fn() }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: jest.fn(() => ({ top: 0, bottom: 0 })) }));
jest.mock('../../contexts/timer-context', () => ({
  LOOP_OPTIONS: [1, 2, 3, 5, 10],
  STD_DURATIONS: [1, 3, 5, 10, 15],
  formatTimer: (seconds: number) => String(seconds),
  useTimer: jest.fn(),
}));
jest.mock('../../contexts/current-japam-context', () => ({ useCurrentJapam: jest.fn() }));
jest.mock('../../components/CurrentJapamHeaderButton', () => 'CurrentJapamHeaderButton');
jest.mock('../../lib/pwaInstall', () => ({
  isIOSDeviceWeb: jest.fn(() => false),
  isStandaloneOrInstalledWeb: jest.fn(() => false),
}));
jest.mock('../../lib/anonymousAuth', () => ({}));
jest.mock('../../lib/supabase', () => ({ supabase: { auth: {} } }));
jest.mock('../../lib/supabaseRestHelper', () => ({ fetchJapamHistoryRows: jest.fn() }));
jest.mock('../../lib/authEvents', () => ({}));
jest.mock('../../constants/assets', () => ({ ZEN_BACKGROUND: '' }));
jest.mock('react-native', () => ({
  DeviceEventEmitter: { addListener: jest.fn() },
  Dimensions: { get: jest.fn(() => ({ width: 390, height: 844 })) },
  Platform: { OS: 'android' },
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));

import {
  isCurrentTimerWorkspaceStatsRequest,
  resolveTimerWorkspaceStats,
  type TimerWorkspaceStatsRequest,
} from '../(tabs)/timer';

const USER_ID = 'user-1';
const TODAY = '2026-08-09';
const JAPAMS = [
  { id: 'workspace-a', userId: USER_ID, name: 'Japam A', syncStatus: 'synced' as const, displayOrder: 0, createdAt: TODAY, updatedAt: TODAY, archivedAt: null },
  { id: 'workspace-b', userId: USER_ID, name: 'Japam B', syncStatus: 'synced' as const, displayOrder: 1, createdAt: TODAY, updatedAt: TODAY, archivedAt: null },
];

const completion = (workspaceId: string, totalCount: number) => ({
  date: `${TODAY}T12:00:00.000Z`,
  malas: Math.floor(totalCount / 108),
  totalCount,
  duration: 0,
  manual: false,
  userId: USER_ID,
  completionId: `${workspaceId}-${totalCount}`,
  syncStatus: 'synced' as const,
  japamId: workspaceId,
  japamName: workspaceId === 'workspace-a' ? 'Japam A' : 'Japam B',
});

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
};

describe('Timer workspace stats local-first generation guard', () => {
  it('A→B applies B local stats while both remote reconciliations remain unresolved', async () => {
    let currentGeneration = 0;
    let activeWorkspaceId = 'workspace-a';
    const applied: { workspaceId: string; total: number }[] = [];
    const remoteA = deferred<ReturnType<typeof completion>[]>();
    const remoteB = deferred<ReturnType<typeof completion>[]>();

    const load = async (
      workspaceId: string,
      local: ReturnType<typeof completion>[],
      remote: Promise<ReturnType<typeof completion>[]>,
    ) => {
      const request: TimerWorkspaceStatsRequest = {
        generation: ++currentGeneration,
        workspaceId,
      };
      const applyIfCurrent = (records: ReturnType<typeof completion>[]) => {
        if (!isCurrentTimerWorkspaceStatsRequest(request, currentGeneration, activeWorkspaceId)) return;
        const stats = resolveTimerWorkspaceStats(records, USER_ID, workspaceId, workspaceId === 'workspace-a' ? 'Japam A' : 'Japam B', JAPAMS, TODAY);
        applied.push({ workspaceId, total: stats.todayTotalCount });
      };

      applyIfCurrent(local);
      applyIfCurrent(await remote);
    };

    const loadA = load('workspace-a', [completion('workspace-a', 216)], remoteA.promise);
    activeWorkspaceId = 'workspace-b';
    const loadB = load('workspace-b', [completion('workspace-b', 108)], remoteB.promise);

    await Promise.resolve();
    expect(applied).toEqual([
      { workspaceId: 'workspace-a', total: 216 },
      { workspaceId: 'workspace-b', total: 108 },
    ]);

    remoteA.resolve([completion('workspace-a', 324)]);
    await Promise.resolve();
    expect(applied).toEqual([
      { workspaceId: 'workspace-a', total: 216 },
      { workspaceId: 'workspace-b', total: 108 },
    ]);

    remoteB.resolve([completion('workspace-b', 216)]);
    await Promise.all([loadA, loadB]);
    expect(applied.at(-1)).toEqual({ workspaceId: 'workspace-b', total: 216 });
  });

  it('B→A rejects a late B result after A becomes active', async () => {
    let currentGeneration = 0;
    let activeWorkspaceId = 'workspace-b';
    const applied: { workspaceId: string; total: number }[] = [];
    const remoteB = deferred<ReturnType<typeof completion>[]>();
    const remoteA = deferred<ReturnType<typeof completion>[]>();

    const load = async (workspaceId: string, local: ReturnType<typeof completion>[], remote: Promise<ReturnType<typeof completion>[]>) => {
      const request: TimerWorkspaceStatsRequest = { generation: ++currentGeneration, workspaceId };
      const applyIfCurrent = (records: ReturnType<typeof completion>[]) => {
        if (!isCurrentTimerWorkspaceStatsRequest(request, currentGeneration, activeWorkspaceId)) return;
        const stats = resolveTimerWorkspaceStats(records, USER_ID, workspaceId, workspaceId === 'workspace-a' ? 'Japam A' : 'Japam B', JAPAMS, TODAY);
        applied.push({ workspaceId, total: stats.todayTotalCount });
      };
      applyIfCurrent(local);
      applyIfCurrent(await remote);
    };

    const loadB = load('workspace-b', [completion('workspace-b', 108)], remoteB.promise);
    activeWorkspaceId = 'workspace-a';
    const loadA = load('workspace-a', [completion('workspace-a', 324)], remoteA.promise);

    await Promise.resolve();
    expect(applied).toEqual([
      { workspaceId: 'workspace-b', total: 108 },
      { workspaceId: 'workspace-a', total: 324 },
    ]);

    remoteB.resolve([completion('workspace-b', 432)]);
    await Promise.resolve();
    expect(applied).toEqual([
      { workspaceId: 'workspace-b', total: 108 },
      { workspaceId: 'workspace-a', total: 324 },
    ]);

    remoteA.resolve([completion('workspace-a', 432)]);
    await Promise.all([loadA, loadB]);
    expect(applied.at(-1)).toEqual({ workspaceId: 'workspace-a', total: 432 });
  });
});
