/**
 * Opaque replacement for retired encrypted values.
 *
 * The marker deliberately is not a valid AES-GCM envelope. Accidentally
 * routing a retired row back through a decryptor therefore fails closed
 * instead of producing a usable destination or URL. A fresh byte array is
 * returned so callers cannot mutate shared process state.
 */
export const SECRET_TOMBSTONE_TEXT = 'linkalive:secret-tombstone:v1';
export const DOWN_NOT_DELIVERED_RECOVERY_CANCEL_REASON =
  '장애 알림이 전달되지 않아 복구 알림을 취소했습니다.';

export function secretTombstoneBytes(): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(SECRET_TOMBSTONE_TEXT);
}

export function isSecretTombstone(value: Uint8Array): boolean {
  const expected = secretTombstoneBytes();
  if (value.byteLength !== expected.byteLength) return false;
  return value.every((byte, index) => byte === expected[index]);
}
