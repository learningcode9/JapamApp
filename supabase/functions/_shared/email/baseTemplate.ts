// Shared, reusable HTML "chrome" for every campaign email: hero banner,
// header, CTA button, and footer. Campaign-specific modules (see
// `campaigns/`) only ever supply a content slot and a hero headline — they
// never redefine layout, so a new campaign cannot accidentally diverge from
// the responsive/table-based structure this file gets right once.
//
// Table-based layout with inline styles throughout is intentional, not
// legacy habit: it is the only markup style that renders consistently across
// Gmail, Apple Mail, and Outlook (which uses Word's rendering engine and
// ignores most modern CSS, including flexbox/grid and external stylesheets).

import type { EmailConfig } from './config';

export interface HeroContent {
  /** Short line above the headline, e.g. "🪷 Japam App". Optional. */
  eyebrow?: string;
  headline: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderHero(hero: HeroContent, config: EmailConfig): string {
  const eyebrowHtml = hero.eyebrow
    ? `<p style="margin:0 0 10px;color:rgba(255,255,255,0.85);font-size:13px;
              letter-spacing:0.12em;text-transform:uppercase;">${escapeHtml(hero.eyebrow)}</p>`
    : '';

  // Prefer a real hosted photo when configured; otherwise fall back to a
  // CSS gradient. The gradient path also guarantees the hero always renders
  // even with images disabled (the Gmail/Outlook default), which a bare
  // <img>-only hero would not.
  const backgroundStyle = config.heroImageUrl
    ? `background-image:url('${config.heroImageUrl}');background-size:cover;background-position:center;`
    : `background:linear-gradient(135deg,${config.colors.primary} 0%,${config.colors.primaryDark} 100%);`;

  return `<tr><td style="${backgroundStyle}padding:56px 32px;text-align:center;">
    ${eyebrowHtml}
    <h1 style="margin:0;color:#ffffff;font-size:28px;line-height:1.35;font-weight:600;
               font-family:Georgia,'Times New Roman',serif;text-shadow:0 1px 3px rgba(0,0,0,0.2);">
      ${escapeHtml(hero.headline)}
    </h1>
    <div style="margin-top:18px;font-size:22px;letter-spacing:0.3em;color:rgba(255,255,255,0.75);">
      🪷&nbsp;&nbsp;🌅&nbsp;&nbsp;🪷
    </div>
  </td></tr>`;
}

/**
 * Only rendered when a real hosted logo image is configured. Without one,
 * the hero's text eyebrow already carries the brand mark — stacking a
 * second text-only "🪷 Japam App" row directly below it would just repeat
 * the same line twice.
 */
function renderLogoBar(config: EmailConfig): string {
  if (!config.logoUrl) return '';
  return `<tr><td style="padding:20px 32px 0;text-align:center;">
    <img src="${config.logoUrl}" alt="${escapeHtml(config.senderName)}" height="28" style="display:block;margin:0 auto;border:0;" />
  </td></tr>`;
}

function renderCta(label: string, config: EmailConfig): string {
  if (!config.ctaUrl) return '';
  return `<tr><td align="center" style="padding:32px 32px 8px;">
    <a href="${config.ctaUrl}"
       style="background:${config.colors.primary};color:#ffffff;text-decoration:none;
              padding:16px 40px;border-radius:999px;font-size:16px;font-weight:600;
              display:inline-block;font-family:Georgia,'Times New Roman',serif;">
      ${escapeHtml(label)}
    </a>
  </td></tr>`;
}

function renderFooter(config: EmailConfig): string {
  const socialHtml = config.socialLinks.length
    ? `<p style="margin:0 0 10px;">
        ${config.socialLinks
          .map(
            link =>
              `<a href="${link.url}" style="color:${config.colors.textMuted};text-decoration:underline;font-size:12px;margin:0 8px;">${escapeHtml(link.label)}</a>`,
          )
          .join('')}
      </p>`
    : '';

  const unsubscribeHtml = config.unsubscribeUrl
    ? `<a href="${config.unsubscribeUrl}" style="color:${config.colors.textMuted};text-decoration:underline;">Unsubscribe</a>`
    : 'Manage email preferences in the app';

  return `<tr><td style="padding:28px 32px;text-align:center;border-top:1px solid rgba(0,0,0,0.06);">
    ${socialHtml}
    <p style="margin:0;color:${config.colors.textMuted};font-size:12px;line-height:1.8;">
      You're receiving this because you have an active ${escapeHtml(config.senderName)} account.<br/>
      ${unsubscribeHtml}
    </p>
  </td></tr>`;
}

/**
 * Wraps campaign-specific content HTML in the shared hero/header/CTA/footer
 * shell. `contentHtml` must be a sequence of `<tr>` rows (this function
 * places it inside the same outer table as the hero/footer).
 */
export function renderCampaignEmail(params: {
  title: string;
  hero: HeroContent;
  contentHtml: string;
  ctaLabel?: string;
  config: EmailConfig;
}): string {
  const { title, hero, contentHtml, ctaLabel, config } = params;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:${config.colors.background};font-family:Georgia,'Times New Roman',serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:${config.colors.background};padding:32px 16px;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0"
       style="max-width:600px;width:100%;background:${config.colors.cardBackground};border-radius:16px;
              overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">

  ${renderHero(hero, config)}
  ${renderLogoBar(config)}
  ${contentHtml}
  ${ctaLabel ? renderCta(ctaLabel, config) : ''}
  ${renderFooter(config)}

</table>
</td></tr>
</table>
</body>
</html>`;
}
