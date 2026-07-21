type InflightEntry = {
  promise: Promise<unknown>;
  waiters: number;
};

export function createDefaultJapamCreationCoordinator() {
  const inflight = new Map<string, InflightEntry>();

  return {
    ensureCreation: async <T>(
      userId: string,
      create: () => Promise<T>,
    ): Promise<T> => {
      const existing = inflight.get(userId);
      if (existing) {
        existing.waiters++;
        try {
          return await existing.promise as T;
        } finally {
          existing.waiters--;
          if (existing.waiters <= 0) {
            inflight.delete(userId);
          }
        }
      }

      const promise = create().catch(() => undefined as unknown as T);
      inflight.set(userId, { promise, waiters: 1 });

      try {
        return await promise;
      } finally {
        const entry = inflight.get(userId);
        if (entry) {
          entry.waiters--;
          if (entry.waiters <= 0) {
            inflight.delete(userId);
          }
        }
      }
    },
  };
}
