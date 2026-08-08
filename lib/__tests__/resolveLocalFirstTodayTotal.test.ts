/**
 * Tests for lib/historyStore.ts's resolveLocalFirstTodayTotal — the LOCAL-FIRST "today" total for
 * Home's counter.
 *
 * Home's counter must render from local storage alone on a cold start offline. It may never be
 * gated on the remote reconciliation (whose supabase.auth.getSession() triggers a network token
 * refresh for a near-expiry session, stalling for minutes offline). This selector is the immediate,
 * network-free value: max(selected-Japam-scoped local-history today total, persisted per-user
 * counter snapshot when dated TODAY).
 */
import {
  resolveLocalFirstTodayTotal,
  toLocalDayKey,
} from '../historyStore';

const UID = 'user-92b7';
const JAPAM_ID = '92b7dc78-f1ae-4803-9e4d-8997d400f1f4';
const JAPAM_NAME = 'My Japam';
const OTHER_JAPAM_ID = 'aaaaaaaa-0000-0000-0000-000000000000';
const OTHER_JAPAM_NAME = 'Other Japam';
const TODAY = '2026-07-28';

const getPreviousDayKey = (dayKey: string) => {
  const d = new Date(`${dayKey}T12:00:00`);
  d.setDate(d.getDate() - 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};
const YESTERDAY = getPreviousDayKey(TODAY);

const todayIso = (h: number) => `${TODAY}T${String(h).padStart(2, '0')}:00:00.000Z`;
const yIso = (h: number) => `${YESTERDAY}T${String(h).padStart(2, '0')}:00:00.000Z`;

type Over = {
  totalCount?: number;
  userId?: string;
  japamId?: string | null;
  japamName?: string | null;
  completionId?: string;
};

const rec = (iso: string, over: Over = {}): Over & { date: string } => ({
  date: iso,
  totalCount: 108,
  userId: UID,
  japamId: null,
  japamName: null,
  ...over,
});

const japams = [
  { id: JAPAM_ID, name: JAPAM_NAME },
  { id: OTHER_JAPAM_ID, name: OTHER_JAPAM_NAME },
];

describe('resolveLocalFirstTodayTotal', () => {
  it('REGRESSION: shows today\'s local-history total even when the persisted counter snapshot is stale (dated a previous day) — the offline cold-start case that previously showed 0', () => {
    const localHistory = [
      rec(todayIso(8), { completionId: 't1' }),
      rec(todayIso(9), { completionId: 't2' }),
    ];
    const total = resolveLocalFirstTodayTotal(
      localHistory,
      UID,
      JAPAM_ID,
      JAPAM_NAME,
      TODAY,
      toLocalDayKey,
      { includeBlankLegacy: true, storedTodayDate: YESTERDAY, storedTodayTotal: 50 },
      japams,
    );
    expect(total).toBe(216);
  });

  it('returns 0 when there is no local history and no valid stored snapshot', () => {
    const total = resolveLocalFirstTodayTotal([], UID, JAPAM_ID, JAPAM_NAME, TODAY, toLocalDayKey, {
      storedTodayDate: TODAY,
      storedTodayTotal: 0,
    }, japams);
    expect(total).toBe(0);
  });

  it('uses the persisted counter snapshot when it is dated today and exceeds the local-history total', () => {
    const localHistory = [
      rec(todayIso(8), { completionId: 't1' }),
      rec(todayIso(9), { completionId: 't2' }),
    ];
    const total = resolveLocalFirstTodayTotal(
      localHistory,
      UID,
      JAPAM_ID,
      JAPAM_NAME,
      TODAY,
      toLocalDayKey,
      { includeBlankLegacy: true, storedTodayDate: TODAY, storedTodayTotal: 300 },
      japams,
    );
    expect(total).toBe(300);
  });

  it('never counts a persisted snapshot dated on a previous day', () => {
    const total = resolveLocalFirstTodayTotal([], UID, JAPAM_ID, JAPAM_NAME, TODAY, toLocalDayKey, {
      storedTodayDate: YESTERDAY,
      storedTodayTotal: 999,
    }, japams);
    expect(total).toBe(0);
  });

  it('scopes to the selected Japam — another Japam\'s today records do not inflate this total', () => {
    const localHistory = [
      rec(todayIso(8), { japamId: JAPAM_ID, japamName: JAPAM_NAME, completionId: 'a1' }),
      rec(todayIso(8), { japamId: OTHER_JAPAM_ID, japamName: OTHER_JAPAM_NAME, completionId: 'b1' }),
    ];
    const total = resolveLocalFirstTodayTotal(
      localHistory,
      UID,
      JAPAM_ID,
      JAPAM_NAME,
      TODAY,
      toLocalDayKey,
      { includeBlankLegacy: true },
      japams,
    );
    expect(total).toBe(108);
  });

  it('excludes another user\'s records', () => {
    const localHistory = [
      rec(todayIso(8), { userId: UID, completionId: 'mine' }),
      rec(todayIso(8), { userId: 'someone-else', completionId: 'theirs' }),
    ];
    const total = resolveLocalFirstTodayTotal(
      localHistory,
      UID,
      JAPAM_ID,
      JAPAM_NAME,
      TODAY,
      toLocalDayKey,
      { includeBlankLegacy: true },
      japams,
    );
    expect(total).toBe(108);
  });

  it('counts legacy null-japamId records that carry the selected Japam\'s name', () => {
    const localHistory = [
      rec(todayIso(8), { japamId: null, japamName: JAPAM_NAME, completionId: 'leg1' }),
    ];
    const total = resolveLocalFirstTodayTotal(
      localHistory,
      UID,
      JAPAM_ID,
      JAPAM_NAME,
      TODAY,
      toLocalDayKey,
      { includeBlankLegacy: false },
      japams,
    );
    expect(total).toBe(108);
  });

  it('counts blank legacy records only when includeBlankLegacy is set (canonical/default Japam)', () => {
    const localHistory = [rec(todayIso(8), { japamId: null, japamName: null, completionId: 'blank1' })];
    const withBlank = resolveLocalFirstTodayTotal(
      localHistory,
      UID,
      JAPAM_ID,
      JAPAM_NAME,
      TODAY,
      toLocalDayKey,
      { includeBlankLegacy: true },
      japams,
    );
    const withoutBlank = resolveLocalFirstTodayTotal(
      localHistory,
      UID,
      JAPAM_ID,
      JAPAM_NAME,
      TODAY,
      toLocalDayKey,
      { includeBlankLegacy: false },
      japams,
    );
    expect(withBlank).toBe(108);
    expect(withoutBlank).toBe(0);
  });

  it('when no Japam is selected yet (japamId null), counts all local records — matching loadHistoryStats while the Japam context hydrates', () => {
    const localHistory = [
      rec(todayIso(8), { japamId: JAPAM_ID, japamName: JAPAM_NAME, completionId: 'a1' }),
      rec(todayIso(8), { japamId: OTHER_JAPAM_ID, japamName: OTHER_JAPAM_NAME, completionId: 'b1' }),
    ];
    const total = resolveLocalFirstTodayTotal(
      localHistory,
      UID,
      null,
      null,
      TODAY,
      toLocalDayKey,
      { includeBlankLegacy: true },
      japams,
    );
    expect(total).toBe(216);
  });

  it('ignores yesterday\'s records', () => {
    const localHistory = [
      rec(yIso(8), { completionId: 'y1' }),
      rec(todayIso(8), { completionId: 't1' }),
    ];
    const total = resolveLocalFirstTodayTotal(
      localHistory,
      UID,
      JAPAM_ID,
      JAPAM_NAME,
      TODAY,
      toLocalDayKey,
      { includeBlankLegacy: true },
      japams,
    );
    expect(total).toBe(108);
  });

  it('dedupes by completionId', () => {
    const localHistory = [
      rec(todayIso(8), { completionId: 'dup' }),
      rec(todayIso(9), { completionId: 'dup' }),
    ];
    const total = resolveLocalFirstTodayTotal(
      localHistory,
      UID,
      JAPAM_ID,
      JAPAM_NAME,
      TODAY,
      toLocalDayKey,
      { includeBlankLegacy: true },
      japams,
    );
    expect(total).toBe(108);
  });
});
