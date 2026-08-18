let recoveryInFlight: Promise<boolean> | null = null;
let authGeneration = 0;
const activeRecoveryGenerations = new Set<number>();

export function getAuthGeneration(): number {
  return authGeneration;
}

export function isAuthGenerationCurrent(generation: number): boolean {
  return generation === authGeneration;
}

export function cancelSessionRecovery(): void {
  authGeneration += 1;
}

export function hasCancelledRecoveryInFlight(): boolean {
  for (const generation of activeRecoveryGenerations) {
    if (generation !== authGeneration) return true;
  }
  return false;
}

export function beginSessionRecovery(): number {
  const generation = authGeneration;
  activeRecoveryGenerations.add(generation);
  return generation;
}

export function getRecoveryInFlight(): Promise<boolean> | null {
  return recoveryInFlight;
}

export function setRecoveryInFlight(promise: Promise<boolean>): void {
  recoveryInFlight = promise;
}

export function finishSessionRecovery(generation: number, promise: Promise<boolean>): void {
  activeRecoveryGenerations.delete(generation);
  if (recoveryInFlight === promise) recoveryInFlight = null;
}

/** Cancel background recovery and wait until its token exchange and cleanup have settled. */
export async function waitForRecoveryToSettleBeforeInteractiveLogin(): Promise<void> {
  cancelSessionRecovery();
  const pending = recoveryInFlight;
  if (pending) await pending.catch(() => {});
}

export function resetAuthRecoveryState(): void {
  authGeneration += 1;
  activeRecoveryGenerations.clear();
  recoveryInFlight = null;
}
