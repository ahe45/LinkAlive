import { describe, expect, it } from 'vitest';
import { decryptJson, decryptString, encryptJson, encryptString } from '../src/common/crypto.js';
import { toDisplayUrl } from '../src/common/display.js';

describe('encrypted values', () => {
  const key = Buffer.alloc(32, 7);

  it('encrypts and decrypts strings', () => {
    const encrypted = encryptString('https://example.com/?token=secret', key);
    expect(encrypted).not.toContain('secret');
    expect(decryptString(encrypted, key)).toBe('https://example.com/?token=secret');
  });

  it('encrypts and decrypts JSON', () => {
    expect(decryptJson(encryptJson({ chatId: '123' }, key), key)).toEqual({ chatId: '123' });
  });

  it('removes URL query values from display', () => {
    const display = toDisplayUrl('https://example.com/health?token=secret');
    expect(display).toBe('https://example.com/health?masked');
    expect(display).not.toContain('secret');
  });
});
