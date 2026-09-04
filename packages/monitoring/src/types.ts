import type { Dispatcher } from 'undici';

export const CHECK_SOURCES = ['SCHEDULED', 'MANUAL', 'TEST'] as const;
export type CheckSource = (typeof CHECK_SOURCES)[number];

export const CHECK_OUTCOMES = [
  'SUCCESS',
  'TARGET_FAILURE',
  'PLATFORM_ERROR',
  'INCONCLUSIVE',
] as const;
export type CheckOutcome = (typeof CHECK_OUTCOMES)[number];

export const CHECK_ERROR_TYPES = [
  'DNS_ERROR',
  'CONNECT_TIMEOUT',
  'CONNECTION_REFUSED',
  'TLS_ERROR',
  'TTFB_TIMEOUT',
  'REQUEST_TIMEOUT',
  'REDIRECT_ERROR',
  'HTTP_STATUS_MISMATCH',
  'CONTENT_MISMATCH',
  'RESPONSE_LIMIT_EXCEEDED',
  'NETWORK_ERROR',
  'PLATFORM_ERROR',
] as const;
export type CheckErrorType = (typeof CHECK_ERROR_TYPES)[number];

export interface MonitorCheckConfig {
  url: string;
  method?: 'GET' | 'HEAD';
  timeoutMs?: number;
  expectedStatusMin?: number;
  expectedStatusMax?: number;
  expectedKeyword?: string | null;
  followRedirects?: boolean;
  maxRedirects?: number;
  source?: CheckSource;
  configVersion?: number;
}

export interface MonitorCheckResult {
  source: CheckSource;
  outcome: CheckOutcome;
  configVersion?: number;
  startedAt: Date;
  finishedAt: Date;
  statusCode: number | null;
  ttfbMs: number | null;
  totalMs: number;
  errorType: CheckErrorType | null;
  errorMessageSafe: string | null;
  finalUrlDisplay: string;
  redirectCount: number;
  inspectedBodyBytes: number;
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface SafeDestination {
  url: URL;
  addresses: readonly ResolvedAddress[];
}

export interface DestinationLease {
  release(): Promise<void>;
}

/**
 * A cross-process guard for outbound requests. Implementations receive only a
 * validated hostname and resolved addresses, never the URL path/query.
 */
export interface DestinationLimiter {
  acquire(destination: SafeDestination, signal?: AbortSignal): Promise<DestinationLease>;
}

export interface DnsResolver {
  resolve(hostname: string, signal?: AbortSignal): Promise<readonly ResolvedAddress[]>;
}

export interface TransportBody extends AsyncIterable<Uint8Array> {
  destroy(error?: Error): void;
}

export interface TransportResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: TransportBody;
  close(): Promise<void>;
}

export interface TransportRequest {
  method: 'GET' | 'HEAD';
  signal: AbortSignal;
  headersTimeoutMs: number;
  bodyTimeoutMs: number;
  maxHeaderBytes: number;
}

export interface HttpTransport {
  request(destination: SafeDestination, request: TransportRequest): Promise<TransportResponse>;
}

export interface HttpCheckerDependencies {
  resolver?: DnsResolver;
  transport?: HttpTransport;
  destinationLimiter?: DestinationLimiter;
  now?: () => Date;
  monotonicNow?: () => number;
}

export type UndiciDispatcher = Dispatcher;
