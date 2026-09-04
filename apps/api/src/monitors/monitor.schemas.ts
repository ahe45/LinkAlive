import { z } from 'zod';
import { MAX_MONITOR_INTERVAL_SECONDS, MIN_MONITOR_INTERVAL_SECONDS } from '@linkalive/domain';

const monitorFields = {
  name: z.string().trim().min(1, '이름을 입력해 주세요.').max(160),
  url: z.string().trim().min(1, 'URL을 입력해 주세요.').max(2_048),
  method: z.enum(['GET', 'HEAD']),
  intervalSec: z.number().int().min(MIN_MONITOR_INTERVAL_SECONDS).max(MAX_MONITOR_INTERVAL_SECONDS),
  timeoutMs: z.number().int().min(1_000).max(30_000),
  expectedStatusMin: z.number().int().min(100).max(599),
  expectedStatusMax: z.number().int().min(100).max(599),
  expectedKeyword: z.string().trim().max(512),
  followRedirects: z.boolean(),
  maxRedirects: z.number().int().min(0).max(5),
  failureThreshold: z.number().int().min(1).max(10),
  recoveryThreshold: z.number().int().min(1).max(10),
  channelIds: z.array(z.string().uuid()).max(20),
} as const;

function validateMonitorCombination(
  value: {
    method?: 'GET' | 'HEAD';
    expectedStatusMin?: number;
    expectedStatusMax?: number;
    expectedKeyword?: string;
  },
  context: z.RefinementCtx,
): void {
  if (
    value.expectedStatusMin !== undefined &&
    value.expectedStatusMax !== undefined &&
    value.expectedStatusMin > value.expectedStatusMax
  ) {
    context.addIssue({
      code: 'custom',
      path: ['expectedStatusMax'],
      message: '최대 상태 코드는 최소 상태 코드보다 작을 수 없습니다.',
    });
  }
  if (value.method === 'HEAD' && value.expectedKeyword) {
    context.addIssue({
      code: 'custom',
      path: ['expectedKeyword'],
      message: 'HEAD 검사에는 응답 키워드를 사용할 수 없습니다.',
    });
  }
}

// Zod 4 rejects partial() on an object after a refinement has been attached.
// Input and patch schemas therefore derive independently from the same fields.
export const monitorInputSchema = z
  .object({
    ...monitorFields,
    method: monitorFields.method.default('GET'),
    intervalSec: monitorFields.intervalSec.default(60),
    timeoutMs: monitorFields.timeoutMs.default(10_000),
    expectedStatusMin: monitorFields.expectedStatusMin.default(200),
    expectedStatusMax: monitorFields.expectedStatusMax.default(299),
    expectedKeyword: monitorFields.expectedKeyword.optional().default(''),
    followRedirects: monitorFields.followRedirects.default(true),
    maxRedirects: monitorFields.maxRedirects.default(5),
    failureThreshold: monitorFields.failureThreshold.default(3),
    recoveryThreshold: monitorFields.recoveryThreshold.default(2),
    channelIds: monitorFields.channelIds.default([]),
  })
  .strict()
  .superRefine(validateMonitorCombination);

export const monitorPatchSchema = z
  .object(monitorFields)
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, '변경할 값을 하나 이상 입력해 주세요.');

export type MonitorInput = z.infer<typeof monitorInputSchema>;
export type MonitorPatch = z.infer<typeof monitorPatchSchema>;
