export interface LoadGuardResult {
  proceed: boolean;
  requestId: number;
}

export interface MarkCompleteResult {
  needsReload: boolean;
  isValid: boolean;
}

export interface LoadGuard {
  shouldLoad(): LoadGuardResult;
  markComplete(requestId: number): MarkCompleteResult;
  unmount(): void;
}

export function createLoadGuard(): LoadGuard {
  let inFlight = false;
  let pending = false;
  let nextId = 1;
  let mounted = true;

  return {
    shouldLoad() {
      if (inFlight) {
        pending = true;
        return { proceed: false, requestId: 0 };
      }
      inFlight = true;
      pending = false;
      const id = nextId++;
      return { proceed: true, requestId: id };
    },

    markComplete(requestId) {
      const latestId = nextId - 1;
      if (requestId !== latestId) {
        return { needsReload: false, isValid: false };
      }

      inFlight = false;

      if (!mounted) {
        return { needsReload: false, isValid: true };
      }

      if (pending) {
        return { needsReload: true, isValid: true };
      }

      return { needsReload: false, isValid: true };
    },

    unmount() {
      mounted = false;
    },
  };
}
