import { detectMalaCrossing } from './malaCompletion';

export type TapIdentitySnapshot = {
  userId: string | null;
  japamId: string | null;
  japamName: string | null;
};

export const createTapIdentitySnapshot = (
  userId: string | null,
  japamId: string | null,
  japamName: string | null
): TapIdentitySnapshot => ({ userId, japamId, japamName });

/** Completion boundaries restart at 1 for every user/workspace pair. */
export const createTapCompletionScopeKey = (
  identity: Pick<TapIdentitySnapshot, 'userId' | 'japamId'>
): string => JSON.stringify([identity.userId, identity.japamId]);

export const computeTapTransition = (previousTotal: number) => {
  const safePreviousTotal = Math.max(0, Math.floor(Number(previousTotal) || 0));
  const nextTotal = safePreviousTotal + 1;
  return {
    previousTotal: safePreviousTotal,
    nextTotal,
    crossing: detectMalaCrossing(safePreviousTotal, nextTotal),
  };
};
