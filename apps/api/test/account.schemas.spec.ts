import { describe, expect, it } from 'vitest';
import { accountCreateSchema } from '../src/accounts/account.schemas.js';

describe('account schemas', () => {
  it('accepts a four-character password', () => {
    expect(
      accountCreateSchema.safeParse({
        username: 'user01',
        password: 'A1!b',
        role: 'USER',
        enabled: true,
      }).success,
    ).toBe(true);
  });

  it('rejects a password shorter than four characters', () => {
    const result = accountCreateSchema.safeParse({
      username: 'user01',
      password: 'A1!',
      role: 'USER',
      enabled: true,
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe('비밀번호는 4자 이상이어야 합니다.');
  });

  it.each(['전운', '관리자', '홍길동01', '사용자.test', 'ㄱㄴㄷ'])(
    'accepts a Korean username: %s',
    (username) => {
      expect(
        accountCreateSchema.safeParse({
          username,
          password: 'password123!',
          role: 'USER',
          enabled: true,
        }).success,
      ).toBe(true);
    },
  );

  it('rejects a one-character username', () => {
    const result = accountCreateSchema.safeParse({
      username: '전',
      password: 'password123!',
      role: 'USER',
      enabled: true,
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe('아이디는 2자 이상이어야 합니다.');
  });

  it.each(['한 글', '한글!', '_관리자'])('rejects an unsupported username: %s', (username) => {
    expect(
      accountCreateSchema.safeParse({
        username,
        password: 'password123!',
        role: 'USER',
        enabled: true,
      }).success,
    ).toBe(false);
  });
});
