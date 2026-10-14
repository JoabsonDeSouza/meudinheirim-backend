export interface BillingCycle {
  /** Inclusive civil date at the beginning of the cycle. */
  readonly periodStart: string;
  /** Exclusive civil date at the close boundary. */
  readonly periodEnd: string;
  readonly dueDate: string;
}

interface CivilDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

function monthLength(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function clampDay(year: number, month: number, day: number): number {
  return Math.min(day, monthLength(year, month));
}

function formatDate(date: CivilDate): string {
  return `${date.year.toString().padStart(4, '0')}-${date.month.toString().padStart(2, '0')}-${date.day.toString().padStart(2, '0')}`;
}

function previousMonth(year: number, month: number): { year: number; month: number } {
  return month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
}

function nextMonth(year: number, month: number): { year: number; month: number } {
  return month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
}

export function civilDateAtInstant(instant: string, timeZone: string): CivilDate {
  const date = new Date(instant);
  if (!Number.isFinite(date.getTime())) throw new RangeError('Invoice occurrence instant is invalid');
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
  } catch {
    throw new RangeError('Invoice time zone must be a valid IANA time zone');
  }
  const value = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((item) => item.type === type)?.value;
    if (part === undefined) throw new RangeError('Could not resolve local invoice date');
    return Number(part);
  };
  return { year: value('year'), month: value('month'), day: value('day') };
}

export function civilDateStringAtInstant(instant: string, timeZone: string): string {
  return formatDate(civilDateAtInstant(instant, timeZone));
}

function monthBoundary(year: number, month: number, closingDay: number): CivilDate {
  return { year, month, day: clampDay(year, month, closingDay) };
}

/** Calculates an invoice cycle from the cardholder's local civil date. */
export function calculateBillingCycle(
  occurredAt: string,
  closingDay: number | null,
  dueDay: number | null,
  timeZone: string,
): BillingCycle {
  if (closingDay !== null && (!Number.isInteger(closingDay) || closingDay < 1 || closingDay > 31)) {
    throw new RangeError('Invoice closing day must be between 1 and 31');
  }
  if (dueDay !== null && (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31)) {
    throw new RangeError('Invoice due day must be between 1 and 31');
  }

  const local = civilDateAtInstant(occurredAt, timeZone);
  let periodStart: CivilDate;
  let periodEnd: CivilDate;

  if (closingDay === null) {
    periodStart = { year: local.year, month: local.month, day: 1 };
    const monthAfter = nextMonth(local.year, local.month);
    periodEnd = { year: monthAfter.year, month: monthAfter.month, day: 1 };
  } else {
    const thisMonthClose = monthBoundary(local.year, local.month, closingDay);
    if (formatDate(local) < formatDate(thisMonthClose)) {
      const previous = previousMonth(local.year, local.month);
      periodStart = monthBoundary(previous.year, previous.month, closingDay);
      periodEnd = thisMonthClose;
    } else {
      periodStart = thisMonthClose;
      const next = nextMonth(local.year, local.month);
      periodEnd = monthBoundary(next.year, next.month, closingDay);
    }
  }

  const due = dueDay ?? closingDay ?? periodEnd.day;
  const candidate = monthBoundary(periodEnd.year, periodEnd.month, due);
  const dueDate = formatDate(candidate) > formatDate(periodEnd)
    ? candidate
    : monthBoundary(nextMonth(periodEnd.year, periodEnd.month).year, nextMonth(periodEnd.year, periodEnd.month).month, due);

  return {
    periodStart: formatDate(periodStart),
    periodEnd: formatDate(periodEnd),
    dueDate: formatDate(dueDate),
  };
}

export function invoicePeriodForLegacyMonth(
  year: number,
  monthIndex: number,
  closingDay: number | null,
  dueDay: number | null,
): BillingCycle {
  if (!Number.isInteger(year) || !Number.isInteger(monthIndex) || monthIndex < 0 || monthIndex > 11) {
    throw new RangeError('Legacy invoice month is invalid');
  }
  const month = monthIndex + 1;
  if (closingDay === null) {
    const next = nextMonth(year, month);
    const due = dueDay ?? 1;
    return {
      periodStart: formatDate({ year, month, day: 1 }),
      periodEnd: formatDate({ year: next.year, month: next.month, day: 1 }),
      dueDate: formatDate(monthBoundary(next.year, next.month, due)),
    };
  }

  const periodEnd = monthBoundary(year, month, closingDay);
  const previous = previousMonth(year, month);
  const periodStart = monthBoundary(previous.year, previous.month, closingDay);
  const due = dueDay ?? closingDay;
  const dueCandidate = monthBoundary(year, month, due);
  const dueDate = formatDate(dueCandidate) > formatDate(periodEnd)
    ? dueCandidate
    : monthBoundary(nextMonth(year, month).year, nextMonth(year, month).month, due);
  return {
    periodStart: formatDate(periodStart),
    periodEnd: formatDate(periodEnd),
    dueDate: formatDate(dueDate),
  };
}
