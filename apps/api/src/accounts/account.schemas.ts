import { z } from 'zod';

const usernameSchema = z
  .string()
  .trim()
  .min(2, '아이디는 2자 이상이어야 합니다.')
  .max(160, '아이디는 160자 이하여야 합니다.')
  .regex(
    /^[\p{Script=Hangul}A-Za-z0-9][\p{Script=Hangul}A-Za-z0-9._@-]*$/u,
    '아이디는 한글, 영문 또는 숫자로 시작하고 한글, 영문, 숫자, ., _, @, -만 사용할 수 있습니다.',
  );

const passwordSchema = z
  .string()
  .min(4, '비밀번호는 4자 이상이어야 합니다.')
  .max(128, '비밀번호는 128자 이하여야 합니다.');

export const accountCreateSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  role: z.enum(['ADMIN', 'USER']).default('USER'),
  enabled: z.boolean().default(true),
});

export const accountPatchSchema = z
  .object({
    username: usernameSchema.optional(),
    password: passwordSchema.optional(),
    role: z.enum(['ADMIN', 'USER']).optional(),
    enabled: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, '변경할 값을 입력해 주세요.');

export const accountBulkCreateSchema = z.object({
  accounts: z
    .array(accountCreateSchema)
    .min(1, '등록할 계정이 없습니다.')
    .max(500, '한 번에 최대 500개 계정까지 등록할 수 있습니다.'),
});

export type AccountCreateInput = z.infer<typeof accountCreateSchema>;
export type AccountPatch = z.infer<typeof accountPatchSchema>;
export type AccountBulkCreateInput = z.infer<typeof accountBulkCreateSchema>;
