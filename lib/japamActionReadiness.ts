export type JapamActionReadinessInput = {
  userId: string | null;
  isAnonymous: boolean;
  currentJapamId: string | null;
  isJapamLoading: boolean;
};

export type JapamCompletionScopeInput = {
  userId: string | null;
  isAnonymous: boolean;
  japamId: string | null;
};

export const requiresResolvedJapam = (userId: string | null, isAnonymous: boolean) =>
  Boolean(userId) && !isAnonymous;

export const getJapamActionReadiness = ({
  userId,
  isAnonymous,
  currentJapamId,
  isJapamLoading,
}: JapamActionReadinessInput) => {
  const needsResolvedJapam = requiresResolvedJapam(userId, isAnonymous);
  const isBlockedByLoading = needsResolvedJapam && isJapamLoading;
  const isBlockedByMissingJapam = needsResolvedJapam && !isJapamLoading && !currentJapamId;

  return {
    requiresResolvedJapam: needsResolvedJapam,
    isBlockedByLoading,
    isBlockedByMissingJapam,
    canAct: !isBlockedByLoading && !isBlockedByMissingJapam,
    canSnapshot: !needsResolvedJapam || Boolean(currentJapamId),
  };
};

export const canPersistJapamCompletion = ({
  userId,
  isAnonymous,
  japamId,
}: JapamCompletionScopeInput) => !requiresResolvedJapam(userId, isAnonymous) || Boolean(japamId);
