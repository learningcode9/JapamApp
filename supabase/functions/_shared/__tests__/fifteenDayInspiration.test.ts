import { fifteenDayInspirationCampaign } from '../email/campaigns/fifteenDayInspiration';
import { loadEmailConfig } from '../email/config';
import type { SummaryStats } from '../email/types';
import type { CampaignContext } from '../email/campaigns/types';
import type { GitaVerse } from '../email/campaigns/gitaVerses';

function makeStats(overrides: Partial<SummaryStats> = {}): SummaryStats {
  return {
    userId: 'u1',
    email: 'devotee@example.com',
    userName: 'Devotee',
    periodStart: '2026-06-16',
    periodEnd: '2026-06-30',
    totalSessions: 12,
    totalMalas: 30,
    recentMalas: 30,
    recentCount: 3240,
    daysPracticed: 10,
    longestStreak: 5,
    averageMalasPerActiveDay: 3,
    bestDay: { date: '2026-06-25', sessions: 2, malas: 6 },
    breakdown: null,
    ...overrides,
  };
}

function makeContext(overrides: Partial<CampaignContext> = {}): CampaignContext {
  return {
    stats: makeStats(),
    lifetimeTotalMalas: 500,
    lifetimeTotalCount: 54000,
    config: { ...loadEmailConfig(), ctaUrl: 'https://mantra-japam.vercel.app' },
    ...overrides,
  };
}

describe('fifteenDayInspirationCampaign metadata', () => {
  it('has a stable id used for dedup and a 15-day period', () => {
    expect(fifteenDayInspirationCampaign.id).toBe('15day_inspiration');
    expect(fifteenDayInspirationCampaign.periodDays).toBe(15);
  });

  it('keeps the existing Mala subject when recent Mala activity is present', () => {
    expect(fifteenDayInspirationCampaign.getSubject?.(makeContext())).toBe(
      '🪷 Every Mala Brings You Closer to Inner Peace',
    );
  });

  it('uses the Count-friendly subject for recent Count-only activity', () => {
    const ctx = makeContext({
      stats: makeStats({ recentMalas: 0, recentCount: 1, totalMalas: 0 }),
    });
    expect(fifteenDayInspirationCampaign.getSubject?.(ctx)).toBe(
      'Your Japam Practice Is Building Quietly',
    );
  });
});

