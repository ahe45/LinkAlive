import { BadRequestException } from '@nestjs/common';
import type { ZodType } from 'zod';

export function parseInput<T>(schema: ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;

  throw new BadRequestException({
    message: '입력값을 확인해 주세요.',
    errors: parsed.error.issues.map((issue) => ({
      field: issue.path.join('.'),
      message: issue.message,
    })),
  });
}

export function parseLimit(value: unknown, fallback = 50, maximum = 100): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new BadRequestException(`limit은 1~${maximum} 사이의 정수여야 합니다.`);
  }
  return parsed;
}
