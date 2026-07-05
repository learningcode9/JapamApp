// Centralized, environment-driven configuration for all email campaigns.
// Nothing in this file is campaign-specific — campaign content lives under
// `campaigns/`. Adding a new brand knob (a color, a social link) means adding
// one field here, not touching every campaign or template file.

export interface BrandColors {
  primary: string;
  primaryDark: string;
  accent: string;
  background: string;
  cardBackground: string;
  textPrimary: string;
  textMuted: string;
}

export interface SocialLink {
  label: string;
  url: string;
}

export interface EmailConfig {
  /** "Name <email>" — passed straight to the provider's `from` field. */
  fromAddress: string;
  senderName: string;
  /** Base app/web URL used to build the CTA link when no override is given. */
  appUrl: string;
  /** CTA destination — falls back to `appUrl` when not explicitly set. */
  ctaUrl: string;
  /** Public URL of a hosted logo image. Optional — templates fall back to a text/emoji mark when unset. */
  logoUrl: string;
  /** Public URL of a hosted hero photo. Optional — templates fall back to a CSS gradient hero when unset. */
  heroImageUrl: string;
  /** Destination for a footer "unsubscribe" link. Required before any real production send. */
  unsubscribeUrl: string;
  colors: BrandColors;
  socialLinks: SocialLink[];
  /** Default interval (days) for campaigns that don't specify their own. */
  defaultPeriodDays: number;
}

// Calm/Headspace-inspired palette: soft sage + warm cream, not the older
// brown/deity-styled palette used by the existing stats-digest template.
const DEFAULT_COLORS: BrandColors = {
  primary: '#4B7F6B',
  primaryDark: '#365E4E',
  accent: '#E8A868',
  background: '#F7F5F0',
  cardBackground: '#FFFFFF',
  textPrimary: '#2E3B36',
  textMuted: '#6B7C76',
};

function parseSocialLinks(raw: string | undefined): SocialLink[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map(pair => pair.trim())
    .filter(Boolean)
    .map(pair => {
      const [label, url] = pair.split('|').map(s => s.trim());
      return label && url ? { label, url } : null;
    })
    .filter((v): v is SocialLink => v !== null);
}

/**
 * Loads campaign-agnostic config from environment variables, with sensible
 * defaults so the system still renders a complete, good-looking email when
 * only the required Supabase/email vars are set.
 */
export function loadEmailConfig(): EmailConfig {
  const fromAddress = process.env.EMAIL_FROM_ADDRESS ?? 'Japam App <noreply@japamapp.com>';
  const senderName =
    process.env.EMAIL_SENDER_NAME ?? (fromAddress.split('<')[0].trim() || 'Japam App');
  const appUrl = process.env.APP_URL ?? '';

  return {
    fromAddress,
    senderName,
    appUrl,
    ctaUrl: process.env.EMAIL_CTA_URL ?? appUrl,
    logoUrl: process.env.EMAIL_LOGO_URL ?? '',
    heroImageUrl: process.env.EMAIL_HERO_IMAGE_URL ?? '',
    unsubscribeUrl: process.env.EMAIL_UNSUBSCRIBE_URL ?? '',
    colors: {
      primary: process.env.EMAIL_COLOR_PRIMARY ?? DEFAULT_COLORS.primary,
      primaryDark: process.env.EMAIL_COLOR_PRIMARY_DARK ?? DEFAULT_COLORS.primaryDark,
      accent: process.env.EMAIL_COLOR_ACCENT ?? DEFAULT_COLORS.accent,
      background: process.env.EMAIL_COLOR_BACKGROUND ?? DEFAULT_COLORS.background,
      cardBackground: process.env.EMAIL_COLOR_CARD ?? DEFAULT_COLORS.cardBackground,
      textPrimary: process.env.EMAIL_COLOR_TEXT ?? DEFAULT_COLORS.textPrimary,
      textMuted: process.env.EMAIL_COLOR_TEXT_MUTED ?? DEFAULT_COLORS.textMuted,
    },
    socialLinks: parseSocialLinks(process.env.EMAIL_SOCIAL_LINKS),
    defaultPeriodDays: Number(process.env.PERIOD_DAYS) || 15,
  };
}
