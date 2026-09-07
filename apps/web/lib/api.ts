import type {
  Account,
  AccountBulkResult,
  AccountInput,
  AccountPatch,
  ApiValidationError,
  AuthResponse,
  CheckResult,
  CursorPage,
  DashboardSummary,
  EffectiveHealthState,
  Incident,
  Monitor,
  MonitorInput,
  NotificationChannel,
  NotificationChannelInput,
  NotificationChannelPatch,
} from '@/lib/types';

const API_BASE_URL = (process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000').replace(
  /\/$/,
  '',
);
const API_REQUEST_TIMEOUT_MS = 10_000;

interface ApiErrorBody {
  message?: string | string[];
  error?: string;
  errors?: ApiValidationError[];
}

export class ApiError extends Error {
  status: number;
  details: ApiValidationError[];

  constructor(message: string, status: number, details: ApiValidationError[] = []) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}

function errorMessage(body: ApiErrorBody | null, status: number): string {
  if (Array.isArray(body?.message)) return body.message.join(' ');
  if (body?.message) return body.message;
  if (body?.error) return body.error;
  if (status === 401) return '로그인이 필요합니다.';
  if (status === 403) return '이 작업을 수행할 권한이 없습니다.';
  if (status === 404) return '요청한 정보를 찾을 수 없습니다.';
  if (status >= 500) return '서버에서 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.';
  return '요청을 처리하지 못했습니다.';
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.body && !(init.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers,
      credentials: 'include',
      cache: 'no-store',
      signal: init.signal ?? AbortSignal.timeout(API_REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new ApiError('API 서버에 연결할 수 없습니다. 서버가 실행 중인지 확인해 주세요.', 0);
  }

  const contentType = response.headers.get('content-type') ?? '';
  const rawBody = response.status === 204 ? '' : await response.text();
  let body: unknown = null;
  if (rawBody && contentType.includes('application/json')) {
    try {
      body = JSON.parse(rawBody) as unknown;
    } catch {
      body = null;
    }
  }

  if (!response.ok) {
    const errorBody = body as ApiErrorBody | null;
    if (
      response.status === 401 &&
      typeof window !== 'undefined' &&
      window.location.pathname !== '/login'
    ) {
      window.location.assign('/login');
    }
    throw new ApiError(
      errorMessage(errorBody, response.status),
      response.status,
      errorBody?.errors ?? [],
    );
  }

  return body as T;
}

function jsonBody(value: unknown): string {
  return JSON.stringify(value);
}

export const authApi = {
  me: () => apiFetch<AuthResponse>('/api/v1/auth/me'),
  login: (username: string, password: string) =>
    apiFetch<AuthResponse>('/api/v1/auth/login', {
      method: 'POST',
      body: jsonBody({ username, password }),
    }),
  logout: () =>
    apiFetch<{ ok: true }>('/api/v1/auth/logout', {
      method: 'POST',
    }),
};

export const accountsApi = {
  list: () => apiFetch<{ items: Account[] }>('/api/v1/accounts'),
  create: (input: AccountInput) =>
    apiFetch<Account>('/api/v1/accounts', { method: 'POST', body: jsonBody(input) }),
  bulkCreate: (accounts: AccountInput[]) =>
    apiFetch<AccountBulkResult>('/api/v1/accounts/bulk', {
      method: 'POST',
      body: jsonBody({ accounts }),
    }),
  update: (id: string, patch: AccountPatch) =>
    apiFetch<Account>(`/api/v1/accounts/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: jsonBody(patch),
    }),
  remove: (id: string) =>
    apiFetch<void>(`/api/v1/accounts/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};

export const dashboardApi = {
  summary: () => apiFetch<DashboardSummary>('/api/v1/dashboard/summary'),
};

export const monitorsApi = {
  list: (
    options: {
      cursor?: string;
      state?: EffectiveHealthState | 'ALL';
      query?: string;
    } = {},
  ) => {
    const parameters = new URLSearchParams();
    if (options.cursor) parameters.set('cursor', options.cursor);
    if (options.state && options.state !== 'ALL') parameters.set('state', options.state);
    if (options.query?.trim()) parameters.set('query', options.query.trim());
    const queryString = parameters.toString();
    return apiFetch<CursorPage<Monitor>>(`/api/v1/monitors${queryString ? `?${queryString}` : ''}`);
  },
  get: (id: string) => apiFetch<Monitor>(`/api/v1/monitors/${encodeURIComponent(id)}`),
  create: (input: MonitorInput) =>
    apiFetch<Monitor>('/api/v1/monitors', {
      method: 'POST',
      body: jsonBody(input),
    }),
  update: (id: string, input: Partial<MonitorInput>) =>
    apiFetch<Monitor>(`/api/v1/monitors/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: jsonBody(input),
    }),
  remove: (id: string) =>
    apiFetch<void>(`/api/v1/monitors/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  pause: (id: string) =>
    apiFetch<Monitor>(`/api/v1/monitors/${encodeURIComponent(id)}/pause`, {
      method: 'POST',
    }),
  resume: (id: string) =>
    apiFetch<Monitor>(`/api/v1/monitors/${encodeURIComponent(id)}/resume`, {
      method: 'POST',
    }),
  checkNow: (id: string) =>
    apiFetch<CheckResult>(`/api/v1/monitors/${encodeURIComponent(id)}/check-now`, {
      method: 'POST',
    }),
  test: (input: MonitorInput) =>
    apiFetch<CheckResult>('/api/v1/monitors/test', {
      method: 'POST',
      body: jsonBody(input),
    }),
  checks: (id: string, cursor?: string) =>
    apiFetch<CursorPage<CheckResult>>(
      `/api/v1/monitors/${encodeURIComponent(id)}/checks${
        cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''
      }`,
    ),
  incidents: (id: string, cursor?: string) =>
    apiFetch<CursorPage<Incident>>(
      `/api/v1/monitors/${encodeURIComponent(id)}/incidents${
        cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''
      }`,
    ),
};

export const notificationChannelsApi = {
  list: (cursor?: string) =>
    apiFetch<CursorPage<NotificationChannel>>(
      `/api/v1/notification-channels${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
    ),
  create: (input: NotificationChannelInput) =>
    apiFetch<NotificationChannel>('/api/v1/notification-channels', {
      method: 'POST',
      body: jsonBody(input),
    }),
  update: (id: string, patch: NotificationChannelPatch) =>
    apiFetch<NotificationChannel>(`/api/v1/notification-channels/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: jsonBody(patch),
    }),
  remove: (id: string) =>
    apiFetch<void>(`/api/v1/notification-channels/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  test: (id: string) =>
    apiFetch<{ ok: true }>(`/api/v1/notification-channels/${encodeURIComponent(id)}/test`, {
      method: 'POST',
    }),
};

export function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '알 수 없는 문제가 발생했습니다.';
}
