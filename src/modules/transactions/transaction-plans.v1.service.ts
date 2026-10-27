import { randomUUID } from 'node:crypto';
import type { Prisma } from '../../generated/prisma/client.js';
import { BadRequestError, NotFoundError } from '../../shared/errors/index.js';
import { AccountType, RecurrenceFrequency } from '../../shared/enums/index.js';
import { prisma } from '../../shared/db/prisma.js';
import { civilDateStringAtInstant } from '../credit-cards/domain/billing-cycle.js';
import { appendSyncChange, findMutationReplay, payloadHash, saveMutationReceipt } from '../../shared/sync/idempotency.js';
import { createRecurringManagedV1WithTx } from '../recurring-transactions/recurring.v1.service.js';
import { calculateMonthlyInstallmentDates, instantAtCivilDateLike, splitTotalIntoInstallments } from './transaction-plan.js';
import { createTransactionV1WithTx } from './transactions.v1.service.js';
import type { CreateTransactionV1Input } from './transactions.v1.schema.js';
import { transactionPlanV1ResponseSchema, type CreateTransactionPlanV1Input, type TransactionPlanV1Response } from './transaction-plans.v1.schema.js';

function civilDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function transactionInput(
  input: CreateTransactionPlanV1Input,
  amountMinorUnits: number,
  occurredAt: string,
): CreateTransactionV1Input {
  return {
    clientMutationId: input.clientMutationId,
    kind: input.kind,
    amount: { minorUnits: amountMinorUnits, currency: input.totalAmount.currency },
    categoryCode: input.categoryCode,
    accountId: input.accountId,
    occurredAt,
    timeZone: input.timeZone,
    note: input.note,
    paid: input.paid,
  };
}

async function requireActiveAccount(
  tx: Prisma.TransactionClient,
  input: CreateTransactionPlanV1Input,
  householdId: string,
): Promise<{ id: string; type: string; currency: string }> {
  await tx.$executeRaw`SELECT id FROM accounts WHERE id = ${input.accountId}::uuid AND household_id = ${householdId}::uuid FOR UPDATE`;
  const account = await tx.account.findFirst({
    where: { id: input.accountId, householdId, isActive: true },
    select: { id: true, type: true, currency: true },
  });
  if (!account) throw new NotFoundError('Active account');
  if (account.currency !== input.totalAmount.currency) throw new BadRequestError('Transaction currency must match account currency');
  return account;
}

export async function createTransactionPlanV1(
  input: CreateTransactionPlanV1Input,
  householdId: string,
  userId: string,
): Promise<TransactionPlanV1Response> {
  const identity = {
    userId,
    clientMutationId: input.clientMutationId,
    hash: payloadHash({ operation: 'transaction.plan.create', householdId, input }),
  };

  return prisma.$transaction(async (tx) => {
    const replay = await findMutationReplay(tx, identity, transactionPlanV1ResponseSchema);
    if (replay !== null) return replay;
    const account = await requireActiveAccount(tx, input, householdId);

    if (input.plan.type === 'INSTALLMENTS') {
      if (account.type !== AccountType.CREDIT) throw new BadRequestError('Installments require an active credit-card account');
      const firstOccurredAt = new Date(input.occurredAt);
      const firstDate = civilDateStringAtInstant(input.occurredAt, input.timeZone);
      const startDate = new Date(`${firstDate}T00:00:00.000Z`);
      const dates = calculateMonthlyInstallmentDates(startDate, input.plan.count);
      const amounts = splitTotalIntoInstallments(input.totalAmount.minorUnits, input.plan.count);
      const installmentId = randomUUID();
      const items = [];

      for (const [index, date] of dates.entries()) {
        const occurredAt = index === 0 ? input.occurredAt : instantAtCivilDateLike(date, firstOccurredAt, input.timeZone).toISOString();
        const transaction = await createTransactionV1WithTx(tx, transactionInput(input, amounts[index], occurredAt), householdId, undefined, {
          installmentId,
          installmentNumber: index + 1,
          totalInstallments: dates.length,
        });
        items.push({ ...transaction, installmentId, installmentNumber: index + 1, totalInstallments: dates.length });
      }

      const result = transactionPlanV1ResponseSchema.safeParse({
        type: 'INSTALLMENTS',
        installmentId,
        totalAmount: input.totalAmount,
        installmentCount: input.plan.count,
        items,
      });
      if (!result.success) throw new BadRequestError(JSON.stringify(result.error.issues));
      const response = result.data;
      await saveMutationReceipt(tx, identity, 'transaction_plan', installmentId, response);
      return response;
    }

    const firstDate = civilDateStringAtInstant(input.occurredAt, input.timeZone);
    const monthlyDates = calculateMonthlyInstallmentDates(new Date(`${firstDate}T00:00:00.000Z`), 2);
    const nextRunAt = civilDate(monthlyDates[1]);
    const recurringTransaction = await createRecurringManagedV1WithTx(tx, {
      accountId: input.accountId,
      categoryCode: input.categoryCode,
      amount: input.totalAmount,
      description: input.note,
      frequency: RecurrenceFrequency.MONTHLY,
      kind: 'FIXED',
      recurrenceMode: 'ALWAYS',
      startDate: firstDate,
      nextRunAt,
      timeZone: input.timeZone,
    }, householdId);
    const firstOccurrenceDate = new Date(`${firstDate}T00:00:00.000Z`);
    const firstOccurrence = await createTransactionV1WithTx(
      tx,
      transactionInput(input, input.totalAmount.minorUnits, input.occurredAt),
      householdId,
      { recurringTransactionId: recurringTransaction.id, occurrenceDate: firstOccurrenceDate, dateBasis: 'TIME_ZONE' },
    );
    await tx.recurringTransaction.update({ where: { id: recurringTransaction.id }, data: { lastRunDate: firstOccurrenceDate } });
    const recurringResponse = { ...recurringTransaction, lastRunDate: firstDate };
    const response = transactionPlanV1ResponseSchema.parse({
      type: 'RECURRING_MONTHLY',
      recurringTransaction: recurringResponse,
      firstOccurrence,
    });
    await appendSyncChange(tx, {
      householdId,
      entityType: 'recurring_transaction',
      entityId: recurringTransaction.id,
      version: 1,
      payload: recurringResponse,
    });
    await saveMutationReceipt(tx, identity, 'transaction_plan', recurringTransaction.id, response);
    return response;
  });
}
