import type { EmailMessage, SendEmailResult } from './types.ts';
import { getEnv } from './env.ts';

export class EmailProviderError extends Error {
  constructor(message: string, public readonly safeToRetry: boolean) {
    super(message);
    this.name = 'EmailProviderError';
  }
}

// ─── Provider interface ────────────────────────────────────────────────────────

export interface EmailProvider {
  sendEmail(message: EmailMessage): Promise<SendEmailResult>;
}

export type CampaignEmailProviderKind = 'resend' | 'gmail';

const GMAIL_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GMAIL_SEND_ENDPOINT = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

// ─── Resend implementation ─────────────────────────────────────────────────────

interface ResendSuccessResponse {
  id: string;
}

export class ResendProvider implements EmailProvider {
  private readonly apiKey: string;

  constructor(apiKey: string) {
    if (!apiKey) throw new Error('ResendProvider: apiKey must not be empty');
    this.apiKey = apiKey;
  }

  async sendEmail(message: EmailMessage): Promise<SendEmailResult> {
    let response: Response;
    try {
      response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          ...(message.idempotencyKey ? { 'Idempotency-Key': message.idempotencyKey } : {}),
        },
        body: JSON.stringify({
          from: message.from,
          to: [message.to],
          subject: message.subject,
          html: message.html,
          text: message.text,
        }),
      });
    } catch (error) {
      throw new EmailProviderError(
        `Resend network error: ${error instanceof Error ? error.message : String(error)}`,
        false,
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '(no body)');
      throw new EmailProviderError(
        `Resend API error: HTTP ${response.status} — ${body}`,
        response.status !== 408 && response.status < 500,
      );
    }

    const data = (await response.json()) as ResendSuccessResponse;
    if (!data.id) throw new Error('Resend API returned success but no message id');
    return { messageId: data.id };
  }
}

// ─── Gmail implementation ────────────────────────────────────────────────────

export interface GmailProviderOptions {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  senderEmail: string;
  fetchImpl?: typeof fetch;
}

interface GmailTokenResponse {
  access_token?: unknown;
}

interface GmailSendResponse {
  id?: unknown;
}

function requireNonEmpty(name: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`GmailProvider: ${name} must not be empty`);
  return trimmed;
}

function assertSafeHeader(name: string, value: string): void {
  if (!value || /[\r\n]/.test(value)) {
    throw new Error(`GmailProvider: ${name} must be a non-empty single-line value`);
  }
}

