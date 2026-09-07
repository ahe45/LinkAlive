import { describe, expect, it } from 'vitest';
import { hashAccountPassword, verifyAccountPassword } from './account-password.js';

describe('account password hashing', () => {
  it('verifies the matching password without storing it in the encoded value', async () => {
    const password = 'control1@';
    const encoded = await hashAccountPassword(password);

    expect(encoded).not.toContain(password);
    await expect(verifyAccountPassword(password, encoded)).resolves.toBe(true);
    await expect(verifyAccountPassword('different-password', encoded)).resolves.toBe(false);
  });

  it('rejects malformed hashes', async () => {
    await expect(verifyAccountPassword('control1@', 'invalid')).resolves.toBe(false);
    await expect(verifyAccountPassword('control1@', 'scrypt-v1$bad$bad')).resolves.toBe(false);
  });
});
