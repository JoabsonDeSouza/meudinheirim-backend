import { z } from 'zod';
import { Prisma } from '../../generated/prisma/client.js';

export const supportedCurrencies = ['BRL', 'USD'] as const;
export type Currency = (typeof supportedCurrencies)[number];

export interface MoneyDto {
  readonly minorUnits: number;
  readonly currency: Currency;
}

export const moneyDtoSchema = z.object({
  minorUnits: z.number().refine(Number.isSafeInteger, 'minorUnits must be a safe integer'),
  currency: z.enum(supportedCurrencies),
}).strict();

export const currencySchema = z.enum(supportedCurrencies);

export function parseMoneyDto(value: unknown): MoneyDto {
  return moneyDtoSchema.parse(value);
}

function decimalPlaces(currency: Currency): number {
  switch (currency) {
    case 'BRL':
    case 'USD':
      return 2;
  }
}

function checkedMinorUnits(value: bigint): number {
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  const min = BigInt(Number.MIN_SAFE_INTEGER);
  if (value > max || value < min) {
    throw new RangeError('Money amount exceeds the safe integer range');
  }
  return Number(value);
}

/** Convert Prisma Decimal directly to integer minor units without Number arithmetic. */
export function decimalToMinorUnits(amount: Prisma.Decimal, currency: Currency): number {
  const scale = new Prisma.Decimal(10).pow(decimalPlaces(currency));
  const scaled = amount.mul(scale);
  if (!scaled.isInteger()) {
    throw new RangeError(`Money amount has fractional minor units for ${currency}`);
  }
  return checkedMinorUnits(BigInt(scaled.toFixed(0)));
}

export function moneyFromMinorUnits(minorUnits: number, currency: Currency): MoneyDto {
  return moneyDtoSchema.parse({ minorUnits, currency });
}

export function minorUnitsToDecimal(money: MoneyDto): Prisma.Decimal {
  const valid = moneyDtoSchema.parse(money);
  const scale = new Prisma.Decimal(10).pow(decimalPlaces(valid.currency));
  return new Prisma.Decimal(valid.minorUnits.toString()).div(scale);
}

export function sumMoneyByCurrency(values: readonly MoneyDto[]): MoneyDto[] {
  const totals = new Map<Currency, bigint>();
  for (const candidate of values) {
    const money = moneyDtoSchema.parse(candidate);
    const current = totals.get(money.currency) ?? 0n;
    totals.set(money.currency, current + BigInt(money.minorUnits));
  }
  return [...totals.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, total]) => moneyFromMinorUnits(checkedMinorUnits(total), currency));
}
