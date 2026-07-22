import { createLoadGuard } from '../dashboardLoadGuard';

describe('dashboardLoadGuard', () => {
  describe('normal operation', () => {
    it('allows the first load to proceed', () => {
      const g = createLoadGuard();
      const r = g.shouldLoad();
      expect(r.proceed).toBe(true);
      expect(r.requestId).toBeGreaterThan(0);
    });

    it('assigns sequential request IDs', () => {
      const g = createLoadGuard();
      const r1 = g.shouldLoad();
      g.markComplete(r1.requestId);

      const r2 = g.shouldLoad();
      expect(r2.requestId).toBe(r1.requestId + 1);

      g.markComplete(r2.requestId);

      const r3 = g.shouldLoad();
      expect(r3.requestId).toBe(r2.requestId + 1);
    });

    it('returns needsReload=false for a clean completion', () => {
      const g = createLoadGuard();
      const r = g.shouldLoad();
      const m = g.markComplete(r.requestId);
      expect(m.isValid).toBe(true);
      expect(m.needsReload).toBe(false);
    });

    it('returns isValid=true for the correct requestId', () => {
      const g = createLoadGuard();
      const r = g.shouldLoad();
      const m = g.markComplete(r.requestId);
      expect(m.isValid).toBe(true);
    });
  });

  describe('in-flight blocking', () => {
    it('blocks a second load while one is in flight', () => {
      const g = createLoadGuard();
      g.shouldLoad();
      const r2 = g.shouldLoad();
      expect(r2.proceed).toBe(false);
      expect(r2.requestId).toBe(0);
    });

    it('allows load after in-flight completes', () => {
      const g = createLoadGuard();
      const r1 = g.shouldLoad();
      g.markComplete(r1.requestId);

      const r2 = g.shouldLoad();
      expect(r2.proceed).toBe(true);
    });

    it('picks up the latest requestId after blocking', () => {
      const g = createLoadGuard();
      const r1 = g.shouldLoad();
      g.markComplete(r1.requestId);

      const r2 = g.shouldLoad();
      const r3 = g.shouldLoad();
      expect(r3.proceed).toBe(false);

      g.markComplete(r2.requestId);

      const r4 = g.shouldLoad();
      expect(r4.requestId).toBe(r2.requestId + 1);
    });
  });

  describe('reloadPending queue', () => {
    it('queues exactly one reload when an event fires during in-flight', () => {
      const g = createLoadGuard();
      g.shouldLoad();

      g.shouldLoad();

      const m = g.markComplete(1);
      expect(m.needsReload).toBe(true);
      expect(m.isValid).toBe(true);
    });

    it('returns needsReload=false when no events fired during in-flight', () => {
      const g = createLoadGuard();
      const r = g.shouldLoad();
      const m = g.markComplete(r.requestId);
      expect(m.needsReload).toBe(false);
    });

    it('executes the queued reload exactly once', () => {
      const g = createLoadGuard();
      const r1 = g.shouldLoad();

      g.shouldLoad();
      g.shouldLoad();
      g.shouldLoad();

      const m1 = g.markComplete(r1.requestId);
      expect(m1.needsReload).toBe(true);

      const r2 = g.shouldLoad();
      expect(r2.proceed).toBe(true);

      const m2 = g.markComplete(r2.requestId);
      expect(m2.needsReload).toBe(false);
    });

    it('does not queue additional reloads during the queued reload itself', () => {
      const g = createLoadGuard();
      const r1 = g.shouldLoad();

      g.shouldLoad();
      const m1 = g.markComplete(r1.requestId);
      expect(m1.needsReload).toBe(true);

      const r2 = g.shouldLoad();
      const m2 = g.markComplete(r2.requestId);
      expect(m2.needsReload).toBe(false);
    });
  });

  describe('rapid events', () => {
    it('handles rapid successive events without losing any', () => {
      const g = createLoadGuard();
      const r1 = g.shouldLoad();

      for (let i = 0; i < 20; i++) {
        g.shouldLoad();
      }

      const m1 = g.markComplete(r1.requestId);
      expect(m1.needsReload).toBe(true);

      const r2 = g.shouldLoad();
      const m2 = g.markComplete(r2.requestId);
      expect(m2.needsReload).toBe(false);
    });

    it('event during reload correctly triggers another reload', () => {
      const g = createLoadGuard();
      const r1 = g.shouldLoad();

      g.shouldLoad();

      const m1 = g.markComplete(r1.requestId);
      expect(m1.needsReload).toBe(true);

      const r2 = g.shouldLoad();
      expect(r2.proceed).toBe(true);

      g.shouldLoad();

      const m2 = g.markComplete(r2.requestId);
      expect(m2.needsReload).toBe(true);

      const r3 = g.shouldLoad();
      expect(r3.proceed).toBe(true);
      const m3 = g.markComplete(r3.requestId);
      expect(m3.needsReload).toBe(false);
    });
  });

  describe('stale response discard', () => {
    it('returns isValid=false for a stale requestId', () => {
      const g = createLoadGuard();
      const r1 = g.shouldLoad();
      g.markComplete(r1.requestId);

      g.shouldLoad();

      const m = g.markComplete(r1.requestId);
      expect(m.isValid).toBe(false);
      expect(m.needsReload).toBe(false);
    });

    it('returns isValid=false when an older request completes after a newer one started', () => {
      const g = createLoadGuard();
      const r1 = g.shouldLoad();

      g.shouldLoad();

      const m1 = g.markComplete(r1.requestId);
      expect(m1.needsReload).toBe(true);

      const r2 = g.shouldLoad();

      const mStale = g.markComplete(r1.requestId);
      expect(mStale.isValid).toBe(false);

      const m2 = g.markComplete(r2.requestId);
      expect(m2.isValid).toBe(true);
    });

    it('returns isValid=false when checking stale requestId multiple times', () => {
      const g = createLoadGuard();
      const r1 = g.shouldLoad();
      g.markComplete(r1.requestId);

      g.shouldLoad();

      const m1 = g.markComplete(r1.requestId);
      expect(m1.isValid).toBe(false);

      const m2 = g.markComplete(r1.requestId);
      expect(m2.isValid).toBe(false);
    });

    it('does not reset inFlight state on stale markComplete', () => {
      const g = createLoadGuard();
      const r1 = g.shouldLoad();
      g.markComplete(r1.requestId);

      g.shouldLoad();

      g.markComplete(r1.requestId);

      const r3 = g.shouldLoad();
      expect(r3.proceed).toBe(false);
    });
  });

  describe('unmount protection', () => {
    it('returns needsReload=false after unmount even if a reload was pending', () => {
      const g = createLoadGuard();
      const r1 = g.shouldLoad();

      g.shouldLoad();

      g.unmount();

      const m = g.markComplete(r1.requestId);
      expect(m.needsReload).toBe(false);
      expect(m.isValid).toBe(true);
    });

    it('returns needsReload=false after unmount for a fresh completion', () => {
      const g = createLoadGuard();
      const r = g.shouldLoad();
      g.unmount();
      const m = g.markComplete(r.requestId);
      expect(m.needsReload).toBe(false);
      expect(m.isValid).toBe(true);
    });

    it('allows markComplete to finish normally even after unmount', () => {
      const g = createLoadGuard();
      const r = g.shouldLoad();
      g.unmount();
      const m = g.markComplete(r.requestId);
      expect(m.isValid).toBe(true);
    });
  });

  describe('multiple load/complete cycles', () => {
    it('handles three sequential load/complete cycles cleanly', () => {
      const g = createLoadGuard();

      const r1 = g.shouldLoad();
      const m1 = g.markComplete(r1.requestId);
      expect(m1.needsReload).toBe(false);
      expect(m1.isValid).toBe(true);

      const r2 = g.shouldLoad();
      const m2 = g.markComplete(r2.requestId);
      expect(m2.needsReload).toBe(false);
      expect(m2.isValid).toBe(true);

      const r3 = g.shouldLoad();
      const m3 = g.markComplete(r3.requestId);
      expect(m3.needsReload).toBe(false);
      expect(m3.isValid).toBe(true);
    });

    it('handles alternating in-flight + event + reload cycles', () => {
      const g = createLoadGuard();

      const r1 = g.shouldLoad();
      g.shouldLoad();
      const m1 = g.markComplete(r1.requestId);
      expect(m1.needsReload).toBe(true);

      const r2 = g.shouldLoad();
      const m2 = g.markComplete(r2.requestId);
      expect(m2.needsReload).toBe(false);

      const r3 = g.shouldLoad();
      g.shouldLoad();
      const m3 = g.markComplete(r3.requestId);
      expect(m3.needsReload).toBe(true);

      const r4 = g.shouldLoad();
      const m4 = g.markComplete(r4.requestId);
      expect(m4.needsReload).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('shouldLoad after unmount still works (caller responsibility to check)', () => {
      const g = createLoadGuard();
      g.unmount();
      const r = g.shouldLoad();
      expect(r.proceed).toBe(true);
    });

    it('markComplete with requestId=0 is treated as stale', () => {
      const g = createLoadGuard();
      const r1 = g.shouldLoad();
      const m = g.markComplete(0);
      expect(m.isValid).toBe(false);
      expect(m.needsReload).toBe(false);
      g.markComplete(r1.requestId);
    });

    it('independent guards do not interfere', () => {
      const g1 = createLoadGuard();
      const g2 = createLoadGuard();

      const r1 = g1.shouldLoad();
      g1.shouldLoad();
      g2.shouldLoad();

      const m1 = g1.markComplete(r1.requestId);
      expect(m1.needsReload).toBe(true);
      expect(m1.isValid).toBe(true);

      const r1b = g1.shouldLoad();
      const m1b = g1.markComplete(r1b.requestId);
      expect(m1b.needsReload).toBe(false);

      const r2Id = 1;
      const m2 = g2.markComplete(r2Id);
      expect(m2.needsReload).toBe(false);
      expect(m2.isValid).toBe(true);
    });

  });
});
