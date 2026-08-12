import { computeTapTransition } from '../tapJapamBehavior';
import {
  createTapWorkspaceSwitchCoordinator,
  rememberTapWorkspaceProgress,
  restoreTapWorkspaceProgress,
} from '../tapJapamWorkspace';

const tap = (
  progressByWorkspace: Map<string | null, ReturnType<typeof restoreTapWorkspaceProgress>>,
  japamId: string,
  taps: number,
) => {
  let total = restoreTapWorkspaceProgress(progressByWorkspace, japamId).total;
  for (let index = 0; index < taps; index += 1) {
    total = computeTapTransition(total).nextTotal;
  }
  return rememberTapWorkspaceProgress(progressByWorkspace, japamId, total);
};

describe('Tap Japam workspace progress restore', () => {
  it('restores A 47 → B 0 → A 47', () => {
    const progressByWorkspace = new Map();

    expect(tap(progressByWorkspace, 'workspace-a', 47)).toMatchObject({ total: 47, count: 47, malas: 0 });
    expect(restoreTapWorkspaceProgress(progressByWorkspace, 'workspace-b')).toMatchObject({ total: 0, count: 0, malas: 0 });
    expect(restoreTapWorkspaceProgress(progressByWorkspace, 'workspace-a')).toMatchObject({ total: 47, count: 47, malas: 0 });
  });

  it('restores A 47 → B 23 → A 47 → B 23', () => {
    const progressByWorkspace = new Map();

    tap(progressByWorkspace, 'workspace-a', 47);
    tap(progressByWorkspace, 'workspace-b', 23);

    expect(restoreTapWorkspaceProgress(progressByWorkspace, 'workspace-a')).toMatchObject({ total: 47, count: 47, malas: 0 });
    expect(restoreTapWorkspaceProgress(progressByWorkspace, 'workspace-b')).toMatchObject({ total: 23, count: 23, malas: 0 });
  });

  it('keeps 108 taps as one mala in the reached workspace', () => {
    const progressByWorkspace = new Map();

    const progress = tap(progressByWorkspace, 'workspace-a', 108);

    expect(progress).toEqual({ total: 108, count: 0, malas: 1 });
    expect(restoreTapWorkspaceProgress(progressByWorkspace, 'workspace-b')).toEqual({ total: 0, count: 0, malas: 0 });
  });

  it('serializes A→B→C→A and never saves A total into B during pending restore', async () => {
    const progressByWorkspace = new Map();
    const storedTotals = new Map([
      ['workspace-a', 0],
      ['workspace-b', 0],
      ['workspace-c', 31],
    ]);
    const pendingBReads: Array<(value: number | null) => void> = [];
    const writes: Array<[string | null, number]> = [];
    const coordinator = createTapWorkspaceSwitchCoordinator(progressByWorkspace, {
      readTotal: (japamId) => {
        if (japamId === 'workspace-b') {
          return new Promise<number | null>((resolve) => pendingBReads.push(resolve));
        }
        return Promise.resolve(storedTotals.get(japamId as string) ?? null);
      },
      writeTotal: async (japamId, total) => {
        writes.push([japamId, total]);
        if (japamId) storedTotals.set(japamId, total);
      },
    });

    rememberTapWorkspaceProgress(progressByWorkspace, 'workspace-a', 47);
    await coordinator.willSwitch('workspace-a');
    expect(storedTotals.get('workspace-a')).toBe(47);

    const restoreB = coordinator.didSwitch('workspace-b');
    const saveB = coordinator.willSwitch('workspace-b');
    const restoreC = coordinator.didSwitch('workspace-c');

    for (let index = 0; index < 6; index += 1) await Promise.resolve();
    expect(pendingBReads).toHaveLength(2);
    pendingBReads.forEach((resolve) => resolve(0));

    expect(await restoreB).toBeNull();
    await saveB;
    expect(await restoreC).toMatchObject({ japamId: 'workspace-c', progress: { total: 31, count: 31 } });

    const restoreA = await coordinator.didSwitch('workspace-a');
    expect(restoreA).toMatchObject({ japamId: 'workspace-a', progress: { total: 47, count: 47 } });
    expect(storedTotals.get('workspace-b')).toBe(0);
    expect(writes).not.toContainEqual(['workspace-b', 47]);
  });
});
