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
