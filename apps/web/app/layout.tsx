import type { Metadata } from 'next';
import { ToastProvider } from '@/components/ToastProvider';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'LinkAlive',
    template: '%s · LinkAlive',
  },
  description: 'URL 가용성 모니터링과 장애 알림 관리',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body>
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
