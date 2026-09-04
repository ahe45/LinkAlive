import { createHmac, timingSafeEqual } from 'node:crypto';

export interface SessionPayload {
  sub: string;
  iat: number;
  exp: number;
}

function signature(payload: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(payload).digest();
}

export function createSessionToken(
  username: string,
  secret: string,
  ttlSeconds = 8 * 60 * 60,
): string {
  const now = Math.floor(Date.now() / 1000);
  const encoded = Buffer.from(
    JSON.stringify({ sub: username, iat: now, exp: now + ttlSeconds } satisfies SessionPayload),
  ).toString('base64url');
  return `${encoded}.${signature(encoded, secret).toString('base64url')}`;
}

export function verifySessionToken(token: string, secret: string): SessionPayload | null {
  const [encoded, providedSignature] = token.split('.');
  if (!encoded || !providedSignature) return null;

  const expected = signature(encoded, secret);
  const provided = Buffer.from(providedSignature, 'base64url');
  if (expected.byteLength !== provided.byteLength || !timingSafeEqual(expected, provided))
    return null;

  try {
    const payload = JSON.parse(
      Buffer.from(encoded, 'base64url').toString('utf8'),
    ) as SessionPayload;
    if (
      !payload.sub ||
      !Number.isInteger(payload.exp) ||
      payload.exp <= Math.floor(Date.now() / 1000)
    ) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

export function safeSecretEqual(left: string, right: string): boolean {
  const leftHash = createHmac('sha256', 'linkalive-password-compare').update(left).digest();
  const rightHash = createHmac('sha256', 'linkalive-password-compare').update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}
