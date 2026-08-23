import { ensureCliRealSendAuthorized } from '../sendCampaignEmail';

describe('sendCampaignEmail CLI real-send guard', () => {
  it('blocks the CLI when send mode is missing', async () => {
    await expect(ensureCliRealSendAuthorized(() => undefined)).rejects.toThrow(
      /EMAIL_SEND_MODE/,
    );
  });

  it('allows the CLI only after shared production authorization passes', async () => {
    const values: Record<string, string> = {
      EMAIL_SEND_MODE: 'production',
      EMAIL_PRODUCTION_CONFIRMATION: 'SEND_TO_ALL_ELIGIBLE_USERS',
    };

    await expect(ensureCliRealSendAuthorized(name => values[name])).resolves.toBeUndefined();
  });
});
