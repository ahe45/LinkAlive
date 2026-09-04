'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Icon } from '@/components/Icon';
import { authApi, getErrorMessage, isUnauthorized } from '@/lib/api';
import type { AuthUser } from '@/lib/types';

const navigation = [
  { href: '/dashboard', label: '대시보드', icon: 'activity' as const },
  { href: '/notifications', label: '알림 채널', icon: 'bell' as const },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  const loadUser = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await authApi.me();
      setUser(response.user);
    } catch (loadError) {
      if (isUnauthorized(loadError)) {
        router.replace('/login');
        return;
      }
      setError(getErrorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    void loadUser();
  }, [loadUser]);

  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  async function logout() {
    setLoggingOut(true);
    try {
      await authApi.logout();
    } finally {
      router.replace('/login');
      router.refresh();
      setLoggingOut(false);
    }
  }

  if (loading) {
    return (
      <div className="auth-check-screen" role="status">
        <Brand />
        <span className="spinner spinner-large" />
        <p>관리자 세션을 확인하고 있습니다</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="auth-check-screen">
        <Brand />
        <div className="connection-error" role="alert">
          <span>
            <Icon name="alert" size={23} />
          </span>
          <h1>서비스에 연결할 수 없습니다</h1>
          <p>{error}</p>
          <button type="button" className="button button-primary" onClick={() => void loadUser()}>
            <Icon name="refresh" size={17} /> 다시 연결
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <aside className={`sidebar${mobileOpen ? ' sidebar-open' : ''}`}>
        <div className="sidebar-top">
          <Brand />
          <button
            type="button"
            className="icon-button mobile-close"
            onClick={() => setMobileOpen(false)}
            aria-label="메뉴 닫기"
          >
            <Icon name="close" />
          </button>
        </div>

        <nav className="sidebar-nav" aria-label="주 메뉴">
          <p className="nav-eyebrow">운영</p>
          {navigation.map((item) => {
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`nav-link${active ? ' nav-link-active' : ''}`}
                aria-current={active ? 'page' : undefined}
              >
                <Icon name={item.icon} size={18} />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="sidebar-security">
          <span>
            <Icon name="shield" size={17} />
          </span>
          <div>
            <strong>안전한 모니터링</strong>
            <p>공인 HTTP/HTTPS만 검사</p>
          </div>
        </div>

        <div className="sidebar-user">
          <span className="user-avatar">{user?.username.slice(0, 1).toUpperCase()}</span>
          <div className="user-info">
            <strong>{user?.username}</strong>
            <span>관리자</span>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="로그아웃"
            title="로그아웃"
            onClick={() => void logout()}
            disabled={loggingOut}
          >
            {loggingOut ? (
              <span className="spinner spinner-small" />
            ) : (
              <Icon name="logout" size={18} />
            )}
          </button>
        </div>
      </aside>

      {mobileOpen ? (
        <button
          type="button"
          className="sidebar-backdrop"
          aria-label="메뉴 닫기"
          onClick={() => setMobileOpen(false)}
        />
      ) : null}

      <div className="app-main">
        <header className="mobile-header">
          <button
            type="button"
            className="icon-button"
            aria-label="메뉴 열기"
            onClick={() => setMobileOpen(true)}
          >
            <Icon name="menu" size={21} />
          </button>
          <Brand compact />
          <span className="mobile-header-spacer" />
        </header>
        <main className="main-content">{children}</main>
      </div>
    </div>
  );
}

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <Link
      className={`brand${compact ? ' brand-compact' : ''}`}
      href="/dashboard"
      aria-label="LinkAlive 대시보드"
    >
      <span className="brand-mark">
        <Icon name="activity" size={20} />
      </span>
      <span className="brand-wordmark">
        Link<span>Alive</span>
      </span>
    </Link>
  );
}
