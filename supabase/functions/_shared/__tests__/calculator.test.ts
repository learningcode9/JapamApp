import {
  calculateSummaryStats,
  calculateLongestStreak,
  getPeriodDates,
} from '../email/calculator';
import type { JapamHistoryRow } from '../email/types';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const P_START = '2026-06-16';
const P_END   = '2026-06-30';

function row(overrides: Partial<JapamHistoryRow> = {}): JapamHistoryRow {
  return {
    user_id: 'u1',
    user_name: 'Dev User',
    malas: 1,
    count: 108,
    created_at: '2026-06-20T08:00:00.000Z',
    completion_id: 'c1',
    ...overrides,
  };
}

// ─── calculateLongestStreak ───────────────────────────────────────────────────

describe('calculateLongestStreak', () => {
  it('returns 0 for empty input', () => {
    expect(calculateLongestStreak([])).toBe(0);
  });

  it('returns 1 for a single date', () => {
    expect(calculateLongestStreak(['2026-06-01'])).toBe(1);
  });

  it('returns streak length for consecutive days', () => {
    expect(calculateLongestStreak(['2026-06-01', '2026-06-02', '2026-06-03'])).toBe(3);
  });

  it('finds the longest streak across a gap', () => {
    // streak-1=2, gap, streak-2=3
    const dates = ['2026-06-01', '2026-06-02', '2026-06-05', '2026-06-06', '2026-06-07'];
    expect(calculateLongestStreak(dates)).toBe(3);
  });

  it('returns 1 when all dates are non-consecutive', () => {
    expect(calculateLongestStreak(['2026-06-01', '2026-06-03', '2026-06-07'])).toBe(1);
  });

  it('handles a streak of 15 consecutive days', () => {
    const dates = Array.from({ length: 15 }, (_, i) => {
      const d = new Date('2026-06-16');
      d.setDate(d.getDate() + i);
      return d.toISOString().slice(0, 10);
    });
    expect(calculateLongestStreak(dates)).toBe(15);
  });
});

// ─── calculateSummaryStats ────────────────────────────────────────────────────

