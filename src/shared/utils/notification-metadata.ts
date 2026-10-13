export interface NotificationMetadata {
  readonly budgetId?: string;
  readonly percentage?: number;
  readonly [key: string]: unknown;
}

/**
 * Runtime guard for the flexible Prisma `Json` metadata column.
 * Returns `null` when the value cannot be treated as an object model.
 */
export function asNotificationMetadata(value: unknown): NotificationMetadata | null {
  if (value === null || typeof value !== 'object') {
    return null;
  }
  const candidate = value as { readonly [key: string]: unknown };
  const { budgetId, percentage } = candidate;
  return {
    ...candidate,
    ...(typeof budgetId === 'string' ? { budgetId } : {}),
    ...(typeof percentage === 'number' ? { percentage } : {}),
  };
}