describe('fifteenDayInspirationCampaign.buildHtml', () => {
  it('includes the hero headline', () => {
    const html = fifteenDayInspirationCampaign.buildHtml(makeContext());
    expect(html).toContain('Every Mala Brings You Closer to Inner Peace');
  });

  it('includes the user name, period stats, and lifetime total', () => {
    const html = fifteenDayInspirationCampaign.buildHtml(makeContext());
    expect(html).toContain('Devotee');
    expect(html).toContain('30'); // totalMalas
    expect(html).toContain('500'); // lifetimeTotalMalas
    expect(html).toContain('Japam count in the last 15 days');
    expect(html).toContain('3,240'); // recentCount
    expect(html).toContain('Lifetime Japam count');
    expect(html).toContain('54,000'); // lifetimeTotalCount
  });

  it('omits the CTA button even when ctaUrl is set', () => {
    const html = fifteenDayInspirationCampaign.buildHtml(makeContext());
    expect(html).not.toContain("Continue Today's Japam");
    expect(html).not.toContain('https://mantra-japam.vercel.app');
  });

  it('includes the Bhagavad Gita verse, clearly attributed', () => {
    const html = fifteenDayInspirationCampaign.buildHtml(makeContext());
    expect(html).toContain('Bhagavad Gita');
  });

  it('uses the selected verse in both Mala and Count-only variants', () => {
    const verse: GitaVerse = {
      chapter: 6,
      verse: 26,
      rendering: 'Whenever attention wanders, return it gently to the practice.',
    };
    const malaContext = makeContext({ gitaVerse: verse });
    const countContext = makeContext({
      gitaVerse: verse,
      stats: makeStats({ recentMalas: 0, recentCount: 7, totalMalas: 0 }),
    });

    for (const rendered of [
      fifteenDayInspirationCampaign.buildHtml(malaContext),
      fifteenDayInspirationCampaign.buildText(malaContext),
      fifteenDayInspirationCampaign.buildHtml(countContext),
      fifteenDayInspirationCampaign.buildText(countContext),
    ]) {
      expect(rendered).toContain(verse.rendering);
      expect(rendered).toContain('Chapter 6, Verse 26');
    }
  });

  it('does not reference any specific deity by name', () => {
    const html = fifteenDayInspirationCampaign.buildHtml(makeContext());
    // The existing stats-digest template uses "Jai Shri Ram" / "the Lord's feet" —
    // this campaign is explicitly designed to feel welcoming to any background.
    expect(html.toLowerCase()).not.toContain('shri ram');
    expect(html.toLowerCase()).not.toContain("lord's feet");
  });

  it('renders a valid HTML document', () => {
    const html = fifteenDayInspirationCampaign.buildHtml(makeContext());
    expect(html).toMatch(/^<!DOCTYPE html>/);
    expect(html).toContain('</html>');
  });

  it('falls back gracefully when bestDay is null', () => {
    const ctx = makeContext({ stats: makeStats({ bestDay: null }) });
    expect(() => fifteenDayInspirationCampaign.buildHtml(ctx)).not.toThrow();
  });

  it('renders zero-activity totals safely', () => {
    const ctx = makeContext({
      stats: makeStats({
        totalSessions: 0,
        totalMalas: 0,
        recentMalas: 0,
        recentCount: 0,
        daysPracticed: 0,
        averageMalasPerActiveDay: 0,
        longestStreak: 0,
        bestDay: null,
      }),
      lifetimeTotalMalas: 0,
    });
    const html = fifteenDayInspirationCampaign.buildHtml(ctx);
    expect(html).toContain('0');
    expect(html).toContain('a quiet stretch');
  });

  it('renders Count-friendly stats for recent Count-only activity', () => {
    const ctx = makeContext({
      stats: makeStats({
        totalSessions: 1,
        totalMalas: 0,
        recentMalas: 0,
        recentCount: 7,
        daysPracticed: 1,
        averageMalasPerActiveDay: 0,
        longestStreak: 1,
        bestDay: { date: '2026-06-25', sessions: 1, malas: 0 },
      }),
      lifetimeTotalMalas: 0,
    });
    const html = fifteenDayInspirationCampaign.buildHtml(ctx);
    expect(html).toContain('Your Japam Practice Is Building Quietly');
    expect(html).toContain('Japam count in the last 15 days');
    expect(html).toContain('>7</td>');
    expect(html).toContain('Lifetime Japam count');
    expect(html).toContain('54,000');
  });

  it('renders recent and lifetime Japam counts in Count-only plain text', () => {
    const ctx = makeContext({
      stats: makeStats({ recentMalas: 0, recentCount: 7, totalMalas: 0 }),
      lifetimeTotalMalas: 0,
      lifetimeTotalCount: 54_000,
    });
    const text = fifteenDayInspirationCampaign.buildText(ctx);
    expect(text).toContain('Japam count in the last 15 days: 7');
    expect(text).toContain('Lifetime Japam count:             54,000');
  });

  it('does not use Mala-specific activity wording for Count-only activity', () => {
    const ctx = makeContext({
      stats: makeStats({ recentMalas: 0, recentCount: 1, totalMalas: 0 }),
      lifetimeTotalMalas: 0,
    });
    const rendered = `${fifteenDayInspirationCampaign.buildHtml(ctx)}\n${fifteenDayInspirationCampaign.buildText(ctx)}`;
    expect(rendered).not.toMatch(/mala/i);
    expect(rendered).toContain('Even one recent practice is meaningful');
  });

  it('HTML-escapes a user-controlled display name instead of injecting it raw', () => {
    const ctx = makeContext({ stats: makeStats({ userName: '<script>alert(1)</script>' }) });
    const html = fifteenDayInspirationCampaign.buildHtml(ctx);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('contains no curly/smart quotes anywhere in the rendered output', () => {
    const html = fifteenDayInspirationCampaign.buildHtml(makeContext());
    expect(html).not.toMatch(/[‘’“”]/);
  });

  it('does not claim the recipient started exactly 15 days ago', () => {
    // The copy must read correctly for long-time practitioners and new users
    // alike; eligibility is based on recent activity, not account age.
    const html = fifteenDayInspirationCampaign.buildHtml(makeContext());
    expect(html).not.toContain('Fifteen days ago, you began');
  });

  it('marks layout tables as presentation-only for screen readers', () => {
    const html = fifteenDayInspirationCampaign.buildHtml(makeContext());
    expect(html).toMatch(/<table role="presentation"/);
  });

  it('declares a light color-scheme to avoid client dark-mode inversion', () => {
    const html = fifteenDayInspirationCampaign.buildHtml(makeContext());
    expect(html).toContain('name="color-scheme" content="light"');
  });
});

describe('fifteenDayInspirationCampaign.buildText', () => {
  it('mirrors the HTML content in plain text', () => {
    const text = fifteenDayInspirationCampaign.buildText(makeContext());
    expect(text).toContain('Every Mala Brings You Closer to Inner Peace');
    expect(text).toContain('Devotee');
    expect(text).toContain('Bhagavad Gita');
  });

  it('omits the CTA line even when ctaUrl is set', () => {
    const ctx = makeContext();
    const text = fifteenDayInspirationCampaign.buildText(ctx);
    expect(text).not.toContain("Continue today's Japam");
    expect(text).not.toContain('https://mantra-japam.vercel.app');
  });
});
