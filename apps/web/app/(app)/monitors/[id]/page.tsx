'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Icon } from '@/components/Icon';
import { useAuthUser } from '@/components/AppShell';
import { MonitorForm } from '@/components/MonitorForm';
import { EmptyState, ErrorPanel, InlineNotice, PageLoader } from '@/components/StateViews';
import { IncidentBadge, OutcomeBadge, StatusBadge } from '@/components/StatusBadge';
import { useToast } from '@/components/ToastProvider';
import { getErrorMessage, isUnauthorized, monitorsApi, notificationChannelsApi } from '@/lib/api';
import {
  effectiveMonitorState,
  errorTypeLabel,
  formatDateTime,
  formatDuration,
  formatInterval,
  formatRelativeTime,
  isMonitorStale,
  SOURCE_LABELS,
} from '@/lib/format';
import type {
  CheckResult,
  Incident,
  Monitor,
  MonitorInput,
  NotificationChannel,
} from '@/lib/types';

type DetailTab = 'overview' | 'checks' | 'incidents' | 'settings';

const tabs: Array<{ value: DetailTab; label: string }> = [
  { value: 'overview', label: '개요' },
  { value: 'checks', label: '검사 이력' },
  { value: 'incidents', label: '장애 이력' },
  { value: 'settings', label: '설정' },
];

