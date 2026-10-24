import { BadRequestError, NotFoundError, OccurrenceAccountConflictError, VersionConflictError } from '../../shared/errors/index.js';
import { AccountType, CategoryType, getCategoriesByType, isCategoryOfType } from '../../shared/enums/index.js';
import { decimalToMinorUnits, minorUnitsToDecimal, type Currency } from '../../shared/money/index.js';
import { isCustomCategoryName, toCustomCategoryId, toCustomCategoryName } from '../../shared/utils/categoryHelpers.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../shared/db/prisma.js';
import { calculateNextRunDate, expandRecurrenceDates } from './recurrence-date.js';
import { createTransactionV1, updateTransactionV1 } from '../transactions/transactions.v1.service.js';
import { createTransactionV1Schema, updateTransactionV1Schema } from '../transactions/transactions.v1.schema.js';
import {
  recurringV1DtoSchema,
  recurringManagedV1DtoSchema,
  type CreateRecurringV1Input,
  type PayRecurringOccurrenceInput,
  type RecurringManagedV1Dto,
  type RecurringV1Dto,
  type UpdateRecurringV1Input,
} from './recurring.v1.schema.js';

function currency(value: string): Currency {
  if (value !== 'BRL' && value !== 'USD') throw new BadRequestError('Account currency is not supported');
  return value;
}

function toCivilDate(value: Date | null): string | null {
  return value?.toISOString().slice(0, 10) ?? null;
}

type RecurringWithAccount = Prisma.RecurringTransactionGetPayload<{
  include: { account: { select: { currency: true } } };
}>;

function toRecurringDto(row: RecurringWithAccount): RecurringManagedV1Dto {
  const accountCurrency = currency(row.account.currency);
  return recurringManagedV1DtoSchema.parse({
    id: row.id,
    accountId: row.accountId,
    categoryCode: row.categoryName,
    amount: { minorUnits: decimalToMinorUnits(row.amount, accountCurrency), currency: accountCurrency },
    description: row.description,
    frequency: row.frequency,
    kind: row.kind,
    recurrenceMode: row.recurrenceMode,
    occurrencesLimit: row.occurrencesLimit,
    anchorDay: row.anchorDay,
    startDate: toCivilDate(row.startDate),
    endDate: toCivilDate(row.endDate),
    nextRunAt: toCivilDate(row.nextRunAt),
    lastRunDate: toCivilDate(row.lastRunDate),
    timeZone: row.timeZone,
    isActive: row.isActive,
  });
}

