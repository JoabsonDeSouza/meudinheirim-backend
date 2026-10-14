export type RecurrenceFrequencyCode = 'DAILY' | 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY' | 'YEARLY';

/** Computes the next civil date in UTC so process timezone/DST cannot shift it. */
export function calculateNextRunDate(currentDate: Date, frequency: RecurrenceFrequencyCode): Date {
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
      return new Date(Date.UTC(year, targetMonth, Math.min(day, lastDay)));
    }
    case 'YEARLY': {
      const targetYear = year + 1;
      const lastDay = new Date(Date.UTC(targetYear, month + 1, 0)).getUTCDate();
      return new Date(Date.UTC(targetYear, month, Math.min(day, lastDay)));
    }
  }
}