export default function MonitorDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const router = useRouter();
  const currentUser = useAuthUser();
  const { showToast } = useToast();
  const [monitor, setMonitor] = useState<Monitor | null>(null);
  const [checks, setChecks] = useState<CheckResult[]>([]);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [channels, setChannels] = useState<NotificationChannel[]>([]);
  const [checkCursor, setCheckCursor] = useState<string | null>(null);
  const [incidentCursor, setIncidentCursor] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<DetailTab>('overview');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [action, setAction] = useState<
    'lifecycle' | 'check' | 'delete' | 'more-checks' | 'more-incidents' | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const load = useCallback(
    async (quiet = false) => {
      quiet ? setRefreshing(true) : setLoading(true);
      setError(null);
      try {
        const [monitorResponse, checksResponse, incidentsResponse, channelsResponse] =
          await Promise.all([
            monitorsApi.get(id),
            monitorsApi.checks(id),
            monitorsApi.incidents(id),
            currentUser.role === 'ADMIN'
              ? notificationChannelsApi.list()
              : Promise.resolve({ items: [], nextCursor: null }),
          ]);
        setMonitor(monitorResponse);
        setChecks(checksResponse.items);
        setCheckCursor(checksResponse.nextCursor);
        setIncidents(incidentsResponse.items);
        setIncidentCursor(incidentsResponse.nextCursor);
        setChannels(channelsResponse.items.filter((channel) => channel.enabled));
      } catch (loadError) {
        if (isUnauthorized(loadError)) {
          router.replace('/login');
          return;
        }
        setError(getErrorMessage(loadError));
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [currentUser.role, id, router],
  );

  useEffect(() => {
    void load();
  }, [load]);

  async function toggleLifecycle() {
    if (!monitor) return;
    const pausing = monitor.lifecycleStatus === 'ACTIVE';
    if (
      pausing &&
      !window.confirm(
        '모니터를 일시 중지할까요? 진행 중인 장애는 취소되고 복구 알림은 발송하지 않습니다.',
      )
    )
      return;
    setAction('lifecycle');
    try {
      const updated = pausing ? await monitorsApi.pause(id) : await monitorsApi.resume(id);
      setMonitor(updated);
      showToast(pausing ? '모니터를 일시 중지했습니다.' : '모니터링을 재개했습니다.', 'success');
      void load(true);
    } catch (actionError) {
      showToast(getErrorMessage(actionError), 'error');
    } finally {
      setAction(null);
    }
  }

  async function checkNow() {
    if (!monitor) return;
    setAction('check');
    try {
      const result = await monitorsApi.checkNow(id);
      if (result?.outcome === 'SUCCESS') {
        showToast('즉시 검사에 성공했습니다.', 'success');
      } else if (result?.outcome) {
        showToast(`검사 완료: ${errorTypeLabel(result.errorType)}`, 'error');
      } else {
        showToast('즉시 검사를 요청했습니다.', 'success');
      }
      await load(true);
    } catch (actionError) {
      showToast(getErrorMessage(actionError), 'error');
    } finally {
      setAction(null);
    }
  }

  async function removeMonitor() {
    if (!monitor) return;
    const confirmed = window.confirm(
      `“${monitor.name}” 모니터를 삭제할까요? 자동 검사가 종료되며 이 작업은 화면에서 되돌릴 수 없습니다.`,
    );
    if (!confirmed) return;
    setAction('delete');
    try {
      await monitorsApi.remove(id);
      showToast('모니터를 삭제했습니다.', 'success');
      router.replace('/dashboard');
    } catch (actionError) {
      showToast(getErrorMessage(actionError), 'error');
    } finally {
      setAction(null);
    }
  }

  async function saveSettings(value: MonitorInput) {
    setSaving(true);
    setSaveError(null);
    try {
      const { url, ...unchangedUrlInput } = value;
      const updated = await monitorsApi.update(id, url ? value : unchangedUrlInput);
      setMonitor(updated);
      showToast('모니터 설정을 저장했습니다.', 'success');
      setActiveTab('overview');
      void load(true);
    } catch (saveSettingsError) {
      setSaveError(getErrorMessage(saveSettingsError));
    } finally {
      setSaving(false);
    }
  }

  async function loadMoreChecks() {
    if (!checkCursor) return;
    setAction('more-checks');
    try {
      const response = await monitorsApi.checks(id, checkCursor);
      setChecks((current) => [...current, ...response.items]);
      setCheckCursor(response.nextCursor);
    } catch (loadError) {
      showToast(getErrorMessage(loadError), 'error');
    } finally {
      setAction(null);
    }
  }

  async function loadMoreIncidents() {
    if (!incidentCursor) return;
    setAction('more-incidents');
    try {
      const response = await monitorsApi.incidents(id, incidentCursor);
      setIncidents((current) => [...current, ...response.items]);
      setIncidentCursor(response.nextCursor);
    } catch (loadError) {
      showToast(getErrorMessage(loadError), 'error');
    } finally {
      setAction(null);
    }
  }

  if (loading)
    return (
      <div className="page-container">
        <PageLoader label="모니터 정보를 불러오는 중입니다" />
      </div>
    );
  if (error || !monitor) {
    return (
      <div className="page-container page-narrow">
        <ErrorPanel message={error ?? '모니터를 찾을 수 없습니다.'} onRetry={() => void load()} />
        <Link className="button button-ghost" href="/dashboard">
          <Icon name="arrowLeft" size={16} /> 대시보드로 돌아가기
        </Link>
      </div>
    );
  }

  const state = effectiveMonitorState(monitor);
  const stale = isMonitorStale(monitor);

  return (
    <div className="page-container">
      <nav className="breadcrumbs" aria-label="현재 위치">
        <Link href="/dashboard">대시보드</Link>
        <Icon name="chevronRight" size={14} />
        <span>{monitor.name}</span>
      </nav>

      <header className="monitor-detail-header">
        <div className="detail-title-wrap">
          <span className={`detail-monitor-icon monitor-favicon-${state.toLowerCase()}`}>
            <Icon name="globe" size={22} />
          </span>
          <div>
            <div className="detail-title-line">
              <h1>{monitor.name}</h1>
              <StatusBadge state={state} />
              {stale && state !== 'STALE' ? <StatusBadge state="STALE" /> : null}
            </div>
            <a
              href={monitor.displayUrl ?? monitor.url}
              target="_blank"
              rel="noreferrer"
              className="detail-url"
            >
              {monitor.displayUrl ?? monitor.url} <Icon name="external" size={13} />
            </a>
          </div>
        </div>
        <div className="page-header-actions detail-actions">
          <button
            type="button"
            className="button button-secondary"
            onClick={() => void checkNow()}
            disabled={action !== null || refreshing}
          >
            {action === 'check' ? (
              <span className="spinner spinner-button" />
            ) : (
              <Icon name="refresh" size={16} />
            )}{' '}
            즉시 검사
          </button>
          <button
            type="button"
            className="button button-secondary"
            onClick={() => void toggleLifecycle()}
            disabled={action !== null}
          >
            {action === 'lifecycle' ? (
              <span className="spinner spinner-button" />
            ) : (
              <Icon name={monitor.lifecycleStatus === 'ACTIVE' ? 'pause' : 'play'} size={16} />
            )}
            {monitor.lifecycleStatus === 'ACTIVE' ? '일시 중지' : '재개'}
          </button>
          <button
            type="button"
            className="button button-danger-ghost"
            onClick={() => void removeMonitor()}
            disabled={action !== null}
          >
            {action === 'delete' ? (
              <span className="spinner spinner-button" />
            ) : (
              <Icon name="trash" size={16} />
            )}{' '}
            삭제
          </button>
        </div>
      </header>

      <div className="tabs" role="tablist" aria-label="모니터 상세 메뉴">
        {tabs.map((tab) => (
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === tab.value}
            className={activeTab === tab.value ? 'tab-active' : ''}
            onClick={() => setActiveTab(tab.value)}
            key={tab.value}
          >
            {tab.label}
            {tab.value === 'incidents' &&
            incidents.filter((incident) => incident.status === 'OPEN').length ? (
              <span className="tab-count">
                {incidents.filter((incident) => incident.status === 'OPEN').length}
              </span>
            ) : null}
          </button>
        ))}
      </div>

      {activeTab === 'overview' ? (
        <OverviewTab
          monitor={monitor}
          checks={checks}
          incidents={incidents}
          refreshing={refreshing}
          onRefresh={() => void load(true)}
          onOpenTab={setActiveTab}
        />
      ) : null}

      {activeTab === 'checks' ? (
        <section className="content-card detail-tab-card">
          <div className="card-header">
            <div>
              <h2>검사 이력</h2>
              <p>자동, 수동, 시험 검사의 최근 결과입니다.</p>
            </div>
            <button
              type="button"
              className="icon-button"
              aria-label="검사 이력 새로고침"
              onClick={() => void load(true)}
              disabled={refreshing}
            >
              {refreshing ? (
                <span className="spinner spinner-small" />
              ) : (
                <Icon name="refresh" size={17} />
              )}
            </button>
          </div>
          <CheckHistory checks={checks} />
          {checkCursor ? (
            <LoadMore loading={action === 'more-checks'} onClick={() => void loadMoreChecks()} />
          ) : null}
        </section>
      ) : null}

      {activeTab === 'incidents' ? (
        <section className="content-card detail-tab-card">
          <div className="card-header">
            <div>
              <h2>장애 이력</h2>
              <p>확정된 장애의 발생, 복구, 취소 기록입니다.</p>
            </div>
            <button
              type="button"
              className="icon-button"
              aria-label="장애 이력 새로고침"
              onClick={() => void load(true)}
              disabled={refreshing}
            >
              {refreshing ? (
                <span className="spinner spinner-small" />
              ) : (
                <Icon name="refresh" size={17} />
              )}
            </button>
          </div>
          <IncidentHistory incidents={incidents} />
          {incidentCursor ? (
            <LoadMore
              loading={action === 'more-incidents'}
              onClick={() => void loadMoreIncidents()}
            />
          ) : null}
        </section>
      ) : null}

      {activeTab === 'settings' ? (
        <div className="settings-tab">
          {saveError ? <InlineNotice tone="error">{saveError}</InlineNotice> : null}
          <MonitorForm
            key={`${monitor.id}-${monitor.updatedAt}`}
            mode="edit"
            currentDisplayUrl={monitor.displayUrl ?? monitor.url}
            initialValue={{
              name: monitor.name,
              method: monitor.method,
              intervalSec: monitor.intervalSec,
              timeoutMs: monitor.timeoutMs,
              expectedStatusMin: monitor.expectedStatusMin,
              expectedStatusMax: monitor.expectedStatusMax,
              expectedKeyword: monitor.expectedKeyword ?? '',
              followRedirects: monitor.followRedirects,
              maxRedirects: monitor.maxRedirects,
              failureThreshold: monitor.failureThreshold,
              recoveryThreshold: monitor.recoveryThreshold,
              channelIds: monitor.channelIds ?? [],
            }}
            channels={channels}
            showNotificationChannels={currentUser.role === 'ADMIN'}
            onSubmit={saveSettings}
            onTest={monitorsApi.test}
            submitting={saving}
          />
        </div>
      ) : null}
    </div>
  );
}

