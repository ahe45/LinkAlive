'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { apiFetch, getErrorMessage } from '@/lib/api';
import { formatDateTime, formatDuration } from '@/lib/format';
import { ErrorPanel, InlineNotice, SectionSkeleton } from '@/components/StateViews';
import { useToast } from '@/components/ToastProvider';
import { Icon } from '@/components/Icon';
import {
  TelegramChannelSelect,
  type SelectableTelegramChannel,
} from '@/components/TelegramChannelSelect';
import Link from 'next/link';

interface Settings {
  enabled: boolean;
  urls: string[];
  channelIds: string[];
  version: number;
}
interface NetworkView {
  settings: Settings;
  channels: SelectableTelegramChannel[];
  observers: {
    id: string;
    status: string;
    checkedAt: string | null;
    probeResults:
      | { url: string; reachable: boolean; statusCode: number | null; errorType: string | null }[]
      | null;
  }[];
  outages: {
    id: string;
    observerId: string;
    startedAt: string;
    recoveredAt: string | null;
    canceledAt: string | null;
    summarizedAt: string | null;
    _count: { observations: number };
  }[];
}

interface ReferenceTestReport {
  checkedFrom: string;
  checkedAt: string;
  results: {
    url: string;
    reachable: boolean;
    statusCode: number | null;
    totalMs: number;
    errorType: string | null;
    errorMessage: string | null;
  }[];
}

const ENDPOINT = '/api/v1/network-settings';
const STATUS: Record<string, string> = {
  ONLINE: '외부 연결 정상',
  OFFLINE: '외부 연결 이상 의심',
  UNKNOWN: '연결 상태 확인 불가',
  DISABLED: '검사 비활성화',
};

