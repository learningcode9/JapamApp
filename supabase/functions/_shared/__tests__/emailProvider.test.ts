import { EmailProviderError, ResendProvider } from '../email/emailProvider';

describe('ResendProvider', () => {
  afterEach(() => {
    jest.restoreAllMocks();
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
