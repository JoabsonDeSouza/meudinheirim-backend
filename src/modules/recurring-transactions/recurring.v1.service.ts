import { BadRequestError, NotFoundError } from '../../shared/errors/index.js';
import { CategoryType, getCategoriesByType } from '../../shared/enums/index.js';
import { decimalToMinorUnits, minorUnitsToDecimal, type Currency } from '../../shared/money/index.js';
import { isCustomCategoryName, toCustomCategoryId, toCustomCategoryName } from '../../shared/utils/categoryHelpers.js';
import { prisma } from '../../shared/db/prisma.js';
import { recurringV1DtoSchema, type CreateRecurringV1Input, type RecurringV1Dto } from './recurring.v1.schema.js';

function currency(value: string): Currency {
  if (value !== 'BRL' && value !== 'USD') throw new BadRequestError('Account currency is not supported');
  return value;
}

function toCivilDate(value: Date | null): string | null {
  return value?.toISOString().slice(0, 10) ?? null;
}

export async function createRecurringV1(input: CreateRecurringV1Input, householdId: string): Promise<RecurringV1Dto> {
  const account = await prisma.account.findFirst({
    where: { id: input.accountId, householdId, isActive: true },
    select: { id: true, currency: true },
  });
  if (!account) throw new NotFoundError('Account');
  const accountCurrency = currency(account.currency);
  if (accountCurrency !== input.amount.currency) throw new BadRequestError('Recurring currency must match account currency');

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

  const row = await prisma.recurringTransaction.create({
    data: {
      householdId,
      accountId: account.id,
      categoryName: categoryCode,
      amount: minorUnitsToDecimal(input.amount),
      description: input.description,
      frequency: input.frequency,
      startDate: new Date(`${input.startDate}T00:00:00.000Z`),
      endDate: input.endDate ? new Date(`${input.endDate}T00:00:00.000Z`) : null,
      nextRunAt: new Date(`${(input.nextRunAt ?? input.startDate)}T00:00:00.000Z`),
      timeZone: input.timeZone,
    },
  });

  return recurringV1DtoSchema.parse({
    id: row.id,
    accountId: row.accountId,
    categoryCode: row.categoryName,
    amount: { minorUnits: decimalToMinorUnits(row.amount, accountCurrency), currency: accountCurrency },
    description: row.description,
    frequency: row.frequency,
    startDate: toCivilDate(row.startDate),
    endDate: toCivilDate(row.endDate),
    nextRunAt: toCivilDate(row.nextRunAt),
    lastRunDate: toCivilDate(row.lastRunDate),
    timeZone: row.timeZone,
    isActive: row.isActive,
  });
}

export async function listRecurringV1(householdId: string): Promise<RecurringV1Dto[]> {
  const rows = await prisma.recurringTransaction.findMany({
    where: { householdId },
    include: { account: { select: { currency: true } } },
    orderBy: [{ isActive: 'desc' }, { nextRunAt: 'asc' }, { id: 'asc' }],
  });
  return rows.map((row) => {
    const accountCurrency = currency(row.account.currency);
    return recurringV1DtoSchema.parse({
      id: row.id,
      accountId: row.accountId,
      categoryCode: row.categoryName,
      amount: { minorUnits: decimalToMinorUnits(row.amount, accountCurrency), currency: accountCurrency },
      description: row.description,
      frequency: row.frequency,
      startDate: toCivilDate(row.startDate),
      endDate: toCivilDate(row.endDate),
      nextRunAt: toCivilDate(row.nextRunAt),
      lastRunDate: toCivilDate(row.lastRunDate),
      timeZone: row.timeZone,
      isActive: row.isActive,
    });
  });
}
