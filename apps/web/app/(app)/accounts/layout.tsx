import { requireAdminUser } from '@/lib/server-auth';

export default async function AccountsLayout({ children }: { children: React.ReactNode }) {
  await requireAdminUser();
  return children;
}
