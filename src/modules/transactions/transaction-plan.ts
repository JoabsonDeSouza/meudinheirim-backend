import { calculateNextRunDate } from '../recurring-transactions/recurrence-date.js';

export function splitTotalIntoInstallments(totalMinorUnits: number, installmentCount: number): number[] {
  if (!Number.isSafeInteger(totalMinorUnits) || totalMinorUnits <= 0) {
    throw new RangeError('Total must be a positive safe integer in minor units');
  }
  if (!Number.isInteger(installmentCount) || installmentCount < 2 || installmentCount > 6) {
    throw new RangeError('Installment count must be between 2 and 6');
  }
  if (totalMinorUnits < installmentCount) {
    throw new RangeError('Total must cover at least one minor unit per installment');
  }

  const base = Math.floor(totalMinorUnits / installmentCount);
  const remainder = totalMinorUnits % installmentCount;
  return Array.from({ length: installmentCount }, (_, index) => base + (index < remainder ? 1 : 0));
}

/** Returns the purchase date followed by monthly dates using the original day anchor. */
export function calculateMonthlyInstallmentDates(startDate: Date, installmentCount: number): Date[] {
  if (!Number.isInteger(installmentCount) || installmentCount < 2 || installmentCount > 6) {
    throw new RangeError('Installment count must be between 2 and 6');
  }
  if (!Number.isFinite(startDate.getTime())) throw new RangeError('Start date is invalid');

  const anchorDay = startDate.getUTCDate();
  const dates = [new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), anchorDay))];
  while (dates.length < installmentCount) {
    dates.push(calculateNextRunDate(dates[dates.length - 1], 'MONTHLY', anchorDay));
  }
  return dates;
}
