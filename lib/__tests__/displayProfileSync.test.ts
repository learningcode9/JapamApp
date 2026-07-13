jest.mock('../displayProfileService', () => ({
  saveMyDisplayProfile: jest.fn(),
}));

import { saveMyDisplayProfile } from '../displayProfileService';
import {
  DisplayProfileSyncController,
  DisplayProfileSyncLifecycle,
} from '../displayProfileSync';

const mockedSave = saveMyDisplayProfile as jest.Mock;

const providerSession = (id = 'uuid-a', name = 'Bellam') => ({
  user: { id, user_metadata: { given_name: name } },
});

const providerSessionWithMetadata = (metadata: Record<string, unknown>, id = 'uuid-a') => ({
  user: { id, user_metadata: metadata },
});

describe('DisplayProfileSyncController', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('creates a provider profile for the first authenticated provider session', async () => {
    mockedSave.mockResolvedValue({ kind: 'updated', profile: {} });
    const controller = new DisplayProfileSyncController();

    await controller.sync(providerSession(), 'SIGNED_IN');

    expect(mockedSave).toHaveBeenCalledWith({ displayName: 'Bellam', nameSource: 'provider' });
  });

  it('uses a trimmed Google given_name instead of the provider full name', async () => {
    mockedSave.mockResolvedValue({ kind: 'updated', profile: {} });
    const controller = new DisplayProfileSyncController();

    await controller.sync(providerSessionWithMetadata({
      given_name: '  Sravani  ',
      name: 'Sravani Bellam',
    }), 'SIGNED_IN');

    expect(mockedSave).toHaveBeenCalledWith({ displayName: 'Sravani', nameSource: 'provider' });
  });

  it('uses only the first word of Google name when given_name is absent', async () => {
    mockedSave.mockResolvedValue({ kind: 'updated', profile: {} });
    const controller = new DisplayProfileSyncController();

    await controller.sync(providerSessionWithMetadata({ name: '  Subbarao Bellam  ' }), 'SIGNED_IN');

    expect(mockedSave).toHaveBeenCalledWith({ displayName: 'Subbarao', nameSource: 'provider' });
  });

  it('uses a one-word Google name when given_name is absent', async () => {
    mockedSave.mockResolvedValue({ kind: 'updated', profile: {} });
    const controller = new DisplayProfileSyncController();

    await controller.sync(providerSessionWithMetadata({ name: 'Subbarao' }), 'SIGNED_IN');

    expect(mockedSave).toHaveBeenCalledWith({ displayName: 'Subbarao', nameSource: 'provider' });
  });

  it('syncs a restored session and provider-name change, but not a repeated identical event', async () => {
    mockedSave.mockResolvedValue({ kind: 'updated', profile: {} });
    const controller = new DisplayProfileSyncController();

    await controller.sync(providerSession(), 'INITIAL_SESSION');
    await controller.sync(providerSession(), 'TOKEN_REFRESHED');
    await controller.sync(providerSession('uuid-a', 'Bellam Reddy'), 'USER_UPDATED');

    expect(mockedSave).toHaveBeenCalledTimes(2);
    expect(mockedSave).toHaveBeenLastCalledWith({
      displayName: 'Bellam Reddy',
      nameSource: 'provider',
    });
  });

  it('ignores a slower initial-session result after a newer auth event', async () => {
    mockedSave.mockResolvedValue({ kind: 'updated', profile: {} });
    const lifecycle = new DisplayProfileSyncLifecycle(new DisplayProfileSyncController());

    await lifecycle.handleAuthEvent('SIGNED_IN', providerSession('uuid-b', 'Bala'));
    await lifecycle.handleInitialSession(providerSession('uuid-a', 'Bellam'));

    expect(mockedSave).toHaveBeenCalledTimes(1);
    expect(mockedSave).toHaveBeenCalledWith({ displayName: 'Bala', nameSource: 'provider' });
  });

  it('keeps a manual profile protected and suppresses later provider refreshes for that user session', async () => {
    mockedSave.mockResolvedValue({
      kind: 'updated',
      profile: { displayName: 'Sravani Bellam', nameSource: 'manual' },
    });
    const controller = new DisplayProfileSyncController();

    await controller.sync(providerSession('uuid-a', 'Bellam'), 'TOKEN_REFRESHED');
    await controller.sync(providerSession('uuid-a', 'Bellam Reddy'), 'TOKEN_REFRESHED');

    expect(mockedSave).toHaveBeenCalledTimes(1);
    expect(mockedSave).toHaveBeenCalledWith({ displayName: 'Bellam', nameSource: 'provider' });
  });

  it('does not call the RPC for blank provider metadata, full_name-only metadata, or an unauthenticated session', async () => {
    const controller = new DisplayProfileSyncController();

    await controller.sync(providerSessionWithMetadata({ given_name: '  ', name: '   ' }), 'INITIAL_SESSION');
    await controller.sync(providerSessionWithMetadata({ full_name: 'Sravani Bellam' }), 'TOKEN_REFRESHED');
    await controller.sync(null, 'SIGNED_OUT');

    expect(mockedSave).not.toHaveBeenCalled();
  });

  it('syncs again when the authenticated UUID changes', async () => {
    mockedSave.mockResolvedValue({ kind: 'updated', profile: {} });
    const controller = new DisplayProfileSyncController();

    await controller.sync(providerSession('uuid-a', 'Bellam'), 'INITIAL_SESSION');
    await controller.sync(providerSession('uuid-b', 'Bellam'), 'SIGNED_IN');

    expect(mockedSave).toHaveBeenCalledTimes(2);
  });

  it('ignores an in-flight result after sign-out, so it cannot mark a signed-out session as synced', async () => {
    let resolveFirst: (value: unknown) => void = () => {};
    mockedSave.mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }));
    mockedSave.mockResolvedValueOnce({ kind: 'updated', profile: {} });
    const controller = new DisplayProfileSyncController();

    const first = controller.sync(providerSession(), 'INITIAL_SESSION');
    controller.reset();
    resolveFirst({ kind: 'updated', profile: {} });
    await first;
    await controller.sync(providerSession(), 'SIGNED_IN');

    expect(mockedSave).toHaveBeenCalledTimes(2);
  });

  it('does not allow an in-flight account A result to overwrite account B guard state', async () => {
    let resolveA: (value: unknown) => void = () => {};
    mockedSave.mockImplementationOnce(() => new Promise((resolve) => { resolveA = resolve; }));
    mockedSave.mockResolvedValueOnce({ kind: 'updated', profile: {} });
    const controller = new DisplayProfileSyncController();

    const accountA = controller.sync(providerSession('uuid-a', 'Bellam'), 'INITIAL_SESSION');
    await controller.sync(providerSession('uuid-b', 'Bala'), 'SIGNED_IN');
    resolveA({ kind: 'updated', profile: {} });
    await accountA;
    await controller.sync(providerSession('uuid-b', 'Bala'), 'TOKEN_REFRESHED');

    expect(mockedSave).toHaveBeenCalledTimes(2);
  });

  it('sign-out resets only its in-memory guard', async () => {
    mockedSave.mockResolvedValue({ kind: 'updated', profile: {} });
    const controller = new DisplayProfileSyncController();

    await controller.sync(providerSession(), 'INITIAL_SESSION');
    controller.reset();
    await controller.sync(providerSession(), 'SIGNED_IN');

    expect(mockedSave).toHaveBeenCalledTimes(2);
  });

  it('does not throw or block on a failed RPC, then retries successfully with a bounded timer', async () => {
    mockedSave
      .mockResolvedValueOnce({ kind: 'error', message: 'network unavailable' })
      .mockResolvedValueOnce({ kind: 'updated', profile: {} });
    const controller = new DisplayProfileSyncController({ retryDelayMs: 10, maxRetries: 1 });

    await expect(controller.sync(providerSession(), 'INITIAL_SESSION')).resolves.toBeUndefined();
    await jest.advanceTimersByTimeAsync(10);
    await jest.runOnlyPendingTimersAsync();

    expect(mockedSave).toHaveBeenCalledTimes(2);
  });

  it('cancels a pending retry on sign-out', async () => {
    mockedSave.mockResolvedValue({ kind: 'error', message: 'network unavailable' });
    const controller = new DisplayProfileSyncController({ retryDelayMs: 10, maxRetries: 1 });

    await controller.sync(providerSession('uuid-a', 'Bellam'), 'INITIAL_SESSION');
    controller.reset();
    await jest.advanceTimersByTimeAsync(10);
    await jest.runOnlyPendingTimersAsync();

    expect(mockedSave).toHaveBeenCalledTimes(1);
  });

  it('cancels account A retry when the authenticated session changes to account B', async () => {
    mockedSave
      .mockResolvedValueOnce({ kind: 'error', message: 'network unavailable' })
      .mockResolvedValueOnce({ kind: 'updated', profile: {} });
    const controller = new DisplayProfileSyncController({ retryDelayMs: 10, maxRetries: 1 });

    await controller.sync(providerSession('uuid-a', 'Bellam'), 'INITIAL_SESSION');
    await controller.sync(providerSession('uuid-b', 'Bala'), 'SIGNED_IN');
    await jest.advanceTimersByTimeAsync(10);
    await jest.runOnlyPendingTimersAsync();

    expect(mockedSave).toHaveBeenCalledTimes(2);
  });

  it('does not multiply retry chains for repeated identical failed auth events', async () => {
    mockedSave.mockResolvedValue({ kind: 'error', message: 'network unavailable' });
    const controller = new DisplayProfileSyncController({ retryDelayMs: 10, maxRetries: 1 });

    await controller.sync(providerSession(), 'INITIAL_SESSION');
    await controller.sync(providerSession(), 'USER_UPDATED');
    await jest.advanceTimersByTimeAsync(10);
    await jest.runOnlyPendingTimersAsync();

    expect(mockedSave).toHaveBeenCalledTimes(2);
  });

  it('retries a failed profile sync after a token-refresh recovery event', async () => {
    mockedSave
      .mockResolvedValueOnce({ kind: 'error', message: 'network unavailable' })
      .mockResolvedValueOnce({ kind: 'updated', profile: {} });
    const controller = new DisplayProfileSyncController({ maxRetries: 0 });

    await controller.sync(providerSession(), 'INITIAL_SESSION');
    await controller.sync(providerSession(), 'TOKEN_REFRESHED', true);

    expect(mockedSave).toHaveBeenCalledTimes(2);
  });

  it('rechecks a manual server result on session recovery so a future provider-source reset is respected', async () => {
    mockedSave
      .mockResolvedValueOnce({
        kind: 'updated',
        profile: { displayName: 'Subbarao', nameSource: 'manual' },
      })
      .mockResolvedValueOnce({
        kind: 'updated',
        profile: { displayName: 'Bellam Reddy', nameSource: 'provider' },
      });
    const controller = new DisplayProfileSyncController();

    await controller.sync(providerSession('uuid-a', 'Bellam'), 'INITIAL_SESSION');
    await controller.sync(providerSession('uuid-a', 'Bellam Reddy'), 'TOKEN_REFRESHED', true);

    expect(mockedSave).toHaveBeenCalledTimes(2);
  });

  it('treats an oversized provider name as a controlled background failure', async () => {
    mockedSave.mockResolvedValue({ kind: 'error', message: 'Display name must be 80 characters or fewer.' });
    const controller = new DisplayProfileSyncController({ maxRetries: 0 });

    await expect(controller.sync(providerSession('uuid-a', 'A'.repeat(81)), 'INITIAL_SESSION')).resolves.toBeUndefined();

    expect(mockedSave).toHaveBeenCalledWith({ displayName: 'A'.repeat(81), nameSource: 'provider' });
  });

  it('logs only sanitized status, never a UUID, display name, email, or token', async () => {
    const log = jest.fn();
    mockedSave.mockResolvedValue({ kind: 'error', message: 'network unavailable' });
    const controller = new DisplayProfileSyncController({ log, maxRetries: 0 });
    const sensitiveSession = {
      user: {
        id: 'uuid-secret-123',
        email: 'private@example.com',
        user_metadata: { given_name: 'Private Name', access_token: 'token-secret' },
      },
    };

    await controller.sync(sensitiveSession, 'INITIAL_SESSION');

    const output = log.mock.calls.flat().join(' ');
    expect(output).not.toContain('uuid-secret-123');
    expect(output).not.toContain('private@example.com');
    expect(output).not.toContain('Private Name');
    expect(output).not.toContain('token-secret');
  });
});
