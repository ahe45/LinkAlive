import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { ADMIN_ONLY } from '../src/auth/admin-only.decorator.js';
import { NetworkController } from '../src/network/network.controller.js';
import { networkSettingsSchema, networkTestSchema } from '../src/network/network.schemas.js';

const input = {
  enabled: true,
  urls: ['https://example.com/', 'https://example.org/'],
  channelIds: [],
  version: 0,
};

describe('administrator network settings', () => {
  it('allows testing one unsaved URL but rejects empty, oversized or unsafe batches', () => {
    expect(networkTestSchema.parse({ urls: [' https://example.com '] })).toEqual({
      urls: ['https://example.com/'],
    });
    for (const urls of [
      [],
      Array(6).fill('https://example.com'),
      ['http://127.0.0.1/'],
      ['https://user:secret@example.com/'],
    ]) {
      expect(networkTestSchema.safeParse({ urls }).success).toBe(false);
    }
    expect(
      networkTestSchema.safeParse({ urls: ['https://example.com/'], enabled: true }).success,
    ).toBe(false);
  });
  it('restricts every settings endpoint to administrators', () => {
    expect(Reflect.getMetadata(ADMIN_ONLY, NetworkController)).toBe(true);
  });
  it('accepts multiple independent hosts and permits an empty disabled configuration', () => {
    expect(networkSettingsSchema.safeParse(input).success).toBe(true);
    expect(networkSettingsSchema.safeParse({ ...input, enabled: false, urls: [] }).success).toBe(
      true,
    );
  });
  it.each([
    ['https://example.com/'],
    ['https://example.com/a', 'https://example.com/b'],
    ['https://example.com/', 'https://example.com./'],
    ['http://127.0.0.1/', 'https://example.org/'],
    ['http://192.168.1.1/', 'https://example.org/'],
    ['http://[::1]/', 'https://example.org/'],
    ['http://localhost/', 'https://example.org/'],
    ['http://host.local/', 'https://example.org/'],
    ['https://user:secret@example.com/', 'https://example.org/'],
    ['https://example.com/?token=secret', 'https://example.org/'],
    ['https://example.com/#secret', 'https://example.org/'],
    ['file:///test', 'https://example.org/'],
  ])('rejects insufficient, duplicate or unsafe references %j', (...urls) => {
    expect(networkSettingsSchema.safeParse({ ...input, urls }).success).toBe(false);
  });
});
