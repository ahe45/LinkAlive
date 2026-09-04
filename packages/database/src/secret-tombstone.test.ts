import { describe, expect, it } from 'vitest';

import {
  isSecretTombstone,
  SECRET_TOMBSTONE_TEXT,
  secretTombstoneBytes,
} from './secret-tombstone.js';

describe('secret tombstone', () => {
  it('is non-empty, stable, and intentionally not a decryptable v1 envelope', () => {
    const first = secretTombstoneBytes();
    const second = secretTombstoneBytes();

    expect(new TextDecoder().decode(first)).toBe(SECRET_TOMBSTONE_TEXT);
    expect(first.byteLength).toBeGreaterThan(0);
    expect(SECRET_TOMBSTONE_TEXT.startsWith('v1.')).toBe(false);
    expect(first).not.toBe(second);
    expect(isSecretTombstone(first)).toBe(true);
    expect(isSecretTombstone(new TextEncoder().encode('a real encrypted value'))).toBe(false);
  });
});
