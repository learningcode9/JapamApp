import { getCampaignCycleDates } from '../email/calculator';
import { GITA_VERSES, selectGitaVerse } from '../email/campaigns/gitaVerses';

const USER_ID = 'user-for-verse-rotation';
const NOW = new Date('2026-08-22T12:00:00.000Z');

describe('Bhagavad Gita campaign rotation', () => {
  it('contains 48 unique, in-range references with meaningful renderings', () => {
    const maxVerseByChapter = [0, 47, 72, 43, 42, 29, 47, 30, 28, 34, 42, 55, 20, 35, 27, 20, 24, 28, 78];
    const references = GITA_VERSES.map(verse => `${verse.chapter}:${verse.verse}`);

    expect(GITA_VERSES).toHaveLength(48);
    expect(new Set(references).size).toBe(48);
    for (const verse of GITA_VERSES) {
      expect(verse.chapter).toBeGreaterThanOrEqual(1);
      expect(verse.chapter).toBeLessThanOrEqual(18);
      expect(verse.verse).toBeGreaterThan(0);
      expect(verse.verse).toBeLessThanOrEqual(maxVerseByChapter[verse.chapter]);
      expect(verse.rendering.trim().length).toBeGreaterThan(20);
    }
  });

  it('is deterministic for the same user and cycle', () => {
    const cycle = getCampaignCycleDates(15, NOW);
    expect(selectGitaVerse(USER_ID, cycle.cycleStart)).toEqual(
      selectGitaVerse(USER_ID, cycle.cycleStart),
    );
  });

  it('selects a different verse in the next cycle', () => {
    const first = getCampaignCycleDates(15, NOW);
    const nextDate = new Date(`${first.cycleEnd}T00:00:00.000Z`);
    nextDate.setUTCDate(nextDate.getUTCDate() + 1);
    const next = getCampaignCycleDates(15, nextDate);
    const firstReference = selectGitaVerse(USER_ID, first.cycleStart);
    const nextReference = selectGitaVerse(USER_ID, next.cycleStart);

    expect(`${firstReference.chapter}:${firstReference.verse}`).not.toBe(
      `${nextReference.chapter}:${nextReference.verse}`,
    );
  });

  it('does not repeat before the full quote pool is used', () => {
    const first = getCampaignCycleDates(15, NOW);
    const references = Array.from({ length: GITA_VERSES.length }, (_, offset) => {
      const cycleDate = new Date(`${first.cycleStart}T00:00:00.000Z`);
      cycleDate.setUTCDate(cycleDate.getUTCDate() + offset * 15);
      const cycle = getCampaignCycleDates(15, cycleDate);
      const verse = selectGitaVerse(USER_ID, cycle.cycleStart);
      return `${verse.chapter}:${verse.verse}`;
    });

    expect(new Set(references).size).toBe(GITA_VERSES.length);
  });
});
