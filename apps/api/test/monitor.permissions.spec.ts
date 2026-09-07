import { AccountRole } from '@linkalive/database';
import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { assertCanManageMonitor, canManageMonitor } from '../src/monitors/monitor.permissions.js';

const owner = { id: 'owner-id', username: 'owner', role: AccountRole.USER };
const anotherUser = { id: 'other-id', username: 'other', role: AccountRole.USER };
const administrator = { id: 'admin-id', username: 'admin', role: AccountRole.ADMIN };

describe('monitor permissions', () => {
  it('allows the account that created the monitor', () => {
    expect(canManageMonitor(owner.id, owner)).toBe(true);
  });

  it('allows administrators regardless of ownership', () => {
    expect(canManageMonitor(owner.id, administrator)).toBe(true);
    expect(canManageMonitor(null, administrator)).toBe(true);
  });

  it('rejects another regular account', () => {
    expect(canManageMonitor(owner.id, anotherUser)).toBe(false);
    expect(() => assertCanManageMonitor(owner.id, anotherUser)).toThrow(ForbiddenException);
  });
});
