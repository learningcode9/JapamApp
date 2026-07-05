// Campaign: 15-Day Inspiration (GitHub Issue #25)
//
// A peaceful, encouraging nudge sent every 15 days — deliberately not a
// stats-heavy digest. It leads with feeling ("you are closer to inner
// peace"), backs that up with a few gentle numbers, and closes with a
// devotional reflection. No deity imagery, so it reads as welcoming to any
// background; the Bhagavad Gita verse is included as optional inspirational
// content, clearly attributed, alongside a more universal reflection line.

import type { CampaignDefinition, CampaignContext } from './types';
import { renderCampaignEmail } from '../baseTemplate';

function fmtDate(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
}

function buildHtml(ctx: CampaignContext): string {
  const { stats, lifetimeTotalMalas, config } = ctx;

  const bestDayLine = stats.bestDay
    ? `${fmtDate(stats.bestDay.date)} — ${stats.bestDay.malas} mala${stats.bestDay.malas !== 1 ? 's' : ''}`
    : 'a quiet stretch — every practice still counts';

  const streakLine =
    stats.longestStreak > 1
      ? `You've kept a ${stats.longestStreak}-day streak going. That kind of consistency is its own reward.`
      : `Consistency builds slowly — even one session this period is a step forward.`;

  const content = `
  <tr><td style="padding:32px 32px 4px;">
    <p style="margin:0;font-size:17px;color:${config.colors.textPrimary};">
      Hello, <strong>${stats.userName}</strong> 🙏
    </p>
    <p style="margin:14px 0 0;font-size:15px;line-height:1.75;color:${config.colors.textPrimary};">
      Fifteen days ago, you began another small chapter of your Japam practice.
      Whatever the pace, showing up for even a few quiet minutes is enough —
      the practice itself is the point, not the count.
    </p>
  </td></tr>

  <tr><td style="padding:20px 32px 0;">
    <table width="100%" cellpadding="0" cellspacing="0"
           style="border-radius:12px;overflow:hidden;border:1px solid rgba(0,0,0,0.06);">
      <tr style="background:${config.colors.background};">
        <td style="padding:14px 20px;font-size:14px;color:${config.colors.textPrimary};">🪷 Malas in the last 15 days</td>
        <td align="right" style="padding:14px 20px;font-size:18px;font-weight:700;color:${config.colors.primary};">${stats.totalMalas.toLocaleString()}</td>
      </tr>
      <tr>
        <td style="padding:14px 20px;font-size:14px;color:${config.colors.textPrimary};">📊 Daily average</td>
        <td align="right" style="padding:14px 20px;font-size:18px;font-weight:700;color:${config.colors.primary};">${stats.averageMalasPerActiveDay.toFixed(1)}</td>
      </tr>
      <tr style="background:${config.colors.background};">
        <td style="padding:14px 20px;font-size:14px;color:${config.colors.textPrimary};">✨ Best practice day</td>
        <td align="right" style="padding:14px 20px;font-size:15px;font-weight:600;color:${config.colors.primary};">${bestDayLine}</td>
      </tr>
      <tr>
        <td style="padding:14px 20px;font-size:14px;color:${config.colors.textPrimary};">📿 Lifetime malas</td>
        <td align="right" style="padding:14px 20px;font-size:18px;font-weight:700;color:${config.colors.primary};">${lifetimeTotalMalas.toLocaleString()}</td>
      </tr>
    </table>
  </td></tr>

  <tr><td style="padding:24px 32px 4px;">
    <p style="margin:0;font-size:14px;line-height:1.7;color:${config.colors.textMuted};">
      ${streakLine}
    </p>
  </td></tr>

  <tr><td style="padding:20px 32px 8px;">
    <div style="background:${config.colors.background};border-left:4px solid ${config.colors.accent};
                padding:20px 22px;border-radius:0 12px 12px 0;">
      <p style="margin:0 0 10px;color:${config.colors.textPrimary};font-style:italic;line-height:1.8;font-size:15px;">
        "You have the right to perform your duty, but never to the fruits of your actions."
      </p>
      <p style="margin:0;color:${config.colors.textMuted};font-size:12px;letter-spacing:0.03em;">
        — Bhagavad Gita, Chapter 2, Verse 47
      </p>
    </div>
  </td></tr>

  <tr><td style="padding:12px 32px 4px;">
    <p style="margin:0;font-size:14px;line-height:1.7;color:${config.colors.textMuted};font-style:italic;">
      Whatever your path, may these next fifteen days bring a little more stillness than the last.
    </p>
  </td></tr>`;

  return renderCampaignEmail({
    title: 'Every Mala Brings You Closer to Inner Peace',
    hero: {
      eyebrow: '🪷 Japam App',
      headline: 'Every Mala Brings You Closer to Inner Peace',
    },
    contentHtml: content,
    ctaLabel: 'Continue Today’s Japam',
    config,
  });
}

function buildText(ctx: CampaignContext): string {
  const { stats, lifetimeTotalMalas, config } = ctx;

  const bestDayLine = stats.bestDay
    ? `${fmtDate(stats.bestDay.date)} (${stats.bestDay.malas} malas)`
    : 'a quiet stretch — every practice still counts';

  const ctaText = config.ctaUrl ? `\n\nContinue today's Japam: ${config.ctaUrl}` : '';
  const unsubscribeText = config.unsubscribeUrl ? `\nUnsubscribe: ${config.unsubscribeUrl}` : '';

  return `Every Mala Brings You Closer to Inner Peace

Hello, ${stats.userName}!

Fifteen days ago, you began another small chapter of your Japam practice. Whatever the pace, showing up for even a few quiet minutes is enough — the practice itself is the point, not the count.

  Malas in the last 15 days: ${stats.totalMalas.toLocaleString()}
  Daily average:             ${stats.averageMalasPerActiveDay.toFixed(1)}
  Best practice day:         ${bestDayLine}
  Lifetime malas:            ${lifetimeTotalMalas.toLocaleString()}

"You have the right to perform your duty, but never to the fruits of your actions."
— Bhagavad Gita, Chapter 2, Verse 47

Whatever your path, may these next fifteen days bring a little more stillness than the last.${ctaText}

You're receiving this because you have an active ${config.senderName} account.${unsubscribeText}`;
}

export const fifteenDayInspirationCampaign: CampaignDefinition = {
  id: '15day_inspiration',
  periodDays: 15,
  subject: '🪷 Every Mala Brings You Closer to Inner Peace',
  buildHtml,
  buildText,
};