describe('calculateSummaryStats', () => {
  it('returns null for empty rows (no activity → skip user)', () => {
    const result = calculateSummaryStats('u1', 'a@b.com', [], P_START, P_END);
    expect(result).toBeNull();
  });

  it('returns null for empty rows regardless of period', () => {
    expect(calculateSummaryStats('u1', 'a@b.com', [], '2026-01-01', '2026-01-15')).toBeNull();
  });

  it('calculates totalMalas correctly', () => {
    const rows = [
      row({ malas: 2, created_at: '2026-06-20T08:00:00Z' }),
      row({ malas: 3, created_at: '2026-06-21T08:00:00Z', completion_id: 'c2' }),
    ];
    expect(calculateSummaryStats('u1', 'a@b.com', rows, P_START, P_END)!.totalMalas).toBe(5);
  });

  it('calculates totalSessions correctly (one row = one session)', () => {
    const rows = [
      row({ completion_id: 'c1' }),
      row({ completion_id: 'c2', created_at: '2026-06-21T08:00:00Z' }),
      row({ completion_id: 'c3', created_at: '2026-06-21T10:00:00Z' }),
    ];
    expect(calculateSummaryStats('u1', 'a@b.com', rows, P_START, P_END)!.totalSessions).toBe(3);
  });

  it('aggregates multiple sessions on the same day into one DailyStats entry', () => {
    const rows = [
      row({ malas: 1, completion_id: 'c1', created_at: '2026-06-20T07:00:00Z' }),
      row({ malas: 2, completion_id: 'c2', created_at: '2026-06-20T14:00:00Z' }),
    ];
    const stats = calculateSummaryStats('u1', 'a@b.com', rows, P_START, P_END)!;
    expect(stats.daysPracticed).toBe(1);
    expect(stats.totalMalas).toBe(3);
    expect(stats.totalSessions).toBe(2);
  });

  it('calculates daysPracticed as count of distinct dates', () => {
    const rows = [
      row({ completion_id: 'c1', created_at: '2026-06-18T08:00:00Z' }),
      row({ completion_id: 'c2', created_at: '2026-06-20T08:00:00Z' }),
      row({ completion_id: 'c3', created_at: '2026-06-25T08:00:00Z' }),
    ];
    expect(calculateSummaryStats('u1', 'a@b.com', rows, P_START, P_END)!.daysPracticed).toBe(3);
  });

  it('identifies bestDay as the date with highest total malas', () => {
    const rows = [
      row({ malas: 1, created_at: '2026-06-20T08:00:00Z', completion_id: 'c1' }),
      row({ malas: 5, created_at: '2026-06-21T08:00:00Z', completion_id: 'c2' }),
      row({ malas: 3, created_at: '2026-06-22T08:00:00Z', completion_id: 'c3' }),
    ];
    const stats = calculateSummaryStats('u1', 'a@b.com', rows, P_START, P_END)!;
    expect(stats.bestDay?.date).toBe('2026-06-21');
    expect(stats.bestDay?.malas).toBe(5);
  });

  it('calculates averageMalasPerActiveDay correctly', () => {
    const rows = [
      row({ malas: 4, created_at: '2026-06-20T08:00:00Z', completion_id: 'c1' }),
      row({ malas: 2, created_at: '2026-06-22T08:00:00Z', completion_id: 'c2' }),
    ];
    const stats = calculateSummaryStats('u1', 'a@b.com', rows, P_START, P_END)!;
    expect(stats.averageMalasPerActiveDay).toBe(3); // (4+2) / 2 days
  });

  it('includes longestStreak in stats', () => {
    const rows = [
      row({ created_at: '2026-06-20T08:00:00Z', completion_id: 'c1' }),
      row({ created_at: '2026-06-21T08:00:00Z', completion_id: 'c2' }),
      row({ created_at: '2026-06-22T08:00:00Z', completion_id: 'c3' }),
      row({ created_at: '2026-06-25T08:00:00Z', completion_id: 'c4' }),
    ];
    expect(calculateSummaryStats('u1', 'a@b.com', rows, P_START, P_END)!.longestStreak).toBe(3);
  });

  it('uses user_name from rows when available', () => {
    const stats = calculateSummaryStats('u1', 'a@b.com', [row({ user_name: 'Priya' })], P_START, P_END)!;
    expect(stats.userName).toBe('Priya');
  });

  it('falls back to email prefix when user_name is null', () => {
    const stats = calculateSummaryStats('u1', 'priya@example.com', [row({ user_name: null })], P_START, P_END)!;
    expect(stats.userName).toBe('priya');
  });

  it('returns null breakdown when no row has source data', () => {
    const stats = calculateSummaryStats('u1', 'a@b.com', [row({ source: null })], P_START, P_END)!;
    expect(stats.breakdown).toBeNull();
  });

  it('returns breakdown counts when source data exists', () => {
    const rows = [
      row({ source: 'timer',  completion_id: 'c1', created_at: '2026-06-20T08:00:00Z' }),
      row({ source: 'timer',  completion_id: 'c2', created_at: '2026-06-21T08:00:00Z' }),
      row({ source: 'tap',    completion_id: 'c3', created_at: '2026-06-22T08:00:00Z' }),
      row({ source: 'manual', completion_id: 'c4', created_at: '2026-06-23T08:00:00Z' }),
    ];
    const stats = calculateSummaryStats('u1', 'a@b.com', rows, P_START, P_END)!;
    expect(stats.breakdown).toEqual({ timer: 2, tap: 1, manual: 1 });
  });

  it('counts unknown source values as manual', () => {
    const rows = [row({ source: 'unknown_future_type' })];
    const stats = calculateSummaryStats('u1', 'a@b.com', rows, P_START, P_END)!;
    expect(stats.breakdown?.manual).toBe(1);
  });
});

// ─── getPeriodDates ───────────────────────────────────────────────────────────

describe('getPeriodDates', () => {
  it('returns dates 14 days apart (15 days inclusive)', () => {
    const { periodStart, periodEnd } = getPeriodDates(15);
    const start = new Date(periodStart);
    const end = new Date(periodEnd);
    const diffDays = (end.getTime() - start.getTime()) / 86_400_000;
    expect(diffDays).toBe(14);
  });

  it('returns YYYY-MM-DD formatted strings', () => {
    const { periodStart, periodEnd } = getPeriodDates(15);
    expect(periodStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(periodEnd).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('respects custom periodDays', () => {
    const { periodStart, periodEnd } = getPeriodDates(30);
    const diff = (new Date(periodEnd).getTime() - new Date(periodStart).getTime()) / 86_400_000;
    expect(diff).toBe(29);
  });
});
