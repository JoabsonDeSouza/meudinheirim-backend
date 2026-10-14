import type { Prisma } from '../../generated/prisma/client.js';
import { TransactionType } from '../../generated/prisma/enums.js';
import { NotFoundError, BadRequestError, VersionConflictError } from '../../shared/errors/index.js';
import { getCategoriesByType, CategoryType, AccountType } from '../../shared/enums/index.js';
import type { CategoryName } from '../../shared/enums/index.js';
import { minorUnitsToDecimal, decimalToMinorUnits, moneyDtoSchema, type Currency } from '../../shared/money/index.js';
import { createPaginatedResponse, buildPaginationArgs } from '../../shared/utils/pagination.js';
import { isCustomCategoryName, toCustomCategoryId, toCustomCategoryName } from '../../shared/utils/categoryHelpers.js';
import { prisma } from '../../shared/db/prisma.js';
import { appendSyncChange, findMutationReplay, payloadHash, saveMutationReceipt } from '../../shared/sync/idempotency.js';
import { transactionV1DtoSchema, type CreateTransactionV1Input, type ListTransactionsV1Query, type TransactionV1Dto, type UpdateTransactionV1Input } from './transactions.v1.schema.js';

export interface TransactionV1Page {
  readonly items: readonly TransactionV1Dto[];
  readonly pagination: {
    readonly nextCursor: string | null;
    readonly hasMore: boolean;
    readonly total: number;
  };
}

function kindToPrismaType(kind: 'expense' | 'income'): TransactionType {
  return kind === 'income' ? TransactionType.INCOME : TransactionType.EXPENSE;
}

function prismaTypeToKind(type: TransactionType): 'expense' | 'income' {
  if (type === TransactionType.INCOME) return 'income';
  if (type === TransactionType.EXPENSE) return 'expense';
  throw new BadRequestError('Only income and expense transactions are supported by this endpoint');
}

function validateCurrency(value: string): Currency {
  if (value !== 'BRL' && value !== 'USD') {
    throw new BadRequestError('Account currency is not supported');
  }
  return value;
}

function civilDate(isoInstant: string): Date {
  return new Date(`${isoInstant.slice(0, 10)}T00:00:00.000Z`);
}

function balanceChange(
  amount: Prisma.Decimal,
  kind: 'expense' | 'income',
  accountType: string,
): Prisma.Decimal {
  if (accountType === AccountType.CREDIT) {
    return kind === 'expense' ? amount : amount.negated();
  }
  return kind === 'income' ? amount : amount.negated();
}

async function requireAccount(
  tx: Prisma.TransactionClient,
  accountId: string,
  householdId: string,
  currency: Currency,
): Promise<{ id: string; type: string }> {
  const account = await tx.account.findFirst({
    where: { id: accountId, householdId, isActive: true },
    select: { id: true, type: true, currency: true },
  });
  if (!account) {
    throw new NotFoundError('Account');
  }
  if (validateCurrency(account.currency) !== currency) {
    throw new BadRequestError('Transaction currency must match account currency');
  }
  return account;
}

async function validateCategory(
  tx: Prisma.TransactionClient,
  categoryCode: string,
  householdId: string,
  type: TransactionType,
): Promise<string> {
  const categoryType = type === TransactionType.INCOME ? CategoryType.INCOME : CategoryType.EXPENSE;
  if (isCustomCategoryName(categoryCode)) {
    const id = toCustomCategoryId(categoryCode);
    if (id === null) throw new BadRequestError('Custom category code is invalid');
    const category = await tx.category.findFirst({ where: { id, householdId } });
    if (!category || category.type !== categoryType) throw new NotFoundError('Category');
    return toCustomCategoryName(category.id);
  }
  const codes = getCategoriesByType(categoryType);
  if (!codes.includes(categoryCode as CategoryName)) {
    throw new BadRequestError('Category code does not match transaction kind');
  }
  return categoryCode;
}

async function applyBalanceChange(
  tx: Prisma.TransactionClient,
  accountId: string,
  change: Prisma.Decimal,
): Promise<void> {
  await tx.account.update({
    where: { id: accountId },
    data: {
      balance: { increment: change },
      totalBalance: { increment: change },
      availableBalance: { increment: change },
      version: { increment: 1 },
    },
  });
}

