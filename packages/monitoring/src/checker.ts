import { Readable, Transform, type TransformCallback } from 'node:stream';
import {
  constants as zlibConstants,
  createBrotliDecompress,
  createGunzip,
  createInflate,
} from 'node:zlib';

import {
  CheckFailure,
  DestinationLimiterError,
  RedirectPolicyError,
  UrlPolicyError,
} from './errors.js';
import { UndiciHttpTransport, undiciErrors } from './transport.js';
import type {
  CheckErrorType,
  CheckOutcome,
  DestinationLimiter,
  DestinationLease,
  HttpCheckerDependencies,
  MonitorCheckConfig,
  MonitorCheckResult,
  TransportBody,
  TransportResponse,
} from './types.js';
import { displayUrl, NodeDnsResolver, resolveSafeDestination } from './url-policy.js';

const MIN_TIMEOUT_MS = 500;
const MAX_TIMEOUT_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_HEADER_BYTES = 32 * 1024;
const MAX_BODY_BYTES = 64 * 1024;
// A compressed stream can consume arbitrarily many wire bytes while producing
// little or no output (for example, concatenated empty gzip members). Keep a
// separate pre-decompression limit so the decoded-prefix limit cannot be
// bypassed that way.
const MAX_ENCODED_BODY_BYTES = 256 * 1024;
const MAX_KEYWORD_BYTES = 4 * 1024;
const DEFAULT_MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

interface NormalizedConfig {
  url: string;
  method: 'GET' | 'HEAD';
  timeoutMs: number;
  expectedStatusMin: number;
  expectedStatusMax: number;
  expectedKeyword: string | null;
  followRedirects: boolean;
  maxRedirects: number;
  source: 'SCHEDULED' | 'MANUAL' | 'TEST';
  configVersion: number | undefined;
}

function normalizeConfig(config: MonitorCheckConfig): NormalizedConfig {
  const method = config.method ?? 'GET';
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const expectedStatusMin = config.expectedStatusMin ?? 200;
  const expectedStatusMax = config.expectedStatusMax ?? 299;
  const expectedKeyword =
    config.expectedKeyword && config.expectedKeyword.trim().length > 0
      ? config.expectedKeyword
      : null;
  const maxRedirects = config.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

  if (method !== 'GET' && method !== 'HEAD') {
    throw new UrlPolicyError('GET 또는 HEAD 방식만 사용할 수 있습니다.');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
    throw new UrlPolicyError(`전체 제한 시간은 ${MIN_TIMEOUT_MS}~${MAX_TIMEOUT_MS}ms여야 합니다.`);
  }
  if (
    !Number.isInteger(expectedStatusMin) ||
    !Number.isInteger(expectedStatusMax) ||
    expectedStatusMin < 100 ||
    expectedStatusMax > 599 ||
    expectedStatusMin > expectedStatusMax
  ) {
    throw new UrlPolicyError('기대 HTTP 상태 코드 범위가 올바르지 않습니다.');
  }
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > DEFAULT_MAX_REDIRECTS) {
    throw new UrlPolicyError(`리다이렉트는 최대 ${DEFAULT_MAX_REDIRECTS}회까지 허용됩니다.`);
  }
  if (method === 'HEAD' && expectedKeyword) {
    throw new UrlPolicyError('HEAD 검사에는 응답 키워드를 설정할 수 없습니다.');
  }
  if (expectedKeyword && Buffer.byteLength(expectedKeyword, 'utf8') > MAX_KEYWORD_BYTES) {
    throw new UrlPolicyError(`응답 키워드는 ${MAX_KEYWORD_BYTES}바이트 이하여야 합니다.`);
  }

  return {
    url: config.url,
    method,
    timeoutMs,
    expectedStatusMin,
    expectedStatusMax,
    expectedKeyword,
    followRedirects: config.followRedirects ?? true,
    maxRedirects,
    source: config.source ?? 'SCHEDULED',
    configVersion: config.configVersion,
  };
}

