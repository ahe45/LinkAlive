import { Agent, errors as undiciErrors, request } from 'undici';

import type {
  HttpTransport,
  ResolvedAddress,
  SafeDestination,
  TransportRequest,
  TransportResponse,
} from './types.js';

function decodeUrlCredential(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function createPinnedLookup(addresses: readonly ResolvedAddress[]) {
  return (
    _hostname: string,
    options: { all?: boolean },
    callback: (error: NodeJS.ErrnoException | null, address: unknown, family?: number) => void,
  ): void => {
    if (options.all) {
      callback(
        null,
        addresses.map(({ address, family }) => ({ address, family })),
      );
      return;
    }
    const first = addresses[0]!;
    callback(null, first.address, first.family);
  };
}

export class UndiciHttpTransport implements HttpTransport {
  async request(
    destination: SafeDestination,
    options: TransportRequest,
  ): Promise<TransportResponse> {
    const requestUrl = new URL(destination.url);
    const authorization =
      requestUrl.username || requestUrl.password
        ? `Basic ${Buffer.from(
            `${decodeUrlCredential(requestUrl.username)}:${decodeUrlCredential(requestUrl.password)}`,
          ).toString('base64')}`
        : undefined;
    requestUrl.username = '';
    requestUrl.password = '';
    const agent = new Agent({
      connect: {
        lookup: createPinnedLookup(destination.addresses) as never,
        timeout: Math.min(3_000, options.headersTimeoutMs),
      },
      autoSelectFamily: destination.addresses.length > 1,
      autoSelectFamilyAttemptTimeout: 250,
      headersTimeout: options.headersTimeoutMs,
      bodyTimeout: options.bodyTimeoutMs,
      maxHeaderSize: options.maxHeaderBytes,
      pipelining: 0,
      connections: 1,
    });

    try {
      const response = await request(requestUrl, {
        dispatcher: agent,
        method: options.method,
        signal: options.signal,
        headersTimeout: options.headersTimeoutMs,
        bodyTimeout: options.bodyTimeoutMs,
        headers: {
          accept: '*/*',
          'accept-encoding': 'identity',
          'user-agent': 'LinkAlive/0.1 (+https://linkalive.invalid)',
          ...(authorization ? { authorization } : {}),
        },
      });
      return {
        statusCode: response.statusCode,
        headers: response.headers,
        body: response.body,
        close: async () => {
          await agent.close();
        },
      };
    } catch (error) {
      await agent.close().catch(() => undefined);
      throw error;
    }
  }
}

export { undiciErrors };