function toDto(row: {
  id: string;
  type: TransactionType;
  amount: Prisma.Decimal;
  currency: string;
  categoryName: string | null;
  accountId: string | null;
  occurredAt: Date;
  timeZone: string;
  notes: string | null;
  paid: boolean;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  version: number;
  clientMutationId: string;
}): TransactionV1Dto {
  if (!row.categoryName || !row.accountId) throw new BadRequestError('Transaction is missing account or category identity');
  const currency = validateCurrency(row.currency);
  return {
    id: row.id,
    kind: prismaTypeToKind(row.type),
    amount: moneyDtoSchema.parse({ minorUnits: decimalToMinorUnits(row.amount, currency), currency }),
    categoryCode: row.categoryName,
    accountId: row.accountId,
    occurredAt: row.occurredAt.toISOString(),
    timeZone: row.timeZone,
    note: row.notes,
    paid: row.paid,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt?.toISOString() ?? null,
    version: row.version,
    clientMutationId: row.clientMutationId,
  };
}

export async function createTransactionV1(
  input: CreateTransactionV1Input,
  householdId: string,
  userId: string,
): Promise<TransactionV1Dto> {
  const type = kindToPrismaType(input.kind);
  const money = moneyDtoSchema.parse(input.amount);
  const amount = minorUnitsToDecimal(money);
  const occurredAt = new Date(input.occurredAt);

  const identity = {
    userId,
    clientMutationId: input.clientMutationId,
    hash: payloadHash({ operation: 'transaction.create', householdId, input }),
  };
  return prisma.$transaction(async (tx) => {
    const replay = await findMutationReplay(tx, identity, transactionV1DtoSchema);
    if (replay !== null) return replay;
    const account = await requireAccount(tx, input.accountId, householdId, money.currency);
    const categoryCode = await validateCategory(tx, input.categoryCode, householdId, type);
    const transaction = await tx.transaction.create({
      data: {
        householdId,
        type,
        accountId: account.id,
        categoryName: categoryCode,
        amount,
        date: civilDate(input.occurredAt),
        occurredAt,
        timeZone: input.timeZone,
        notes: input.note,
        paid: input.paid,
        clientMutationId: input.clientMutationId,
      },
    });
    if (input.paid) {
      await applyBalanceChange(tx, account.id, balanceChange(amount, input.kind, account.type));
    }
    const dto = toDto({ ...transaction, currency: money.currency });
    await saveMutationReceipt(tx, identity, 'transaction', transaction.id, dto);
    await appendSyncChange(tx, {
      householdId,
      entityType: 'transaction',
      entityId: transaction.id,
      version: transaction.version,
      payload: dto,
    });
    return dto;
  });
}

export async function listTransactionsV1(query: ListTransactionsV1Query, householdId: string): Promise<TransactionV1Page> {
  const where: Prisma.TransactionWhereInput = {
    householdId,
    deletedAt: null,
    ...(query.accountId ? { accountId: query.accountId } : {}),
    ...(query.kind ? { type: kindToPrismaType(query.kind) } : {}),
    ...(query.categoryCode ? { categoryName: query.categoryCode } : {}),
    ...((query.occurredAfter || query.occurredBefore) ? {
      occurredAt: {
        ...(query.occurredAfter ? { gte: new Date(query.occurredAfter) } : {}),
        ...(query.occurredBefore ? { lte: new Date(query.occurredBefore) } : {}),
      },
    } : {}),
  };
  const pageArgs = buildPaginationArgs(query);
  const [rows, total] = await Promise.all([
    prisma.transaction.findMany({
      where,
      ...pageArgs,
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      include: { account: { select: { currency: true } } },
    }),
    prisma.transaction.count({ where }),
  ]);
  const page = createPaginatedResponse(rows, query.limit, total);
  const items = page.data.map((row) => {
    if (!row.account) throw new BadRequestError('Transaction account is unavailable');
    return toDto({ ...row, currency: row.account.currency });
  });
  return {
    items,
    pagination: {
      ...page.pagination,
      total,
    },
  };
}