function firstHeader(headers: TransportResponse['headers'], name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function approximateHeaderBytes(headers: TransportResponse['headers']): number {
  return Object.entries(headers).reduce((total, [name, value]) => {
    const values = Array.isArray(value) ? value : [value];
    return (
      total + values.reduce((sum, item) => sum + Buffer.byteLength(`${name}: ${item ?? ''}\r\n`), 0)
    );
  }, 2);
}

function decompressorFor(contentEncoding: string | undefined): Transform | null {
  const encoding = contentEncoding?.trim().toLowerCase();
  if (!encoding || encoding === 'identity') return null;
  if (encoding === 'gzip' || encoding === 'x-gzip') return createGunzip();
  if (encoding === 'deflate') return createInflate();
  if (encoding === 'br') {
    return createBrotliDecompress({
      chunkSize: 16 * 1024,
      params: {
        // Reject non-standard large-window Brotli streams. Keeping ring-buffer
        // reallocation enabled avoids eagerly reserving the advertised window
        // while only a bounded decoded prefix is inspected.
        [zlibConstants.BROTLI_DECODER_PARAM_LARGE_WINDOW]: false,
        [zlibConstants.BROTLI_DECODER_PARAM_DISABLE_RING_BUFFER_REALLOCATION]: false,
      },
    });
  }
  throw new CheckFailure('TARGET_FAILURE', 'NETWORK_ERROR', '지원하지 않는 응답 압축 형식입니다.');
}

function assertEncodedContentLength(response: TransportResponse): void {
  const raw = firstHeader(response.headers, 'content-length')?.trim();
  if (!raw || !/^\d+$/.test(raw)) return;

  try {
    if (BigInt(raw) > BigInt(MAX_ENCODED_BODY_BYTES)) {
      throw new CheckFailure(
        'TARGET_FAILURE',
        'RESPONSE_LIMIT_EXCEEDED',
        '압축 응답의 전송 크기 제한을 초과했습니다.',
      );
    }
  } catch (error) {
    if (error instanceof CheckFailure) throw error;
    throw new CheckFailure(
      'TARGET_FAILURE',
      'RESPONSE_LIMIT_EXCEEDED',
      '압축 응답의 전송 크기를 안전하게 확인할 수 없습니다.',
    );
  }
}

class EncodedBodyLimitTransform extends Transform {
  private bytesRead = 0;

  override _transform(
    chunk: Buffer | Uint8Array | string,
    encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : typeof chunk === 'string'
        ? Buffer.from(chunk, encoding)
        : Buffer.from(chunk);
    this.bytesRead += buffer.byteLength;
    if (this.bytesRead > MAX_ENCODED_BODY_BYTES) {
      callback(
        new CheckFailure(
          'TARGET_FAILURE',
          'RESPONSE_LIMIT_EXCEEDED',
          '압축 응답의 전송 크기 제한을 초과했습니다.',
        ),
      );
      return;
    }
    callback(null, buffer);
  }
}

async function inspectKeyword(
  response: TransportResponse,
  keyword: string,
  signal: AbortSignal,
): Promise<{ found: boolean; inspected: number }> {
  const contentEncoding = firstHeader(response.headers, 'content-encoding');
  const normalizedEncoding = contentEncoding?.trim().toLowerCase();
  if (
    normalizedEncoding === 'gzip' ||
    normalizedEncoding === 'x-gzip' ||
    normalizedEncoding === 'deflate' ||
    normalizedEncoding === 'br'
  ) {
    assertEncodedContentLength(response);
  }
  const decompressor = decompressorFor(contentEncoding);
  const source = Readable.from(response.body);
  const encodedLimiter = decompressor ? new EncodedBodyLimitTransform() : null;
  if (encodedLimiter && decompressor) {
    // pipe() does not forward source errors by itself. Explicit propagation
    // makes the async iterator observe the original safe limit/network error.
    source.once('error', (error: Error) => encodedLimiter.destroy(error));
    encodedLimiter.once('error', (error: Error) => decompressor.destroy(error));
  }
  const decoded: AsyncIterable<Buffer> =
    encodedLimiter && decompressor ? source.pipe(encodedLimiter).pipe(decompressor) : source;
  const textDecoder = new TextDecoder('utf-8', { fatal: false });
  let inspected = 0;
  let overlap = '';

  try {
    for await (const rawChunk of decoded) {
      if (signal.aborted) throw signal.reason;
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      const remaining = MAX_BODY_BYTES - inspected;
      if (remaining <= 0) break;
      const bounded = chunk.subarray(0, remaining);
      inspected += bounded.length;
      const text = overlap + textDecoder.decode(bounded, { stream: inspected < MAX_BODY_BYTES });
      if (text.includes(keyword)) return { found: true, inspected };
      overlap = text.slice(-Math.max(keyword.length - 1, 0));
      if (bounded.length < chunk.length || inspected >= MAX_BODY_BYTES) break;
    }
    const tail = overlap + textDecoder.decode();
    if (tail.includes(keyword)) return { found: true, inspected };
  } catch (error) {
    if (signal.aborted) throw error;
    if (error instanceof CheckFailure) throw error;
    throw new CheckFailure(
      'TARGET_FAILURE',
      'NETWORK_ERROR',
      '응답 본문을 안전하게 처리할 수 없습니다.',
      { cause: error },
    );
  } finally {
    response.body.destroy();
    source.destroy();
    encodedLimiter?.destroy();
    decompressor?.destroy();
  }

  return { found: false, inspected };
}

function nestedErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth += 1) {
    const candidate = current as { code?: unknown; cause?: unknown };
    if (typeof candidate.code === 'string') return candidate.code;
    current = candidate.cause;
  }
  return undefined;
}

