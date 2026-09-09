import { beforeEach, describe, expect, it, vi } from 'vitest';
import { checkReferenceUrls, type MonitorCheckResult } from '@linkalive/monitoring';
import { prisma } from '@linkalive/database';
import { encryptJson } from '../src/common/crypto.js';
import { NetworkService, networkChannelView } from '../src/network/network.service.js';
import { networkSettingsSchema } from '../src/network/network.schemas.js';

vi.mock('@linkalive/monitoring', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@linkalive/monitoring')>()),
  checkReferenceUrls: vi.fn(),
}));
vi.mock('../src/common/config.js', () => ({
  getConfig: () => ({ encryptionKey: Buffer.alloc(32, 7) }),
}));

describe('network reference testing and channel selection', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns persisted settings that can be submitted again through the strict save schema', async () => {
    vi.spyOn(prisma.networkSettings, 'findUnique').mockResolvedValue({
      id: 1,
      enabled: false,
      urls: ['https://example.com/', 'https://example.org/'],
      channelIds: [],
      version: 3,
      updatedAt: new Date(),
    });
    vi.spyOn(prisma.networkObserver, 'findMany').mockResolvedValue([]);
    vi.spyOn(prisma.networkOutage, 'findMany').mockResolvedValue([]);
    vi.spyOn(prisma.notificationChannel, 'findMany').mockResolvedValue([]);
    const view = await new NetworkService().get();
    const submitted = JSON.parse(JSON.stringify({ ...view.settings, enabled: true }));
    expect(networkSettingsSchema.parse(submitted)).toEqual({
      enabled: true,
      urls: ['https://example.com/', 'https://example.org/'],
      channelIds: [],
      version: 3,
    });
  });

  it('exposes the Telegram chat ID without returning the bot token or encrypted configuration', () => {
    const channel = {
      id: 'channel-1',
      displayName: '서비스 모니터링',
      encryptedConfig: new TextEncoder().encode(
        encryptJson(
          { type: 'TELEGRAM', chatId: '-10012345', botToken: 'test-secret-token' },
          Buffer.alloc(32, 7),
        ),
      ),
    };
    expect(networkChannelView(channel)).toEqual({
      id: 'channel-1',
      displayName: '서비스 모니터링',
      chatId: '-10012345',
    });
    expect(
      networkChannelView({ ...channel, encryptedConfig: new Uint8Array([0]) }).chatId,
    ).toBeNull();
  });

  it('reports HTTP 500 as reachable and a timeout as unreachable without persisting state or sending alerts', async () => {
    vi.mocked(checkReferenceUrls).mockResolvedValue([
      { statusCode: 500, totalMs: 32, errorType: null, errorMessageSafe: null },
      {
        statusCode: null,
        totalMs: 5000,
        errorType: 'CONNECT_TIMEOUT',
        errorMessageSafe: '연결 시간 초과',
      },
    ] as MonitorCheckResult[]);
    const transaction = vi.spyOn(prisma, '$transaction');
    const createOutage = vi.spyOn(prisma.networkOutage, 'create');
    const createNotification = vi.spyOn(prisma.notificationOutbox, 'create');
    const report = await new NetworkService().test({
      urls: ['https://example.com/', 'https://example.org/'],
    });
    expect(report.results).toEqual([
      {
        url: 'https://example.com/',
        reachable: true,
        statusCode: 500,
        totalMs: 32,
        errorType: null,
        errorMessage: null,
      },
      {
        url: 'https://example.org/',
        reachable: false,
        statusCode: null,
        totalMs: 5000,
        errorType: 'CONNECT_TIMEOUT',
        errorMessage: '연결 시간 초과',
      },
    ]);
    expect(report.checkedFrom).toBeTruthy();
    expect(transaction).not.toHaveBeenCalled();
    expect(createOutage).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('rejects simultaneous test batches and permits another test when the first finishes', async () => {
    let finish!: (results: MonitorCheckResult[]) => void;
    vi.mocked(checkReferenceUrls).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const service = new NetworkService();
    const first = service.test({ urls: ['https://example.com/'] });
    await expect(service.test({ urls: ['https://example.org/'] })).rejects.toMatchObject({
      status: 429,
    });
    finish([]);
    await first;
    vi.mocked(checkReferenceUrls).mockResolvedValue([]);
    await expect(service.test({ urls: ['https://example.org/'] })).resolves.toMatchObject({
      results: [],
    });
  });
});