function base64Encode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64UrlEncode(value: string): string {
  return base64Encode(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function wrapBase64(value: string): string {
  return value.match(/.{1,76}/g)?.join('\r\n') ?? '';
}

function normalizeCrlf(value: string): string {
  return value.replace(/\r\n|\r|\n/g, '\r\n');
}

function encodeMimeHeader(value: string): string {
  return `=?UTF-8?B?${base64Encode(value)}?=`;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function httpRetrySafety(status: number): boolean {
  return status !== 408 && status < 500;
}

export class GmailProvider implements EmailProvider {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly refreshToken: string;
  private readonly senderEmail: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GmailProviderOptions) {
    this.clientId = requireNonEmpty('clientId', options.clientId);
    this.clientSecret = requireNonEmpty('clientSecret', options.clientSecret);
    this.refreshToken = requireNonEmpty('refreshToken', options.refreshToken);
    this.senderEmail = requireNonEmpty('senderEmail', options.senderEmail);
    this.fetchImpl = options.fetchImpl ?? fetch;

    assertSafeHeader('senderEmail', this.senderEmail);
    if (!/^[^\s@]+@[^\s@]+$/.test(this.senderEmail)) {
      throw new Error('GmailProvider: senderEmail must be a valid email address');
    }
  }

  private async refreshAccessToken(): Promise<string> {
    let response: Response;
    try {
      response = await this.fetchImpl(GMAIL_TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: this.clientId,
          client_secret: this.clientSecret,
          refresh_token: this.refreshToken,
          grant_type: 'refresh_token',
        }),
      });
    } catch (error) {
      throw new EmailProviderError(
        `Gmail token network error: ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    }

    const body = await response.text().catch(() => '');
    if (!response.ok) {
      throw new EmailProviderError(
        `Gmail token endpoint error: HTTP ${response.status}`,
        httpRetrySafety(response.status),
      );
    }

    let data: GmailTokenResponse;
    try {
      data = JSON.parse(body) as GmailTokenResponse;
    } catch {
      throw new Error('Gmail token endpoint returned invalid JSON');
    }

    if (typeof data.access_token !== 'string' || !data.access_token) {
      throw new Error('Gmail token endpoint returned no access token');
    }
    return data.access_token;
  }

  private async buildMimeMessage(message: EmailMessage): Promise<string> {
    assertSafeHeader('to', message.to);
    assertSafeHeader('subject', message.subject);
    assertSafeHeader('from', this.senderEmail);

    const stableKey = message.idempotencyKey ?? `${message.to}\n${message.subject}`;
    const digest = await sha256Hex(stableKey);
    const boundary = `japam-alt-${digest.slice(0, 24)}`;
    const mimeMessageId = `<${digest}@japam.app>`;

    return [
      'MIME-Version: 1.0',
      `From: ${this.senderEmail}`,
      `To: ${message.to}`,
      `Subject: ${encodeMimeHeader(message.subject)}`,
      `Message-ID: ${mimeMessageId}`,
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      wrapBase64(base64Encode(normalizeCrlf(message.text))),
      `--${boundary}`,
      'Content-Type: text/html; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      wrapBase64(base64Encode(normalizeCrlf(message.html))),
      `--${boundary}--`,
      '',
    ].join('\r\n');
  }

  async sendEmail(message: EmailMessage): Promise<SendEmailResult> {
    const accessToken = await this.refreshAccessToken();
    const raw = base64UrlEncode(await this.buildMimeMessage(message));

    let response: Response;
    try {
      response = await this.fetchImpl(GMAIL_SEND_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ raw }),
      });
    } catch (error) {
      throw new EmailProviderError(
        `Gmail send network error: ${error instanceof Error ? error.message : String(error)}`,
        false,
      );
    }

    const body = await response.text().catch(() => '');
    if (!response.ok) {
      throw new EmailProviderError(
        `Gmail API error: HTTP ${response.status}`,
        httpRetrySafety(response.status),
      );
    }

    let data: GmailSendResponse;
    try {
      data = JSON.parse(body) as GmailSendResponse;
    } catch {
      throw new EmailProviderError('Gmail API returned invalid JSON after send', false);
    }

    if (typeof data.id !== 'string' || !data.id) {
      throw new EmailProviderError('Gmail API returned success but no message id', false);
    }
    return { messageId: data.id };
  }
}

// ─── Factory ───────────────────────────────────────────────────────────────────

/**
 * Reads RESEND_API_KEY from env and returns a configured provider.
 * Throws if the key is missing so callers fail loudly instead of silently.
 * In dry-run mode, pass `null` as the provider — the service handles that.
 */
export function createEmailProvider(): EmailProvider {
  const apiKey = getEnv('RESEND_API_KEY');
  if (!apiKey) {
    throw new Error(
      'RESEND_API_KEY is not set. ' +
        'Set it in your environment or use DRY_RUN=true to skip sending.',
    );
  }
  return new ResendProvider(apiKey);
}

function configuredProviderKind(): CampaignEmailProviderKind {
  const raw = getEnv('EMAIL_PROVIDER')?.trim().toLowerCase();
  if (!raw || raw === 'resend') return 'resend';
  if (raw === 'gmail') return 'gmail';
  throw new Error(`Unsupported EMAIL_PROVIDER "${raw}". Expected "resend" or "gmail".`);
}

/**
 * Campaign-only provider selection. Resend remains the default until the
 * non-secret EMAIL_PROVIDER setting is explicitly changed to "gmail".
 */
export function createCampaignEmailProvider(): EmailProvider {
  if (configuredProviderKind() === 'resend') return createEmailProvider();

  const missing = [
    'GMAIL_CLIENT_ID',
    'GMAIL_CLIENT_SECRET',
    'GMAIL_REFRESH_TOKEN',
    'GMAIL_SENDER_EMAIL',
  ].filter(name => !getEnv(name));
  if (missing.length > 0) {
    throw new Error(`Gmail provider requires: ${missing.join(', ')}.`);
  }

  return new GmailProvider({
    clientId: getEnv('GMAIL_CLIENT_ID')!,
    clientSecret: getEnv('GMAIL_CLIENT_SECRET')!,
    refreshToken: getEnv('GMAIL_REFRESH_TOKEN')!,
    senderEmail: getEnv('GMAIL_SENDER_EMAIL')!,
  });
}

export function getCampaignEmailProviderKind(): CampaignEmailProviderKind {
  return configuredProviderKind();
}
