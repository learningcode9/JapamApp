import type * as Notifications from 'expo-notifications';

export type TimerNotificationResponseApi = Pick<
  typeof Notifications,
  | 'addNotificationResponseReceivedListener'
  | 'getLastNotificationResponseAsync'
  | 'clearLastNotificationResponseAsync'
>;

type TimerRouter = {
  push: (href: string) => unknown;
};

export function isTimerNotificationResponse(
  response: Notifications.NotificationResponse | null | undefined
): boolean {
  const content = response?.notification.request.content as {
    channelId?: string;
    title?: string;
    body?: string;
  } | undefined;
  if (!content) return false;
  const channelId = String(content.channelId ?? '').toLowerCase();
  const title = String(content.title ?? '').toLowerCase();
  const body = String(content.body ?? '').toLowerCase();
  return channelId === 'japam-timer'
    || channelId === 'japam-complete'
    || body.includes('japam timer')
    || title.includes('time left')
    || title.includes('mala completed');
}

export function registerTimerNotificationResponseListener(
  notifications: TimerNotificationResponseApi,
  router: TimerRouter,
) {
  let handledNotificationId: string | null = null;

  const openTimerFromNotification = (response: Notifications.NotificationResponse | null) => {
    if (!response || !isTimerNotificationResponse(response)) return;
    const identifier = response.notification.request.identifier;
    if (handledNotificationId === identifier) return;
    handledNotificationId = identifier;
    router.push('/timer');
    void notifications.clearLastNotificationResponseAsync().catch(() => {});
  };

  const responseSub = notifications.addNotificationResponseReceivedListener(openTimerFromNotification);
  void notifications.getLastNotificationResponseAsync().then(openTimerFromNotification).catch(() => {});
  return responseSub;
}
