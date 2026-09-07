import { SetMetadata } from '@nestjs/common';

export const ADMIN_ONLY = 'linkalive:admin-only';
export const AdminOnly = () => SetMetadata(ADMIN_ONLY, true);
