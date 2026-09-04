import { describe, expect, it } from 'vitest';

import { UrlPolicyError } from './errors.js';
import type { DnsResolver, ResolvedAddress } from './types.js';
import { displayUrl, parseMonitorUrl, resolveSafeDestination } from './url-policy.js';

class StaticResolver implements DnsResolver {
  constructor(private readonly addresses: readonly ResolvedAddress[]) {}
  async resolve(): Promise<readonly ResolvedAddress[]> {
    return this.addresses;
  }
}

describe('URL policy', () => {
  it('allows credentials, localhost and non-standard ports', () => {
    const parsed = parseMonitorUrl('http://user:pass@localhost:3000/health');
    expect(parsed.hostname).toBe('localhost');
    expect(parsed.port).toBe('3000');
    expect(parsed.username).toBe('user');
    expect(parsed.password).toBe('pass');
  });

  it('rejects unsupported schemes', () => {
    expect(() => parseMonitorUrl('file:///etc/passwd')).toThrow(/HTTP/);
  });

  it('rejects hostnames that cannot fit DNS or database limits', () => {
    expect(() => parseMonitorUrl(`https://${'a'.repeat(64)}.example.com`)).toThrow(UrlPolicyError);
    expect(() =>
      parseMonitorUrl(`https://${Array.from({ length: 5 }, () => 'a'.repeat(60)).join('.')}`),
    ).toThrow(UrlPolicyError);
  });

  it('accepts private and public addresses in the same DNS result', async () => {
    const resolver = new StaticResolver([
      { address: '8.8.8.8', family: 4 },
      { address: '10.0.0.1', family: 4 },
    ]);
    await expect(
      resolveSafeDestination('https://example.com:8443', resolver),
    ).resolves.toMatchObject({
      url: new URL('https://example.com:8443'),
      addresses: [
        { address: '8.8.8.8', family: 4 },
        { address: '10.0.0.1', family: 4 },
      ],
    });
  });

  it('removes secrets from a display URL', () => {
    expect(displayUrl('https://user:pass@example.com/path?api_key=secret#fragment')).toBe(
      'https://example.com/path',
    );
  });
});
