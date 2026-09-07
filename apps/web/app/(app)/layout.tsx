import { AppShell } from '@/components/AppShell';
import { requireAuthenticatedSession } from '@/lib/server-auth';

export default async function ProtectedLayout({ children }: { children: React.ReactNode }) {
  const session = await requireAuthenticatedSession();
  return (
    <AppShell initialUser={session.user} sessionPolicy={session.sessionPolicy}>
      {children}
    </AppShell>
  );
}
