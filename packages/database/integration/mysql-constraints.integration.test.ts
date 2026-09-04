import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  IncidentClosureReason,
  IncidentStatus,
  ScheduledCheckStatus,
  prisma,
} from '../src/index.js';

const integrationEnabled = process.env.LINKALIVE_INTEGRATION_TESTS === 'true';

describe.runIf(integrationEnabled)('MySQL/MariaDB schema invariants', () => {
  const monitorId = randomUUID();
  const scheduledIds = [randomUUID(), randomUUID()];
  const incidentIds = [randomUUID(), randomUUID()];
  const now = new Date();

  beforeAll(async () => {
    await prisma.monitor.create({
      data: {
        id: monitorId,
        name: 'Integration constraint monitor',
        requestUrlEncrypted: Buffer.from('integration-secret'),
        displayUrl: 'https://constraints.example.test/',
        hostnameNormalized: 'constraints.example.test',
        nextCheckAt: now,
      },
    });
  });

  afterAll(async () => {
    await prisma.incident.deleteMany({ where: { monitorId } });
    await prisma.scheduledCheck.deleteMany({ where: { monitorId } });
    await prisma.monitor.deleteMany({ where: { id: monitorId } });
    await prisma.$disconnect();
  });

  it('allows only one active scheduled check per monitor', async () => {
    await prisma.scheduledCheck.create({
      data: {
        id: scheduledIds[0],
        monitorId,
        scheduledAt: now,
        configVersion: 1,
      },
    });

    await expect(
      prisma.scheduledCheck.create({
        data: {
          id: scheduledIds[1],
          monitorId,
          scheduledAt: new Date(now.getTime() + 1_000),
          configVersion: 1,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });

    await prisma.scheduledCheck.update({
      where: { id: scheduledIds[0] },
      data: { status: ScheduledCheckStatus.COMPLETED, completedAt: now },
    });

    await expect(
      prisma.scheduledCheck.create({
        data: {
          id: scheduledIds[1],
          monitorId,
          scheduledAt: new Date(now.getTime() + 1_000),
          configVersion: 1,
        },
      }),
    ).resolves.toMatchObject({ id: scheduledIds[1] });
  });

  it('allows only one open incident per monitor', async () => {
    await prisma.incident.create({
      data: {
        id: incidentIds[0],
        monitorId,
        configVersion: 1,
        firstFailureAt: now,
        detectedAt: now,
      },
    });

    await expect(
      prisma.incident.create({
        data: {
          id: incidentIds[1],
          monitorId,
          configVersion: 1,
          firstFailureAt: now,
          detectedAt: now,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });

    await prisma.incident.update({
      where: { id: incidentIds[0] },
      data: {
        status: IncidentStatus.RESOLVED,
        closureReason: IncidentClosureReason.RECOVERED,
        resolvedAt: now,
      },
    });

    await expect(
      prisma.incident.create({
        data: {
          id: incidentIds[1],
          monitorId,
          configVersion: 1,
          firstFailureAt: now,
          detectedAt: now,
        },
      }),
    ).resolves.toMatchObject({ id: incidentIds[1] });
  });
});