function classifyUnknownError(error: unknown, aborted: boolean): CheckFailure {
  if (error instanceof CheckFailure) return error;
  const code = nestedErrorCode(error);
  if (aborted || code === 'ABORT_ERR') {
    return new CheckFailure(
      'TARGET_FAILURE',
      'REQUEST_TIMEOUT',
      '전체 요청 제한 시간이 초과되었습니다.',
      { cause: error },
    );
  }
  if (error instanceof undiciErrors.HeadersTimeoutError || code === 'UND_ERR_HEADERS_TIMEOUT') {
    return new CheckFailure(
      'TARGET_FAILURE',
      'TTFB_TIMEOUT',
      '첫 응답 바이트 제한 시간이 초과되었습니다.',
      { cause: error },
    );
  }
  if (
    error instanceof undiciErrors.ConnectTimeoutError ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    code === 'ETIMEDOUT'
  ) {
    return new CheckFailure(
      'TARGET_FAILURE',
      'CONNECT_TIMEOUT',
      '대상 서버 연결 시간이 초과되었습니다.',
      { cause: error },
    );
  }
  if (code === 'ECONNREFUSED') {
    return new CheckFailure(
      'TARGET_FAILURE',
      'CONNECTION_REFUSED',
      '대상 서버가 연결을 거절했습니다.',
      { cause: error },
    );
  }
  if (
    code?.startsWith('ERR_TLS') ||
    code?.startsWith('ERR_SSL') ||
    [
      'CERT_HAS_EXPIRED',
      'CERT_NOT_YET_VALID',
      'DEPTH_ZERO_SELF_SIGNED_CERT',
      'SELF_SIGNED_CERT_IN_CHAIN',
      'UNABLE_TO_GET_ISSUER_CERT',
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    ].includes(code ?? '')
  ) {
    return new CheckFailure(
      'TARGET_FAILURE',
      'TLS_ERROR',
      'TLS 연결 또는 인증서 검증에 실패했습니다.',
      { cause: error },
    );
  }
  if (code === 'UND_ERR_HEADERS_OVERFLOW' || code === 'HPE_HEADER_OVERFLOW') {
    return new CheckFailure(
      'TARGET_FAILURE',
      'RESPONSE_LIMIT_EXCEEDED',
      '응답 헤더 크기 제한을 초과했습니다.',
      { cause: error },
    );
  }
  if (code === 'UND_ERR_BODY_TIMEOUT') {
    return new CheckFailure(
      'TARGET_FAILURE',
      'REQUEST_TIMEOUT',
      '응답 본문 처리 제한 시간이 초과되었습니다.',
      { cause: error },
    );
  }
  if (
    code === 'UND_ERR_SOCKET' ||
    ['ECONNRESET', 'ECONNABORTED', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'EPIPE'].includes(
      code ?? '',
    )
  ) {
    return new CheckFailure(
      'TARGET_FAILURE',
      'NETWORK_ERROR',
      '대상 서버와의 네트워크 요청에 실패했습니다.',
      { cause: error },
    );
  }
  return new CheckFailure(
    'PLATFORM_ERROR',
    'PLATFORM_ERROR',
    '검사 처리 중 내부 오류가 발생했습니다.',
    { cause: error },
  );
}