export async function createRecurringManagedV1(input: CreateRecurringV1Input, householdId: string): Promise<RecurringManagedV1Dto> {
  let categoryCode = input.categoryCode;
  if (isCustomCategoryName(input.categoryCode)) {
    const id = toCustomCategoryId(input.categoryCode);
    if (!id) throw new BadRequestError('Custom category code is invalid');
    const category = await prisma.category.findFirst({ where: { id, householdId } });
    if (!category) throw new NotFoundError('Category');
    categoryCode = toCustomCategoryName(category.id);
  } else if (![...getCategoriesByType(CategoryType.INCOME), ...getCategoriesByType(CategoryType.EXPENSE)]
    .some((code) => code === input.categoryCode)) {
    throw new BadRequestError('Category code is not supported for recurring transactions');
  }

  const row = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT id FROM accounts WHERE id = ${input.accountId}::uuid AND household_id = ${householdId}::uuid FOR UPDATE`;
    const account = await tx.account.findFirst({
      where: { id: input.accountId, householdId, isActive: true },
      select: { id: true, currency: true },
    });
    if (!account) throw new NotFoundError('Account');
    const accountCurrency = currency(account.currency);
    if (accountCurrency !== input.amount.currency) throw new BadRequestError('Recurring currency must match account currency');

    return tx.recurringTransaction.create({
      data: {
        householdId,
        accountId: account.id,
        categoryName: categoryCode,
        amount: minorUnitsToDecimal(input.amount),
        description: input.description,
        frequency: input.frequency,
        kind: input.kind,
        recurrenceMode: input.recurrenceMode ?? (input.endDate ? 'LIMITED' : 'ALWAYS'),
        occurrencesLimit: input.recurrenceMode === 'ONCE' ? 1 : input.occurrencesLimit,
        anchorDay: new Date(`${input.startDate}T00:00:00.000Z`).getUTCDate(),
        effectiveFromDate: new Date(`${input.startDate}T00:00:00.000Z`),
        occurrencesCountOffset: 0,
        startDate: new Date(`${input.startDate}T00:00:00.000Z`),
        endDate: input.endDate ? new Date(`${input.endDate}T00:00:00.000Z`) : null,
        nextRunAt: new Date(`${(input.nextRunAt ?? input.startDate)}T00:00:00.000Z`),
        timeZone: input.timeZone,
      },
      include: { account: { select: { currency: true } } },
    });
  });

  return toRecurringDto(row);
}

export async function listRecurringV1(householdId: string): Promise<RecurringV1Dto[]> {
  const rows = await prisma.recurringTransaction.findMany({
    where: { householdId },
    include: { account: { select: { currency: true } } },
    orderBy: [{ isActive: 'desc' }, { nextRunAt: 'asc' }, { id: 'asc' }],
  });
  return rows.map((row) => {
    const item = toRecurringDto(row);
    return recurringV1DtoSchema.parse({
      id: item.id,
      accountId: item.accountId,
      categoryCode: item.categoryCode,
      amount: item.amount,
      description: item.description,
      frequency: item.frequency,
      startDate: item.startDate,
      endDate: item.endDate,
      nextRunAt: item.nextRunAt,
      lastRunDate: item.lastRunDate,
      timeZone: item.timeZone,
      isActive: item.isActive,
    });
  });
}

export async function listRecurringManagedV1(householdId: string): Promise<RecurringManagedV1Dto[]> {
  const rows = await prisma.recurringTransaction.findMany({
    where: { householdId },
    include: { account: { select: { currency: true } } },
    orderBy: [{ isActive: 'desc' }, { nextRunAt: 'asc' }, { id: 'asc' }],
  });
  return rows.map(toRecurringDto);
}

export async function createRecurringV1(input: CreateRecurringV1Input, householdId: string): Promise<RecurringV1Dto> {
  const item = await createRecurringManagedV1(input, householdId);
  return recurringV1DtoSchema.parse({
    id: item.id,
    accountId: item.accountId,
    categoryCode: item.categoryCode,
    amount: item.amount,
    description: item.description,
    frequency: item.frequency,
    startDate: item.startDate,
    endDate: item.endDate,
    nextRunAt: item.nextRunAt,
    lastRunDate: item.lastRunDate,
    timeZone: item.timeZone,
    isActive: item.isActive,
  });
}

export async function updateRecurringV1(
  recurringId: string,
  householdId: string,
  input: UpdateRecurringV1Input,
): Promise<RecurringManagedV1Dto> {
  const current = await prisma.recurringTransaction.findFirst({
    where: { id: recurringId, householdId, isActive: true },
    include: { account: { select: { id: true, currency: true, type: true } }, scheduleVersions: true },
  });
  if (!current) throw new NotFoundError('Recurring transaction');
  const targetAccount = input.accountId === undefined
    ? current.account
    : await prisma.account.findFirst({ where: { id: input.accountId, householdId, isActive: true }, select: { id: true, currency: true, type: true } });
  if (!targetAccount) throw new NotFoundError('Active account');
  if (currency(targetAccount.currency) !== currency(current.account.currency)) {
    throw new BadRequestError('Recurring account currency cannot be changed');
  }
  if (input.amount && currency(targetAccount.currency) !== input.amount.currency) {
    throw new BadRequestError('Recurring currency must match account currency');
  }

  let categoryName = input.categoryCode ?? current.categoryName;
  if (input.categoryCode && isCustomCategoryName(input.categoryCode)) {
    const id = toCustomCategoryId(input.categoryCode);
    if (!id) throw new BadRequestError('Custom category code is invalid');
    const category = await prisma.category.findFirst({ where: { id, householdId } });
    if (!category) throw new NotFoundError('Category');
    categoryName = toCustomCategoryName(category.id);
  } else if (input.categoryCode && ![...getCategoriesByType(CategoryType.INCOME), ...getCategoriesByType(CategoryType.EXPENSE)]
    .some((code) => code === input.categoryCode)) {
    throw new BadRequestError('Category code is not supported for recurring transactions');
  }

  const recurrenceMode = input.recurrenceMode ?? current.recurrenceMode;
  const endDate = input.endDate === undefined
    ? recurrenceMode === 'ALWAYS' || recurrenceMode === 'ONCE' ? null : current.endDate
    : input.endDate ? new Date(`${input.endDate}T00:00:00.000Z`) : null;
  const occurrencesLimit = recurrenceMode === 'ONCE' ? 1
    : recurrenceMode === 'ALWAYS' ? null
    : input.occurrencesLimit === undefined ? current.occurrencesLimit : input.occurrencesLimit;
  if (recurrenceMode === 'LIMITED' && occurrencesLimit === null && endDate === null) {
    throw new BadRequestError('LIMITED recurrence requires an occurrence limit or end date');
  }
  if (recurrenceMode === 'ALWAYS' && (occurrencesLimit !== null || endDate !== null)) {
    throw new BadRequestError('ALWAYS recurrence cannot have a limit or end date');
  }
  if (recurrenceMode === 'ONCE' && occurrencesLimit !== 1) {
    throw new BadRequestError('ONCE recurrence must contain exactly one occurrence');
  }

  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  let effectiveFromDate = new Date(current.nextRunAt);
  let advances = 0;
  while (effectiveFromDate <= today && advances < 20000) {
    effectiveFromDate = calculateNextRunDate(effectiveFromDate, current.frequency, current.anchorDay);
    advances += 1;
  }
  if (advances >= 20000) throw new BadRequestError('Recurring schedule is too old to safely edit');
  const previousDay = new Date(effectiveFromDate.getTime() - 86400000);
  const countRuleDates = (rule: {
    effectiveFromDate: Date; startDate: Date; endDate: Date | null; frequency: 'DAILY' | 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY' | 'YEARLY';
    anchorDay: number; recurrenceMode: RecurringManagedV1Dto['recurrenceMode']; occurrencesLimit: number | null;
    occurrencesCountOffset: number; effectiveToDate?: Date;
  }): number => {
    const upper = rule.effectiveToDate && rule.effectiveToDate < previousDay ? rule.effectiveToDate : previousDay;
    const endDateValue = rule.endDate && rule.endDate < upper ? rule.endDate : upper;
    if (endDateValue < rule.effectiveFromDate) return 0;
    return expandRecurrenceDates({
      startDate: rule.effectiveFromDate,
      from: rule.effectiveFromDate,
      to: upper,
      frequency: rule.frequency,
      anchorDay: rule.anchorDay,
      recurrenceMode: rule.recurrenceMode,
      occurrencesLimit: rule.occurrencesLimit,
      occurrencesCountOffset: rule.occurrencesCountOffset,
      endDate: endDateValue,
    }).length;
  };
  const historicalCount = current.occurrencesCountOffset + countRuleDates(current);
  const nextIsActive = !(occurrencesLimit !== null && historicalCount >= occurrencesLimit)
    && !(endDate !== null && effectiveFromDate > endDate);

  const row = await prisma.$transaction(async (tx) => {
    const accountChanged = targetAccount.id !== current.accountId;
    let pendingOccurrences: Array<{ accountId: string | null; account: { type: string } | null }> = [];
    if (accountChanged) {
      await tx.$executeRaw`SELECT id FROM accounts WHERE id = ${targetAccount.id}::uuid AND household_id = ${householdId}::uuid FOR UPDATE`;
      const activeTarget = await tx.account.findFirst({ where: { id: targetAccount.id, householdId, isActive: true } });
      if (!activeTarget) throw new NotFoundError('Active account');
      pendingOccurrences = await tx.transaction.findMany({
        where: { recurringTransactionId: recurringId, date: { gte: effectiveFromDate }, paid: false, deletedAt: null },
        select: { accountId: true, account: { select: { type: true } } },
      });
      if (pendingOccurrences.length > 0 && (targetAccount.type === AccountType.CREDIT || pendingOccurrences.some((item) => item.account?.type === AccountType.CREDIT))) {
        throw new OccurrenceAccountConflictError('A materialized unpaid card occurrence cannot be reassigned; edit the schedule after it is settled or use the invoice lifecycle');
      }
    }
    if (effectiveFromDate > current.effectiveFromDate) {
      await tx.recurringScheduleVersion.create({
        data: {
          recurringTransactionId: current.id,
          effectiveFromDate: current.effectiveFromDate,
          effectiveToDate: previousDay,
          startDate: current.startDate,
          endDate: current.endDate,
          accountId: current.accountId,
          categoryName: current.categoryName,
          amount: current.amount,
          description: current.description,
          frequency: current.frequency,
          kind: current.kind,
          recurrenceMode: current.recurrenceMode,
          occurrencesLimit: current.occurrencesLimit,
          occurrencesCountOffset: current.occurrencesCountOffset,
          anchorDay: current.anchorDay,
          timeZone: current.timeZone,
        },
      });
    }
    const updated = await tx.recurringTransaction.update({
      where: { id: recurringId },
      data: {
        ...(accountChanged ? { accountId: targetAccount.id } : {}),
        categoryName,
        amount: input.amount ? minorUnitsToDecimal(input.amount) : undefined,
        description: input.description,
        frequency: input.frequency,
        kind: input.kind,
        recurrenceMode,
        occurrencesLimit,
        endDate,
        timeZone: input.timeZone,
        effectiveFromDate,
        occurrencesCountOffset: historicalCount,
        nextRunAt: effectiveFromDate,
        isActive: nextIsActive,
      },
      include: { account: { select: { currency: true } } },
    });
    await tx.transaction.updateMany({
      where: {
        recurringTransactionId: recurringId,
        date: { gte: effectiveFromDate },
        paid: false,
        deletedAt: null,
      },
      data: {
        categoryName,
        ...(accountChanged && pendingOccurrences.length > 0 ? { accountId: targetAccount.id } : {}),
        amount: input.amount ? minorUnitsToDecimal(input.amount) : undefined,
        description: input.description === undefined ? undefined : input.description ?? `Recurring: ${categoryName}`,
      },
    });
    return updated;
  });
  return toRecurringDto(row);
}

export async function cancelRecurringV1(recurringId: string, householdId: string): Promise<RecurringManagedV1Dto> {
  const row = await prisma.recurringTransaction.findFirst({
    where: { id: recurringId, householdId },
    include: { account: { select: { currency: true } } },
  });
  if (!row) throw new NotFoundError('Recurring transaction');
  if (row.isActive) {
    const today = new Date();
    const cancelledAt = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
    const updated = await prisma.recurringTransaction.update({
      where: { id: recurringId },
      data: { isActive: false, cancelledAt },
      include: { account: { select: { currency: true } } },
    });
    return toRecurringDto(updated);
  }
  return toRecurringDto(row);
}

export async function listRecurringOccurrencesV1(
  householdId: string,
  fromDate: string,
  toDate: string,
): Promise<{ items: Array<Record<string, unknown>>; totalsByCurrency: Array<Record<string, number | string>> }> {
  const from = new Date(`${fromDate}T00:00:00.000Z`);
  const to = new Date(`${toDate}T00:00:00.000Z`);
  if (to.getTime() - from.getTime() > 366 * 86400000) throw new BadRequestError('Occurrence range cannot exceed 366 days');
  const schedules = await prisma.recurringTransaction.findMany({
    where: { householdId, startDate: { lte: to } },
    include: { account: { select: { currency: true } }, occurrences: { include: { transaction: true } }, scheduleVersions: true },
    orderBy: [{ startDate: 'asc' }, { id: 'asc' }],
  });
  const today = new Date();
  const todayKey = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const items: Array<Record<string, unknown>> = [];
  const totals = new Map<string, { totalMinorUnits: number; paidMinorUnits: number; remainingMinorUnits: number; estimatedMinorUnits: number }>();

  for (const schedule of schedules) {
    const accountCurrency = currency(schedule.account.currency);
    const occurrenceByDate = new Map(schedule.occurrences.map((item) => [toCivilDate(item.occurrenceDate)!, item]));
    const rules = [
      ...schedule.scheduleVersions,
      { ...schedule, effectiveToDate: null },
    ];
    for (const rule of rules) {
      const ruleFrom = rule.effectiveFromDate > from ? rule.effectiveFromDate : from;
      let ruleTo = rule.effectiveToDate && rule.effectiveToDate < to ? rule.effectiveToDate : to;
      if (schedule.cancelledAt && schedule.cancelledAt < ruleTo) ruleTo = schedule.cancelledAt;
      if (ruleFrom > ruleTo) continue;
      const dates = expandRecurrenceDates({
        startDate: rule.effectiveFromDate,
        from: ruleFrom,
        to: ruleTo,
        frequency: rule.frequency,
        anchorDay: rule.anchorDay,
        recurrenceMode: rule.recurrenceMode,
        occurrencesLimit: rule.occurrencesLimit,
        occurrencesCountOffset: rule.occurrencesCountOffset,
        endDate: rule.endDate,
      });
      for (const date of dates) {
      const dateKey = toCivilDate(date)!;
      const marker = occurrenceByDate.get(dateKey);
      const transaction = marker?.transaction;
      const amountMinorUnits = transaction
        ? decimalToMinorUnits(transaction.amount, accountCurrency)
        : decimalToMinorUnits(rule.amount, accountCurrency);
      const paid = transaction?.paid === true;
      const status = paid ? 'PAID' : date.getTime() < todayKey ? 'OVERDUE' : transaction ? 'PENDING' : 'SCHEDULED';
      const summary = totals.get(accountCurrency) ?? { totalMinorUnits: 0, paidMinorUnits: 0, remainingMinorUnits: 0, estimatedMinorUnits: 0 };
      summary.totalMinorUnits += amountMinorUnits;
      if (paid) summary.paidMinorUnits += amountMinorUnits;
      else summary.remainingMinorUnits += amountMinorUnits;
      if (rule.kind === 'VARIABLE' && !paid) summary.estimatedMinorUnits += amountMinorUnits;
      totals.set(accountCurrency, summary);
      items.push({
        recurringTransactionId: schedule.id,
        date: dateKey,
        kind: rule.kind,
        amount: { minorUnits: amountMinorUnits, currency: accountCurrency },
        isEstimate: rule.kind === 'VARIABLE' && !paid,
        status,
        transactionId: transaction?.id ?? null,
        transactionVersion: transaction?.version ?? null,
        description: rule.description,
        categoryCode: rule.categoryName,
        accountId: transaction?.accountId ?? rule.accountId,
      });
      }
    }
  }
  items.sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.recurringTransactionId).localeCompare(String(b.recurringTransactionId)));
  const totalsByCurrency = [...totals.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([currencyCode, values]) => ({
    currency: currencyCode,
    ...values,
    paidPercent: values.totalMinorUnits === 0 ? 0 : Math.round((values.paidMinorUnits / values.totalMinorUnits) * 100),
  }));
  return { items, totalsByCurrency };
}

export async function payRecurringOccurrenceV1(
  recurringId: string,
  occurrenceDate: string,
  householdId: string,
  userId: string,
  input: PayRecurringOccurrenceInput,
): Promise<{ recurringTransactionId: string; date: string; transactionId: string; accountId: string; status: 'PAID'; amount: { minorUnits: number; currency: Currency }; replayed: boolean }> {
  const recurring = await prisma.recurringTransaction.findFirst({
    where: { id: recurringId, householdId },
    include: { account: { select: { currency: true } }, occurrences: { where: { occurrenceDate: new Date(`${occurrenceDate}T00:00:00.000Z`) }, include: { transaction: { include: { account: { select: { id: true, type: true, currency: true } } } } } }, scheduleVersions: true },
  });
  if (!recurring) throw new NotFoundError('Recurring transaction');
  const accountCurrency = currency(recurring.account.currency);
  if (input.amount.currency !== accountCurrency) throw new BadRequestError('Occurrence currency must match account currency');
  const paidDate = new Date(`${occurrenceDate}T00:00:00.000Z`);
  const rules = [...recurring.scheduleVersions, { ...recurring, effectiveToDate: null }];
  const rule = rules.find((item) => item.effectiveFromDate <= paidDate && (!item.effectiveToDate || item.effectiveToDate >= paidDate));
  if (!rule) throw new NotFoundError('Recurring occurrence');
  const baseMinorUnits = decimalToMinorUnits(rule.amount, accountCurrency);
  if (rule.kind === 'FIXED' && input.amount.minorUnits !== baseMinorUnits) {
    throw new BadRequestError('Fixed occurrence amount must match the recurring amount');
  }
  const incomeCategory = isCustomCategoryName(rule.categoryName)
    ? (await prisma.category.findFirst({ where: { id: toCustomCategoryId(rule.categoryName)!, householdId }, select: { type: true } }))?.type === CategoryType.INCOME
    : isCategoryOfType(CategoryType.INCOME, rule.categoryName);
  if (incomeCategory) throw new BadRequestError('Recurring payment can only record an expense');
  const today = new Date();
  const todayDate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  if (paidDate > todayDate) throw new BadRequestError('Future occurrences cannot be paid before their due date');
  const expectedDates = expandRecurrenceDates({
    startDate: rule.effectiveFromDate,
    from: paidDate,
    to: paidDate,
    frequency: rule.frequency,
    anchorDay: rule.anchorDay,
    recurrenceMode: rule.recurrenceMode,
    occurrencesLimit: rule.occurrencesLimit,
    occurrencesCountOffset: rule.occurrencesCountOffset,
    endDate: rule.endDate,
  });
  if (!expectedDates.length) throw new NotFoundError('Recurring occurrence');
  const existingTransaction = recurring.occurrences[0]?.transaction;
  if (existingTransaction?.paid) {
    if (input.accountId !== undefined && input.accountId !== existingTransaction.accountId) {
      throw new OccurrenceAccountConflictError('A paid occurrence cannot be reassigned to another account');
    }
    const currentMinorUnits = decimalToMinorUnits(existingTransaction.amount, accountCurrency);
    if (currentMinorUnits !== input.amount.minorUnits) throw new BadRequestError('Occurrence has already been paid with a different amount');
    return { recurringTransactionId: recurringId, date: occurrenceDate, transactionId: existingTransaction.id, accountId: existingTransaction.accountId!, status: 'PAID', amount: input.amount, replayed: true };
  }
  const targetAccountId = input.accountId ?? existingTransaction?.accountId ?? rule.accountId;
  const targetAccount = await prisma.account.findFirst({ where: { id: targetAccountId, householdId, isActive: true } });
  if (!targetAccount) throw new NotFoundError('Active account');
  if (currency(targetAccount.currency) !== accountCurrency) throw new BadRequestError('Occurrence account currency must match the recurring schedule');
  if (existingTransaction) {
    let updated: Awaited<ReturnType<typeof updateTransactionV1>>;
    try {
      updated = await updateTransactionV1(
        existingTransaction.id,
        householdId,
        userId,
        updateTransactionV1Schema.parse({
          clientMutationId: input.clientMutationId,
          expectedVersion: existingTransaction.version,
          ...(targetAccountId !== existingTransaction.accountId ? { accountId: targetAccountId } : {}),
          amount: input.amount,
          paid: true,
        }),
        { allowOccurrenceAccountChange: true },
      );
    } catch (error) {
      if (!(error instanceof VersionConflictError)) throw error;
      const latest = await prisma.transaction.findFirst({ where: { id: existingTransaction.id, householdId, deletedAt: null } });
      if (!latest?.paid || latest.accountId !== targetAccountId || decimalToMinorUnits(latest.amount, accountCurrency) !== input.amount.minorUnits) throw error;
      return { recurringTransactionId: recurringId, date: occurrenceDate, transactionId: latest.id, accountId: latest.accountId!, status: 'PAID', amount: input.amount, replayed: true };
    }
    return { recurringTransactionId: recurringId, date: occurrenceDate, transactionId: updated.id, accountId: updated.accountId, status: 'PAID', amount: input.amount, replayed: updated.version === existingTransaction.version };
  }
  const created = await createTransactionV1(
    createTransactionV1Schema.parse({
      clientMutationId: input.clientMutationId,
      kind: 'expense',
      amount: input.amount,
      categoryCode: rule.categoryName,
      accountId: targetAccountId,
      occurredAt: `${occurrenceDate}T00:00:00.000Z`,
      timeZone: rule.timeZone,
      paid: true,
    }),
    householdId,
    userId,
    { recurringTransactionId: recurringId, occurrenceDate: paidDate },
  );
  return { recurringTransactionId: recurringId, date: occurrenceDate, transactionId: created.id, accountId: created.accountId, status: 'PAID', amount: input.amount, replayed: false };
}
