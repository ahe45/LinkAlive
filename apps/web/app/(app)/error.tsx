'use client';

import { ErrorPanel } from '@/components/StateViews';

export default function ErrorBoundary({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="page-container page-narrow">
      <ErrorPanel message="화면을 표시하는 중 문제가 발생했습니다." onRetry={reset} />
    </div>
  );
}
