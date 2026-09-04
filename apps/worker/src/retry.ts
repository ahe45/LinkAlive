export function retryDelayMs(attempt: number, random = Math.random): number {
  const safeAttempt = Math.max(1, Math.min(10, Math.floor(attempt)));
  const base = Math.min(60_000, 2_000 * 2 ** (safeAttempt - 1));
  return Math.round(base * (0.75 + random() * 0.5));
}
