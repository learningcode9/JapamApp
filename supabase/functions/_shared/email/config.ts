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
 * Parses EMAIL_ALLOWLIST (comma-separated addresses) into a lowercased Set,
 * or `null` when unset/whitespace-only — `null` means "no restriction,"
 * preserving today's behavior for anyone who hasn't set the var. Used by
 * dataAccess.ts's getActiveUsersInPeriod, the single shared choke point
 * every send passes through, so setting this var restricts every campaign
 * at once (intended for controlled testing against real data).
 *
 * Fails closed: if the var IS set to something (showing intent to
 * restrict) but it parses to zero valid addresses — e.g. "," or " , , " —
 * this throws instead of silently falling back to "no restriction". The
 * whole point of this var is to prevent accidentally emailing real users
 * during testing; silently treating a malformed value as "send to
 * everyone" would be the one failure mode this feature exists to avoid.
 */
export function parseAllowlist(raw: string | undefined): Set<string> | null {
  if (!raw || !raw.trim()) return null;
  const addresses = raw
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);

  if (addresses.length === 0) {
    throw new Error(
      `EMAIL_ALLOWLIST is set to "${raw}" but contains no valid addresses. ` +
        'Refusing to fall back to "no restriction" — fix the value or unset the var entirely.',
    );
  }

  return new Set(addresses);
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

// ─── Production-readiness validation ───────────────────────────────────────

/**
 * Checks the environment for the specific things that are safe to forget
 * when flipping DRY_RUN=false, and have already caused real problems in
 * this project: RESEND_API_KEY, EMAIL_FROM_ADDRESS still pointing at the
 * (confirmed NXDOMAIN) japamapp.com default, and no unsubscribe link
 * configured. Returns a list of problems — empty means clear to send.
 * Does not throw; see `assertProductionReady` for the throwing form used by
 * the CLI scripts before a real send.
 */
export function validateProductionEnv(): string[] {
  const problems: string[] = [];

  if (!process.env.RESEND_API_KEY) {
    problems.push('RESEND_API_KEY is not set — required for real sending.');
  }

  const fromAddress = process.env.EMAIL_FROM_ADDRESS;
  if (!fromAddress) {
    problems.push(
      'EMAIL_FROM_ADDRESS is not set — sending would silently fall back to the built-in ' +
        'default (noreply@japamapp.com), which is not a real, DNS-verified domain ' +
        '(confirmed NXDOMAIN). Set it explicitly to a domain you have verified with your ' +
        'email provider — see docs/CAMPAIGN_EMAIL_ARCHITECTURE.md, "DNS requirements".',
    );
  } else if (fromAddress.includes('japamapp.com')) {
    problems.push(
      'EMAIL_FROM_ADDRESS still references japamapp.com, which is not a registered domain. ' +
        'Use a real, DNS-verified sending domain.',
    );
  }

  if (!process.env.EMAIL_UNSUBSCRIBE_URL) {
    problems.push(
      'EMAIL_UNSUBSCRIBE_URL is not set — required before any real production send.',
    );
  }

  if (!(process.env.EXPO_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL)) {
    problems.push('EXPO_PUBLIC_SUPABASE_URL (or SUPABASE_URL) is not set.');
  }

  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    problems.push('SUPABASE_SERVICE_ROLE_KEY is not set.');
  }

  return problems;
}

/**
 * Throws with every problem listed at once (not just the first) if the
 * environment isn't ready for a real send. Call this — not
 * validateProductionEnv directly — from CLI entry points right before a
 * non-dry-run send, so a misconfigured environment fails loudly instead of
 * emailing users from a domain that doesn't exist.
 */
export function assertProductionReady(): void {
  const problems = validateProductionEnv();
  if (problems.length > 0) {
    throw new Error(
      `Refusing to send real emails — ${problems.length} production-readiness check(s) failed:\n` +
        problems.map(p => `  - ${p}`).join('\n'),
    );
  }
}