function OverviewTab({
  monitor,
  checks,
  incidents,
  refreshing,
  onRefresh,
  onOpenTab,
}: {
  monitor: Monitor;
  checks: CheckResult[];
  incidents: Incident[];
  refreshing: boolean;
  onRefresh: () => void;
  onOpenTab: (tab: DetailTab) => void;
}) {
  const openIncident = incidents.find((incident) => incident.status === 'OPEN');
  return (
    <div className="overview-layout">
      <div className="overview-main">
        {openIncident ? (
          <div className="incident-alert">
            <span>
              <Icon name="alert" size={22} />
            </span>
            <div>
              <strong>현재 장애가 진행 중입니다</strong>
              <p>
                {errorTypeLabel(openIncident.lastErrorType)} ·{' '}
                {formatRelativeTime(openIncident.detectedAt)} 감지
              </p>
            </div>
            <button
              type="button"
              className="button button-danger-ghost button-small"
              onClick={() => onOpenTab('incidents')}
            >
              자세히 보기
            </button>
          </div>
        ) : null}

        <section className="detail-metrics-grid">
          <article>
            <span>
              <Icon name="clock" size={17} /> 최근 검사
            </span>
            <strong>{formatRelativeTime(monitor.lastCheckedAt)}</strong>
            <small>{formatDateTime(monitor.lastCheckedAt)}</small>
          </article>
          <article>
            <span>
              <Icon name="activity" size={17} /> 응답 시간
            </span>
            <strong>{formatDuration(monitor.lastTtfbMs)}</strong>
            <small>
              {monitor.lastTotalMs != null
                ? `전체 ${formatDuration(monitor.lastTotalMs)}`
                : '측정값 없음'}
            </small>
          </article>
          <article>
            <span>
              <Icon name="globe" size={17} /> HTTP 상태
            </span>
            <strong>{monitor.lastStatusCode ?? '—'}</strong>
            <small>
              정상 범위 {monitor.expectedStatusMin}–{monitor.expectedStatusMax}
            </small>
          </article>
          <article>
            <span>
              <Icon name="refresh" size={17} /> 다음 검사
            </span>
            <strong>
              {monitor.lifecycleStatus === 'PAUSED'
                ? '중지됨'
                : formatRelativeTime(monitor.nextCheckAt)}
            </strong>
            <small>매 {formatInterval(monitor.intervalSec)}</small>
          </article>
        </section>

        <section className="content-card overview-history-card">
          <div className="card-header">
            <div>
              <h2>최근 검사</h2>
              <p>가장 최근 수행된 검사 결과입니다.</p>
            </div>
            <button type="button" className="text-button" onClick={() => onOpenTab('checks')}>
              전체 보기 <Icon name="chevronRight" size={15} />
            </button>
          </div>
          <CheckHistory checks={checks.slice(0, 5)} compact />
        </section>
      </div>

      <aside className="overview-sidebar">
        <section className="content-card config-summary-card">
          <div className="card-header">
            <h2>검사 설정</h2>
            <button
              type="button"
              className="icon-button"
              aria-label="설정 수정"
              onClick={() => onOpenTab('settings')}
            >
              <Icon name="edit" size={16} />
            </button>
          </div>
          <dl className="config-list">
            <div>
              <dt>요청 방식</dt>
              <dd>{monitor.method}</dd>
            </div>
            <div>
              <dt>검사 주기</dt>
              <dd>{formatInterval(monitor.intervalSec)}</dd>
            </div>
            <div>
              <dt>제한 시간</dt>
              <dd>{monitor.timeoutMs / 1000}초</dd>
            </div>
            <div>
              <dt>정상 상태</dt>
              <dd>
                {monitor.expectedStatusMin}–{monitor.expectedStatusMax}
              </dd>
            </div>
            <div>
              <dt>장애 확정</dt>
              <dd>{monitor.failureThreshold}회 실패</dd>
            </div>
            <div>
              <dt>복구 확정</dt>
              <dd>{monitor.recoveryThreshold}회 성공</dd>
            </div>
            <div>
              <dt>리다이렉트</dt>
              <dd>{monitor.followRedirects ? `최대 ${monitor.maxRedirects}회` : '허용 안 함'}</dd>
            </div>
          </dl>
        </section>

        <section className="content-card latest-result-card">
          <div className="card-header">
            <h2>현재 판정</h2>
          </div>
          {monitor.lastErrorType ? (
            <div className="latest-error">
              <span>
                <Icon name="alert" size={19} />
              </span>
              <div>
                <strong>{errorTypeLabel(monitor.lastErrorType)}</strong>
                <p>{monitor.lastErrorMessage ?? '최근 검사에서 대상 오류가 확인되었습니다.'}</p>
              </div>
            </div>
          ) : (
            <div className="latest-success">
              <span>
                <Icon name="check" size={20} />
              </span>
              <div>
                <strong>대상이 정상입니다</strong>
                <p>최근 검사에서 문제를 발견하지 못했습니다.</p>
              </div>
            </div>
          )}
          <button
            type="button"
            className="button button-secondary button-full"
            onClick={onRefresh}
            disabled={refreshing}
          >
            {refreshing ? (
              <span className="spinner spinner-button" />
            ) : (
              <Icon name="refresh" size={16} />
            )}{' '}
            정보 새로고침
          </button>
        </section>
      </aside>
    </div>
  );
}

