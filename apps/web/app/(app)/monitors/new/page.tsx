'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Icon } from '@/components/Icon';
import { useAuthUser } from '@/components/AppShell';
import { MonitorForm } from '@/components/MonitorForm';
import { InlineNotice } from '@/components/StateViews';
import { useToast } from '@/components/ToastProvider';
import { getErrorMessage, isUnauthorized, monitorsApi, notificationChannelsApi } from '@/lib/api';
import type { MonitorInput, NotificationChannel } from '@/lib/types';

export default function NewMonitorPage() {
  const router = useRouter();
  const currentUser = useAuthUser();
  const { showToast } = useToast();
  const [channels, setChannels] = useState<NotificationChannel[]>([]);
  const [channelError, setChannelError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (currentUser.role !== 'ADMIN') {
      setChannels([]);
      setChannelError(null);
      return;
    }
    notificationChannelsApi
      .list()
      .then((response) => setChannels(response.items.filter((channel) => channel.enabled)))
      .catch((error) => {
        if (isUnauthorized(error)) {
          router.replace('/login');
          return;
        }
        setChannelError(getErrorMessage(error));
      });
  }, [currentUser.role, router]);

  async function createMonitor(value: MonitorInput) {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const monitor = await monitorsApi.create(value);
      showToast('모니터를 등록했습니다.', 'success');
      router.push(`/monitors/${monitor.id}`);
    } catch (error) {
      if (isUnauthorized(error)) {
        router.replace('/login');
        return;
      }
      setSubmitError(getErrorMessage(error));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="page-container form-page-container">
      <nav className="breadcrumbs" aria-label="현재 위치">
        <Link href="/dashboard">대시보드</Link>
        <Icon name="chevronRight" size={14} />
        <span>새 모니터</span>
      </nav>
      <header className="page-header form-page-header">
        <div>
          <span className="page-eyebrow">New monitor</span>
          <h1>새 URL 모니터</h1>
          <p>접속 상태를 확인할 주소와 장애 판정 기준을 설정합니다.</p>
        </div>
        <Link className="button button-ghost" href="/dashboard">
          <Icon name="close" size={16} /> 취소
        </Link>
      </header>

      {channelError ? (
        <InlineNotice tone="warning">
          알림 채널을 불러오지 못했습니다. 모니터는 채널 없이 등록할 수 있습니다. {channelError}
        </InlineNotice>
      ) : null}
      {submitError ? <InlineNotice tone="error">{submitError}</InlineNotice> : null}

      <MonitorForm
        mode="create"
        channels={channels}
        showNotificationChannels={currentUser.role === 'ADMIN'}
        onSubmit={createMonitor}
        onTest={monitorsApi.test}
        submitting={submitting}
      />
    </div>
  );
}