function resultFromFailure(
  failure: CheckFailure,
  values: {
    config: NormalizedConfig;
    startedAt: Date;
    finishedAt: Date;
    elapsedMs: number;
    statusCode: number | null;
    ttfbMs: number | null;
    finalUrl: string;
    redirects: number;
    inspectedBodyBytes: number;
  },
): MonitorCheckResult {
  return {
    source: values.config.source,
    outcome: failure.outcome,
    ...(values.config.configVersion !== undefined
      ? { configVersion: values.config.configVersion }
      : {}),
    startedAt: values.startedAt,
    finishedAt: values.finishedAt,
    statusCode: values.statusCode,
    ttfbMs: values.ttfbMs,
    totalMs: Math.max(0, Math.round(values.elapsedMs)),
    errorType: failure.errorType,
    errorMessageSafe: failure.safeMessage,
    finalUrlDisplay: displayUrl(values.finalUrl),
    redirectCount: values.redirects,
    inspectedBodyBytes: values.inspectedBodyBytes,
  };
}

export function createHttpChecker(dependencies: HttpCheckerDependencies = {}) {
  const resolver = dependencies.resolver ?? new NodeDnsResolver();
  const transport = dependencies.transport ?? new UndiciHttpTransport();
  const destinationLimiter = dependencies.destinationLimiter;
  const now = dependencies.now ?? (() => new Date());
  const monotonicNow = dependencies.monotonicNow ?? (() => performance.now());

  return async function checkUrl(input: MonitorCheckConfig): Promise<MonitorCheckResult> {
    const startedAt = now();
    const startedTick = monotonicNow();
    let config: NormalizedConfig;
    try {
      config = normalizeConfig(input);
    } catch (error) {
      const finishedAt = now();
      const fallback: NormalizedConfig = {
        url: input.url,
        method: input.method === 'HEAD' ? 'HEAD' : 'GET',
        timeoutMs: DEFAULT_TIMEOUT_MS,
        expectedStatusMin: 200,
        expectedStatusMax: 299,
        expectedKeyword: null,
        followRedirects: true,
        maxRedirects: DEFAULT_MAX_REDIRECTS,
        source: input.source ?? 'SCHEDULED',
        configVersion: input.configVersion,
      };
      return resultFromFailure(classifyUnknownError(error, false), {
        config: fallback,
        startedAt,
        finishedAt,
        elapsedMs: monotonicNow() - startedTick,
        statusCode: null,
        ttfbMs: null,
        finalUrl: input.url,
        redirects: 0,
        inspectedBodyBytes: 0,
      });
    }

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error('overall timeout')),
      config.timeoutMs,
    );
    timeout.unref?.();
    let currentUrl = config.url;
    let statusCode: number | null = null;
    let ttfbMs: number | null = null;
    let redirects = 0;
    let inspectedBodyBytes = 0;
    let response: TransportResponse | null = null;
    let destinationLease: DestinationLease | null = null;
    const visited = new Set<string>();

    try {
      while (true) {
        const destination = await resolveSafeDestination(currentUrl, resolver, controller.signal);
        const canonical = destination.url.toString();
        if (visited.has(canonical)) {
          throw new RedirectPolicyError('리다이렉트 순환이 감지되었습니다.');
        }
        visited.add(canonical);
        currentUrl = canonical;

        destinationLease = destinationLimiter
          ? await acquireDestinationLease(destinationLimiter, destination, controller.signal)
          : null;

        const elapsed = monotonicNow() - startedTick;
        const remaining = Math.max(1, Math.floor(config.timeoutMs - elapsed));
        response = await transport.request(destination, {
          method: config.method,
          signal: controller.signal,
          headersTimeoutMs: Math.min(5_000, remaining),
          bodyTimeoutMs: remaining,
          maxHeaderBytes: MAX_HEADER_BYTES,
        });
        statusCode = response.statusCode;
        ttfbMs = Math.max(0, Math.round(monotonicNow() - startedTick));

        if (approximateHeaderBytes(response.headers) > MAX_HEADER_BYTES) {
          throw new CheckFailure(
            'TARGET_FAILURE',
            'RESPONSE_LIMIT_EXCEEDED',
            '응답 헤더 크기 제한을 초과했습니다.',
          );
        }

        const location = firstHeader(response.headers, 'location');
        if (config.followRedirects && REDIRECT_STATUSES.has(statusCode) && location) {
          if (redirects >= config.maxRedirects) {
            throw new RedirectPolicyError('허용된 리다이렉트 횟수를 초과했습니다.');
          }
          let next: URL;
          try {
            next = new URL(location, destination.url);
          } catch (error) {
            throw new RedirectPolicyError('리다이렉트 주소가 올바르지 않습니다.', { cause: error });
          }
          response.body.destroy();
          await response.close();
          response = null;
          await releaseDestinationLease(destinationLease);
          destinationLease = null;
          currentUrl = next.toString();
          redirects += 1;
          continue;
        }

        if (statusCode < config.expectedStatusMin || statusCode > config.expectedStatusMax) {
          throw new CheckFailure(
            'TARGET_FAILURE',
            'HTTP_STATUS_MISMATCH',
            `기대 범위를 벗어난 HTTP 상태 코드(${statusCode})를 받았습니다.`,
          );
        }

        if (config.expectedKeyword) {
          const inspection = await inspectKeyword(
            response,
            config.expectedKeyword,
            controller.signal,
          );
          inspectedBodyBytes = inspection.inspected;
          if (!inspection.found) {
            throw new CheckFailure(
              'TARGET_FAILURE',
              'CONTENT_MISMATCH',
              '제한된 응답 본문에서 기대 키워드를 찾지 못했습니다.',
            );
          }
        } else {
          response.body.destroy();
        }
        await response.close();
        response = null;
        await releaseDestinationLease(destinationLease);
        destinationLease = null;
        const finishedAt = now();
        return {
          source: config.source,
          outcome: 'SUCCESS',
          ...(config.configVersion !== undefined ? { configVersion: config.configVersion } : {}),
          startedAt,
          finishedAt,
          statusCode,
          ttfbMs,
          totalMs: Math.max(0, Math.round(monotonicNow() - startedTick)),
          errorType: null,
          errorMessageSafe: null,
          finalUrlDisplay: displayUrl(currentUrl),
          redirectCount: redirects,
          inspectedBodyBytes,
        };
      }
    } catch (error) {
      let effectiveError = error;
      if (response) {
        response.body.destroy();
        await response.close().catch(() => undefined);
        response = null;
      }
      if (destinationLease) {
        try {
          await releaseDestinationLease(destinationLease);
        } catch (releaseError) {
          // A release failure means the distributed safety boundary is no
          // longer observable. It must supersede a target failure so an
          // infrastructure fault can never advance the DOWN state machine.
          effectiveError = releaseError;
        }
        destinationLease = null;
      }
      const policyError =
        effectiveError instanceof UrlPolicyError && redirects > 0
          ? new RedirectPolicyError('리다이렉트 대상 URL을 검사할 수 없습니다.', {
              cause: effectiveError,
            })
          : effectiveError;
      const failure = classifyUnknownError(policyError, controller.signal.aborted);
      const finishedAt = now();
      return resultFromFailure(failure, {
        config,
        startedAt,
        finishedAt,
        elapsedMs: monotonicNow() - startedTick,
        statusCode,
        ttfbMs,
        finalUrl: currentUrl,
        redirects,
        inspectedBodyBytes,
      });
    } finally {
      clearTimeout(timeout);
      if (response) {
        response.body.destroy();
        await response.close().catch(() => undefined);
      }
      if (destinationLease) {
        await destinationLease.release().catch(() => undefined);
      }
    }
  };
}

