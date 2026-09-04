export type NotificationEventType = 'DOWN' | 'RECOVERY' | 'RESOLVED_SUMMARY' | 'TEST';

export interface SafeNotificationPayload {
  eventType: NotificationEventType;
  monitorName: string;
  displayUrl: string;
  occurredAt: string | Date;
  errorType?: string | null;
  errorMessageSafe?: string | null;
  statusCode?: number | null;
  ttfbMs?: number | null;
  durationMs?: number | null;
  dashboardUrl?: string | null;
}

export interface RenderedNotification {
  telegramText: string;
}

export interface NotificationSendResult {
  messageId: string;
  providerMessageId: string | null;
}

export interface NotificationAdapter<TDestination> {
  send(
    payload: SafeNotificationPayload,
    destination: TDestination,
    messageId: string,
  ): Promise<NotificationSendResult>;
}

export interface TelegramDestination {
  botToken: string;
  chatId: string;
}
