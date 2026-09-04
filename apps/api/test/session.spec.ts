import { describe, expect, it } from 'vitest';
import { createSessionToken, safeSecretEqual, verifySessionToken } from '../src/auth/session.js';

describe('session token', () => {
  const secret = 'a'.repeat(32);

  it('round trips a valid token', () => {
    const token = createSessionToken('admin', secret, 60);
    expect(verifySessionToken(token, secret)?.sub).toBe('admin');
  });

  it('rejects tampering', () => {
    const token = createSessionToken('admin', secret, 60);
    expect(verifySessionToken(`${token}x`, secret)).toBeNull();
  });

  it('compares secrets without a length side channel', () => {
    expect(safeSecretEqual('same', 'same')).toBe(true);
    expect(safeSecretEqual('short', 'a much longer value')).toBe(false);
  });
});
