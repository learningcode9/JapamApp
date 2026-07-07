import { makeCompletionId, type HistoryRecord } from '../historyStore';
import { planLegacyHistoryBackfill } from '../legacyHistoryBackfill';

const UID = 'user-123';
const JAPAM_ID = 'japam-default-1';
const JAPAM_NAME = 'Gayatri';

const session = (iso: string, over: Partial<HistoryRecord> = {}) => ({
  date: iso,
  malas: 1,
  totalCount: 108,
  duration: 60,
  manual: false,
  userId: UID,
  syncStatus: 'synced' as const,
  ...over,
});

describe('planLegacyHistoryBackfill', () => {
  it('no history: needsBackfill is false, both record arrays are empty', () => {
    const plan = planLegacyHistoryBackfill([], JAPAM_ID, JAPAM_NAME);
    expect(plan.needsBackfill).toBe(false);
    expect(plan.updatedRecords).toEqual([]);
    expect(plan.reassignedRecords).toEqual([]);
  });

  it('no null japamId records: needsBackfill is false, records come back unchanged', () => {
    const records = [
      session('2026-01-01T09:00:00.000Z', { japamId: 'gayatri', japamName: 'Gayatri' }),
      session('2026-01-02T09:00:00.000Z', { japamId: 'govinda', japamName: 'Govinda' }),
    ];
    const plan = planLegacyHistoryBackfill(records, JAPAM_ID, JAPAM_NAME);
    expect(plan.needsBackfill).toBe(false);
    expect(plan.reassignedRecords).toEqual([]);
    expect(plan.updatedRecords.map((r) => ({ japamId: r.japamId, japamName: r.japamName }))).toEqual([
      { japamId: 'gayatri', japamName: 'Gayatri' },
      { japamId: 'govinda', japamName: 'Govinda' },
    ]);
  });

  it('mixed tagged + untagged: only the untagged record is reassigned, the tagged one is untouched', () => {
    const tagged = session('2026-01-01T09:00:00.000Z', {
      japamId: 'govinda',
      japamName: 'Govinda',
      completionId: 'already-tagged',
    });
    const untagged = session('2026-01-02T09:00:00.000Z', {
      japamId: null,
      japamName: null,
      completionId: 'legacy-row',
    });
    const plan = planLegacyHistoryBackfill([tagged, untagged], JAPAM_ID, JAPAM_NAME);

    expect(plan.needsBackfill).toBe(true);
    expect(plan.reassignedRecords).toHaveLength(1);
    expect(plan.reassignedRecords[0].completionId).toBe('legacy-row');
    expect(plan.reassignedRecords[0].japamId).toBe(JAPAM_ID);
    expect(plan.reassignedRecords[0].japamName).toBe(JAPAM_NAME);

    const stillTagged = plan.updatedRecords.find((r) => r.completionId === 'already-tagged');
    expect(stillTagged).toMatchObject({ japamId: 'govinda', japamName: 'Govinda' });
  });

  it('guest (no userId): reassigns japamId/japamName but leaves syncStatus untouched', () => {
    const guestRecord = session('2026-01-01T09:00:00.000Z', {
      userId: null,
      japamId: null,
      japamName: null,
      syncStatus: 'synced',
      completionId: 'guest-row',
    });
    const plan = planLegacyHistoryBackfill([guestRecord], JAPAM_ID, JAPAM_NAME);

    expect(plan.needsBackfill).toBe(true);
    const reassigned = plan.reassignedRecords[0];
    expect(reassigned.japamId).toBe(JAPAM_ID);
    expect(reassigned.japamName).toBe(JAPAM_NAME);
    expect(reassigned.syncStatus).toBe('synced');
  });

  it('signed-in (userId present): reassigns japamId/japamName AND marks syncStatus pending', () => {
    const signedInRecord = session('2026-01-01T09:00:00.000Z', {
      userId: UID,
      japamId: null,
      japamName: null,
      syncStatus: 'synced',
      completionId: 'signed-in-row',
    });
    const plan = planLegacyHistoryBackfill([signedInRecord], JAPAM_ID, JAPAM_NAME);

    const reassigned = plan.reassignedRecords[0];
    expect(reassigned.japamId).toBe(JAPAM_ID);
    expect(reassigned.japamName).toBe(JAPAM_NAME);
    expect(reassigned.syncStatus).toBe('pending');
  });

  it('idempotency: running the plan a second time over its own output finds nothing left to do', () => {
    const records = [
      session('2026-01-01T09:00:00.000Z', { japamId: null, japamName: null, completionId: 'row-1' }),
      session('2026-01-02T09:00:00.000Z', { japamId: 'govinda', japamName: 'Govinda', completionId: 'row-2' }),
    ];
    const firstPlan = planLegacyHistoryBackfill(records, JAPAM_ID, JAPAM_NAME);
    expect(firstPlan.needsBackfill).toBe(true);

    const secondPlan = planLegacyHistoryBackfill(firstPlan.updatedRecords, JAPAM_ID, JAPAM_NAME);
    expect(secondPlan.needsBackfill).toBe(false);
    expect(secondPlan.reassignedRecords).toEqual([]);
    expect(secondPlan.updatedRecords).toEqual(firstPlan.updatedRecords);
  });

  it('existing Japams are never guessed at or merged into, no matter which japamId they already carry', () => {
    const records = [
      session('2026-01-01T09:00:00.000Z', { japamId: 'gayatri', japamName: 'Gayatri', completionId: 'a' }),
      session('2026-01-02T09:00:00.000Z', { japamId: 'govinda', japamName: 'Govinda', completionId: 'b' }),
      session('2026-01-03T09:00:00.000Z', { japamId: JAPAM_ID, japamName: JAPAM_NAME, completionId: 'c' }),
    ];
    const plan = planLegacyHistoryBackfill(records, JAPAM_ID, JAPAM_NAME);

    expect(plan.needsBackfill).toBe(false);
    expect(plan.reassignedRecords).toEqual([]);
    expect(plan.updatedRecords.find((r) => r.completionId === 'a')?.japamId).toBe('gayatri');
    expect(plan.updatedRecords.find((r) => r.completionId === 'b')?.japamId).toBe('govinda');
  });

  it('preserves completionId, date, malas, totalCount for a reassigned record -- only japamId/japamName/syncStatus change', () => {
    const iso = '2026-03-15T08:30:00.000Z';
    const record = session(iso, {
      userId: UID,
      japamId: null,
      japamName: null,
      malas: 4,
      totalCount: 432,
      syncStatus: 'synced',
      completionId: 'preserve-me',
    });
    const plan = planLegacyHistoryBackfill([record], JAPAM_ID, JAPAM_NAME);
    const reassigned = plan.reassignedRecords[0];

    expect(reassigned.completionId).toBe('preserve-me');
    expect(reassigned.date).toBe(iso);
    expect(reassigned.malas).toBe(4);
    expect(reassigned.totalCount).toBe(432);
  });

  it('derives a stable completionId via makeCompletionId when the input record has none', () => {
    const iso = '2026-04-01T10:00:00.000Z';
    const record = session(iso, { japamId: null, japamName: null });
    delete (record as { completionId?: string }).completionId;
    const plan = planLegacyHistoryBackfill([record], JAPAM_ID, JAPAM_NAME);

    expect(plan.reassignedRecords[0].completionId).toBe(makeCompletionId(UID, iso));
  });
});
