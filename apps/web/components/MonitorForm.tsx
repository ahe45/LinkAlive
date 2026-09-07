'use client';

import { FormEvent, useState } from 'react';
import { Icon } from '@/components/Icon';
import { InlineNotice } from '@/components/StateViews';
import { OutcomeBadge } from '@/components/StatusBadge';
import { getErrorMessage } from '@/lib/api';
import { errorTypeLabel, formatDuration } from '@/lib/format';
import type { CheckResult, MonitorInput, NotificationChannel } from '@/lib/types';

const MIN_INTERVAL_SECONDS = 5;
const MAX_INTERVAL_SECONDS = 86_400;
const ADVANCED_ERROR_FIELDS = [
  'timeoutMs',
  'expectedStatus',
  'expectedKeyword',
  'maxRedirects',
] as const;

const DEFAULT_VALUE: MonitorInput = {
  name: '',
  url: '',
  method: 'GET',
  intervalSec: 60,
  timeoutMs: 10_000,
  expectedStatusMin: 200,
  expectedStatusMax: 299,
  expectedKeyword: '',
  followRedirects: true,
  maxRedirects: 5,
  failureThreshold: 3,
  recoveryThreshold: 2,
  channelIds: [],
};

interface MonitorFormProps {
  mode: 'create' | 'edit';
  initialValue?: Partial<MonitorInput>;
  currentDisplayUrl?: string;
  channels?: NotificationChannel[];
  showNotificationChannels?: boolean;
  onSubmit: (value: MonitorInput) => Promise<void>;
  onTest?: (value: MonitorInput) => Promise<CheckResult>;
  submitLabel?: string;
  submitting?: boolean;
}

type FieldErrors = Record<string, string>;

