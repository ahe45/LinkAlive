import { createCipheriv, randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { decryptJson, decryptString } from './crypto.js';
import { recoveryPrerequisiteStatus } from './notification-order.js';
import { retryDelayMs } from './retry.js';

function encrypt(value: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [
    'v1',
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

describe('worker safety utilities', () => {
  it('decrypts API-compatible encrypted byte snapshots', () => {
    const key = randomBytes(32);
    const encrypted = Buffer.from(encrypt(JSON.stringify({ chatId: '123' }), key));
    expect(decryptString(encrypted, key)).toContain('chatId');
    expect(decryptJson(encrypted, key)).toEqual({ chatId: '123' });
  });

  it('keeps recovery blocked until DOWN is sent and cancels after terminal failure', () => {
    expect(recoveryPrerequisiteStatus('PENDING')).toBe('WAIT');
    expect(recoveryPrerequisiteStatus('PROCESSING')).toBe('WAIT');
    expect(recoveryPrerequisiteStatus('SENT')).toBe('READY');
    expect(recoveryPrerequisiteStatus('FAILED')).toBe('CANCEL');
    expect(recoveryPrerequisiteStatus('CANCELED')).toBe('CANCEL');
    expect(recoveryPrerequisiteStatus(null)).toBe('CANCEL');
  });

  it('uses bounded exponential backoff with jitter', () => {
    expect(retryDelayMs(1, () => 0)).toBe(1_500);
    expect(retryDelayMs(2, () => 1)).toBe(5_000);
    expect(retryDelayMs(20, () => 1)).toBe(75_000);
  });
});