function CheckHistory({ checks, compact = false }: { checks: CheckResult[]; compact?: boolean }) {
  if (!checks.length) {
    return (
      <EmptyState
        icon="activity"
        title="아직 검사 기록이 없습니다"
        description="첫 자동 검사나 즉시 검사를 수행하면 결과가 여기에 표시됩니다."
      />
    );
  }
  return (
    <div
      className={`history-table${compact ? ' history-table-compact' : ''}`}
      role="table"
      aria-label="검사 이력"
    >
      <div className="history-header" role="row">
        <span>결과</span>
        <span>검사 시각</span>
        <span>유형</span>
        <span>HTTP</span>
        <span>응답 시간</span>
        <span>상세</span>
      </div>
      {checks.map((check) => (
        <div className="history-row" role="row" key={check.id}>
          <span data-label="결과">
            <OutcomeBadge outcome={check.outcome} />
          </span>
          <span data-label="검사 시각">
            <strong>{formatRelativeTime(check.finishedAt)}</strong>
            <small>{formatDateTime(check.finishedAt)}</small>
          </span>
          <span data-label="유형">{SOURCE_LABELS[check.source]}</span>
          <span data-label="HTTP">{check.statusCode ?? '—'}</span>
          <span data-label="응답 시간">{formatDuration(check.ttfbMs)}</span>
          <span data-label="상세" title={check.errorMessageSafe ?? undefined}>
            {check.errorType ? errorTypeLabel(check.errorType) : '정상 응답'}
          </span>
        </div>
      ))}
    </div>
  );
}

