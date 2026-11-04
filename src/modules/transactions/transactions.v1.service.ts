import { createHash } from 'node:crypto';
import type { Prisma } from '../../generated/prisma/client.js';
import { TransactionType } from '../../generated/prisma/enums.js';
import { NotFoundError, BadRequestError, InstallmentGroupConflictError, OccurrenceAccountConflictError, RecurringOccurrenceExcludedError, VersionConflictError } from '../../shared/errors/index.js';
import { getCategoriesByType, CategoryType, AccountType } from '../../shared/enums/index.js';
import type { CategoryName } from '../../shared/enums/index.js';
import { minorUnitsToDecimal, decimalToMinorUnits, moneyDtoSchema, type Currency } from '../../shared/money/index.js';
import { createPaginatedResponse, buildPaginationArgs } from '../../shared/utils/pagination.js';
import { isCustomCategoryName, toCustomCategoryId, toCustomCategoryName } from '../../shared/utils/categoryHelpers.js';
import { prisma } from '../../shared/db/prisma.js';
import { adjustInvoiceTotal, getOrCreateInvoiceForTransaction, signedInvoiceAmount } from '../credit-cards/domain/invoice-cycle.js';
import { calculateBillingCycle, civilDateStringAtInstant } from '../credit-cards/domain/billing-cycle.js';
import { appendSyncChange, findMutationReplay, payloadHash, saveMutationReceipt } from '../../shared/sync/idempotency.js';
import { transactionV1DtoSchema, installmentGroupDeleteV1ResponseSchema, installmentGroupSummaryV1Schema, type CreateTransactionV1Input, type InstallmentGroupDeleteV1Response, type InstallmentGroupSummaryV1, type ListTransactionsV1Query, type TransactionV1Dto, type UpdateTransactionV1Input } from './transactions.v1.schema.js';

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
): Promise<{ id: string; type: string; currency: string; closingDay: number | null; dueDay: number | null }> {
  await tx.$executeRaw`SELECT id FROM accounts WHERE id = ${accountId}::uuid AND household_id = ${householdId}::uuid FOR UPDATE`;
  const account = await tx.account.findFirst({
    where: { id: accountId, householdId, isActive: true },
    select: { id: true, type: true, currency: true, closingDay: true, dueDay: true },
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
  allowArchived = false,
): Promise<string> {
  const categoryType = type === TransactionType.INCOME ? CategoryType.INCOME : CategoryType.EXPENSE;
  if (isCustomCategoryName(categoryCode)) {
    const id = toCustomCategoryId(categoryCode);
    if (id === null) throw new BadRequestError('Custom category code is invalid');
    const category = await tx.category.findFirst({ where: { id, householdId, ...(allowArchived ? {} : { archivedAt: null }) } });
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

async function lockInvoiceLifecycle(tx: Prisma.TransactionClient, invoiceIds: readonly (string | null)[]): Promise<void> {
  for (const invoiceId of [...new Set(invoiceIds.filter((id): id is string => id !== null))].sort()) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`invoice-lifecycle:${invoiceId}`}))`;
  }
}

function toDto(row: {
  id: string;
  type: TransactionType;
  amount: Prisma.Decimal;
  currency: string;
  categoryName: string | null;
  accountId: string | null;
  invoiceId: string | null;
  occurredAt: Date;
  timeZone: string;
  notes: string | null;
  paid: boolean;
  paidAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  version: number;
  clientMutationId: string;
  installmentId: string | null;
  installmentNumber: number | null;
  totalInstallments: number | null;
  installmentTotalAmount: Prisma.Decimal | null;
}): TransactionV1Dto {
  if (!row.categoryName || !row.accountId) throw new BadRequestError('Transaction is missing account or category identity');
  const currency = validateCurrency(row.currency);
  return {
    id: row.id,
    kind: prismaTypeToKind(row.type),
    amount: moneyDtoSchema.parse({ minorUnits: decimalToMinorUnits(row.amount, currency), currency }),
    categoryCode: row.categoryName,
    accountId: row.accountId,
    invoiceId: row.invoiceId,
    occurredAt: row.occurredAt.toISOString(),
    timeZone: row.timeZone,
    note: row.notes,
    paid: row.paid,
    paidAt: row.paidAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt?.toISOString() ?? null,
    version: row.version,
    clientMutationId: row.clientMutationId,
    installmentId: row.installmentId,
    installmentNumber: row.installmentNumber,
    totalInstallments: row.totalInstallments,
    installmentTotalAmount: row.installmentTotalAmount
      ? moneyDtoSchema.parse({ minorUnits: decimalToMinorUnits(row.installmentTotalAmount, currency), currency })
      : null,
  };
}

export async function createTransactionV1(
  input: CreateTransactionV1Input,
  householdId: string,
  userId: string,
  recurringOccurrence?: { recurringTransactionId: string; occurrenceDate: Date; dateBasis?: 'UTC' | 'TIME_ZONE' },
): Promise<TransactionV1Dto> {
  const identity = {
    userId,
    clientMutationId: input.clientMutationId,
    hash: payloadHash({ operation: 'transaction.create', householdId, input, ...(recurringOccurrence ? { recurringOccurrence } : {}) }),
  };
  return prisma.$transaction(async (tx) => {
    const replay = await findMutationReplay(tx, identity, transactionV1DtoSchema);
    if (replay !== null) return replay;
    const dto = await createTransactionV1WithTx(tx, input, householdId, recurringOccurrence);
    await saveMutationReceipt(tx, identity, 'transaction', dto.id, dto);
    return dto;
  });
}

export async function createTransactionV1WithTx(
  tx: Prisma.TransactionClient,
  input: CreateTransactionV1Input,
  householdId: string,
  recurringOccurrence?: { recurringTransactionId: string; occurrenceDate: Date; dateBasis?: 'UTC' | 'TIME_ZONE' },
  installment?: { installmentId: string; installmentNumber: number; totalInstallments: number; installmentTotalAmount: Prisma.Decimal },
): Promise<TransactionV1Dto> {
  const type = kindToPrismaType(input.kind);
  const money = moneyDtoSchema.parse(input.amount);
  const amount = minorUnitsToDecimal(money);
  const occurredAt = new Date(input.occurredAt);

  if (recurringOccurrence) {
    const occurrenceDateKey = recurringOccurrence.dateBasis === 'TIME_ZONE'
      ? civilDateStringAtInstant(input.occurredAt, input.timeZone)
      : civilDate(input.occurredAt).toISOString().slice(0, 10);
    const linkedDateKey = recurringOccurrence.occurrenceDate.toISOString().slice(0, 10);
    if (occurrenceDateKey !== linkedDateKey) {
      throw new BadRequestError('Transaction date must match its recurring occurrence date');
    }
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`recurring-occurrence:${recurringOccurrence.recurringTransactionId}:${occurrenceDateKey}`}))`;
    await tx.$executeRaw`SELECT id FROM recurring_transactions WHERE id = ${recurringOccurrence.recurringTransactionId}::uuid AND household_id = ${householdId}::uuid FOR UPDATE`;
    const recurring = await tx.recurringTransaction.findFirst({
      where: { id: recurringOccurrence.recurringTransactionId, householdId },
      include: { account: { select: { currency: true } } },
    });
    if (!recurring) throw new NotFoundError('Recurring transaction');
    if (recurring.cancelledAt && recurringOccurrence.occurrenceDate > recurring.cancelledAt) throw new RecurringOccurrenceExcludedError();
    const exclusion = await tx.recurringOccurrenceExclusion.findUnique({
      where: { recurringTransactionId_occurrenceDate: {
        recurringTransactionId: recurringOccurrence.recurringTransactionId,
        occurrenceDate: recurringOccurrence.occurrenceDate,
      } },
    });
    if (exclusion) throw new RecurringOccurrenceExcludedError();
    const existing = await tx.recurringOccurrence.findUnique({
      where: { recurringTransactionId_occurrenceDate: { recurringTransactionId: recurringOccurrence.recurringTransactionId, occurrenceDate: recurringOccurrence.occurrenceDate } },
      include: { transaction: { include: { account: { select: { currency: true } } } } },
    });
    if (existing?.transaction.account) {
      return toDto({ ...existing.transaction, currency: existing.transaction.account.currency });
    }
    if (recurring.account.currency !== money.currency) {
      throw new BadRequestError('Occurrence account currency must match the recurring schedule');
    }
  }
  const account = await requireAccount(tx, input.accountId, householdId, money.currency);
  const categoryCode = await validateCategory(tx, input.categoryCode, householdId, type, recurringOccurrence !== undefined);
  const invoiceId = account.type === AccountType.CREDIT
    ? await getOrCreateInvoiceForTransaction(tx, {
        householdId,
        cardAccountId: account.id,
        currency: money.currency,
        closingDay: account.closingDay,
        dueDay: account.dueDay,
        occurredAt,
        timeZone: input.timeZone,
        amount,
        transactionType: input.kind === 'income' ? 'INCOME' : 'EXPENSE',
      })
    : null;
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
      invoiceId,
      notes: input.note,
      paid: input.paid,
      paidAt: input.paid ? new Date() : null,
      clientMutationId: input.clientMutationId,
      ...(recurringOccurrence ? { recurringTransactionId: recurringOccurrence.recurringTransactionId } : {}),
      ...(installment ? {
        installmentId: installment.installmentId,
        installmentNumber: installment.installmentNumber,
        totalInstallments: installment.totalInstallments,
        installmentTotalAmount: installment.installmentTotalAmount,
      } : {}),
    },
  });
  if (recurringOccurrence) {
    await tx.recurringOccurrence.create({
      data: {
        recurringTransactionId: recurringOccurrence.recurringTransactionId,
        occurrenceDate: recurringOccurrence.occurrenceDate,
        transactionId: transaction.id,
      },
    });
  }
  if (input.paid) {
    await applyBalanceChange(tx, account.id, balanceChange(amount, input.kind, account.type));
  }
  const dto = toDto({ ...transaction, currency: money.currency });
  await appendSyncChange(tx, {
    householdId,
    entityType: 'transaction',
    entityId: transaction.id,
    version: transaction.version,
    payload: dto,
  });
  return dto;
}

