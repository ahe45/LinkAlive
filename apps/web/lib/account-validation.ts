const USERNAME_PATTERN = /^[\p{Script=Hangul}A-Za-z0-9][\p{Script=Hangul}A-Za-z0-9._@-]*$/u;

export function validateAccountUsername(value: string): string | null {
  const username = value.trim();
  if (username.length < 2) return '아이디는 2자 이상이어야 합니다.';
  if (username.length > 160) return '아이디는 160자 이하여야 합니다.';
  if (!USERNAME_PATTERN.test(username)) return '아이디 형식이 올바르지 않습니다.';
  return null;
}

export function validateAccountPassword(value: string): string | null {
  if (value.length < 4) return '비밀번호는 4자 이상이어야 합니다.';
  if (value.length > 128) return '비밀번호는 128자 이하여야 합니다.';
  return null;
}
