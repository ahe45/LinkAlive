export type LifecycleStatus = 'ACTIVE' | 'PAUSED' | 'DELETED';

export type HealthState = 'PENDING' | 'UP' | 'SUSPECT' | 'DOWN' | 'RECOVERING';

export type EffectiveHealthState = HealthState | 'STALE' | 'PAUSED';

export type HttpMethod = 'GET' | 'HEAD';

export type CheckSource = 'SCHEDULED' | 'MANUAL' | 'TEST';

export type CheckOutcome = 'SUCCESS' | 'TARGET_FAILURE' | 'PLATFORM_ERROR' | 'INCONCLUSIVE';

export type ErrorType =
  | 'DNS_ERROR'
  | 'CONNECT_TIMEOUT'
  | 'CONNECTION_REFUSED'
  | 'TLS_ERROR'
  | 'TTFB_TIMEOUT'
  | 'REQUEST_TIMEOUT'
  | 'REDIRECT_ERROR'
  | 'HTTP_STATUS_MISMATCH'
  | 'CONTENT_MISMATCH'
  | 'RESPONSE_LIMIT_EXCEEDED'
  | 'NETWORK_ERROR'
  | 'PLATFORM_ERROR';

export interface Monitor {
  id: string;
  name: string;
  /** API는 query 값이 마스킹된 안전한 URL만 반환합니다. */
  url: string;
  displayUrl?: string;
  method: HttpMethod;
  intervalSec: number;
  timeoutMs: number;
  expectedStatusMin: number;
  expectedStatusMax: number;
  expectedKeyword?: string | null;
  followRedirects: boolean;
  maxRedirects: number;
  failureThreshold: number;
  recoveryThreshold: number;
  lifecycleStatus: LifecycleStatus;
  healthState: HealthState;
  failureCount: number;
  successCount: number;
  nextCheckAt?: string | null;
  lastCheckedAt?: string | null;
  lastStatusCode?: number | null;
  lastTtfbMs?: number | null;
  lastTotalMs?: number | null;
  lastErrorType?: ErrorType | null;
  lastErrorMessage?: string | null;
  configVersion?: number;
  channelIds?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface MonitorInput {
  name: string;
  url: string;
  method: HttpMethod;
  intervalSec: number;
  timeoutMs: number;
  expectedStatusMin: number;
  expectedStatusMax: number;
  expectedKeyword?: string;
  followRedirects: boolean;
  maxRedirects: number;
  failureThreshold: number;
  recoveryThreshold: number;
  channelIds: string[];
}

export interface CheckResult {
  id: string;
  monitorId?: string | null;
  configVersion?: number | null;
  displayUrlSnapshot: string;
  source: CheckSource;
  outcome: CheckOutcome;
  startedAt: string;
  finishedAt: string;
  statusCode?: number | null;
  ttfbMs?: number | null;
  totalMs?: number | null;
  errorType?: ErrorType | null;
  errorMessageSafe?: string | null;
}

export type IncidentStatus = 'OPEN' | 'RESOLVED' | 'CANCELED';

export type NotificationEventType = 'DOWN' | 'RECOVERY' | 'RESOLVED_SUMMARY' | 'TEST';

export type NotificationOutboxStatus =
  'PENDING' | 'ENQUEUED' | 'PROCESSING' | 'RETRY' | 'SENT' | 'FAILED' | 'CANCELED';

export type NotificationDeliveryStatus = 'ATTEMPTING' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN';

export interface NotificationDeliveryAttempt {
  id: string;
  attempt: number;
  status: NotificationDeliveryStatus;
  /** 서버에서 비밀값을 제거한 운영용 오류 문구입니다. */
  errorSafe?: string | null;
  startedAt: string;
  finishedAt?: string | null;
}

export interface IncidentNotification {
  id: string;
  channelDisplayNameSnapshot: string;
  eventType: NotificationEventType;
  status: NotificationOutboxStatus;
  attemptCount: number;
  lastErrorSafe?: string | null;
  sentAt?: string | null;
  /** 개별 발송 중 FAILED/UNKNOWN 결과만 안전한 필드로 반환됩니다. */
  deliveries?: NotificationDeliveryAttempt[];
}

export interface Incident {
  id: string;
  monitorId: string;
  status: IncidentStatus;
  firstFailureAt: string;
  detectedAt: string;
  resolvedAt?: string | null;
  canceledAt?: string | null;
  firstErrorType?: ErrorType | null;
  lastErrorType?: ErrorType | null;
  closureReason?: 'RECOVERED' | 'PAUSED' | 'DELETED' | 'CONFIG_CHANGED' | string | null;
  durationMs?: number | null;
  notifications?: IncidentNotification[];
}

export interface DashboardSummary {
  total: number;
  up: number;
  suspect: number;
  down: number;
  paused: number;
  pending: number;
  recovering: number;
  stale?: number;
  warning: number;
}

export type NotificationChannelType = 'TELEGRAM';

export interface NotificationChannel {
  id: string;
  type: NotificationChannelType;
  displayName: string;
  /** DB에는 암호화되어 저장되며 로그인된 관리자 화면에서는 원문을 표시합니다. */
  botToken?: string | null;
  chatId?: string | null;
  enabled: boolean;
  verifiedAt?: string | null;
  lastTestedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NotificationChannelInput {
  type: 'TELEGRAM';
  displayName: string;
  botToken: string;
  chatId: string;
}

export interface NotificationChannelPatch {
  displayName?: string;
  enabled?: boolean;
  botToken?: string;
  chatId?: string;
}

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

export interface AuthUser {
  username: string;
}

export interface AuthResponse {
  user: AuthUser;
}

export interface ApiValidationError {
  field?: string;
  message: string;
}
