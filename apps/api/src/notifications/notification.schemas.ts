import { z } from 'zod';

const displayName = z.string().trim().min(1, '채널 이름을 입력해 주세요.').max(160);
const botToken = z.string().trim().min(1, 'Bot token을 입력해 주세요.').max(256);
const chatId = z.string().trim().min(1, 'Chat ID를 입력해 주세요.').max(64);

export const notificationChannelInputSchema = z
  .object({
    type: z.literal('TELEGRAM'),
    displayName,
    botToken: z.string().trim().max(256).default(''),
    chatId,
  })
  .strict();

export const notificationChannelPatchSchema = z
  .object({
    displayName: displayName.optional(),
    enabled: z.boolean().optional(),
    botToken: botToken.optional(),
    chatId: chatId.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, '변경할 값을 하나 이상 입력해 주세요.');

export type NotificationChannelInput = z.infer<typeof notificationChannelInputSchema>;
export type NotificationChannelPatch = z.infer<typeof notificationChannelPatchSchema>;
