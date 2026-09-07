import { describe, expect, it } from 'vitest';
import { createSessionToken, safeSecretEqual, verifySessionToken } from '../src/auth/session.js';

describe('session token', () => {
  const secret = 'a'.repeat(32);

  it('round trips a valid token', () => {
    const token = createSessionToken('admin', 'session-id', secret, 60);
    expect(verifySessionToken(token, secret)).toMatchObject({ sub: 'admin', sid: 'session-id' });
  });

  it('rejects tampering', () => {
    const token = createSessionToken('admin', 'session-id', secret, 60);
    expect(verifySessionToken(`${token}x`, secret)).toBeNull();
  });

  it('rejects an expired token', () => {
    const token = createSessionToken('admin', 'session-id', secret, -1);
    expect(verifySessionToken(token, secret)).toBeNull();
  });

  it('compares secrets without a length side channel', () => {
    expect(safeSecretEqual('same', 'same')).toBe(true);
    expect(safeSecretEqual('short', 'a much longer value')).toBe(false);
  });
});
