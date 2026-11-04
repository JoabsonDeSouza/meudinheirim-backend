import { Prisma } from '../../generated/prisma/client.js';
import { AccountType } from '../../shared/enums/index.js';
import { decimalToMinorUnits, type Currency, type MoneyDto } from '../../shared/money/index.js';

export interface CreditLimitSummaryDto {
  readonly total: MoneyDto;
  readonly used: MoneyDto;
  readonly available: MoneyDto;
  readonly utilizationPercent: number;
}

interface CreditLimitAccount {
  readonly type: string;
  readonly currency: string;
  readonly creditLimit: Prisma.Decimal | null;
  readonly totalLimit: Prisma.Decimal | null;
  readonly availableLimit: Prisma.Decimal | null;
}

function supportedCurrency(currency: string): Currency {
  if (currency === 'BRL' || currency === 'USD') return currency;
  throw new RangeError(`Unsupported account currency: ${currency}`);
}

export function buildCreditLimitSummary(
  account: CreditLimitAccount,
  outstandingDebt = new Prisma.Decimal(0),
): CreditLimitSummaryDto | null {
  if (account.type !== AccountType.CREDIT) return null;
  const currency = supportedCurrency(account.currency);
  const zero = new Prisma.Decimal(0);
  const total = account.totalLimit ?? account.creditLimit ?? zero;
  const used = Prisma.Decimal.max(zero, Prisma.Decimal.min(total, outstandingDebt));
  const available = total.sub(used);
  const utilizationPercent = total.greaterThan(zero)
    ? used.mul(100).div(total).toDecimalPlaces(1).toNumber()
    : 0;
  return {
    total: { minorUnits: decimalToMinorUnits(total, currency), currency },
    used: { minorUnits: decimalToMinorUnits(used, currency), currency },
    available: { minorUnits: decimalToMinorUnits(available, currency), currency },
    utilizationPercent,
  };
}
