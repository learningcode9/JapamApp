import {
  createCampaignEmailProvider,
  EmailProviderError,
  GmailProvider,
  ResendProvider,
} from '../email/emailProvider';

const ORIGINAL_ENV = { ...process.env };

function gmailMessage() {
  return {
    to: 'user@example.com',
    from: 'Ignored by GmailProvider <unused@example.com>',
    subject: '🪷 Subject',
    html: '<p>HTML body</p>',
    text: 'Text body',
    idempotencyKey: '15day_inspiration/u1/2026-08-22',
  };
}

function decodeBase64Url(value: string): string {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

describe('ResendProvider', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    process.env = { ...ORIGINAL_ENV };
  });

  it('passes the stable idempotency key to Resend', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'msg-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await new ResendProvider('re_test').sendEmail({
      to: 'user@example.com',
      from: 'Japam App <noreply@example.com>',
      subject: 'Subject',
      html: '<p>Body</p>',
      text: 'Body',
      idempotencyKey: '15day_inspiration/u1/2026-08-08',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.resend.com/emails',
      expect.objectContaining({
        headers: expect.objectContaining({
          'Idempotency-Key': '15day_inspiration/u1/2026-08-08',
        }),
      }),
    );
  });

  it('does not return success when Resend returns an error', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response('rate limited', { status: 429 }));

    await expect(
      new ResendProvider('re_test').sendEmail({
        to: 'user@example.com',
        from: 'Japam App <noreply@example.com>',
        subject: 'Subject',
        html: '<p>Body</p>',
        text: 'Body',
      }),
    ).rejects.toThrow('HTTP 429');
  });

  it('marks network/5xx failures as unsafe for automatic retry', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response('server error', { status: 500 }));

    let error: unknown;
    try {
      await new ResendProvider('re_test').sendEmail({
        to: 'user@example.com',
        from: 'Japam App <noreply@example.com>',
        subject: 'Subject',
        html: '<p>Body</p>',
        text: 'Body',
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(EmailProviderError);
    expect((error as EmailProviderError).safeToRetry).toBe(false);
  });
});

describe('GmailProvider', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    process.env = { ...ORIGINAL_ENV };
  });

  it('refreshes an access token and sends base64url-encoded MIME without storing the token', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'access-token-test', expires_in: 3600 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'gmail-message-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

    const result = await new GmailProvider({
      clientId: 'client-id-test',
      clientSecret: 'client-secret-test',
      refreshToken: 'refresh-token-test',
      senderEmail: 'mantrajapamapp@gmail.com',
    }).sendEmail(gmailMessage());

    expect(result).toEqual({ messageId: 'gmail-message-1' });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const tokenRequest = fetchMock.mock.calls[0][1] as RequestInit;
    const tokenParams = new URLSearchParams(String(tokenRequest.body));
    expect(fetchMock.mock.calls[0][0]).toBe('https://oauth2.googleapis.com/token');
    expect(tokenParams.get('grant_type')).toBe('refresh_token');
    expect(tokenParams.get('client_id')).toBe('client-id-test');
    expect(tokenParams.get('client_secret')).toBe('client-secret-test');
    expect(tokenParams.get('refresh_token')).toBe('refresh-token-test');

    const sendRequest = fetchMock.mock.calls[1][1] as RequestInit;
    expect(fetchMock.mock.calls[1][0]).toBe(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
    );
    expect(sendRequest.headers).toEqual({
      Authorization: 'Bearer access-token-test',
      'Content-Type': 'application/json',
    });
    const raw = (JSON.parse(String(sendRequest.body)) as { raw: string }).raw;
    const mime = decodeBase64Url(raw);
    expect(mime).toContain('From: mantrajapamapp@gmail.com');
    expect(mime).toContain('To: user@example.com');
    expect(mime).toContain('Subject: =?UTF-8?B?');
    expect(mime).toContain('Message-ID: <');
    expect(mime).toContain(Buffer.from('HTML body').toString('base64'));
    expect(mime).toContain(Buffer.from('Text body').toString('base64'));
  });

  it('treats a deterministic token endpoint failure as retryable', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response('invalid grant', { status: 400 }));

    await expect(
      new GmailProvider({
        clientId: 'client-id-test',
        clientSecret: 'client-secret-test',
        refreshToken: 'refresh-token-test',
        senderEmail: 'mantrajapamapp@gmail.com',
      }).sendEmail(gmailMessage()),
    ).rejects.toMatchObject({ safeToRetry: true });
  });

  it('marks an ambiguous Gmail send failure unsafe to retry', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'access-token-test' }), { status: 200 }))
      .mockResolvedValueOnce(new Response('upstream failure', { status: 503 }));

    await expect(
      new GmailProvider({
        clientId: 'client-id-test',
        clientSecret: 'client-secret-test',
        refreshToken: 'refresh-token-test',
        senderEmail: 'mantrajapamapp@gmail.com',
      }).sendEmail(gmailMessage()),
    ).rejects.toMatchObject({ safeToRetry: false });
  });

  it('selects Gmail only when EMAIL_PROVIDER explicitly opts into it', () => {
    process.env.EMAIL_PROVIDER = 'gmail';
    process.env.GMAIL_CLIENT_ID = 'client-id-test';
    process.env.GMAIL_CLIENT_SECRET = 'client-secret-test';
    process.env.GMAIL_REFRESH_TOKEN = 'refresh-token-test';
    process.env.GMAIL_SENDER_EMAIL = 'mantrajapamapp@gmail.com';

    expect(createCampaignEmailProvider()).toBeInstanceOf(GmailProvider);
  });
});