export async function listTransactionsV1(query: ListTransactionsV1Query, householdId: string): Promise<TransactionV1Page> {
  const where: Prisma.TransactionWhereInput = {
    householdId,
    deletedAt: null,
    ...(query.accountId ? { accountId: query.accountId } : {}),
    ...(query.kind ? { type: kindToPrismaType(query.kind) } : {}),
    ...(query.categoryCode ? { categoryName: query.categoryCode } : {}),
    ...(query.installmentId ? { installmentId: query.installmentId } : {}),
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
  options: { allowOccurrenceAccountChange?: boolean } = {},
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
      include: { account: { select: { id: true, type: true, currency: true, closingDay: true, dueDay: true } } },
    });
    if (!existing || !existing.account) throw new NotFoundError('Transaction');
    const accountChangeRequested = input.accountId !== undefined && input.accountId !== existing.account.id;
    if (accountChangeRequested && (!options.allowOccurrenceAccountChange || !existing.recurringTransactionId || existing.paid)) {
      throw new BadRequestError('Only an unpaid recurring occurrence can be reassigned to another account');
    }
    const invoiceIdsToLock: Array<string | null> = [existing.invoiceId];
    const nextOccurredAt = input.occurredAt ? new Date(input.occurredAt) : existing.occurredAt;
    if (existing.account.type === AccountType.CREDIT) {
      const cycle = calculateBillingCycle(nextOccurredAt.toISOString(), existing.account.closingDay, existing.account.dueDay, input.timeZone ?? existing.timeZone);
      const targetInvoice = await tx.creditCardInvoice.findUnique({
        where: { cardAccountId_periodStart: { cardAccountId: existing.account.id, periodStart: new Date(`${cycle.periodStart}T00:00:00.000Z`) } },
        select: { id: true },
      });
      invoiceIdsToLock.push(targetInvoice?.id ?? null);
    }
    await lockInvoiceLifecycle(tx, invoiceIdsToLock);
    const accountIdsToLock = [...new Set([existing.account.id, ...(accountChangeRequested && input.accountId ? [input.accountId] : [])])].sort();
    for (const accountId of accountIdsToLock) {
      await tx.$executeRaw`SELECT id FROM accounts WHERE id = ${accountId}::uuid AND household_id = ${householdId}::uuid FOR UPDATE`;
    }
    if (existing.version !== input.expectedVersion) throw new VersionConflictError();
    let nextAccount = existing.account;
    if (accountChangeRequested) {
      const selectedAccount = await tx.account.findFirst({ where: { id: input.accountId, householdId, isActive: true } });
      if (!selectedAccount) throw new NotFoundError('Active account');
      if (existing.account.type === AccountType.CREDIT || selectedAccount.type === AccountType.CREDIT) {
        throw new OccurrenceAccountConflictError();
      }
      nextAccount = selectedAccount;
    }
    const currency = validateCurrency(nextAccount.currency);
    const kind = prismaTypeToKind(existing.type);
    const nextAmount = input.amount ? minorUnitsToDecimal(input.amount) : existing.amount;
    if (input.amount && input.amount.currency !== currency) throw new BadRequestError('Transaction currency must match account currency');
    const nextCode = input.categoryCode
      ? await validateCategory(tx, input.categoryCode, householdId, existing.type)
      : existing.categoryName;
    if (!nextCode) throw new BadRequestError('Transaction category is missing');
    const nextPaid = input.paid ?? existing.paid;
    let nextInvoiceId = existing.invoiceId;
    if (existing.account.type === AccountType.CREDIT) {
      if (existing.invoiceId) {
        const invoice = await tx.creditCardInvoice.findUnique({
          where: { id: existing.invoiceId },
          select: { status: true },
        });
        if (invoice?.status !== 'OPEN') throw new BadRequestError('A closed invoice transaction cannot be changed');
        await adjustInvoiceTotal(tx, existing.invoiceId, signedInvoiceAmount(existing.amount, kind === 'income' ? 'INCOME' : 'EXPENSE').negated());
      }
      nextInvoiceId = await getOrCreateInvoiceForTransaction(tx, {
        householdId,
        cardAccountId: existing.account.id,
        currency,
        closingDay: existing.account.closingDay,
        dueDay: existing.account.dueDay,
        occurredAt: nextOccurredAt,
        timeZone: input.timeZone ?? existing.timeZone,
        amount: nextAmount,
        transactionType: kind === 'income' ? 'INCOME' : 'EXPENSE',
      });
    }

    if (existing.paid) {
      await applyBalanceChange(tx, existing.account.id, balanceChange(existing.amount, kind, existing.account.type).negated());
    }
    if (nextPaid) {
      await applyBalanceChange(tx, nextAccount.id, balanceChange(nextAmount, kind, nextAccount.type));
    }

    const update = await tx.transaction.updateMany({
      where: { id: existing.id, householdId, version: input.expectedVersion, deletedAt: null },
      data: {
        ...(accountChangeRequested ? { accountId: nextAccount.id } : {}),
        amount: nextAmount,
        categoryName: nextCode,
        date: input.occurredAt ? civilDate(input.occurredAt) : undefined,
        occurredAt: input.occurredAt ? new Date(input.occurredAt) : undefined,
        timeZone: input.timeZone,
        invoiceId: nextInvoiceId,
        notes: input.note,
        paid: nextPaid,
        paidAt: nextPaid ? (existing.paid ? existing.paidAt : new Date()) : null,
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
  return prisma.$transaction((tx) => softDeleteTransactionV1WithTx(tx, transactionId, householdId, userId, clientMutationId, expectedVersion));
}

export async function softDeleteTransactionV1WithTx(
  tx: Prisma.TransactionClient,
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
    const replay = await findMutationReplay(tx, identity, transactionV1DtoSchema);
    if (replay !== null) return replay;
    const existing = await tx.transaction.findFirst({
      where: { id: transactionId, householdId, deletedAt: null },
      include: { account: { select: { id: true, type: true } } },
    });
    if (!existing || !existing.account) throw new NotFoundError('Transaction');
    if (existing.version !== expectedVersion) throw new VersionConflictError();
    await lockInvoiceLifecycle(tx, [existing.invoiceId]);
    if (existing.paid) {
      const kind = prismaTypeToKind(existing.type);
      await applyBalanceChange(tx, existing.account.id, balanceChange(existing.amount, kind, existing.account.type).negated());
    }
    if (existing.invoiceId) {
      const invoice = await tx.creditCardInvoice.findUnique({
        where: { id: existing.invoiceId },
        select: { status: true },
      });
      if (invoice?.status !== 'OPEN') throw new BadRequestError('A closed invoice transaction cannot be deleted');
      await adjustInvoiceTotal(
        tx,
        existing.invoiceId,
        signedInvoiceAmount(existing.amount, existing.type === TransactionType.INCOME ? 'INCOME' : 'EXPENSE').negated(),
      );
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
}

interface InstallmentGroupItem {
  id: string;
  type: TransactionType;
  amount: Prisma.Decimal;
  currency: string;
  accountType: string;
  categoryName: string | null;
  accountId: string;
  invoiceId: string | null;
  occurredAt: Date;
  timeZone: string;
  notes: string | null;
  paid: boolean;
  paidAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
  clientMutationId: string;
  installmentId: string;
  installmentNumber: number | null;
  totalInstallments: number | null;
  installmentTotalAmount: Prisma.Decimal | null;
}

/**
 * Deterministic snapshot token of the active (non-deleted) items of the group:
 * SHA-256 over the sorted set of item identities, versions, mutations, amounts,
 * paid flags and invoice links. Identifies the exact set, so any membership,
 * version or value change (even with identical counts or sums) invalidates the
 * previously confirmed group.
 */
function installmentGroupToken(
  items: ReadonlyArray<{
    id: string;
    version: number;
    updatedAt: Date;
    amount: Prisma.Decimal;
    paid: boolean;
    invoiceId: string | null;
  }>,
): string {
  const hash = createHash('sha256');
  for (const item of [...items].sort((left, right) => left.id.localeCompare(right.id))) {
    hash.update([
      item.id,
      String(item.version),
      item.updatedAt.toISOString(),
      item.amount.toFixed(2),
      item.paid ? '1' : '0',
      item.invoiceId ?? '-',
    ].join('|'));
    hash.update('\n');
  }
  return hash.digest('hex');
}

function decimalToMinorUnitsByCurrency(amount: Prisma.Decimal, currency: string): number {
  return decimalToMinorUnits(amount, validateCurrency(currency));
}

/**
 * Reliable impact preview for the mobile confirmation dialog: everything the
 * GROUP delete would touch, server-side selected by household + installmentId.
 */
export async function getInstallmentGroupSummaryV1(
  transactionId: string,
  householdId: string,
): Promise<InstallmentGroupSummaryV1> {
  const anchor = await prisma.transaction.findFirst({
    where: { id: transactionId, householdId, deletedAt: null },
    select: {
      installmentId: true,
      installmentNumber: true,
      totalInstallments: true,
      account: { select: { currency: true } },
    },
  });
  if (!anchor?.account) throw new NotFoundError('Transaction');

  let items: Array<{
    id: string;
    amount: Prisma.Decimal;
    paid: boolean;
    version: number;
    updatedAt: Date;
    invoiceId: string | null;
    currency: string;
  }>;

  if (anchor.installmentId === null) {
    const single = await prisma.transaction.findFirstOrThrow({
      where: { id: transactionId, householdId, deletedAt: null },
      select: { id: true, amount: true, paid: true, version: true, updatedAt: true, invoiceId: true, account: { select: { currency: true } } },
    });
    if (single.account === null) throw new NotFoundError('Transaction');
    items = [{ id: single.id, amount: single.amount, paid: single.paid, version: single.version, updatedAt: single.updatedAt, invoiceId: single.invoiceId, currency: single.account.currency }];
  } else {
    const groupRows = await prisma.transaction.findMany({
      where: { householdId, installmentId: anchor.installmentId, deletedAt: null },
      select: { id: true, amount: true, paid: true, version: true, updatedAt: true, invoiceId: true, account: { select: { currency: true } } },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    });
    items = groupRows.map((row) => {
      if (row.account === null) throw new NotFoundError('Transaction');
      return { id: row.id, amount: row.amount, paid: row.paid, version: row.version, updatedAt: row.updatedAt, invoiceId: row.invoiceId, currency: row.account.currency };
    });
  }

  const invoiceIds = [...new Set(items.flatMap((item) => (item.invoiceId ? [item.invoiceId] : [])))];
  const invoices = invoiceIds.length > 0
    ? await prisma.creditCardInvoice.findMany({ where: { id: { in: invoiceIds } }, select: { id: true, status: true } })
    : [];
  const invoiceStatusById = new Map(invoices.map((invoice) => [invoice.id, invoice.status]));
  const openInvoiceItemCount = items.filter((item) => item.invoiceId && invoiceStatusById.get(item.invoiceId) === 'OPEN').length;

  const amounts = new Map<Currency, number>();
  for (const item of items) {
    const currency = validateCurrency(item.currency);
    const minorUnits = decimalToMinorUnitsByCurrency(item.amount, currency);
    amounts.set(currency, (amounts.get(currency) ?? 0) + minorUnits);
  }

  return installmentGroupSummaryV1Schema.parse({
    transactionId,
    installmentId: anchor.installmentId,
    isInstallmentGroup: anchor.installmentId !== null,
    installmentNumber: anchor.installmentNumber,
    totalInstallments: anchor.totalInstallments,
    activeCount: items.length,
    paidCount: items.filter((item) => item.paid).length,
    openInvoiceCount: openInvoiceItemCount,
    groupToken: installmentGroupToken(items),
    amounts: [...amounts.entries()].map(([currency, minorUnits]) => ({ currency, minorUnits })),
  });
}

export async function softDeleteInstallmentGroupV1(
  transactionId: string,
  householdId: string,
  userId: string,
  clientMutationId: string,
  expectedGroupCount: number,
  expectedGroupToken: string,
): Promise<InstallmentGroupDeleteV1Response> {
  return prisma.$transaction((tx) => softDeleteInstallmentGroupV1WithTx(
    tx,
    transactionId,
    householdId,
    userId,
    clientMutationId,
    expectedGroupCount,
    expectedGroupToken,
  ));
}

/**
 * Server-side selection by household + installmentId: deletes ALL active (not
 * deleted) installments of the same purchase, regardless of date or page. The
 * whole group is rejected atomically when any item cannot be deleted (closed
 * invoice), and re-checked against the confirmed count/version so concurrent
 * changes are detected instead of silently deleting a different group.
 */
export async function softDeleteInstallmentGroupV1WithTx(
  tx: Prisma.TransactionClient,
  transactionId: string,
  householdId: string,
  userId: string,
  clientMutationId: string,
  expectedGroupCount: number,
  expectedGroupToken: string,
): Promise<InstallmentGroupDeleteV1Response> {
  const identity = {
    userId,
    clientMutationId,
    hash: payloadHash({
      operation: 'transaction.delete_group',
      transactionId,
      householdId,
      expectedGroupCount,
      expectedGroupToken,
    }),
  };
  const replay = await findMutationReplay(tx, identity, installmentGroupDeleteV1ResponseSchema);
  if (replay !== null) return replay;

  const anchor = await tx.transaction.findFirst({
    where: { id: transactionId, householdId, deletedAt: null },
    select: { id: true, installmentId: true },
  });
  if (!anchor) throw new NotFoundError('Transaction');
  if (anchor.installmentId === null) {
    throw new BadRequestError('This transaction is not an installment purchase; there is no group to delete');
  }

  // Use a common lock order: invoice lifecycle advisory locks, then accounts
  // (sorted), then transaction rows (sorted). Updates lock accounts before
  // their transaction row; invoice lifecycle endpoints lock invoice first.
  // This avoids the account↔transaction cycle between an edit and group delete.
  const lockSnapshot = await tx.transaction.findMany({
    where: { householdId, installmentId: anchor.installmentId, deletedAt: null },
    select: { id: true, accountId: true, invoiceId: true },
  });
  await lockInvoiceLifecycle(tx, lockSnapshot.map((item) => item.invoiceId));
  const accountIdsToLock = [...new Set(lockSnapshot.map((item) => item.accountId).filter((id): id is string => id !== null))].sort();
  for (const accountId of accountIdsToLock) {
    await tx.$executeRaw`SELECT id FROM accounts WHERE id = ${accountId}::uuid AND household_id = ${householdId}::uuid FOR UPDATE`;
  }
  await tx.$executeRaw`SELECT id FROM transactions WHERE household_id = ${householdId}::uuid AND installment_id = ${anchor.installmentId} AND deleted_at IS NULL ORDER BY id FOR UPDATE`;

  const rows = await tx.transaction.findMany({
    where: { householdId, installmentId: anchor.installmentId, deletedAt: null },
    include: { account: { select: { id: true, type: true, currency: true } } },
    orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
  });
  const items = rows.map((row): InstallmentGroupItem => {
    if (!row?.account) throw new NotFoundError('Transaction');
    return {
      id: row.id,
      type: row.type,
      amount: row.amount,
      currency: row.account.currency,
      accountType: row.account.type,
      categoryName: row.categoryName,
      accountId: row.account.id,
      invoiceId: row.invoiceId,
      occurredAt: row.occurredAt,
      timeZone: row.timeZone,
      notes: row.notes,
      paid: row.paid,
      paidAt: row.paidAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      version: row.version,
      clientMutationId: row.clientMutationId,
      installmentId: row.installmentId ?? (anchor.installmentId as string),
      installmentNumber: row.installmentNumber,
      totalInstallments: row.totalInstallments,
      installmentTotalAmount: row.installmentTotalAmount,
    };
  });

  const currentGroupToken = installmentGroupToken(items);
  if (items.length !== expectedGroupCount || currentGroupToken !== expectedGroupToken) {
    throw new InstallmentGroupConflictError(
      `Installment group is stale: expected ${expectedGroupCount} items with group token ${expectedGroupToken.slice(0, 12)}…, found ${items.length} items with group token ${currentGroupToken.slice(0, 12)}…; re-fetch the installment summary`,
    );
  }

  // Re-read every invoice after holding its lifecycle lock. The group snapshot
  // was read before locks only to establish this consistent lock order.
  const invoiceIds = [...new Set(items.flatMap((item) => (item.invoiceId ? [item.invoiceId] : [])))].sort();
  const invoices = invoiceIds.length > 0
    ? await tx.creditCardInvoice.findMany({ where: { id: { in: invoiceIds } }, select: { id: true, status: true } })
    : [];
  const invoiceStatusById = new Map(invoices.map((invoice) => [invoice.id, invoice.status]));
  const blockedItems = items.filter((item) => item.invoiceId && invoiceStatusById.get(item.invoiceId) !== 'OPEN');
  const closedInvoices = new Set(blockedItems.flatMap((item) => (item.invoiceId ? [item.invoiceId] : [])));
  if (closedInvoices.size > 0) {
    throw new BadRequestError(
      `Cannot delete the installment group: ${closedInvoices.size} closed invoice(s) block ${blockedItems.length} of the ${items.length} transactions`,
    );
  }

  // Deterministic mutation order (sorted account then invoice then item) keeps
  // lock acquisition deadlock-safe against create flows that lock the account
  // row before touching transactions/invoices.
  const deletableItems = [...items].sort((left, right) =>
    (left.accountId.localeCompare(right.accountId)) || left.id.localeCompare(right.id));
  const deletedAt = new Date();
  for (const item of deletableItems) {
    if (item.paid) {
      await applyBalanceChange(tx, item.accountId, balanceChange(item.amount, prismaTypeToKind(item.type), item.accountType).negated());
    }
  }
  for (const item of [...items].sort((left, right) =>
    ((left.invoiceId ?? '').localeCompare(right.invoiceId ?? '')) || left.id.localeCompare(right.id))) {
    if (item.invoiceId) {
      await adjustInvoiceTotal(
        tx,
        item.invoiceId,
        signedInvoiceAmount(item.amount, item.type === TransactionType.INCOME ? 'INCOME' : 'EXPENSE').negated(),
      );
    }
  }
  for (const item of [...items].sort((left, right) => left.id.localeCompare(right.id))) {
    const update = await tx.transaction.updateMany({
      where: { id: item.id, householdId, version: item.version, deletedAt: null },
      data: { deletedAt, version: { increment: 1 }, clientMutationId },
    });
    if (update.count !== 1) throw new VersionConflictError();
  }

  const deletedIds = items.map((item) => item.id);
  const deletedRows = await tx.transaction.findMany({
    where: { id: { in: deletedIds } },
    include: { account: { select: { currency: true } } },
    orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
  });
  const dtoItems = deletedRows.map((row) => {
    if (!row?.account) throw new NotFoundError('Transaction');
    return transactionV1DtoSchema.parse(toDto({ ...row, currency: row.account.currency }));
  });

  const response = installmentGroupDeleteV1ResponseSchema.parse({
    type: 'INSTALLMENT_GROUP_DELETE',
    scope: 'group',
    installmentId: anchor.installmentId,
    deletedCount: dtoItems.length,
    deletedPaidCount: dtoItems.filter((item) => item.paid).length,
    matchedGroupToken: currentGroupToken,
    items: dtoItems,
  });

  await saveMutationReceipt(tx, identity, 'transaction_group', anchor.installmentId, response);
  for (const dto of dtoItems) {
    await appendSyncChange(tx, {
      householdId,
      entityType: 'transaction',
      entityId: dto.id,
      version: dto.version,
      payload: dto,
      deletedAt,
    });
  }
  return response;
}
