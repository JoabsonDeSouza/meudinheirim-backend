import type { Prisma } from '../../generated/prisma/client.js';

/** A materialized occurrence may later be excluded; count its civil date once. */
export async function countProcessedRecurringSlots(
  db: Prisma.TransactionClient,
  recurringId: string,
  effectiveFromDate: Date,
  throughDate: Date,
): Promise<number> {
  const fromKey = effectiveFromDate.toISOString().slice(0, 10);
  const throughKey = throughDate.toISOString().slice(0, 10);
  const rows = await db.$queryRaw<Array<{ count: number }>>`
    SELECT COUNT(*)::integer AS count FROM (
      SELECT occurrence_date FROM recurring_occurrences
      WHERE recurring_transaction_id = ${recurringId}::uuid
        AND occurrence_date >= ${fromKey}::date
        AND occurrence_date <= ${throughKey}::date
      UNION
      SELECT occurrence_date FROM recurring_occurrence_exclusions
      WHERE recurring_transaction_id = ${recurringId}::uuid
        AND occurrence_date >= ${fromKey}::date
        AND occurrence_date <= ${throughKey}::date
    ) AS processed_dates
  `;
  return rows[0]?.count ?? 0;
}
