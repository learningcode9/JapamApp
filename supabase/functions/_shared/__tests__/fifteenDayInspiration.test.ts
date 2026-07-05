import { fifteenDayInspirationCampaign } from '../email/campaigns/fifteenDayInspiration';
import { loadEmailConfig } from '../email/config';
import type { SummaryStats } from '../email/types';
import type { CampaignContext } from '../email/campaigns/types';

function makeStats(overrides: Partial<SummaryStats> = {}): SummaryStats {
  return {
    userId: 'u1',
    email: 'devotee@example.com',
    userName: 'Devotee',
    periodStart: '2026-06-16',
    periodEnd: '2026-06-30',
    totalSessions: 12,
    totalMalas: 30,
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
    config: { ...loadEmailConfig(), ctaUrl: 'https://mantra-japam.vercel.app' },
    ...overrides,
  };
}

describe('fifteenDayInspirationCampaign metadata', () => {
  it('has a stable id used for dedup and a 15-day period', () => {
    expect(fifteenDayInspirationCampaign.id).toBe('15day_inspiration');
    expect(fifteenDayInspirationCampaign.periodDays).toBe(15);
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
  });

  it('includes the CTA button when ctaUrl is set', () => {
    const html = fifteenDayInspirationCampaign.buildHtml(makeContext());
    expect(html).toContain('Continue Today');
    expect(html).toContain('https://mantra-japam.vercel.app');
  });

  it('includes the Bhagavad Gita verse, clearly attributed', () => {
    const html = fifteenDayInspirationCampaign.buildHtml(makeContext());
    expect(html).toContain('Bhagavad Gita');
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
    // The copy must read correctly for long-time practitioners too, not
    // just someone on literally day 15 — see campaignService's "too new"
    // eligibility gate, which only guarantees >= 15 days of history, not
    // exactly 15.
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

  it('omits the CTA line when ctaUrl is empty', () => {
    const ctx = makeContext({ config: { ...loadEmailConfig(), ctaUrl: '' } });
    const text = fifteenDayInspirationCampaign.buildText(ctx);
    expect(text).not.toContain('Continue today');
  });
});
