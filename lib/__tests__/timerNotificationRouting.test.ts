import {
  isTimerNotificationResponse,
  registerTimerNotificationResponseListener,
} from '../timerNotificationRouting';

const response = (content: Record<string, unknown>) => ({
  notification: { request: { identifier: 'notification-1', content } },
}) as any;

describe('timer notification routing', () => {
  it('recognizes a running timer notification', () => {
    expect(isTimerNotificationResponse(response({ channelId: 'japam-timer' }))).toBe(true);
  });

  it('recognizes a completion notification', () => {
    expect(isTimerNotificationResponse(response({ channelId: 'japam-complete' }))).toBe(true);
    expect(isTimerNotificationResponse(response({ title: 'Mala completed' }))).toBe(true);
  });

  it('recognizes the running notification body fallback', () => {
    expect(isTimerNotificationResponse(response({ body: 'Japam Timer — 01:00 remaining' }))).toBe(true);
  });

  it('ignores unrelated notifications and missing responses', () => {
    expect(isTimerNotificationResponse(null)).toBe(false);
    expect(isTimerNotificationResponse(response({ channelId: 'other-channel', title: 'Reminder' }))).toBe(false);
  });

  it('routes the live and cold-start response paths once, then clears the last response', async () => {
    let lastResponse: any = response({ channelId: 'japam-complete', title: 'Mala completed' });
    let listener: ((value: any) => void) | null = null;
    const remove = jest.fn();
    const notifications = {
      addNotificationResponseReceivedListener: jest.fn((next: (value: any) => void) => {
        listener = next;
        return { remove };
      }),
      getLastNotificationResponseAsync: jest.fn(async () => lastResponse),
      clearLastNotificationResponseAsync: jest.fn(async () => { lastResponse = null; }),
    };
    const router = { push: jest.fn() };

    const registration = registerTimerNotificationResponseListener(notifications, router);
    await Promise.resolve();
    await Promise.resolve();
    expect(router.push).toHaveBeenCalledTimes(1);
    expect(notifications.clearLastNotificationResponseAsync).toHaveBeenCalledTimes(1);

    const liveListener = listener as ((value: any) => void) | null;
    if (liveListener) liveListener(response({ channelId: 'japam-complete', title: 'Mala completed' }));
    await Promise.resolve();
    expect(router.push).toHaveBeenCalledTimes(1);

    registration.remove();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(await notifications.getLastNotificationResponseAsync()).toBeNull();
  });
});
