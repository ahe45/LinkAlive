'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@/components/Icon';
import { EmptyState, ErrorPanel, SectionSkeleton } from '@/components/StateViews';
import { StatusBadge } from '@/components/StatusBadge';
import { useToast } from '@/components/ToastProvider';
import { dashboardApi, getErrorMessage, isUnauthorized, monitorsApi } from '@/lib/api';
import {
  effectiveMonitorState,
  errorTypeLabel,
  formatDuration,
  formatInterval,
  formatRelativeTime,
  isMonitorStale,
} from '@/lib/format';
import type { DashboardSummary, EffectiveHealthState, Monitor } from '@/lib/types';

type FilterValue = 'ALL' | EffectiveHealthState;

const EMPTY_SUMMARY: DashboardSummary = {
  total: 0,
  up: 0,
  suspect: 0,
  down: 0,
  paused: 0,
  pending: 0,
  recovering: 0,
  warning: 0,
};

export default function DashboardPage() {
  const router = useRouter();
  const { showToast } = useToast();
  const [summary, setSummary] = useState<DashboardSummary>(EMPTY_SUMMARY);
  const [monitors, setMonitors] = useState<Monitor[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<FilterValue>('ALL');
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const loadSequence = useRef(0);
  const loadMoreInFlight = useRef(false);

  const loadDashboard = useCallback(
    async (quiet = false) => {
      const sequence = ++loadSequence.current;
      loadMoreInFlight.current = true;
      setLoadingMore(false);
      quiet ? setRefreshing(true) : setLoading(true);
      setError(null);
      try {
        const [summaryResponse, monitorResponse] = await Promise.all([
          dashboardApi.summary(),
          monitorsApi.list({ state: filter, query }),
        ]);
        if (sequence !== loadSequence.current) return;
        setSummary(summaryResponse);
        setMonitors(monitorResponse.items);
        setNextCursor(monitorResponse.nextCursor);
      } catch (loadError) {
        if (sequence !== loadSequence.current) return;
        if (isUnauthorized(loadError)) {
          router.replace('/login');
          return;
        }
        setError(getErrorMessage(loadError));
      } finally {
        if (sequence === loadSequence.current) {
          loadMoreInFlight.current = false;
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [filter, query, router],
  );

  useEffect(() => {
    // Invalidate both the current page and an older load-more response as soon
    // as the requested filter changes, before the debounced request starts.
    loadSequence.current += 1;
    loadMoreInFlight.current = true;
    setLoadingMore(false);
    setLoading(true);
    setNextCursor(null);
    const timer = window.setTimeout(() => void loadDashboard(), 200);
    return () => window.clearTimeout(timer);
  }, [loadDashboard]);

  const visibleMonitors = useMemo(() => {
    const search = query.trim().toLocaleLowerCase('ko-KR');
    return monitors.filter((monitor) => {
      const state = effectiveMonitorState(monitor);
      const matchesFilter =
        filter === 'ALL' || (filter === 'STALE' ? isMonitorStale(monitor) : state === filter);
      const matchesSearch =
        !search ||
        monitor.name.toLocaleLowerCase('ko-KR').includes(search) ||
        (monitor.displayUrl ?? monitor.url).toLocaleLowerCase('ko-KR').includes(search);
      return matchesFilter && matchesSearch;
    });
  }, [filter, monitors, query]);

  async function toggleLifecycle(monitor: Monitor) {
    const pausing = monitor.lifecycleStatus === 'ACTIVE';
    setPendingAction(monitor.id);
    try {
      const updated = pausing
        ? await monitorsApi.pause(monitor.id)
        : await monitorsApi.resume(monitor.id);
      setMonitors((current) => current.map((item) => (item.id === monitor.id ? updated : item)));
      showToast(
        pausing ? '모니터를 일시 중지했습니다.' : '모니터링을 다시 시작했습니다.',
        'success',
      );
      void dashboardApi
        .summary()
        .then(setSummary)
        .catch(() => undefined);
    } catch (actionError) {
      showToast(getErrorMessage(actionError), 'error');
    } finally {
      setPendingAction(null);
    }
  }

  async function checkNow(monitor: Monitor) {
    setPendingAction(monitor.id);
    try {
      const result = await monitorsApi.checkNow(monitor.id);
      if (result?.outcome === 'SUCCESS') {
        showToast(`${monitor.name}에 정상적으로 접속했습니다.`, 'success');
      } else if (result?.outcome) {
        showToast(`${monitor.name} 검사 완료: ${errorTypeLabel(result.errorType)}`, 'error');
      } else {
        showToast('즉시 검사를 요청했습니다.', 'success');
      }
      window.setTimeout(() => void loadDashboard(true), 800);
    } catch (actionError) {
      showToast(getErrorMessage(actionError), 'error');
    } finally {
      setPendingAction(null);
    }
  }

  async function loadMore() {
    if (!nextCursor || loadMoreInFlight.current) return;
    const sequence = loadSequence.current;
    loadMoreInFlight.current = true;
    setLoadingMore(true);
    try {
      const response = await monitorsApi.list({ cursor: nextCursor, state: filter, query });
      if (sequence !== loadSequence.current) return;
      setMonitors((current) => [...current, ...response.items]);
      setNextCursor(response.nextCursor);
    } catch (loadError) {
      if (sequence === loadSequence.current) {
        showToast(getErrorMessage(loadError), 'error');
      }
    } finally {
      if (sequence === loadSequence.current) {
        loadMoreInFlight.current = false;
        setLoadingMore(false);
      }
    }
  }

  const warningCount = summary.warning;

  return (
    <div className="page-container">
      <header className="page-header dashboard-header">
        <div>
          <span className="page-eyebrow">Overview</span>
          <h1>서비스 모니터링</h1>
          <p>등록한 URL의 현재 상태와 최근 검사 결과를 한눈에 확인하세요.</p>
        </div>
        <div className="page-header-actions">
          <button
            type="button"
            className="button button-secondary"
            onClick={() => void loadDashboard(true)}
            disabled={refreshing}
          >
            {refreshing ? (
              <span className="spinner spinner-button" />
            ) : (
              <Icon name="refresh" size={16} />
            )}
            새로고침
          </button>
          <Link className="button button-primary" href="/monitors/new">
            <Icon name="plus" size={17} /> 모니터 추가
          </Link>
        </div>
      </header>

      {error && !loading ? (
        <ErrorPanel message={error} onRetry={() => void loadDashboard()} />
      ) : (
        <>
          <section className="summary-grid" aria-label="모니터 상태 요약">
            {loading ? (
              Array.from({ length: 5 }, (_, index) => <SummarySkeleton key={index} />)
            ) : (
              <>
                <SummaryCard
                  label="전체 모니터"
                  value={summary.total}
                  tone="neutral"
                  icon="globe"
                  detail="등록된 전체 URL"
                />
                <SummaryCard
                  label="정상"
                  value={summary.up}
                  tone="success"
                  icon="check"
                  detail="문제없이 응답 중"
                />
                <SummaryCard
                  label="확인 필요"
                  value={warningCount}
                  tone="warning"
                  icon="clock"
                  detail="불안정 · 대기 · 지연"
                />
                <SummaryCard
                  label="장애"
                  value={summary.down}
                  tone="danger"
                  icon="alert"
                  detail={summary.down ? '지금 확인이 필요합니다' : '현재 장애 없음'}
                />
                <SummaryCard
                  label="일시 중지"
                  value={summary.paused}
                  tone="muted"
                  icon="pause"
                  detail="자동 검사를 쉬는 중"
                />
              </>
            )}
          </section>

          <section className="content-card monitor-list-card">
            <div className="card-header monitor-toolbar-heading">
              <div>
                <h2>모니터 목록</h2>
                <p>
                  {loading
                    ? '목록을 불러오는 중입니다'
                    : `총 ${summary.total}개 URL을 관리하고 있습니다.`}
                </p>
              </div>
              <div className="toolbar">
                <label className="search-field">
                  <Icon name="search" size={16} />
                  <span className="sr-only">모니터 검색</span>
                  <input
                    type="search"
                    placeholder="이름 또는 URL 검색"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                  {query ? (
                    <button type="button" onClick={() => setQuery('')} aria-label="검색어 지우기">
                      <Icon name="close" size={14} />
                    </button>
                  ) : null}
                </label>
                <label className="filter-field">
                  <span className="sr-only">상태 필터</span>
                  <select
                    value={filter}
                    onChange={(event) => setFilter(event.target.value as FilterValue)}
                  >
                    <option value="ALL">모든 상태</option>
                    <option value="UP">정상</option>
                    <option value="SUSPECT">불안정</option>
                    <option value="DOWN">장애</option>
                    <option value="RECOVERING">복구 확인 중</option>
                    <option value="PENDING">확인 대기</option>
                    <option value="STALE">검사 지연</option>
                    <option value="PAUSED">일시 중지</option>
                  </select>
                </label>
              </div>
            </div>

            {loading ? (
              <div className="card-body">
                <SectionSkeleton rows={5} />
              </div>
            ) : summary.total === 0 ? (
              <EmptyState
                icon="globe"
                title="첫 번째 URL을 등록해 보세요"
                description="등록한 주소를 주기적으로 확인하고 장애와 복구 순간에 알림을 받을 수 있습니다."
                action={
                  <Link className="button button-primary" href="/monitors/new">
                    <Icon name="plus" size={16} /> 모니터 추가
                  </Link>
                }
              />
            ) : visibleMonitors.length === 0 ? (
              <EmptyState
                icon="search"
                title="조건에 맞는 모니터가 없습니다"
                description="검색어나 상태 필터를 바꿔 보세요."
                action={
                  <button
                    type="button"
                    className="button button-secondary"
                    onClick={() => {
                      setQuery('');
                      setFilter('ALL');
                    }}
                  >
                    필터 초기화
                  </button>
                }
              />
            ) : (
              <div className="monitor-table" role="table" aria-label="모니터 목록">
                <div className="monitor-table-header" role="row">
                  <span role="columnheader">모니터</span>
                  <span role="columnheader">상태</span>
                  <span role="columnheader">최근 검사</span>
                  <span role="columnheader">응답</span>
                  <span role="columnheader">다음 검사</span>
                  <span role="columnheader">
                    <span className="sr-only">작업</span>
                  </span>
                </div>
                {visibleMonitors.map((monitor) => {
                  const state = effectiveMonitorState(monitor);
                  const stale = isMonitorStale(monitor);
                  const busy = pendingAction === monitor.id;
                  return (
                    <div className="monitor-row" role="row" key={monitor.id}>
                      <div className="monitor-identity" role="cell">
                        <span className={`monitor-favicon monitor-favicon-${state.toLowerCase()}`}>
                          <Icon name="globe" size={18} />
                        </span>
                        <div>
                          <Link href={`/monitors/${monitor.id}`}>{monitor.name}</Link>
                          <span title={monitor.displayUrl ?? monitor.url}>
                            {monitor.displayUrl ?? monitor.url}
                          </span>
                        </div>
                      </div>
                      <div role="cell" data-label="상태">
                        <div className="status-badge-group">
                          <StatusBadge state={state} />
                          {stale && state !== 'STALE' ? <StatusBadge state="STALE" /> : null}
                        </div>
                      </div>
                      <div className="table-meta" role="cell" data-label="최근 검사">
                        <strong>{formatRelativeTime(monitor.lastCheckedAt)}</strong>
                        <span>
                          {monitor.lastErrorType
                            ? errorTypeLabel(monitor.lastErrorType)
                            : `매 ${formatInterval(monitor.intervalSec)}`}
                        </span>
                      </div>
                      <div className="table-meta" role="cell" data-label="응답">
                        <strong>
                          {monitor.lastTtfbMs != null ? formatDuration(monitor.lastTtfbMs) : '—'}
                        </strong>
                        <span>
                          {monitor.lastStatusCode
                            ? `HTTP ${monitor.lastStatusCode}`
                            : '상태 코드 없음'}
                        </span>
                      </div>
                      <div className="table-meta" role="cell" data-label="다음 검사">
                        <strong>
                          {monitor.lifecycleStatus === 'PAUSED'
                            ? '중지됨'
                            : formatRelativeTime(monitor.nextCheckAt)}
                        </strong>
                        <span>
                          {monitor.lifecycleStatus === 'PAUSED'
                            ? '자동 검사 안 함'
                            : `매 ${formatInterval(monitor.intervalSec)}`}
                        </span>
                      </div>
                      <div className="row-actions" role="cell">
                        <button
                          type="button"
                          className="icon-button"
                          title="즉시 검사"
                          aria-label={`${monitor.name} 즉시 검사`}
                          onClick={() => void checkNow(monitor)}
                          disabled={busy}
                        >
                          {busy ? (
                            <span className="spinner spinner-small" />
                          ) : (
                            <Icon name="refresh" size={17} />
                          )}
                        </button>
                        <button
                          type="button"
                          className="icon-button"
                          title={monitor.lifecycleStatus === 'ACTIVE' ? '일시 중지' : '재개'}
                          aria-label={`${monitor.name} ${monitor.lifecycleStatus === 'ACTIVE' ? '일시 중지' : '재개'}`}
                          onClick={() => void toggleLifecycle(monitor)}
                          disabled={busy}
                        >
                          <Icon
                            name={monitor.lifecycleStatus === 'ACTIVE' ? 'pause' : 'play'}
                            size={17}
                          />
                        </button>
                        <Link
                          className="icon-button"
                          href={`/monitors/${monitor.id}`}
                          title="상세 보기"
                          aria-label={`${monitor.name} 상세 보기`}
                        >
                          <Icon name="chevronRight" size={18} />
                        </Link>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {nextCursor ? (
              <div className="load-more-wrap">
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => void loadMore()}
                  disabled={loadingMore}
                >
                  {loadingMore ? (
                    <span className="spinner spinner-button" />
                  ) : (
                    <Icon name="more" size={16} />
                  )}{' '}
                  {filter === 'ALL' && !query ? '더 보기' : '다음 목록에서도 찾기'}
                </button>
              </div>
            ) : null}
          </section>
        </>
      )}
    </div>
  );
}

function SummaryCard({
  label,
  value,
  tone,
  icon,
  detail,
}: {
  label: string;
  value: number;
  tone: 'neutral' | 'success' | 'warning' | 'danger' | 'muted';
  icon: 'globe' | 'check' | 'clock' | 'alert' | 'pause';
  detail: string;
}) {
  return (
    <article className={`summary-card summary-${tone}`}>
      <div className="summary-top">
        <span className="summary-icon">
          <Icon name={icon} size={19} />
        </span>
        <span className="summary-label">{label}</span>
      </div>
      <strong className="summary-value">{value.toLocaleString('ko-KR')}</strong>
      <span className="summary-detail">{detail}</span>
    </article>
  );
}

function SummarySkeleton() {
  return (
    <div className="summary-card summary-skeleton" aria-hidden="true">
      <span className="skeleton-line" />
      <span className="skeleton-line skeleton-number" />
      <span className="skeleton-line" />
    </div>
  );
}