function IncidentHistory({ incidents }: { incidents: Incident[] }) {
  if (!incidents.length) {
    return (
      <EmptyState
        icon="shield"
        title="기록된 장애가 없습니다"
        description="장애 임계치에 도달한 사건이 생기면 발생과 복구 정보가 여기에 기록됩니다."
      />
    );
  }
  return (
    <div className="incident-list">
      {incidents.map((incident) => {
        const endedAt = incident.resolvedAt ?? incident.canceledAt;
        const duration =
          incident.durationMs ??
          (endedAt ? new Date(endedAt).getTime() : Date.now()) -
            new Date(incident.detectedAt).getTime();
        return (
          <article
            className={`incident-item incident-item-${incident.status.toLowerCase()}`}
            key={incident.id}
          >
            <span className="incident-timeline-dot">
              <Icon
                name={
                  incident.status === 'RESOLVED'
                    ? 'check'
                    : incident.status === 'OPEN'
                      ? 'alert'
                      : 'close'
                }
                size={16}
              />
            </span>
            <div className="incident-item-main">
              <div className="incident-item-heading">
                <div>
                  <IncidentBadge status={incident.status} />
                  <strong>
                    {errorTypeLabel(incident.lastErrorType ?? incident.firstErrorType)}
                  </strong>
                </div>
                <span>{formatDuration(Math.max(0, duration))}</span>
              </div>
              <dl>
                <div>
                  <dt>최초 실패</dt>
                  <dd>{formatDateTime(incident.firstFailureAt)}</dd>
                </div>
                <div>
                  <dt>장애 확정</dt>
                  <dd>{formatDateTime(incident.detectedAt)}</dd>
                </div>
                <div>
                  <dt>{incident.status === 'RESOLVED' ? '복구' : '종료'}</dt>
                  <dd>{formatDateTime(endedAt)}</dd>
                </div>
                {incident.closureReason ? (
                  <div>
                    <dt>종료 사유</dt>
                    <dd>{closureReasonLabel(incident.closureReason)}</dd>
                  </div>
                ) : null}
              </dl>
              {incident.notifications?.length ? (
                <div className="incident-notifications" aria-label="알림 발송 상태">
                  {incident.notifications.map((notification) => (
                    <div className="incident-notification" key={notification.id}>
                      <div className="incident-notification-summary">
                        <span>
                          <strong>{notification.channelDisplayNameSnapshot}</strong>
                          <small>{notificationEventLabel(notification.eventType)}</small>
                        </span>
                        <span
                          className={`delivery-badge delivery-${notification.status.toLowerCase()}`}
                          title={notification.lastErrorSafe ?? undefined}
                        >
                          {notificationStatusLabel(notification.status)}
                        </span>
                      </div>
                      {notification.deliveries?.length ? (
                        <div
                          className="delivery-attempts"
                          aria-label="실패 또는 결과 불명 발송 시도"
                        >
                          {notification.deliveries.map((delivery) => (
                            <div
                              className={`delivery-attempt delivery-attempt-${delivery.status.toLowerCase()}`}
                              key={delivery.id}
                            >
                              <span>
                                {delivery.attempt}차 시도 ·{' '}
                                {notificationDeliveryStatusLabel(delivery.status)}
                              </span>
                              <time dateTime={delivery.finishedAt ?? delivery.startedAt}>
                                {formatDateTime(delivery.finishedAt ?? delivery.startedAt)}
                              </time>
                              {delivery.errorSafe ? <small>{delivery.errorSafe}</small> : null}
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          </article>
        );
      })}
    </div>
  );
}

function notificationEventLabel(value: string): string {
  const labels: Record<string, string> = {
    DOWN: '장애 알림',
    RECOVERY: '복구 알림',
    RESOLVED_SUMMARY: '장애·복구 요약',
    TEST: '시험 알림',
  };
  return labels[value] ?? value;
}

function notificationStatusLabel(value: string): string {
  const labels: Record<string, string> = {
    PENDING: '대기',
    ENQUEUED: '발송 대기',
    PROCESSING: '발송 중',
    RETRY: '재시도',
    SENT: '발송 완료',
    FAILED: '최종 실패',
    CANCELED: '취소',
  };
  return labels[value] ?? value;
}

function notificationDeliveryStatusLabel(value: string): string {
  const labels: Record<string, string> = {
    FAILED: '실패',
    UNKNOWN: '결과 불명',
  };
  return labels[value] ?? value;
}

function closureReasonLabel(value: string): string {
  const labels: Record<string, string> = {
    RECOVERED: '정상 복구',
    PAUSED: '모니터 일시 중지',
    DELETED: '모니터 삭제',
    CONFIG_CHANGED: '판정 설정 변경',
  };
  return labels[value] ?? value;
}

function LoadMore({ loading, onClick }: { loading: boolean; onClick: () => void }) {
  return (
    <div className="load-more-wrap">
      <button
        type="button"
        className="button button-secondary"
        onClick={onClick}
        disabled={loading}
      >
        {loading ? <span className="spinner spinner-button" /> : <Icon name="more" size={16} />}{' '}
        이전 기록 더 보기
      </button>
    </div>
  );
}
