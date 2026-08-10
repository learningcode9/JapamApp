export type TapWorkspaceRestoreToken = {
  generation: number;
  japamId: string;
};

export type TapWorkspaceRestoreCoordinator = {
  begin: (japamId: string) => TapWorkspaceRestoreToken;
  invalidate: () => void;
  current: () => TapWorkspaceRestoreToken | null;
  isCurrent: (token: TapWorkspaceRestoreToken) => boolean;
};

/** Signed-in Tap state must always have a concrete Japam scope. */
export const canRestoreTapWorkspace = (userId: string | null, japamId: string | null): boolean =>
  !userId || Boolean(japamId);

/**
 * A monotonic token makes every in-flight restore belong to exactly one workspace visit. A token
 * from A becomes unusable as soon as B (or a later A visit) begins, so late async work cannot
 * commit into the currently selected workspace.
 */
export const createTapWorkspaceRestoreCoordinator = (): TapWorkspaceRestoreCoordinator => {
  let generation = 0;
  let active: TapWorkspaceRestoreToken | null = null;

  return {
    begin: (japamId: string) => {
      active = { generation: ++generation, japamId };
      return active;
    },
    invalidate: () => {
      generation += 1;
      active = null;
    },
    current: () => active,
    isCurrent: (token: TapWorkspaceRestoreToken) =>
      active?.generation === token.generation && active.japamId === token.japamId,
  };
};
