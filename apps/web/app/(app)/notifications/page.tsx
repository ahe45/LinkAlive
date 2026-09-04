'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Icon } from '@/components/Icon';
import { EmptyState, ErrorPanel, InlineNotice, SectionSkeleton } from '@/components/StateViews';
import { useToast } from '@/components/ToastProvider';
import { getErrorMessage, isUnauthorized, notificationChannelsApi } from '@/lib/api';
import { formatDateTime, formatRelativeTime } from '@/lib/format';
import type {
  NotificationChannel,
  NotificationChannelInput,
  NotificationChannelPatch,
} from '@/lib/types';

export default function NotificationChannelsPage() {
  const router = useRouter();
  const { showToast } = useToast();
  const [channels, setChannels] = useState<NotificationChannel[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editingChannel, setEditingChannel] = useState<NotificationChannel | null>(null);
  const [pendingChannel, setPendingChannel] = useState<string | null>(null);

  const load = useCallback(
    async (quiet = false) => {
      quiet ? setRefreshing(true) : setLoading(true);
      setError(null);
      try {
        const response = await notificationChannelsApi.list();
        setChannels(response.items);
        setNextCursor(response.nextCursor);
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
    [router],
  );

  useEffect(() => {
    void load();
  }, [load]);

  async function testChannel(channel: NotificationChannel) {
    setPendingChannel(channel.id);
    try {
      await notificationChannelsApi.test(channel.id);
      showToast(`${channel.displayName} 채널로 시험 알림을 보냈습니다.`, 'success');
      void load(true);
    } catch (testError) {
      showToast(getErrorMessage(testError), 'error');
    } finally {
      setPendingChannel(null);
    }
  }

  async function removeChannel(channel: NotificationChannel) {
    if (
      !window.confirm(
        `“${channel.displayName}” 알림 채널을 삭제할까요? 연결된 모니터에서도 제거됩니다.`,
      )
    )
      return;
    setPendingChannel(channel.id);
    try {
      await notificationChannelsApi.remove(channel.id);
      setChannels((current) => current.filter((item) => item.id !== channel.id));
      showToast('알림 채널을 삭제했습니다.', 'success');
    } catch (removeError) {
      showToast(getErrorMessage(removeError), 'error');
    } finally {
      setPendingChannel(null);
    }
  }

  async function loadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const response = await notificationChannelsApi.list(nextCursor);
      setChannels((current) => [...current, ...response.items]);
      setNextCursor(response.nextCursor);
    } catch (loadError) {
      showToast(getErrorMessage(loadError), 'error');
    } finally {
      setLoadingMore(false);
    }
  }

  function beginAdd() {
    setEditingChannel(null);
    setFormOpen(true);
  }

  function beginEdit(channel: NotificationChannel) {
    setFormOpen(false);
    setEditingChannel(channel);
  }

  return (
    <div className="page-container notifications-page">
      <header className="page-header">
        <div>
          <span className="page-eyebrow">Notifications</span>
          <h1>알림 채널</h1>
          <p>장애와 복구 소식을 받을 Telegram 채팅을 관리합니다.</p>
        </div>
        <div className="page-header-actions">
          <button
            type="button"
            className="button button-secondary"
            onClick={() => void load(true)}
            disabled={refreshing}
          >
            {refreshing ? (
              <span className="spinner spinner-button" />
            ) : (
              <Icon name="refresh" size={16} />
            )}{' '}
            새로고침
          </button>
          <button type="button" className="button button-primary" onClick={beginAdd}>
            <Icon name="plus" size={17} /> 채널 추가
          </button>
        </div>
      </header>

      <section className="notification-guide-grid">
        <button
          type="button"
          className="notification-guide notification-guide-telegram"
          onClick={beginAdd}
        >
          <span className="guide-icon">
            <Icon name="telegram" size={23} />
          </span>
          <span>
            <strong>Telegram 채팅</strong>
            <small>봇이 개인 또는 그룹 채팅으로 즉시 알림</small>
          </span>
          <Icon name="plus" size={18} />
        </button>
      </section>

      {formOpen ? (
        <ChannelForm
          onClose={() => setFormOpen(false)}
          onCreated={(channel) => {
            setChannels((current) => [channel, ...current]);
            setFormOpen(false);
            showToast('알림 채널을 추가했습니다. 시험 알림으로 연결을 확인해 주세요.', 'success');
          }}
        />
      ) : null}

      {editingChannel ? (
        <ChannelEditForm
          channel={editingChannel}
          onClose={() => setEditingChannel(null)}
          onUpdated={(updated) => {
            setChannels((current) =>
              current.map((channel) => (channel.id === updated.id ? updated : channel)),
            );
            setEditingChannel(null);
            showToast('알림 채널을 수정했습니다. 목적지를 바꿨다면 시험 발송해 주세요.', 'success');
          }}
        />
      ) : null}

      {error && !loading ? (
        <ErrorPanel message={error} onRetry={() => void load()} />
      ) : (
        <section className="content-card channel-list-card">
          <div className="card-header">
            <div>
              <h2>등록된 채널</h2>
              <p>
                {loading
                  ? '채널을 불러오는 중입니다'
                  : `${channels.length}개 채널을 사용하고 있습니다.`}
              </p>
            </div>
          </div>
          {loading ? (
            <div className="card-body">
              <SectionSkeleton rows={4} />
            </div>
          ) : channels.length === 0 ? (
            <EmptyState
              icon="bell"
              title="아직 알림 채널이 없습니다"
              description="Telegram을 연결하면 장애와 복구 순간을 바로 받아볼 수 있습니다."
              action={
                <button type="button" className="button button-primary" onClick={beginAdd}>
                  <Icon name="plus" size={16} /> 첫 채널 추가
                </button>
              }
            />
          ) : (
            <div className="channel-cards">
              {channels.map((channel) => {
                const busy = pendingChannel === channel.id;
                return (
                  <article className="channel-card" key={channel.id}>
                    <span className="channel-card-icon channel-telegram">
                      <Icon name="telegram" size={22} />
                    </span>
                    <div className="channel-card-main">
                      <div className="channel-card-title">
                        <h3>{channel.displayName}</h3>
                        <span
                          className={`verification-badge ${channel.verifiedAt ? 'verified' : 'unverified'}`}
                        >
                          <Icon name={channel.verifiedAt ? 'check' : 'clock'} size={12} />
                          {channel.verifiedAt ? '연결 확인됨' : '시험 필요'}
                        </span>
                      </div>
                      <dl className="channel-config-list">
                        <>
                          <div>
                            <dt>Bot token</dt>
                            <dd>{channel.botToken ?? '불러올 수 없음'}</dd>
                          </div>
                          <div>
                            <dt>Chat ID</dt>
                            <dd>{channel.chatId ?? '불러올 수 없음'}</dd>
                          </div>
                        </>
                      </dl>
                      <div className="channel-card-meta">
                        <span>Telegram</span>
                        <span>·</span>
                        <span>
                          {channel.lastTestedAt
                            ? `마지막 시험 ${formatRelativeTime(channel.lastTestedAt)}`
                            : `추가 ${formatRelativeTime(channel.createdAt)}`}
                        </span>
                      </div>
                    </div>
                    <div className="channel-card-actions">
                      <button
                        type="button"
                        className="icon-button"
                        onClick={() => beginEdit(channel)}
                        disabled={busy}
                        aria-label={`${channel.displayName} 수정`}
                        title="수정"
                      >
                        <Icon name="edit" size={17} />
                      </button>
                      <button
                        type="button"
                        className="button button-secondary button-small"
                        onClick={() => void testChannel(channel)}
                        disabled={busy}
                      >
                        {busy ? (
                          <span className="spinner spinner-button" />
                        ) : (
                          <Icon name="send" size={15} />
                        )}{' '}
                        시험 발송
                      </button>
                      <button
                        type="button"
                        className="icon-button icon-button-danger"
                        onClick={() => void removeChannel(channel)}
                        disabled={busy}
                        aria-label={`${channel.displayName} 삭제`}
                        title="삭제"
                      >
                        <Icon name="trash" size={17} />
                      </button>
                    </div>
                  </article>
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
                더 보기
              </button>
            </div>
          ) : null}
        </section>
      )}

      <InlineNotice>
        Telegram 연결 정보는 DB에 암호화해 저장하며, 로그인된 관리자 화면에서는 원문을 표시합니다.
      </InlineNotice>
    </div>
  );
}

function ChannelEditForm({
  channel,
  onClose,
  onUpdated,
}: {
  channel: NotificationChannel;
  onClose: () => void;
  onUpdated: (channel: NotificationChannel) => void;
}) {
  const [displayName, setDisplayName] = useState(channel.displayName);
  const [enabled, setEnabled] = useState(channel.enabled);
  const [botToken, setBotToken] = useState(channel.botToken ?? '');
  const [chatId, setChatId] = useState(channel.chatId ?? '');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (!displayName.trim()) {
      setError('채널 이름을 입력해 주세요.');
      return;
    }
    if (!botToken.trim()) {
      setError('Telegram bot token을 입력해 주세요.');
      return;
    }
    if (!chatId.trim()) {
      setError('Telegram chat ID를 입력해 주세요.');
      return;
    }

    const patch: NotificationChannelPatch = {
      displayName: displayName.trim(),
      enabled,
      botToken: botToken.trim(),
      chatId: chatId.trim(),
    };

    setSubmitting(true);
    try {
      onUpdated(await notificationChannelsApi.update(channel.id, patch));
    } catch (updateError) {
      setError(getErrorMessage(updateError));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="content-card channel-form-card">
      <div className="card-header">
        <div>
          <h2>알림 채널 수정</h2>
          <p>저장된 연결 정보를 확인하고 필요한 값을 직접 수정할 수 있습니다.</p>
        </div>
        <button type="button" className="icon-button" aria-label="채널 수정 닫기" onClick={onClose}>
          <Icon name="close" size={18} />
        </button>
      </div>
      <form className="channel-form" onSubmit={submit} noValidate>
        {error ? (
          <div className="form-error" role="alert">
            <Icon name="alert" size={16} /> {error}
          </div>
        ) : null}
        <div className="channel-form-grid">
          <label className="field">
            <span className="field-label">
              채널 이름 <em>필수</em>
            </span>
            <input
              type="text"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              maxLength={160}
            />
          </label>
          <label className="field">
            <span className="field-label">활성 상태</span>
            <select
              value={enabled ? 'enabled' : 'disabled'}
              onChange={(event) => setEnabled(event.target.value === 'enabled')}
            >
              <option value="enabled">활성</option>
              <option value="disabled">비활성</option>
            </select>
          </label>
          <>
            <label className="field">
              <span className="field-label">
                Bot token <em>필수</em>
              </span>
              <span className="input-with-icon">
                <Icon name="key" size={17} />
                <input
                  type="text"
                  value={botToken}
                  onChange={(event) => setBotToken(event.target.value)}
                  autoComplete="off"
                />
              </span>
            </label>
            <label className="field">
              <span className="field-label">
                Chat ID <em>필수</em>
              </span>
              <span className="input-with-icon">
                <Icon name="telegram" size={17} />
                <input
                  type="text"
                  value={chatId}
                  onChange={(event) => setChatId(event.target.value)}
                  autoComplete="off"
                />
              </span>
            </label>
          </>
        </div>
        <InlineNotice tone="warning">
          수신 정보를 변경하면 연결 확인 상태가 초기화됩니다. 저장 후 시험 발송으로 확인해 주세요.
        </InlineNotice>
        <div className="channel-form-actions">
          <button type="button" className="button button-ghost" onClick={onClose}>
            취소
          </button>
          <button type="submit" className="button button-primary" disabled={submitting}>
            {submitting ? (
              <>
                <span className="spinner spinner-button" /> 저장 중
              </>
            ) : (
              <>
                <Icon name="check" size={16} /> 변경 저장
              </>
            )}
          </button>
        </div>
      </form>
    </section>
  );
}

function ChannelForm({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (channel: NotificationChannel) => void;
}) {
  const [displayName, setDisplayName] = useState('');
  const [botToken, setBotToken] = useState('');
  const [chatId, setChatId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (!displayName.trim()) {
      setError('채널 이름을 입력해 주세요.');
      return;
    }
    if (!chatId.trim()) {
      setError('Telegram chat ID를 입력해 주세요.');
      return;
    }

    const input: NotificationChannelInput = {
      type: 'TELEGRAM',
      displayName: displayName.trim(),
      botToken: botToken.trim(),
      chatId: chatId.trim(),
    };
    setSubmitting(true);
    try {
      const channel = await notificationChannelsApi.create(input);
      onCreated(channel);
    } catch (createError) {
      setError(getErrorMessage(createError));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="content-card channel-form-card">
      <div className="card-header">
        <div>
          <h2>새 알림 채널</h2>
          <p>연결 후 시험 알림을 보내 목적지가 올바른지 확인하세요.</p>
        </div>
        <button type="button" className="icon-button" aria-label="채널 추가 닫기" onClick={onClose}>
          <Icon name="close" size={18} />
        </button>
      </div>
      <form className="channel-form" onSubmit={submit} noValidate>
        {error ? (
          <div className="form-error" role="alert">
            <Icon name="alert" size={16} /> {error}
          </div>
        ) : null}
        <div className="channel-form-grid">
          <label className="field">
            <span className="field-label">
              채널 이름 <em>필수</em>
            </span>
            <input
              type="text"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="예: 장애 대응방"
              maxLength={100}
            />
          </label>
          <>
            <label className="field">
              <span className="field-label">
                Bot token <small>선택</small>
              </span>
              <span className="input-with-icon">
                <Icon name="key" size={17} />
                <input
                  type="password"
                  value={botToken}
                  onChange={(event) => setBotToken(event.target.value)}
                  placeholder="123456:ABC…"
                  autoComplete="off"
                />
              </span>
              <span className="field-help">비워두면 서버에 설정된 공용 봇을 사용합니다.</span>
            </label>
            <label className="field">
              <span className="field-label">
                Chat ID <em>필수</em>
              </span>
              <span className="input-with-icon">
                <Icon name="telegram" size={17} />
                <input
                  type="text"
                  value={chatId}
                  onChange={(event) => setChatId(event.target.value)}
                  placeholder="예: -1001234567890"
                  autoComplete="off"
                />
              </span>
            </label>
          </>
        </div>
        <InlineNotice tone="warning">
          봇을 대상 채팅에 먼저 초대하고 메시지를 보낼 수 있는 권한을 부여해 주세요.
        </InlineNotice>
        <div className="channel-form-actions">
          <button type="button" className="button button-ghost" onClick={onClose}>
            취소
          </button>
          <button type="submit" className="button button-primary" disabled={submitting}>
            {submitting ? (
              <>
                <span className="spinner spinner-button" /> 추가 중
              </>
            ) : (
              <>
                <Icon name="plus" size={16} /> 채널 추가
              </>
            )}
          </button>
        </div>
      </form>
    </section>
  );
}
