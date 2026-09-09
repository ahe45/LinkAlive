import { requireAdminUser } from '@/lib/server-auth';

export default async function NetworkLayout({ children }: { children: React.ReactNode }) {
  await requireAdminUser();
  return children;
}
