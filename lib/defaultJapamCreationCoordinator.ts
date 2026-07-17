type InflightEntry = {
  promise: Promise<void>;
  waiters: number;
};

export function createDefaultJapamCreationCoordinator() {
  const inflight = new Map<string, InflightEntry>();

  return {
    ensureCreation: async (
      userId: string,
      create: () => Promise<unknown>,
    ): Promise<void> => {
      const existing = inflight.get(userId);
      if (existing) {
        existing.waiters++;
        try {
          await existing.promise;
        } finally {
          existing.waiters--;
          if (existing.waiters <= 0) {
            inflight.delete(userId);
          }
        }
        return;
      }

      const promise = create().then(() => {}).catch(() => {});
      inflight.set(userId, { promise, waiters: 1 });

      try {
        await promise;
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
