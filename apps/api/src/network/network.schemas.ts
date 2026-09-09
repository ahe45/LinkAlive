import { z } from 'zod';
import { isPublicAddress, parseMonitorUrl } from '@linkalive/monitoring';
import { isIP } from 'node:net';

export const referenceUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .transform((value, ctx) => {
    try {
      const original = new URL(value);
      if (original.hash) throw new Error();
      const url = parseMonitorUrl(value);
      if (url.username || url.password || url.search || url.hash) throw new Error();
      const host = url.hostname
        .replace(/^\[|\]$/g, '')
        .replace(/\.$/, '')
        .toLowerCase();
      if (
        (isIP(host) && !isPublicAddress(host)) ||
        (!isIP(host) &&
          (!host.includes('.') || host.endsWith('.localhost') || host.endsWith('.local')))
      )
        throw new Error();
      url.hostname = isIP(host) === 6 ? `[${host}]` : host;
      return url.toString();
    } catch {
      ctx.addIssue({
        code: 'custom',
        message:
          '공인 HTTP/HTTPS 주소를 입력하세요. 인증정보, 쿼리, fragment는 사용할 수 없습니다.',
      });
      return z.NEVER;
    }
  });

export const networkSettingsSchema = z
  .object({
    enabled: z.boolean(),
    urls: z.array(referenceUrlSchema).max(5),
    channelIds: z.array(z.string().uuid()).max(20),
    version: z.number().int().min(0),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.enabled && value.urls.length < 2) {
      ctx.addIssue({
        code: 'custom',
        path: ['urls'],
        message: '활성화하려면 서로 다른 호스트의 기준 주소를 2개 이상 등록하세요.',
      });
    }
    if (new Set(value.urls.map((url) => new URL(url).hostname)).size !== value.urls.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['urls'],
        message: '기준 주소는 서로 다른 호스트여야 합니다.',
      });
    }
    if (new Set(value.channelIds).size !== value.channelIds.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['channelIds'],
        message: '알림 채널이 중복되었습니다.',
      });
    }
  });

export type NetworkSettingsInput = z.infer<typeof networkSettingsSchema>;

export const networkTestSchema = z
  .object({
    urls: z.array(referenceUrlSchema).min(1, '테스트할 기준 주소를 입력하세요.').max(5),
  })
  .strict();
export type NetworkTestInput = z.infer<typeof networkTestSchema>;