async function releaseDestinationLease(lease: DestinationLease | null): Promise<void> {
  if (!lease) return;
  try {
    await lease.release();
  } catch (error) {
    if (error instanceof DestinationLimiterError) throw error;
    throw new DestinationLimiterError(
      '검사 보호 제한을 안전하게 해제하지 못해 결과를 확정하지 않았습니다.',
    );
  }
}

async function acquireDestinationLease(
  limiter: DestinationLimiter,
  destination: Parameters<DestinationLimiter['acquire']>[0],
  signal: AbortSignal,
): Promise<DestinationLease> {
  try {
    return await limiter.acquire(destination, signal);
  } catch (error) {
    if (error instanceof DestinationLimiterError) throw error;
    throw new DestinationLimiterError(
      '검사 보호 제한을 확인할 수 없어 이번 검사를 시작하지 않았습니다.',
    );
  }
}

export const checkUrl = createHttpChecker();

export function isStateBearingResult(
  result: Pick<MonitorCheckResult, 'source' | 'outcome'>,
): boolean {
  return (
    result.source === 'SCHEDULED' &&
    (result.outcome === 'SUCCESS' || result.outcome === 'TARGET_FAILURE')
  );
}

export function safeFailure(
  outcome: CheckOutcome,
  errorType: CheckErrorType,
  message: string,
): Pick<MonitorCheckResult, 'outcome' | 'errorType' | 'errorMessageSafe'> {
  return { outcome, errorType, errorMessageSafe: message.replace(/[\r\n\t]/g, ' ').slice(0, 500) };
}
