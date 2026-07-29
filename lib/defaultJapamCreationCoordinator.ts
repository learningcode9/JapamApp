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
    ): Promise<T | undefined> => {
      const existing = inflight.get(userId);
      if (existing) {
        existing.waiters++;
        try {
          return (await existing.promise) as T | undefined;
        } finally {
          existing.waiters--;
          if (existing.waiters <= 0) {
            inflight.delete(userId);
          }
        }
      }

      let promise: Promise<T | undefined>;
      try {
        promise = Promise.resolve(create()).catch(() => undefined as T | undefined);
      } catch {
        promise = Promise.resolve(undefined as T | undefined);
      }
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
