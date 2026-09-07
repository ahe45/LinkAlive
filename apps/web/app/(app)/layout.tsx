import { AppShell } from '@/components/AppShell';
import { requireAuthenticatedUser } from '@/lib/server-auth';

export default async function ProtectedLayout({ children }: { children: React.ReactNode }) {
  const user = await requireAuthenticatedUser();
  return <AppShell initialUser={user}>{children}</AppShell>;
}
