'use client';

import { FormEvent, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Icon } from '@/components/Icon';
import { authApi, getErrorMessage } from '@/lib/api';

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    authApi
      .me()
      .then(() => {
        if (active) router.replace('/dashboard');
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setChecking(false);
      });
    return () => {
      active = false;
    };
  }, [router]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!username.trim() || !password) {
      setError('아이디와 비밀번호를 모두 입력해 주세요.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await authApi.login(username.trim(), password);
      router.replace('/dashboard');
      router.refresh();
    } catch (loginError) {
      setError(getErrorMessage(loginError));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="login-page">
      <section className="login-visual" aria-hidden="true">
        <div className="visual-grid" />
        <div className="visual-copy">
          <div className="brand brand-on-dark">
            <span className="brand-mark">
              <Icon name="activity" size={20} />
            </span>
            <span className="brand-wordmark">
              Link<span>Alive</span>
            </span>
          </div>
          <div className="visual-heading">
            <span className="eyebrow-dark">Always on. Always informed.</span>
            <h1>
              서비스의 이상 신호를
              <br />
              가장 먼저 발견하세요.
            </h1>
            <p>URL 상태를 지속적으로 확인하고 장애와 복구 순간을 놓치지 않습니다.</p>
          </div>
          <div className="visual-status-card">
            <div className="mini-chart">
              {[42, 55, 38, 64, 48, 68, 73, 60, 78, 72, 84, 80].map((height, index) => (
                <span key={index} style={{ height: `${height}%` }} />
              ))}
            </div>
            <div>
              <span className="live-dot" /> 실시간 검사 작동 중
            </div>
            <strong>99.98%</strong>
            <small>최근 가용성</small>
          </div>
        </div>
      </section>

      <section className="login-panel">
        <div className="login-form-wrap">
          <div className="mobile-login-brand">
            <span className="brand-mark">
              <Icon name="activity" size={20} />
            </span>
            <span className="brand-wordmark">
              Link<span>Alive</span>
            </span>
          </div>
          <div className="login-copy">
            <span className="login-kicker">관리자 콘솔</span>
            <h2>다시 만나 반갑습니다</h2>
            <p>모니터링 현황을 확인하려면 로그인해 주세요.</p>
          </div>

          {checking ? (
            <div className="login-checking" role="status">
              <span className="spinner" /> 기존 세션을 확인하고 있습니다
            </div>
          ) : (
            <form className="login-form" onSubmit={submit} noValidate>
              {error ? (
                <div className="form-error" role="alert">
                  <Icon name="alert" size={17} /> {error}
                </div>
              ) : null}

              <label className="field">
                <span className="field-label">아이디</span>
                <span className="input-with-icon">
                  <Icon name="user" size={17} />
                  <input
                    type="text"
                    name="username"
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                    placeholder="관리자 아이디"
                    autoComplete="username"
                    autoFocus
                  />
                </span>
              </label>

              <label className="field">
                <span className="field-label">비밀번호</span>
                <span className="input-with-icon">
                  <Icon name="key" size={17} />
                  <input
                    type="password"
                    name="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder="비밀번호"
                    autoComplete="current-password"
                  />
                </span>
              </label>

              <button
                type="submit"
                className="button button-primary button-login"
                disabled={submitting}
              >
                {submitting ? (
                  <>
                    <span className="spinner spinner-button" /> 로그인 중
                  </>
                ) : (
                  <>
                    로그인 <Icon name="chevronRight" size={17} />
                  </>
                )}
              </button>
            </form>
          )}

          <p className="login-help">
            <Icon name="shield" size={15} /> 인증 정보는 안전한 쿠키로 보호됩니다.
          </p>
        </div>
      </section>
    </main>
  );
}
