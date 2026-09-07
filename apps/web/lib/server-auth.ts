import 'server-only';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { AuthResponse, AuthUser } from '@/lib/types';

const AUTH_COOKIE_NAME = process.env.AUTH_COOKIE_NAME ?? 'linkalive_session';
const INTERNAL_API_BASE_URL = (
  process.env.INTERNAL_API_BASE_URL ?? 'http://127.0.0.1:4000'
).replace(/\/$/, '');

export async function requireAuthenticatedUser(): Promise<AuthUser> {
  const sessionToken = (await cookies()).get(AUTH_COOKIE_NAME)?.value;
  if (!sessionToken) redirect('/login');

  const response = await fetch(`${INTERNAL_API_BASE_URL}/api/v1/auth/me`, {
    headers: { cookie: `${AUTH_COOKIE_NAME}=${sessionToken}` },
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 401) redirect('/login');
  if (!response.ok) throw new Error(`Session verification failed with status ${response.status}`);

  return ((await response.json()) as AuthResponse).user;
}

export async function requireAdminUser(): Promise<AuthUser> {
  const user = await requireAuthenticatedUser();
  if (user.role !== 'ADMIN') redirect('/dashboard');
  return user;
}