export async function updateTransactionV1(
  transactionId: string,
  householdId: string,
  userId: string,
  input: UpdateTransactionV1Input,
): Promise<TransactionV1Dto> {
  const identity = {
    userId,
    clientMutationId: input.clientMutationId,
    hash: payloadHash({ operation: 'transaction.update', transactionId, householdId, input }),
  };
  return prisma.$transaction(async (tx) => {
    const replay = await findMutationReplay(tx, identity, transactionV1DtoSchema);
    if (replay !== null) return replay;
    const existing = await tx.transaction.findFirst({
      where: { id: transactionId, householdId, deletedAt: null },
      include: { account: { select: { id: true, type: true, currency: true } } },
    });
    if (!existing || !existing.account) throw new NotFoundError('Transaction');
    if (existing.version !== input.expectedVersion) throw new VersionConflictError();
    const currency = validateCurrency(existing.account.currency);
    const kind = prismaTypeToKind(existing.type);
    const nextAmount = input.amount ? minorUnitsToDecimal(input.amount) : existing.amount;
    if (input.amount && input.amount.currency !== currency) throw new BadRequestError('Transaction currency must match account currency');
    const nextCode = input.categoryCode
      ? await validateCategory(tx, input.categoryCode, householdId, existing.type)
      : existing.categoryName;
    if (!nextCode) throw new BadRequestError('Transaction category is missing');
    const nextPaid = input.paid ?? existing.paid;

    if (existing.paid) {
      await applyBalanceChange(tx, existing.account.id, balanceChange(existing.amount, kind, existing.account.type).negated());
    }
    if (nextPaid) {
      await applyBalanceChange(tx, existing.account.id, balanceChange(nextAmount, kind, existing.account.type));
    }

    const update = await tx.transaction.updateMany({
      where: { id: existing.id, householdId, version: input.expectedVersion, deletedAt: null },
      data: {
        amount: nextAmount,
        categoryName: nextCode,
        date: input.occurredAt ? civilDate(input.occurredAt) : undefined,
        occurredAt: input.occurredAt ? new Date(input.occurredAt) : undefined,
        timeZone: input.timeZone,
        notes: input.note,
        paid: nextPaid,
        version: { increment: 1 },
        clientMutationId: input.clientMutationId,
      },
    });
    if (update.count !== 1) throw new VersionConflictError();
    const updated = await tx.transaction.findUnique({
      where: { id: existing.id },
      include: { account: { select: { currency: true } } },
    });
    if (!updated?.account) throw new NotFoundError('Transaction');
    const dto = transactionV1DtoSchema.parse(toDto({ ...updated, currency: updated.account.currency }));
    await saveMutationReceipt(tx, identity, 'transaction', updated.id, dto);
    await appendSyncChange(tx, {
      householdId,
      entityType: 'transaction',
      entityId: updated.id,
      version: updated.version,
      payload: dto,
    });
    return dto;
  });
}

export async function softDeleteTransactionV1(
  transactionId: string,
  householdId: string,
  userId: string,
  clientMutationId: string,
  expectedVersion: number,
): Promise<TransactionV1Dto> {
  const identity = {
    userId,
    clientMutationId,
    hash: payloadHash({ operation: 'transaction.delete', transactionId, householdId, expectedVersion }),
  };
  return prisma.$transaction(async (tx) => {
    const replay = await findMutationReplay(tx, identity, transactionV1DtoSchema);
    if (replay !== null) return replay;
    const existing = await tx.transaction.findFirst({
      where: { id: transactionId, householdId, deletedAt: null },
      include: { account: { select: { id: true, type: true } } },
    });
    if (!existing || !existing.account) throw new NotFoundError('Transaction');
    if (existing.version !== expectedVersion) throw new VersionConflictError();
    if (existing.paid) {
      const kind = prismaTypeToKind(existing.type);
      await applyBalanceChange(tx, existing.account.id, balanceChange(existing.amount, kind, existing.account.type).negated());
    }
    const deletedAt = new Date();
    const update = await tx.transaction.updateMany({
      where: { id: existing.id, householdId, version: expectedVersion, deletedAt: null },
      data: { deletedAt, version: { increment: 1 }, clientMutationId },
    });
    if (update.count !== 1) throw new VersionConflictError();
    const deleted = await tx.transaction.findUnique({
      where: { id: existing.id },
      include: { account: { select: { currency: true } } },
    });
    if (!deleted?.account) throw new NotFoundError('Transaction');
    const dto = transactionV1DtoSchema.parse(toDto({ ...deleted, currency: deleted.account.currency }));
    await saveMutationReceipt(tx, identity, 'transaction', deleted.id, dto);
    await appendSyncChange(tx, {
      householdId,
      entityType: 'transaction',
      entityId: deleted.id,
      version: deleted.version,
      payload: dto,
      deletedAt,
    });
    return dto;
  });
}
