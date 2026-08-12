export type TapWorkspaceProgress = {
  total: number;
  count: number;
  malas: number;
};

export const zeroTapWorkspaceProgress = (): TapWorkspaceProgress => ({
  total: 0,
  count: 0,
  malas: 0,
});

export const tapWorkspaceProgressFromTotal = (value: number): TapWorkspaceProgress => {
  const total = Math.max(0, Math.floor(Number(value) || 0));
  return {
    total,
    count: total % 108,
    malas: Math.floor(total / 108),
  };
};

/**
 * Keep the latest live Tap total independently for every selected Japam.
 * A missing workspace is intentionally a fresh zero, never another workspace's value.
 */
export const rememberTapWorkspaceProgress = (
  progressByWorkspace: Map<string | null, TapWorkspaceProgress>,
  japamId: string | null,
  total: number,
): TapWorkspaceProgress => {
  const progress = tapWorkspaceProgressFromTotal(total);
  progressByWorkspace.set(japamId, progress);
  return progress;
};

export const restoreTapWorkspaceProgress = (
  progressByWorkspace: Map<string | null, TapWorkspaceProgress>,
  japamId: string | null,
): TapWorkspaceProgress => {
  return progressByWorkspace.get(japamId) ?? zeroTapWorkspaceProgress();
};

export type TapWorkspaceSwitchStorage = {
  readTotal: (japamId: string | null) => Promise<number | null>;
  writeTotal: (japamId: string | null, total: number) => Promise<void>;
};

export type TapWorkspaceSwitchCoordinator = {
  willSwitch: (fromJapamId: string | null) => Promise<void>;
  didSwitch: (toJapamId: string | null) => Promise<{
    japamId: string | null;
    progress: TapWorkspaceProgress;
  } | null>;
};

/**
 * Serialize the actual will-switch save / did-switch restore protocol. A switch can arrive while
 * the prior workspace's restore is still reading storage, so an outgoing save must resolve its
 * value by fromJapamId rather than borrowing a screen-wide totalRef.
 */
export const createTapWorkspaceSwitchCoordinator = (
  progressByWorkspace: Map<string | null, TapWorkspaceProgress>,
  storage: TapWorkspaceSwitchStorage,
): TapWorkspaceSwitchCoordinator => {
  let writeQueue = Promise.resolve();
  let latestSave: Promise<void> | null = null;
  let restoreGeneration = 0;

  const willSwitch = (fromJapamId: string | null) => {
    const save = writeQueue
      .catch(() => undefined)
      .then(async () => {
        let progress = progressByWorkspace.get(fromJapamId);
        if (!progress) {
          const storedTotal = await storage.readTotal(fromJapamId);
          progress = rememberTapWorkspaceProgress(
            progressByWorkspace,
            fromJapamId,
            storedTotal ?? 0,
          );
        }
        await storage.writeTotal(fromJapamId, progress.total);
      });
    writeQueue = save;
    latestSave = save;
    return save;
  };

  const didSwitch = async (toJapamId: string | null) => {
    const generation = ++restoreGeneration;
    const saveBarrier = latestSave;
    if (saveBarrier) {
      try { await saveBarrier; } catch {}
    }

    const storedTotal = await storage.readTotal(toJapamId);
    if (generation !== restoreGeneration) return null;

    return {
      japamId: toJapamId,
      progress: rememberTapWorkspaceProgress(
        progressByWorkspace,
        toJapamId,
        storedTotal ?? 0,
      ),
    };
  };

  return { willSwitch, didSwitch };
};
