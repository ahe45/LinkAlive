/**
 * Runtime string constants are used instead of TypeScript enums so values can
 * cross API, queue and database boundaries without numeric-enum surprises.
 */
export const MonitorLifecycle = {
  ACTIVE: 'ACTIVE',
  PAUSED: 'PAUSED',
  DELETED: 'DELETED',
} as const;
export type MonitorLifecycle = (typeof MonitorLifecycle)[keyof typeof MonitorLifecycle];

export const MonitorHealth = {
  PENDING: 'PENDING',
  UP: 'UP',
  SUSPECT: 'SUSPECT',
  DOWN: 'DOWN',
  RECOVERING: 'RECOVERING',
} as const;
export type MonitorHealth = (typeof MonitorHealth)[keyof typeof MonitorHealth];

export const HttpMethod = {
  GET: 'GET',
  HEAD: 'HEAD',
} as const;
export type HttpMethod = (typeof HttpMethod)[keyof typeof HttpMethod];

export const CheckSource = {
  SCHEDULED: 'SCHEDULED',
  MANUAL: 'MANUAL',
  TEST: 'TEST',
} as const;
export type CheckSource = (typeof CheckSource)[keyof typeof CheckSource];

export const CheckOutcome = {
  SUCCESS: 'SUCCESS',
  TARGET_FAILURE: 'TARGET_FAILURE',
  PLATFORM_ERROR: 'PLATFORM_ERROR',
  INCONCLUSIVE: 'INCONCLUSIVE',
} as const;
export type CheckOutcome = (typeof CheckOutcome)[keyof typeof CheckOutcome];

export const CheckErrorType = {
  DNS_ERROR: 'DNS_ERROR',
  CONNECT_TIMEOUT: 'CONNECT_TIMEOUT',
  CONNECTION_REFUSED: 'CONNECTION_REFUSED',
  TLS_ERROR: 'TLS_ERROR',
  TTFB_TIMEOUT: 'TTFB_TIMEOUT',
  REQUEST_TIMEOUT: 'REQUEST_TIMEOUT',
  REDIRECT_ERROR: 'REDIRECT_ERROR',
  HTTP_STATUS_MISMATCH: 'HTTP_STATUS_MISMATCH',
  CONTENT_MISMATCH: 'CONTENT_MISMATCH',
  RESPONSE_LIMIT_EXCEEDED: 'RESPONSE_LIMIT_EXCEEDED',
  NETWORK_ERROR: 'NETWORK_ERROR',
  PLATFORM_ERROR: 'PLATFORM_ERROR',
} as const;
export type CheckErrorType = (typeof CheckErrorType)[keyof typeof CheckErrorType];

export const ScheduledCheckStatus = {
  PENDING: 'PENDING',
  ENQUEUED: 'ENQUEUED',
  RUNNING: 'RUNNING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCELED: 'CANCELED',
} as const;
export type ScheduledCheckStatus = (typeof ScheduledCheckStatus)[keyof typeof ScheduledCheckStatus];

export const IncidentStatus = {
  OPEN: 'OPEN',
  RESOLVED: 'RESOLVED',
  CANCELED: 'CANCELED',
} as const;
export type IncidentStatus = (typeof IncidentStatus)[keyof typeof IncidentStatus];

export const IncidentClosureReason = {
  RECOVERED: 'RECOVERED',
  PAUSED: 'PAUSED',
  DELETED: 'DELETED',
  CONFIG_CHANGED: 'CONFIG_CHANGED',
} as const;
export type IncidentClosureReason =
  (typeof IncidentClosureReason)[keyof typeof IncidentClosureReason];

export const NotificationChannelType = {
  TELEGRAM: 'TELEGRAM',
} as const;
export type NotificationChannelType =
  (typeof NotificationChannelType)[keyof typeof NotificationChannelType];

export const NotificationEventType = {
  DOWN: 'DOWN',
  RECOVERY: 'RECOVERY',
  RESOLVED_SUMMARY: 'RESOLVED_SUMMARY',
  TEST: 'TEST',
} as const;
export type NotificationEventType =
  (typeof NotificationEventType)[keyof typeof NotificationEventType];

export const NotificationOutboxStatus = {
  PENDING: 'PENDING',
  ENQUEUED: 'ENQUEUED',
  PROCESSING: 'PROCESSING',
  RETRY: 'RETRY',
  SENT: 'SENT',
  FAILED: 'FAILED',
  CANCELED: 'CANCELED',
} as const;
export type NotificationOutboxStatus =
  (typeof NotificationOutboxStatus)[keyof typeof NotificationOutboxStatus];

export const NotificationDeliveryStatus = {
  ATTEMPTING: 'ATTEMPTING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  UNKNOWN: 'UNKNOWN',
} as const;
export type NotificationDeliveryStatus =
  (typeof NotificationDeliveryStatus)[keyof typeof NotificationDeliveryStatus];

export const MIN_MONITOR_INTERVAL_SECONDS = 5;
export const MAX_MONITOR_INTERVAL_SECONDS = 86_400;

export const DEFAULT_MONITOR_POLICY = {
  intervalSec: 60,
  timeoutMs: 10_000,
  expectedStatusMin: 200,
  expectedStatusMax: 299,
  failureThreshold: 3,
  recoveryThreshold: 2,
  followRedirects: true,
  maxRedirects: 5,
} as const;
