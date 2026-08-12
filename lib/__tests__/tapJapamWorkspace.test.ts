import { computeTapTransition } from '../tapJapamBehavior';
import {
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
});
