import { TransactionType } from '../../generated/prisma/enums.js';
import { BadRequestError, NotFoundError, VersionConflictError } from '../../shared/errors/index.js';
import { minorUnitsToDecimal, type Currency } from '../../shared/money/index.js';
import { prisma } from '../../shared/db/prisma.js';
import { transferV1DtoSchema, type CreateTransferV1Input, type TransferV1Dto } from './transfers.v1.schema.js';
import { appendSyncChange, findMutationReplay, payloadHash, saveMutationReceipt } from '../../shared/sync/idempotency.js';

function currency(value: string): Currency {
  if (value !== 'BRL' && value !== 'USD') throw new BadRequestError('Account currency is not supported');
  return value;
}

export async function createTransferV1(
  input: CreateTransferV1Input,
  householdId: string,
  userId: string,
): Promise<TransferV1Dto> {
  if (input.fromAccountId === input.toAccountId) {
    throw new BadRequestError('Cannot transfer to the same account');
  }
  const amount = minorUnitsToDecimal(input.amount);
  const accountIds = [input.fromAccountId, input.toAccountId].sort();
  const identity = {
    userId,
    clientMutationId: input.clientMutationId,
    hash: payloadHash({ operation: 'transaction.transfer', householdId, input }),
  };

  return prisma.$transaction(async (tx) => {
    const replay = await findMutationReplay(tx, identity, transferV1DtoSchema);
    if (replay !== null) return replay;
    for (const accountId of accountIds) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`account-version:${accountId}`}))`;
    }

    const accounts = await tx.account.findMany({
      where: { id: { in: accountIds }, householdId, isActive: true },
      select: { id: true, type: true, currency: true, availableBalance: true, version: true },
    });
    const fromAccount = accounts.find((account) => account.id === input.fromAccountId);
    const toAccount = accounts.find((account) => account.id === input.toAccountId);
    if (!fromAccount || !toAccount) throw new NotFoundError('Account');

    const fromCurrency = currency(fromAccount.currency);
    const toCurrency = currency(toAccount.currency);
    if (fromCurrency !== toCurrency || input.amount.currency !== fromCurrency) {
      throw new BadRequestError('Transfers require matching account and transaction currencies');
    }
    if (fromAccount.version !== input.expectedFromVersion || toAccount.version !== input.expectedToVersion) {
      throw new VersionConflictError();
    }
    if (fromAccount.type !== 'CREDIT' && fromAccount.availableBalance.lessThan(amount)) {
      throw new BadRequestError('Insufficient available balance');
    }

    const debit = amount.negated();
    const updatedFrom = await tx.account.updateMany({
      where: { id: fromAccount.id, householdId, version: input.expectedFromVersion },
      data: {
        balance: { increment: debit },
        availableBalance: { increment: debit },
        totalBalance: { increment: debit },
        version: { increment: 1 },
      },
    });
    if (updatedFrom.count !== 1) throw new VersionConflictError();

    const updatedTo = await tx.account.updateMany({
      where: { id: toAccount.id, householdId, version: input.expectedToVersion },
      data: {
        balance: { increment: amount },
        availableBalance: { increment: amount },
        totalBalance: { increment: amount },
        version: { increment: 1 },
      },
    });
    if (updatedTo.count !== 1) throw new VersionConflictError();

    const occurredAt = new Date(input.occurredAt);
    const transaction = await tx.transaction.create({
      data: {
        householdId,
        type: TransactionType.TRANSFER,
        fromAccountId: fromAccount.id,
        toAccountId: toAccount.id,
        categoryName: 'TRANSFER',
        amount,
        date: new Date(`${input.occurredAt.slice(0, 10)}T00:00:00.000Z`),
        occurredAt,
        timeZone: input.timeZone,
        notes: input.note,
        paid: true,
        clientMutationId: input.clientMutationId,
      },
    });

    const result: TransferV1Dto = {
      transaction: {
        id: transaction.id,
        kind: 'transfer',
        amount: input.amount,
        fromAccountId: fromAccount.id,
        toAccountId: toAccount.id,
        occurredAt: occurredAt.toISOString(),
        timeZone: input.timeZone,
        note: input.note ?? null,
        version: transaction.version,
        clientMutationId: input.clientMutationId,
      },
      fromVersion: input.expectedFromVersion + 1,
      toVersion: input.expectedToVersion + 1,
    };
    await saveMutationReceipt(tx, identity, 'transaction', transaction.id, result);
    await appendSyncChange(tx, {
      householdId,
      entityType: 'transaction',
      entityId: transaction.id,
      version: transaction.version,
      payload: result,
    });
    return result;
  });
}
