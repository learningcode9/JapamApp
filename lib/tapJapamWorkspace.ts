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
