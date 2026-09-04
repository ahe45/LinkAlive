import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import { CheckFailure, UrlPolicyError } from './errors.js';
import type { DnsResolver, ResolvedAddress, SafeDestination } from './types.js';

const DNS_TIMEOUT_MS = 2_000;
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

interface Cidr4 {
  base: number;
  mask: number;
}

const BLOCKED_IPV4_CIDRS = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.88.99.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
].map(parseCidr4);

const BLOCKED_IPV6_CIDRS: ReadonlyArray<readonly [bigint, number]> = [
  [parseIpv6('2001::'), 23],
  [parseIpv6('2001:db8::'), 32],
  [parseIpv6('2002::'), 16],
  [parseIpv6('3fff::'), 20],
];

function ipv4ToNumber(address: string): number {
  const parts = address.split('.');
  if (parts.length !== 4) {
    throw new Error('Invalid IPv4 address');
  }

  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      throw new Error('Invalid IPv4 address');
    }
    const octet = Number(part);
    if (octet > 255) {
      throw new Error('Invalid IPv4 address');
    }
    value = ((value << 8) | octet) >>> 0;
  }
  return value >>> 0;
}

function parseCidr4(cidr: string): Cidr4 {
  const [address, prefixText] = cidr.split('/');
  const prefix = Number(prefixText);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return { base: (ipv4ToNumber(address!) & mask) >>> 0, mask };
}

function isBlockedIpv4(address: string): boolean {
  const value = ipv4ToNumber(address);
  return BLOCKED_IPV4_CIDRS.some(({ base, mask }) => (value & mask) >>> 0 === base);
}

function parseIpv6(input: string): bigint {
  let address = input.toLowerCase();
  const zoneIndex = address.indexOf('%');
  if (zoneIndex >= 0) {
    address = address.slice(0, zoneIndex);
  }

  if (address.includes('.')) {
    const lastColon = address.lastIndexOf(':');
    if (lastColon < 0) {
      throw new Error('Invalid IPv6 address');
    }
    const ipv4 = ipv4ToNumber(address.slice(lastColon + 1));
    address = `${address.slice(0, lastColon)}:${(ipv4 >>> 16).toString(16)}:${(ipv4 & 0xffff).toString(16)}`;
  }

  const halves = address.split('::');
  if (halves.length > 2) {
    throw new Error('Invalid IPv6 address');
  }
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) {
    throw new Error('Invalid IPv6 address');
  }
  const groups = [...left, ...Array.from({ length: missing }, () => '0'), ...right];
  if (groups.length !== 8) {
    throw new Error('Invalid IPv6 address');
  }

  let value = 0n;
  for (const group of groups) {
    if (!/^[\da-f]{1,4}$/.test(group)) {
      throw new Error('Invalid IPv6 address');
    }
    value = (value << 16n) | BigInt(Number.parseInt(group, 16));
  }
  return value;
}

function isInIpv6Cidr(value: bigint, base: bigint, prefix: number): boolean {
  if (prefix === 0) return true;
  const shift = BigInt(128 - prefix);
  return value >> shift === base >> shift;
}

function mappedIpv4(value: bigint): string | null {
  if (value >> 32n !== 0xffffn) return null;
  const raw = Number(value & 0xffffffffn);
  return [raw >>> 24, (raw >>> 16) & 255, (raw >>> 8) & 255, raw & 255].join('.');
}

function isBlockedIpv6(address: string): boolean {
  const value = parseIpv6(address);
  const mapped = mappedIpv4(value);
  if (mapped) return isBlockedIpv4(mapped);

  // Public IPv6 destinations are restricted to the global-unicast block.
  if (!isInIpv6Cidr(value, parseIpv6('2000::'), 3)) return true;
  return BLOCKED_IPV6_CIDRS.some(([base, prefix]) => isInIpv6Cidr(value, base, prefix));
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  try {
    if (family === 4) return !isBlockedIpv4(address);
    if (family === 6) return !isBlockedIpv6(address);
    return false;
  } catch {
    return false;
  }
}

export function parseMonitorUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch (error) {
    throw new UrlPolicyError('올바른 HTTP 또는 HTTPS URL이 아닙니다.', { cause: error });
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new UrlPolicyError('HTTP와 HTTPS URL만 검사할 수 있습니다.');
  }
  if (!url.hostname) {
    throw new UrlPolicyError('URL에 호스트 이름이 필요합니다.');
  }
  const hostname = url.hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
  if (isIP(hostname) === 0) {
    const labels = hostname.split('.');
    if (hostname.length > 253 || labels.some((label) => label.length === 0 || label.length > 63)) {
      throw new UrlPolicyError('도메인 이름의 길이가 올바르지 않습니다.');
    }
  }
  url.hash = '';
  return url;
}

export function displayUrl(input: string | URL): string {
  try {
    const url = typeof input === 'string' ? new URL(input) : new URL(input.toString());
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '(invalid URL)';
  }
}

export class NodeDnsResolver implements DnsResolver {
  async resolve(hostname: string, signal?: AbortSignal): Promise<readonly ResolvedAddress[]> {
    const literalFamily = isIP(hostname);
    if (literalFamily === 4 || literalFamily === 6) {
      return [{ address: hostname, family: literalFamily }];
    }

    const timeoutSignal = AbortSignal.timeout(DNS_TIMEOUT_MS);
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    try {
      let removeAbortListener = (): void => undefined;
      const aborted = new Promise<never>((_resolve, reject) => {
        const onAbort = (): void =>
          reject(combinedSignal.reason ?? new Error('DNS lookup aborted'));
        if (combinedSignal.aborted) onAbort();
        else {
          combinedSignal.addEventListener('abort', onAbort, { once: true });
          removeAbortListener = () => combinedSignal.removeEventListener('abort', onAbort);
        }
      });
      const entries = await Promise.race([
        lookup(hostname, { all: true, verbatim: true }),
        aborted,
      ]).finally(removeAbortListener);
      return entries
        .filter(
          (entry): entry is { address: string; family: 4 | 6 } =>
            entry.family === 4 || entry.family === 6,
        )
        .map(({ address, family }) => ({ address, family }));
    } catch (error) {
      if (combinedSignal.aborted) {
        throw new CheckFailure('TARGET_FAILURE', 'DNS_ERROR', 'DNS 조회 시간이 초과되었습니다.', {
          cause: error,
        });
      }
      throw new CheckFailure('TARGET_FAILURE', 'DNS_ERROR', '도메인 이름을 조회할 수 없습니다.', {
        cause: error,
      });
    }
  }
}

export async function resolveSafeDestination(
  input: string | URL,
  resolver: DnsResolver = new NodeDnsResolver(),
  signal?: AbortSignal,
): Promise<SafeDestination> {
  const url = parseMonitorUrl(input.toString());
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = await resolver.resolve(hostname, signal);
  if (addresses.length === 0) {
    throw new CheckFailure(
      'TARGET_FAILURE',
      'DNS_ERROR',
      '도메인 이름에 연결 가능한 주소가 없습니다.',
    );
  }

  const unique = Array.from(
    new Map(addresses.map((entry) => [`${entry.family}:${entry.address}`, entry])).values(),
  );
  return { url, addresses: unique };
}
