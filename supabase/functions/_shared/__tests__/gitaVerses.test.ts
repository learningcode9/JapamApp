import { GITA_VERSES, selectGitaVerseForOrdinal } from '../email/campaigns/gitaVerses';

const USER_ID = 'user-for-verse-rotation';

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
    expect(selectGitaVerseForOrdinal(USER_ID, 7)).toEqual(
      selectGitaVerseForOrdinal(USER_ID, 7),
    );
  });

  it('advances only when the successful-send ordinal advances', () => {
    const firstReference = selectGitaVerseForOrdinal(USER_ID, 0);
    const secondReference = selectGitaVerseForOrdinal(USER_ID, 1);

    expect(`${firstReference.chapter}:${firstReference.verse}`).not.toBe(
      `${secondReference.chapter}:${secondReference.verse}`,
    );
  });

  it('uses all 48 verses once, then restarts at the first verse on send 49', () => {
    const references = Array.from({ length: GITA_VERSES.length + 1 }, (_, sendOrdinal) => {
      const verse = selectGitaVerseForOrdinal(USER_ID, sendOrdinal);
      return `${verse.chapter}:${verse.verse}`;
    });

    expect(new Set(references.slice(0, 48)).size).toBe(48);
    expect(references[48]).toBe(references[0]);
  });
});
