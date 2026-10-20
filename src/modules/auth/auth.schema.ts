import { z } from 'zod';

const timeZoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine(value => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, 'Expected a valid IANA timezone');

export const authSyncSchema = z
  .object({
    locale: z.enum(['pt-BR', 'en-US']),
    baseCurrency: z.enum(['BRL', 'USD']),
    timeZone: timeZoneSchema,
    referralCode: z.string().max(20).optional(),
  })
  .strict();

export type AuthSyncInput = z.infer<typeof authSyncSchema>;