export function MonitorForm({
  mode,
  initialValue,
  currentDisplayUrl,
  channels = [],
  showNotificationChannels = true,
  onSubmit,
  onTest,
  submitLabel = mode === 'create' ? '모니터 만들기' : '변경사항 저장',
  submitting = false,
}: MonitorFormProps) {
  const [value, setValue] = useState<MonitorInput>(() => ({
    ...DEFAULT_VALUE,
    ...initialValue,
    url: mode === 'edit' ? '' : (initialValue?.url ?? ''),
    channelIds: initialValue?.channelIds ?? [],
  }));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<CheckResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  function patchValue(patch: Partial<MonitorInput>) {
    setValue((current) => ({ ...current, ...patch }));
  }

  function validate(requireUrl: boolean): boolean {
    const nextErrors: FieldErrors = {};
    if (!value.name.trim()) nextErrors.name = '모니터 이름을 입력해 주세요.';
    if (value.name.trim().length > 160) nextErrors.name = '이름은 160자 이내로 입력해 주세요.';

    if (requireUrl && !value.url.trim()) {
      nextErrors.url = '검사할 URL을 입력해 주세요.';
    } else if (value.url.trim()) {
      if (value.url.trim().length > 2048) {
        nextErrors.url = 'URL은 2,048자 이내로 입력해 주세요.';
      }
      try {
        const parsed = new URL(value.url.trim());
        if (!['http:', 'https:'].includes(parsed.protocol)) {
          nextErrors.url = 'http:// 또는 https:// URL만 사용할 수 있습니다.';
        }
      } catch {
        nextErrors.url = '올바른 URL 형식으로 입력해 주세요.';
      }
    }

    if (!Number.isInteger(value.timeoutMs) || value.timeoutMs < 1000 || value.timeoutMs > 30_000) {
      nextErrors.timeoutMs = '제한 시간은 1~30초 사이여야 합니다.';
    }
    if (
      !Number.isInteger(value.expectedStatusMin) ||
      value.expectedStatusMin < 100 ||
      value.expectedStatusMin > 599
    ) {
      nextErrors.expectedStatus = '상태 코드는 100~599 사이여야 합니다.';
    }
    if (
      !Number.isInteger(value.expectedStatusMax) ||
      value.expectedStatusMax < value.expectedStatusMin ||
      value.expectedStatusMax > 599
    ) {
      nextErrors.expectedStatus = '최댓값은 최솟값보다 크거나 같아야 합니다.';
    }
    if (
      !Number.isInteger(value.intervalSec) ||
      value.intervalSec < MIN_INTERVAL_SECONDS ||
      value.intervalSec > MAX_INTERVAL_SECONDS
    ) {
      nextErrors.intervalSec = '검사 주기는 5~86,400초 사이의 정수로 입력해 주세요.';
    }
    if (value.method === 'HEAD' && value.expectedKeyword?.trim()) {
      nextErrors.expectedKeyword = 'HEAD 방식에서는 응답 키워드를 검사할 수 없습니다.';
    }
    if ((value.expectedKeyword?.trim().length ?? 0) > 512) {
      nextErrors.expectedKeyword = '응답 키워드는 512자 이내로 입력해 주세요.';
    }
    if (!Number.isInteger(value.maxRedirects) || value.maxRedirects < 0 || value.maxRedirects > 5) {
      nextErrors.maxRedirects = '리다이렉트 횟수는 0~5 사이여야 합니다.';
    }
    if (
      !Number.isInteger(value.failureThreshold) ||
      value.failureThreshold < 1 ||
      value.failureThreshold > 10
    ) {
      nextErrors.failureThreshold = '1~10회 사이로 설정해 주세요.';
    }
    if (
      !Number.isInteger(value.recoveryThreshold) ||
      value.recoveryThreshold < 1 ||
      value.recoveryThreshold > 10
    ) {
      nextErrors.recoveryThreshold = '1~10회 사이로 설정해 주세요.';
    }
    if (value.channelIds.length > 20) {
      nextErrors.channelIds = '알림 채널은 최대 20개까지 선택할 수 있습니다.';
    }
    setErrors(nextErrors);
    if (ADVANCED_ERROR_FIELDS.some((field) => nextErrors[field])) setAdvancedOpen(true);
    return Object.keys(nextErrors).length === 0;
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!validate(mode === 'create')) return;
    const keyword = value.expectedKeyword?.trim() ?? '';
    await onSubmit({
      ...value,
      name: value.name.trim(),
      url: value.url.trim(),
      expectedKeyword: mode === 'edit' ? keyword : keyword || undefined,
    });
  }

  async function runTest() {
    if (!onTest || !validate(true)) return;
    setTesting(true);
    setTestResult(null);
    setTestError(null);
    try {
      const result = await onTest({
        ...value,
        name: value.name.trim(),
        url: value.url.trim(),
        expectedKeyword: value.expectedKeyword?.trim() || undefined,
      });
      setTestResult(result);
    } catch (error) {
      setTestError(getErrorMessage(error));
    } finally {
      setTesting(false);
    }
  }

  return (
    <form className="monitor-form" onSubmit={submit} noValidate>
      {showNotificationChannels ? (
        <section className="form-section">
          <div className="form-section-heading">
            <span className="section-number">01</span>
            <div>
              <h2>기본 정보</h2>
              <p>구분하기 쉬운 이름과 검사할 주소를 입력하세요.</p>
            </div>
          </div>
          <div className="form-grid">
            <label className="field field-span-2">
              <span className="field-label">
                모니터 이름 <em>필수</em>
              </span>
              <input
                type="text"
                value={value.name}
                onChange={(event) => patchValue({ name: event.target.value })}
                placeholder="예: 공식 웹사이트"
                maxLength={160}
                aria-invalid={Boolean(errors.name)}
              />
              {errors.name ? <span className="field-error">{errors.name}</span> : null}
            </label>

            <label className="field field-span-2">
              <span className="field-label">
                검사 URL {mode === 'create' ? <em>필수</em> : null}
              </span>
              {mode === 'edit' && currentDisplayUrl ? (
                <span className="current-value">
                  <Icon name="globe" size={15} /> 현재 주소: <strong>{currentDisplayUrl}</strong>
                </span>
              ) : null}
              <span className="input-with-prefix">
                <span>
                  <Icon name="globe" size={17} />
                </span>
                <input
                  type="url"
                  value={value.url}
                  onChange={(event) => patchValue({ url: event.target.value })}
                  placeholder={
                    mode === 'edit'
                      ? '주소를 변경할 때만 새 URL 입력'
                      : 'https://example.com/health'
                  }
                  inputMode="url"
                  aria-invalid={Boolean(errors.url)}
                />
              </span>
              {errors.url ? <span className="field-error">{errors.url}</span> : null}
              <span className="field-help">
                http:// 또는 https:// 주소를 입력하세요. localhost, 사설 IP, 사용자 지정 포트도
                사용할 수 있습니다.
              </span>
            </label>

            <label className="field">
              <span className="field-label">검사 주기 (초)</span>
              <span className="input-with-unit input-with-unit-compact">
                <input
                  type="number"
                  min={MIN_INTERVAL_SECONDS}
                  max={MAX_INTERVAL_SECONDS}
                  step={1}
                  value={value.intervalSec}
                  onChange={(event) => patchValue({ intervalSec: Number(event.target.value) })}
                  aria-invalid={Boolean(errors.intervalSec)}
                />
                <span>초</span>
              </span>
              {errors.intervalSec ? (
                <span className="field-error">{errors.intervalSec}</span>
              ) : null}
              <span className="field-help">5초부터 86,400초(24시간)까지 입력할 수 있습니다.</span>
            </label>
          </div>
        </section>
      ) : null}

      <section className="form-section">
        <div className="form-section-heading">
          <span className="section-number">02</span>
          <div>
            <h2>장애 민감도</h2>
            <p>짧은 네트워크 흔들림이 실제 장애로 오인되지 않도록 조절합니다.</p>
          </div>
        </div>
        <div className="form-grid">
          <label className="field">
            <span className="field-label">장애 확정</span>
            <span className="input-with-unit">
              <input
                type="number"
                min={1}
                max={10}
                value={value.failureThreshold}
                onChange={(event) => patchValue({ failureThreshold: Number(event.target.value) })}
                aria-invalid={Boolean(errors.failureThreshold)}
              />
              <span>회 연속 실패</span>
            </span>
            {errors.failureThreshold ? (
              <span className="field-error">{errors.failureThreshold}</span>
            ) : null}
          </label>
          <label className="field">
            <span className="field-label">복구 확정</span>
            <span className="input-with-unit">
              <input
                type="number"
                min={1}
                max={10}
                value={value.recoveryThreshold}
                onChange={(event) => patchValue({ recoveryThreshold: Number(event.target.value) })}
                aria-invalid={Boolean(errors.recoveryThreshold)}
              />
              <span>회 연속 성공</span>
            </span>
            {errors.recoveryThreshold ? (
              <span className="field-error">{errors.recoveryThreshold}</span>
            ) : null}
          </label>
        </div>
        <InlineNotice>
          권장 기본값은 3회 실패 후 장애 확정, 2회 성공 후 복구 확정입니다.
        </InlineNotice>
      </section>

      <section className="form-section">
        <div className="form-section-heading">
          <span className="section-number">03</span>
          <div>
            <h2>알림 채널</h2>
            <p>장애와 복구 메시지를 받을 채널을 선택하세요.</p>
          </div>
        </div>
        {channels.length ? (
          <div className="channel-select-grid">
            {channels.map((channel) => {
              const checked = value.channelIds.includes(channel.id);
              return (
                <label
                  className={`channel-choice${checked ? ' channel-choice-selected' : ''}`}
                  key={channel.id}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(event) => {
                      const channelIds = event.target.checked
                        ? [...value.channelIds, channel.id]
                        : value.channelIds.filter((id) => id !== channel.id);
                      patchValue({ channelIds });
                    }}
                  />
                  <span className={`channel-icon channel-${channel.type.toLowerCase()}`}>
                    <Icon name="telegram" size={19} />
                  </span>
                  <span>
                    <strong>{channel.displayName}</strong>
                    <small>{channel.chatId ?? 'Chat ID를 불러올 수 없음'}</small>
                  </span>
                  <span className="choice-check">
                    <Icon name="check" size={14} />
                  </span>
                </label>
              );
            })}
          </div>
        ) : (
          <div className="channel-empty-note">
            <Icon name="bell" size={20} />
            <div>
              <strong>등록된 알림 채널이 없습니다</strong>
              <p>모니터를 먼저 만든 뒤 알림 채널 화면에서 연결할 수 있습니다.</p>
            </div>
          </div>
        )}
        {errors.channelIds ? <span className="field-error">{errors.channelIds}</span> : null}
      </section>

      <details
        className="advanced-settings"
        open={advancedOpen}
        onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
      >
        <summary>
          <span className="advanced-settings-icon">
            <Icon name="settings" size={19} />
          </span>
          <span className="advanced-settings-copy">
            <strong>상세 설정</strong>
            <small>일반 사용자는 기본값 그대로 저장해도 됩니다.</small>
          </span>
          <span className="advanced-settings-current">
            {value.method} · HTTP {value.expectedStatusMin}–{value.expectedStatusMax} ·{' '}
            {value.timeoutMs / 1000}초
          </span>
          <span className="advanced-settings-chevron">
            <Icon name="chevronRight" size={17} />
          </span>
        </summary>

        <div className="advanced-settings-body">
          <div className="advanced-settings-heading">
            <h3>요청 및 정상 판정</h3>
            <p>요청 방식이나 정상 응답 조건을 세밀하게 조정할 때만 변경하세요.</p>
          </div>
          <div className="form-grid">
            <label className="field">
              <span className="field-label">요청 방식</span>
              <select
                value={value.method}
                onChange={(event) => {
                  const method = event.target.value as MonitorInput['method'];
                  patchValue({ method, ...(method === 'HEAD' ? { expectedKeyword: '' } : {}) });
                }}
              >
                <option value="GET">GET · 일반 요청</option>
                <option value="HEAD">HEAD · 헤더만 확인</option>
              </select>
            </label>

            <label className="field">
              <span className="field-label">전체 제한 시간</span>
              <span className="input-with-unit">
                <input
                  type="number"
                  min={1}
                  max={30}
                  value={value.timeoutMs / 1000}
                  onChange={(event) => patchValue({ timeoutMs: Number(event.target.value) * 1000 })}
                  aria-invalid={Boolean(errors.timeoutMs)}
                />
                <span>초</span>
              </span>
              {errors.timeoutMs ? <span className="field-error">{errors.timeoutMs}</span> : null}
            </label>

            <div className="field">
              <span className="field-label">기대 HTTP 상태</span>
              <div className="range-inputs">
                <input
                  type="number"
                  min={100}
                  max={599}
                  value={value.expectedStatusMin}
                  onChange={(event) =>
                    patchValue({ expectedStatusMin: Number(event.target.value) })
                  }
                  aria-label="최소 HTTP 상태 코드"
                  aria-invalid={Boolean(errors.expectedStatus)}
                />
                <span>부터</span>
                <input
                  type="number"
                  min={100}
                  max={599}
                  value={value.expectedStatusMax}
                  onChange={(event) =>
                    patchValue({ expectedStatusMax: Number(event.target.value) })
                  }
                  aria-label="최대 HTTP 상태 코드"
                  aria-invalid={Boolean(errors.expectedStatus)}
                />
              </div>
              {errors.expectedStatus ? (
                <span className="field-error">{errors.expectedStatus}</span>
              ) : null}
            </div>

            <label className="field field-span-2">
              <span className="field-label">
                응답에 포함할 키워드 <small>선택</small>
              </span>
              <input
                type="text"
                value={value.expectedKeyword ?? ''}
                onChange={(event) => patchValue({ expectedKeyword: event.target.value })}
                placeholder={
                  value.method === 'HEAD'
                    ? 'HEAD 방식에서는 사용할 수 없습니다'
                    : '예: service healthy'
                }
                disabled={value.method === 'HEAD'}
                maxLength={512}
                aria-invalid={Boolean(errors.expectedKeyword)}
              />
              {errors.expectedKeyword ? (
                <span className="field-error">{errors.expectedKeyword}</span>
              ) : null}
              <span className="field-help">
                응답 본문의 처음 64KB 안에서 대소문자를 구분해 찾습니다.
              </span>
            </label>

            <div className="field field-span-2 toggle-row">
              <div>
                <span className="field-label">리다이렉트 따라가기</span>
                <span className="field-help">최종 도착 주소의 응답을 기준으로 판정합니다.</span>
              </div>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={value.followRedirects}
                  onChange={(event) => patchValue({ followRedirects: event.target.checked })}
                />
                <span className="switch-track">
                  <span />
                </span>
                <span className="sr-only">리다이렉트 따라가기</span>
              </label>
            </div>

            {value.followRedirects ? (
              <label className="field">
                <span className="field-label">최대 리다이렉트</span>
                <span className="input-with-unit">
                  <input
                    type="number"
                    min={0}
                    max={5}
                    value={value.maxRedirects}
                    onChange={(event) => patchValue({ maxRedirects: Number(event.target.value) })}
                    aria-invalid={Boolean(errors.maxRedirects)}
                  />
                  <span>회</span>
                </span>
                {errors.maxRedirects ? (
                  <span className="field-error">{errors.maxRedirects}</span>
                ) : null}
              </label>
            ) : null}
          </div>
        </div>
      </details>

      {onTest ? (
        <section className="test-section">
          <div>
            <h3>저장 전에 연결을 확인해 보세요</h3>
            <p>시험 결과는 모니터 상태와 장애 이력에 반영되지 않습니다.</p>
          </div>
          <button
            type="button"
            className="button button-secondary"
            onClick={() => void runTest()}
            disabled={testing || (mode === 'edit' && !value.url)}
            title={
              mode === 'edit' && !value.url ? '새 URL을 입력해야 시험할 수 있습니다' : undefined
            }
          >
            {testing ? (
              <>
                <span className="spinner spinner-button" /> 시험 중
              </>
            ) : (
              <>
                <Icon name="play" size={16} /> 시험 검사
              </>
            )}
          </button>
        </section>
      ) : null}

      {testError ? <InlineNotice tone="error">{testError}</InlineNotice> : null}
      {testResult ? (
        <div
          className={`test-result test-result-${testResult.outcome === 'SUCCESS' ? 'success' : 'failure'}`}
        >
          <span className="test-result-icon">
            <Icon name={testResult.outcome === 'SUCCESS' ? 'check' : 'alert'} size={22} />
          </span>
          <div className="test-result-main">
            <span className="test-result-title">
              시험 검사 결과 <OutcomeBadge outcome={testResult.outcome} />
            </span>
            <strong>
              {testResult.outcome === 'SUCCESS'
                ? '정상적으로 접속했습니다.'
                : errorTypeLabel(testResult.errorType)}
            </strong>
            {testResult.errorMessageSafe ? <p>{testResult.errorMessageSafe}</p> : null}
          </div>
          <dl className="test-result-metrics">
            <div>
              <dt>상태 코드</dt>
              <dd>{testResult.statusCode ?? '—'}</dd>
            </div>
            <div>
              <dt>응답 시간</dt>
              <dd>{formatDuration(testResult.ttfbMs)}</dd>
            </div>
          </dl>
        </div>
      ) : null}

      <div className="form-actions">
        <p>
          <Icon name="shield" size={15} /> URL의 query 값과 비밀 정보는 화면과 로그에 노출하지
          않습니다.
        </p>
        <button
          type="submit"
          className="button button-primary button-submit"
          disabled={submitting || testing}
        >
          {submitting ? (
            <>
              <span className="spinner spinner-button" /> 저장 중
            </>
          ) : (
            <>
              <Icon name="check" size={17} /> {submitLabel}
            </>
          )}
        </button>
      </div>
    </form>
  );
}
