import { describe, expect, it } from 'vitest';

import { monitorInputSchema, monitorPatchSchema } from '../src/monitors/monitor.schemas.js';

describe('monitor schemas', () => {
  it('applies the documented monitor defaults', () => {
    expect(
      monitorInputSchema.parse({
        name: 'Example',
        url: 'https://example.com/health',
      }),
    ).toMatchObject({
      method: 'GET',
      intervalSec: 60,
      timeoutMs: 10_000,
      expectedStatusMin: 200,
      expectedStatusMax: 299,
      failureThreshold: 3,
      recoveryThreshold: 2,
    });
  });

  it('parses a partial update without injecting defaults', () => {
    expect(monitorPatchSchema.parse({ name: 'Renamed' })).toEqual({ name: 'Renamed' });
  });

  it('accepts a custom integer interval in seconds', () => {
    expect(monitorPatchSchema.parse({ intervalSec: 17 })).toEqual({ intervalSec: 17 });
  });

  it('rejects intervals outside the scheduler range', () => {
    expect(monitorPatchSchema.safeParse({ intervalSec: 4 }).success).toBe(false);
    expect(monitorPatchSchema.safeParse({ intervalSec: 86_401 }).success).toBe(false);
    expect(monitorPatchSchema.safeParse({ intervalSec: 10.5 }).success).toBe(false);
  });

  it('rejects invalid full-field combinations', () => {
    expect(
      monitorInputSchema.safeParse({
        name: 'Example',
        url: 'https://example.com/health',
        method: 'HEAD',
        expectedKeyword: 'ready',
      }).success,
    ).toBe(false);
    expect(
      monitorInputSchema.safeParse({
        name: 'Example',
        url: 'https://example.com/health',
        expectedStatusMin: 500,
        expectedStatusMax: 200,
      }).success,
    ).toBe(false);
  });
});
