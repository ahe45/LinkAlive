import { describe, expect, it } from 'vitest';

import { notificationChannelPatchSchema } from '../src/notifications/notification.schemas.js';

describe('notification channel patch schema', () => {
  it('accepts editable Telegram destination fields', () => {
    expect(
      notificationChannelPatchSchema.parse({ botToken: '123456:new-token', chatId: '-100123' }),
    ).toEqual({ botToken: '123456:new-token', chatId: '-100123' });
  });

  it('rejects an empty update and invalid destination values', () => {
    expect(() => notificationChannelPatchSchema.parse({})).toThrow();
    expect(() => notificationChannelPatchSchema.parse({ botToken: ' ' })).toThrow();
    expect(() => notificationChannelPatchSchema.parse({ chatId: ' ' })).toThrow();
  });
});
