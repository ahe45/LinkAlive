import { randomBytes, scrypt as nodeScrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(nodeScrypt);
const FORMAT = 'scrypt-v1';
const SALT_BYTES = 16;
const KEY_BYTES = 64;

export async function hashAccountPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derived = (await scrypt(password, salt, KEY_BYTES)) as Buffer;
  return `${FORMAT}$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

export async function verifyAccountPassword(password: string, encoded: string): Promise<boolean> {
  const [format, saltValue, hashValue, extra] = encoded.split('$');
  if (format !== FORMAT || !saltValue || !hashValue || extra !== undefined) return false;

  try {
    const salt = Buffer.from(saltValue, 'base64url');
    const expected = Buffer.from(hashValue, 'base64url');
    if (salt.byteLength !== SALT_BYTES || expected.byteLength !== KEY_BYTES) return false;
    const actual = (await scrypt(password, salt, expected.byteLength)) as Buffer;
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
