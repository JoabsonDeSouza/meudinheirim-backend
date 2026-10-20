import { z } from 'zod';

export const apiErrorSchema = z.object({
  success: z.literal(false),
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    requestId: z.string().min(1),
    fieldErrors: z.record(z.array(z.string())).optional(),
  }).strict(),
}).strict();

export type ApiErrorDto = z.infer<typeof apiErrorSchema>;
