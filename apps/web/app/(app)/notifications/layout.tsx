import { requireAdminUser } from '@/lib/server-auth';

export default async function NotificationsLayout({ children }: { children: React.ReactNode }) {
  await requireAdminUser();
  return children;
}
