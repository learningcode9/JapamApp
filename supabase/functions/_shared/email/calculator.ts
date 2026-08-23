import type { JapamHistoryRow, DailyStats, SummaryStats, SourceBreakdown } from './types.ts';

// ─── Period helpers ────────────────────────────────────────────────────────────

/**
 * Returns the inclusive start/end dates for a rolling window ending today (UTC).
 * A 15-day period ending today means today is included, so start = today - 14 days.
 */
export function getPeriodDates(
  periodDays = 15,
  now = new Date(),
): { periodStart: string; periodEnd: string } {
  const end = new Date(now);
  end.setUTCHours(0, 0, 0, 0);

  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (periodDays - 1));

  return {
    periodStart: start.toISOString().slice(0, 10),
    periodEnd: end.toISOString().slice(0, 10),
  };
}

/**
 * Returns a stable, non-overlapping UTC cycle for recurring campaigns.
 *
 * Activity remains a rolling window (getPeriodDates); campaign history uses
 * this fixed key so a daily scheduler can send at most once per 15-day cycle.
 */
export function getCampaignCycleDates(
  periodDays = 15,
  now = new Date(),
): { cycleStart: string; cycleEnd: string; cycleNumber: number } {
  if (!Number.isInteger(periodDays) || periodDays <= 0) {
    throw new Error('periodDays must be a positive integer');
  }

  const day = new Date(now);
  day.setUTCHours(0, 0, 0, 0);
  const epoch = Date.UTC(1970, 0, 1);
  const dayNumber = Math.floor((day.getTime() - epoch) / 86_400_000);
  const cycleNumber = Math.floor(dayNumber / periodDays);
  const cycleStartDate = new Date(epoch + cycleNumber * periodDays * 86_400_000);
  const cycleEndDate = new Date(cycleStartDate.getTime() + (periodDays - 1) * 86_400_000);

  return {
    cycleStart: cycleStartDate.toISOString().slice(0, 10),
    cycleEnd: cycleEndDate.toISOString().slice(0, 10),
    cycleNumber,
  };
}

// ─── Streak calculation ────────────────────────────────────────────────────────

/**
 * Given an array of YYYY-MM-DD strings (already deduped, sorted ascending),
 * returns the length of the longest consecutive-day run.
 */
export function calculateLongestStreak(sortedDates: string[]): number {
  if (sortedDates.length === 0) return 0;

  let longest = 1;
  let current = 1;

  for (let i = 1; i < sortedDates.length; i++) {
    const prev = Date.UTC(
      ...parseDateParts(sortedDates[i - 1]) as [number, number, number],
    );
    const curr = Date.UTC(
      ...parseDateParts(sortedDates[i]) as [number, number, number],
    );
    const diffDays = (curr - prev) / 86_400_000;

    if (diffDays === 1) {
      current += 1;
      if (current > longest) longest = current;
    } else {
      current = 1;
    }
  }

  return longest;
}

function parseDateParts(dateStr: string): [number, number, number] {
  const [y, m, d] = dateStr.split('-').map(Number);
  return [y, m - 1, d]; // month is 0-indexed for Date.UTC
}

function toDateString(isoTimestamp: string): string {
  // Handles both "2026-06-20T08:00:00Z" and "2026-06-20"
  return isoTimestamp.slice(0, 10);
}

// ─── Main calculator ───────────────────────────────────────────────────────────

/**
 * Aggregates raw japam_history rows into a SummaryStats object.
 * Returns null when there are no rows (caller should skip the user).
 */
export function calculateSummaryStats(
  userId: string,
  email: string,
  rows: JapamHistoryRow[],
  periodStart: string,
  periodEnd: string,
): SummaryStats | null {
  const genuineActivityRows = rows.filter(
    row => Number(row.malas) > 0 || Number(row.count) > 0,
  );
  if (genuineActivityRows.length === 0) return null;

  const dailyMap = new Map<string, DailyStats>();
  let hasSourceData = false;
  const breakdown: SourceBreakdown = { timer: 0, tap: 0, manual: 0 };

  for (const row of genuineActivityRows) {
    const date = toDateString(row.created_at);
    const existing = dailyMap.get(date) ?? { date, sessions: 0, malas: 0 };
    dailyMap.set(date, {
      date,
      sessions: existing.sessions + 1,
      malas: existing.malas + (Number(row.malas) || 0),
    });

    if (row.source) {
      hasSourceData = true;
      if (row.source === 'timer') breakdown.timer += 1;
      else if (row.source === 'tap') breakdown.tap += 1;
      else breakdown.manual += 1;
    }
  }

  const days = Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date));

  const totalSessions = days.reduce((sum, d) => sum + d.sessions, 0);
  const totalMalas = days.reduce((sum, d) => sum + d.malas, 0);
  const recentCount = genuineActivityRows.reduce((sum, row) => sum + (Number(row.count) || 0), 0);
  const daysPracticed = days.length;
  const averageMalasPerActiveDay = daysPracticed > 0 ? totalMalas / daysPracticed : 0;

  const bestDay = days.reduce<DailyStats | null>((best, d) => {
    if (!best || d.malas > best.malas || (d.malas === best.malas && d.sessions > best.sessions)) {
      return d;
    }
    return best;
  }, null);

  const longestStreak = calculateLongestStreak(days.map(d => d.date));

  // Best available display name: user_name field from any row, or email prefix
  const userName =
    genuineActivityRows.find(r => r.user_name)?.user_name?.trim() || email.split('@')[0];

  return {
    userId,
    email,
    userName,
    periodStart,
    periodEnd,
    totalSessions,
    totalMalas,
    recentMalas: totalMalas,
    recentCount,
    daysPracticed,
    longestStreak,
    averageMalasPerActiveDay,
    bestDay,
    breakdown: hasSourceData ? breakdown : null,
  };
}
