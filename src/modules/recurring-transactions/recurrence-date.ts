export type RecurrenceFrequencyCode = 'DAILY' | 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY' | 'YEARLY';

/** Computes the next civil date in UTC so process timezone/DST cannot shift it. */
export function calculateNextRunDate(
  currentDate: Date,
  frequency: RecurrenceFrequencyCode,
  anchorDay = currentDate.getUTCDate(),
): Date {
  const year = currentDate.getUTCFullYear();
  const month = currentDate.getUTCMonth();
  const day = currentDate.getUTCDate();

  switch (frequency) {
    case 'DAILY':
      return new Date(Date.UTC(year, month, day + 1));
    case 'WEEKLY':
      return new Date(Date.UTC(year, month, day + 7));
    case 'BIWEEKLY':
      return new Date(Date.UTC(year, month, day + 14));
    case 'MONTHLY': {
      const targetMonth = month + 1;
      const lastDay = new Date(Date.UTC(year, targetMonth + 1, 0)).getUTCDate();
      return new Date(Date.UTC(year, targetMonth, Math.min(anchorDay, lastDay)));
    }
    case 'YEARLY': {
      const targetYear = year + 1;
      const lastDay = new Date(Date.UTC(targetYear, month + 1, 0)).getUTCDate();
      return new Date(Date.UTC(targetYear, month, Math.min(anchorDay, lastDay)));
    }
  }
}

export function expandRecurrenceDates(input: {
  startDate: Date;
  from: Date;
  to: Date;
  frequency: RecurrenceFrequencyCode;
  anchorDay: number;
  recurrenceMode: 'ONCE' | 'LIMITED' | 'ALWAYS';
  occurrencesLimit: number | null;
  occurrencesCountOffset?: number;
  endDate: Date | null;
}): Date[] {
  const dates: Date[] = [];
  let occurrenceDate = new Date(Date.UTC(input.startDate.getUTCFullYear(), input.startDate.getUTCMonth(), input.startDate.getUTCDate()));
  const from = Date.UTC(input.from.getUTCFullYear(), input.from.getUTCMonth(), input.from.getUTCDate());
  const to = Date.UTC(input.to.getUTCFullYear(), input.to.getUTCMonth(), input.to.getUTCDate());
  const end = input.endDate ? Date.UTC(input.endDate.getUTCFullYear(), input.endDate.getUTCMonth(), input.endDate.getUTCDate()) : Number.POSITIVE_INFINITY;
  let index = input.occurrencesCountOffset ?? 0;

  while (occurrenceDate.getTime() <= to && occurrenceDate.getTime() <= end) {
    if (input.occurrencesLimit !== null && index >= input.occurrencesLimit) break;
    if (input.recurrenceMode === 'ONCE' && index > 0) break;
    if (occurrenceDate.getTime() >= from) dates.push(occurrenceDate);
    index += 1;
    if (index > 20_000) throw new RangeError('Recurrence expansion exceeds the supported horizon');
    occurrenceDate = calculateNextRunDate(occurrenceDate, input.frequency, input.anchorDay);
  }
  return dates;
}
