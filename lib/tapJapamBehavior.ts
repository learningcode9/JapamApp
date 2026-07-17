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

export const computeTapTransition = (previousTotal: number) => {
  const safePreviousTotal = Math.max(0, Math.floor(Number(previousTotal) || 0));
  const nextTotal = safePreviousTotal + 1;
  return {
    previousTotal: safePreviousTotal,
    nextTotal,
    crossing: detectMalaCrossing(safePreviousTotal, nextTotal),
  };
};