export default function NetworkPage() {
  const { showToast } = useToast();
  const [view, setView] = useState<NetworkView | null>(null);
  const [form, setForm] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<number | 'all' | null>(null);
  const [testReport, setTestReport] = useState<ReferenceTestReport | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const load = useCallback(async (replaceForm = false) => {
    try {
      const data = await apiFetch<NetworkView>(ENDPOINT);
      setView(data);
      setForm((current) => (replaceForm || !current ? data.settings : current));
      if (replaceForm) {
        setTestReport(null);
        setTestError(null);
      }
      setError(null);
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 15_000);
    return () => window.clearInterval(timer);
  }, [load]);

  function updateUrls(urls: string[]) {
    setForm((current) => (current ? { ...current, urls } : current));
    setTestReport(null);
    setTestError(null);
  }

  async function testConnections(index?: number) {
    if (!form || testing !== null) return;
    setTesting(index ?? 'all');
    setTestReport(null);
    setTestError(null);
    try {
      const urls = index === undefined ? form.urls : [form.urls[index]!];
      setTestReport(
        await apiFetch<ReferenceTestReport>(`${ENDPOINT}/test`, {
          method: 'POST',
          body: JSON.stringify({ urls }),
        }),
      );
    } catch (err) {
      setTestError(getErrorMessage(err));
    } finally {
      setTesting(null);
    }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!form) return;
    setSaving(true);
    setSaveError(null);
    try {
      const data = await apiFetch<NetworkView>(ENDPOINT, {
        method: 'PUT',
        body: JSON.stringify({
          enabled: form.enabled,
          urls: form.urls,
          channelIds: form.channelIds,
          version: form.version,
        }),
      });
      setView(data);
      setForm(data.settings);
      setError(null);
      showToast('감시 네트워크 설정을 저장했습니다.', 'success');
    } catch (err) {
      setSaveError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="page-container network-page">
      <header className="page-header">
        <div>
          <span className="page-eyebrow">Network</span>
          <h1>감시 네트워크</h1>
          <p>감시 PC의 인터넷 연결 이상을 대상 서버 장애와 구분합니다.</p>
        </div>
        <button
          className="button button-secondary"
          type="button"
          onClick={() => void load(true)}
          disabled={saving || testing !== null}
        >
          <Icon name="refresh" size={16} /> 새로고침
        </button>
      </header>
      {error ? <ErrorPanel message={error} onRetry={() => void load()} /> : null}
      {!view || !form ? (
        <SectionSkeleton />
      ) : (
        <>
          <InlineNotice>
            서로 다른 운영사·네트워크의 기준 주소를 2~5개 등록하세요. 모든 기준 주소의 연결 실패가
            대상 연결 실패와 겹치면 대상 판정을 보류합니다. 평상시에는 60초, 모든 기준 주소의 연결
            실패가 감지되면 10초 간격으로 확인하며, 한 곳이라도 응답하면 60초로 돌아갑니다.
          </InlineNotice>
          <form className="network-card" onSubmit={(event) => void save(event)}>
            <fieldset disabled={saving || testing !== null}>
              <legend>기준 주소 설정</legend>
              <div className="field toggle-row">
                <div>
                  <span className="field-label">감시 PC 연결 검사 사용</span>
                  <span className="field-help">
                    {form.enabled ? '사용' : '사용 안 함'} · 변경 후 설정 저장을 눌러 적용하세요.
                  </span>
                </div>
                <label className="switch">
                  <input
                    type="checkbox"
                    role="switch"
                    aria-label="감시 PC 연결 검사 사용"
                    checked={form.enabled}
                    onChange={(event) => setForm({ ...form, enabled: event.target.checked })}
                  />
                  <span className="switch-track">
                    <span />
                  </span>
                </label>
              </div>
              <p className="network-help">
                공인 HTTP/HTTPS 주소만 사용할 수 있습니다. 로그인이나 인증 토큰이 필요한 주소는
                제외하세요.
              </p>
              <div className="network-references">
                {form.urls.map((url, index) => (
                  <div className="network-reference" key={index}>
                    <label htmlFor={`reference-${index}`}>기준 주소 {index + 1}</label>
                    <input
                      id={`reference-${index}`}
                      type="url"
                      required
                      maxLength={2048}
                      value={url}
                      placeholder="https://example.com/"
                      onChange={(event) =>
                        updateUrls(
                          form.urls.map((value, i) => (i === index ? event.target.value : value)),
                        )
                      }
                    />
                    <button
                      type="button"
                      className="button button-secondary button-small"
                      disabled={!url.trim() || testing !== null || saving}
                      aria-label={`기준 주소 ${index + 1} 연결 테스트`}
                      onClick={() => void testConnections(index)}
                    >
                      {testing === index ? '테스트 중…' : '연결 테스트'}
                    </button>
                    <button
                      type="button"
                      className="button button-secondary button-small"
                      aria-label={`기준 주소 ${index + 1} 삭제`}
                      onClick={() => updateUrls(form.urls.filter((_, i) => i !== index))}
                    >
                      삭제
                    </button>
                  </div>
                ))}
              </div>
              <div className="network-reference-actions">
                <button
                  type="button"
                  className="button button-secondary button-small"
                  disabled={form.urls.length >= 5 || saving}
                  onClick={() => updateUrls([...form.urls, ''])}
                >
                  <Icon name="plus" size={15} /> 기준 주소 추가
                </button>
                <button
                  type="button"
                  className="button button-secondary button-small"
                  disabled={
                    !form.urls.length ||
                    form.urls.some((url) => !url.trim()) ||
                    testing !== null ||
                    saving
                  }
                  onClick={() => void testConnections()}
                >
                  <Icon name="activity" size={15} />{' '}
                  {testing === 'all' ? '전체 테스트 중…' : '전체 연결 테스트'}
                </button>
              </div>
              <p className="network-help">
                저장 전에도 입력한 주소를 테스트할 수 있습니다. 테스트는 설정이나 자동 장애 판정에
                반영되지 않습니다.
              </p>
              {testing !== null ? (
                <InlineNotice>주소별로 최대 5초 동안 응답을 확인하고 있습니다.</InlineNotice>
              ) : null}
              {testError ? <InlineNotice tone="error">{testError}</InlineNotice> : null}
              {testReport ? (
                <section
                  className="network-test-results"
                  aria-label="기준 주소 연결 테스트 결과"
                  aria-live="polite"
                >
                  <h3>연결 테스트 결과</h3>
                  <p className="network-help">
                    실행 PC: {testReport.checkedFrom} · {formatDateTime(testReport.checkedAt)}
                  </p>
                  {testReport.results.map((result, index) => (
                    <article className="network-test-result" key={`${result.url}-${index}`}>
                      <strong className="network-test-url">{result.url}</strong>
                      <span
                        className={`plain-badge outcome-${result.reachable ? 'success' : 'inconclusive'}`}
                      >
                        {result.reachable ? '연결 가능' : '연결 확인 불가'}
                      </span>
                      <p>
                        {result.reachable
                          ? `HTTP ${result.statusCode} 응답 · ${formatDuration(result.totalMs)}`
                          : `${result.errorMessage ?? '응답을 받지 못했습니다.'} (${result.errorType ?? 'UNKNOWN'})`}
                      </p>
                    </article>
                  ))}
                  <p className="network-help">
                    HTTP 404·500도 응답을 받았다면 외부 연결은 가능한 것으로 판단합니다.
                  </p>
                </section>
              ) : null}
              <h3>복구 요약 알림</h3>
              <p className="network-help">
                복구 요약을 받을 Telegram 채널을 선택하세요. 여러 채널을 선택할 수 있습니다. 외부
                연결이 돌아오면 대상을 재검사하고 선택한 채널마다 요약을 한 번 생성합니다. 재검사가
                2분 넘게 걸리면 확인 대기 수를 함께 알립니다.
              </p>
              <TelegramChannelSelect
                channels={view.channels}
                selectedIds={form.channelIds}
                onChange={(channelIds) => setForm({ ...form, channelIds })}
              />
              <p className="network-help">
                <Link href="/notifications">Telegram 채널 등록·관리</Link>
              </p>
              {form.channelIds.some((id) => !view.channels.some((channel) => channel.id === id)) ? (
                <p className="network-help">
                  사용할 수 없는 채널이 선택되어 있습니다.{' '}
                  <button
                    type="button"
                    className="button button-secondary button-small"
                    onClick={() =>
                      setForm({
                        ...form,
                        channelIds: form.channelIds.filter((id) =>
                          view.channels.some((channel) => channel.id === id),
                        ),
                      })
                    }
                  >
                    선택 정리
                  </button>
                </p>
              ) : null}
              {!form.channelIds.length ? (
                <p className="network-help">알림 채널을 선택하지 않으면 중단 이력만 저장합니다.</p>
              ) : null}
              <div className="network-actions">
                <button className="button button-primary" type="submit" disabled={saving}>
                  {saving ? '저장 중…' : '설정 저장'}
                </button>
              </div>
              {saveError ? (
                <InlineNotice tone="error">설정을 저장하지 못했습니다. {saveError}</InlineNotice>
              ) : null}
            </fieldset>
          </form>
          <section className="network-card" aria-labelledby="network-observers">
            <h2 id="network-observers">감시 PC 연결 상태</h2>
            {!view.observers.length ? (
              <p>워커가 연결 상태를 보고하면 여기에 표시됩니다.</p>
            ) : (
              view.observers.map((observer) => {
                const stale =
                  !observer.checkedAt ||
                  Date.now() - new Date(observer.checkedAt).getTime() > 90_000;
                return (
                  <article className="network-observer" key={observer.id}>
                    <div className="network-observer-heading">
                      <strong>{observer.id}</strong>
                      <span
                        className={`badge ${stale || observer.status === 'UNKNOWN' ? 'badge-pending' : observer.status === 'ONLINE' ? 'badge-up' : 'badge-suspect'}`}
                      >
                        {stale ? '최근 상태 보고 없음' : (STATUS[observer.status] ?? '확인 불가')}
                      </span>
                    </div>
                    <p className="network-help">
                      마지막 확인: {formatDateTime(observer.checkedAt)}
                    </p>
                    {observer.probeResults?.map((probe) => (
                      <div className="network-probe" key={probe.url}>
                        <span>{probe.url}</span>
                        <span>
                          {probe.reachable
                            ? `HTTP ${probe.statusCode} 응답`
                            : (probe.errorType ?? '확인 불가')}
                        </span>
                      </div>
                    ))}
                  </article>
                );
              })
            )}
          </section>
          <section className="network-card" aria-labelledby="network-history">
            <h2 id="network-history">최근 연결 중단 이력</h2>
            {!view.outages.length ? (
              <p>기록된 연결 중단이 없습니다.</p>
            ) : (
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>감시 PC</th>
                      <th>감지 시각</th>
                      <th>복구 시각</th>
                      <th>지속 시간</th>
                      <th>대상 수</th>
                      <th>처리 상태</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.outages.map((outage) => (
                      <tr key={outage.id}>
                        <td>{outage.observerId}</td>
                        <td>{formatDateTime(outage.startedAt)}</td>
                        <td>{formatDateTime(outage.recoveredAt)}</td>
                        <td>
                          {outage.recoveredAt
                            ? formatDuration(
                                new Date(outage.recoveredAt).getTime() -
                                  new Date(outage.startedAt).getTime(),
                              )
                            : '—'}
                        </td>
                        <td>{outage._count.observations}</td>
                        <td>
                          {outage.canceledAt
                            ? '설정 비활성화로 종료'
                            : outage.summarizedAt
                              ? '요약 처리 완료'
                              : outage.recoveredAt
                                ? '재검사·요약 대기'
                                : '외부 연결 이상 의심'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
