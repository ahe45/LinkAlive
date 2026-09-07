import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AccountsModule } from './accounts/accounts.module.js';
import { AuthGuard } from './auth/auth.guard.js';
import { AuthModule } from './auth/auth.module.js';
import { DashboardModule } from './dashboard/dashboard.module.js';
import { HealthModule } from './health/health.module.js';
import { IncidentsModule } from './incidents/incidents.module.js';
import { MonitorsModule } from './monitors/monitors.module.js';
import { NotificationChannelsModule } from './notifications/notification-channels.module.js';
import { InfrastructureLifecycleService } from './common/infrastructure-lifecycle.service.js';

@Module({
  imports: [
    AccountsModule,
    AuthModule,
    MonitorsModule,
    IncidentsModule,
    NotificationChannelsModule,
    DashboardModule,
    HealthModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: AuthGuard }, InfrastructureLifecycleService],
})
export class AppModule {}
