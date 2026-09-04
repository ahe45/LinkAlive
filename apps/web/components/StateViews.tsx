import { Icon, type IconName } from '@/components/Icon';

export function PageLoader({ label = '정보를 불러오는 중입니다' }: { label?: string }) {
  return (
    <div className="page-loader" role="status">
      <span className="spinner" />
      <span>{label}</span>
    </div>
  );
}

export function SectionSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="skeleton-card" aria-hidden="true">
      <div className="skeleton-line skeleton-title" />
      {Array.from({ length: rows }, (_, index) => (
        <div className="skeleton-row" key={index}>
          <div className="skeleton-dot" />
          <div className="skeleton-line" />
        </div>
      ))}
    </div>
  );
}

interface ErrorPanelProps {
  message: string;
  onRetry?: () => void;
  compact?: boolean;
}

export function ErrorPanel({ message, onRetry, compact = false }: ErrorPanelProps) {
  return (
    <div className={`state-panel state-error${compact ? ' state-compact' : ''}`} role="alert">
      <span className="state-icon">
        <Icon name="alert" size={22} />
      </span>
      <div>
        <strong>정보를 불러오지 못했습니다</strong>
        <p>{message}</p>
      </div>
      {onRetry ? (
        <button type="button" className="button button-secondary button-small" onClick={onRetry}>
          <Icon name="refresh" size={15} /> 다시 시도
        </button>
      ) : null}
    </div>
  );
}

interface EmptyStateProps {
  icon?: IconName;
  title: string;
  description: string;
  action?: React.ReactNode;
}

export function EmptyState({ icon = 'inbox', title, description, action }: EmptyStateProps) {
  return (
    <div className="empty-state">
      <span className="empty-icon">
        <Icon name={icon} size={30} />
      </span>
      <h3>{title}</h3>
      <p>{description}</p>
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  );
}

export function InlineNotice({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'success' | 'warning' | 'error';
  children: React.ReactNode;
}) {
  return (
    <div className={`inline-notice notice-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <Icon name={tone === 'success' ? 'check' : tone === 'info' ? 'bell' : 'alert'} size={17} />
      <div>{children}</div>
    </div>
  );
}
