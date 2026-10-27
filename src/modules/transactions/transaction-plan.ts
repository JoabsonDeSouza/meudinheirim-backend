import { calculateNextRunDate } from '../recurring-transactions/recurrence-date.js';

function zonedDateTimeParts(instant: Date, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((item) => item.type === type)?.value;
    if (part === undefined) throw new RangeError(`Could not resolve ${type} in ${timeZone}`);
    return Number(part);
  };
  return { year: value('year'), month: value('month'), day: value('day'), hour: value('hour'), minute: value('minute'), second: value('second') };
}

/** Keeps the original local wall-clock time while moving to another civil date. */
export function instantAtCivilDateLike(
  civilDate: Date,
  referenceInstant: Date,
  timeZone: string,
): Date {
  if (!Number.isFinite(civilDate.getTime()) || !Number.isFinite(referenceInstant.getTime())) {
    throw new RangeError('Civil date and reference instant must be valid');
  }
  const target = {
    year: civilDate.getUTCFullYear(),
    month: civilDate.getUTCMonth() + 1,
    day: civilDate.getUTCDate(),
    ...((parts) => ({ hour: parts.hour, minute: parts.minute, second: parts.second }))(zonedDateTimeParts(referenceInstant, timeZone)),
    millisecond: referenceInstant.getUTCMilliseconds(),
  };
  const targetAsUtc = Date.UTC(target.year, target.month - 1, target.day, target.hour, target.minute, target.second, target.millisecond);
  let candidate = targetAsUtc;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = zonedDateTimeParts(new Date(candidate), timeZone);
    const actualAsUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second, target.millisecond);
    const adjustment = targetAsUtc - actualAsUtc;
    if (adjustment === 0) return new Date(candidate);
    candidate += adjustment;
  }

  const resolved = new Date(candidate);
  const actual = zonedDateTimeParts(resolved, timeZone);
  if (actual.year !== target.year || actual.month !== target.month || actual.day !== target.day) {
    throw new RangeError(`Could not resolve ${target.year}-${target.month}-${target.day} in ${timeZone}`);
  }
  return resolved;
}

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
