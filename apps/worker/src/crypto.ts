import { createDecipheriv } from 'node:crypto';

export function decryptString(value: Uint8Array | string, key: Buffer): string {
  const encoded = typeof value === 'string' ? value : Buffer.from(value).toString('utf8');
  const [version, ivEncoded, tagEncoded, ciphertextEncoded] = encoded.split('.');
  if (version !== 'v1' || !ivEncoded || !tagEncoded || !ciphertextEncoded) {
    throw new Error('Unsupported encrypted value');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivEncoded, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagEncoded, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextEncoded, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

export function decryptJson(value: Uint8Array | string, key: Buffer): unknown {
  return JSON.parse(decryptString(value, key)) as unknown;
}
