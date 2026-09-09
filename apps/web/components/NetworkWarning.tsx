import { formatDateTime, HEALTH_LABELS } from '@/lib/format';
import type { Monitor } from '@/lib/types';

export function NetworkWarning({ monitor }: { monitor: Monitor }) {
  if (!monitor.networkUnknownSince || monitor.lifecycleStatus !== 'ACTIVE') return null;
  return (
    <p className="network-monitor-warning" role="status">
      감시 PC 연결 이상으로 확인 불가 · 마지막 확인 상태: {HEALTH_LABELS[monitor.healthState]}
      <span>확인 불가 시작: {formatDateTime(monitor.networkUnknownSince)}</span>
    </p>
  );
}
