import { describe, expect, it } from 'vitest';
import { validateAccountPassword, validateAccountUsername } from './account-validation';

describe('account validation', () => {
  it.each(['전운', '홍길동01', 'user.name'])('accepts a supported username: %s', (username) => {
    expect(validateAccountUsername(username)).toBeNull();
  });

  it.each([
    ['전', '아이디는 2자 이상이어야 합니다.'],
    ['_관리자', '아이디 형식이 올바르지 않습니다.'],
    [`u${'a'.repeat(160)}`, '아이디는 160자 이하여야 합니다.'],
  ])('rejects an invalid username: %s', (username, message) => {
    expect(validateAccountUsername(username)).toBe(message);
  });

  it('enforces the API password length limits', () => {
    expect(validateAccountPassword('123')).toBe('비밀번호는 4자 이상이어야 합니다.');
    expect(validateAccountPassword('1234')).toBeNull();
    expect(validateAccountPassword('a'.repeat(129))).toBe('비밀번호는 128자 이하여야 합니다.');
  });
});
