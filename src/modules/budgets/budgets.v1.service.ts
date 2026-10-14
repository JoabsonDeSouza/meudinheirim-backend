import { Prisma } from '../../generated/prisma/client.js';
import type { CategoryType as PrismaCategoryType } from '../../generated/prisma/enums.js';
import type { CategoryType } from '../../shared/enums/index.js';
import { BadRequestError, ConflictError, NotFoundError } from '../../shared/errors/index.js';
import { decimalToMinorUnits, minorUnitsToDecimal, type Currency, type MoneyDto } from '../../shared/money/index.js';
import { getCategoriesByType } from '../../shared/enums/index.js';
import { isCustomCategoryName, toCustomCategoryId, toCustomCategoryName } from '../../shared/utils/categoryHelpers.js';
import { prisma } from '../../shared/db/prisma.js';
import type { CreateBudgetV1Input, ListBudgetsV1Query } from './budgets.v1.schema.js';

export interface BudgetV1Dto {
  readonly id: string;
  readonly categoryCode: string;
  readonly type: PrismaCategoryType;
  readonly month: string;
  readonly currency: Currency;
  readonly monthlyLimit: MoneyDto;
  readonly spent: MoneyDto;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function requireCurrency(value: string): Currency {
  if (value !== 'BRL' && value !== 'USD') throw new BadRequestError('Currency is not supported');
  return value;
}

async function validateBudgetCategory(
  householdId: string,
  categoryCode: string,
  type: CategoryType,
): Promise<string> {
  if (categoryCode === 'GENERAL') return categoryCode;
  if (isCustomCategoryName(categoryCode)) {
    const id = toCustomCategoryId(categoryCode);
    if (!id) throw new BadRequestError('Custom category code is invalid');
    const custom = await prisma.category.findFirst({ where: { id, householdId, type } });
    if (!custom) throw new NotFoundError('Category');
    return toCustomCategoryName(custom.id);
  }
  if (!getCategoriesByType(type).some((candidate) => candidate === categoryCode)) {
    throw new BadRequestError('Category code does not match budget type');
  }
  return categoryCode;
}

export async function createBudgetV1(input: CreateBudgetV1Input, householdId: string): Promise<BudgetV1Dto> {
  const categoryCode = await validateBudgetCategory(householdId, input.categoryCode, input.type);
  const month = new Date(`${input.month}-01T00:00:00.000Z`);
  const currency = requireCurrency(input.monthlyLimit.currency);
  try {
    const budget = await prisma.budget.create({
      data: {
        householdId,
        categoryName: categoryCode,
        type: input.type as PrismaCategoryType,
        month,
        currency,
        monthlyLimit: minorUnitsToDecimal(input.monthlyLimit),
      },
    });
    return {
      id: budget.id,
      categoryCode: budget.categoryName,
      type: budget.type,
      month: input.month,
      currency,
      monthlyLimit: input.monthlyLimit,
      spent: { minorUnits: 0, currency },
      createdAt: budget.createdAt.toISOString(),
      updatedAt: budget.updatedAt.toISOString(),
    };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new ConflictError('Budget already exists for this category, month and currency');
    }
    throw error;
  }
}

export async function listBudgetsV1(query: ListBudgetsV1Query, householdId: string): Promise<BudgetV1Dto[]> {
  const [yearText, monthText] = query.month.split('-');
  const year = Number(yearText);
  const monthNumber = Number(monthText);
  const start = new Date(Date.UTC(year, monthNumber - 1, 1));
  const endExclusive = new Date(Date.UTC(year, monthNumber, 1));
  const budgets = await prisma.budget.findMany({
    where: {
      householdId,
      month: start,
      ...(query.type ? { type: query.type as PrismaCategoryType } : {}),
      ...(query.currency ? { currency: query.currency } : {}),
    },
    orderBy: [{ currency: 'asc' }, { type: 'asc' }, { categoryName: 'asc' }],
  });

  return Promise.all(budgets.map(async (budget): Promise<BudgetV1Dto> => {
    const currency = requireCurrency(budget.currency);
    const transactions = await prisma.transaction.findMany({
      where: {
        householdId,
        type: budget.type,
        date: { gte: start, lt: endExclusive },
        ...(budget.categoryName === 'GENERAL' ? {} : { categoryName: budget.categoryName }),
        account: { is: { currency } },
        deletedAt: null,
      },
      select: { amount: true },
    });
    const spent = transactions.reduce(
      (sum, transaction) => sum.add(transaction.amount.abs()),
      new Prisma.Decimal(0),
    );
    return {
      id: budget.id,
      categoryCode: budget.categoryName,
      type: budget.type,
      month: query.month,
      currency,
      monthlyLimit: { minorUnits: decimalToMinorUnits(budget.monthlyLimit, currency), currency },
      spent: { minorUnits: decimalToMinorUnits(spent, currency), currency },
      createdAt: budget.createdAt.toISOString(),
      updatedAt: budget.updatedAt.toISOString(),
    };
  }));
}
