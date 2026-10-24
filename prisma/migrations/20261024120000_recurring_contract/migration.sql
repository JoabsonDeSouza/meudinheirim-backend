CREATE TYPE "RecurringKind" AS ENUM ('FIXED', 'VARIABLE');
CREATE TYPE "RecurrenceMode" AS ENUM ('ONCE', 'LIMITED', 'ALWAYS');

ALTER TABLE "recurring_transactions"
  ADD COLUMN "kind" "RecurringKind" NOT NULL DEFAULT 'FIXED',
  ADD COLUMN "recurrence_mode" "RecurrenceMode" NOT NULL DEFAULT 'ALWAYS',
  ADD COLUMN "occurrences_limit" INTEGER,
  ADD COLUMN "anchor_day" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "cancelled_at" DATE;

UPDATE "recurring_transactions"
SET "anchor_day" = EXTRACT(DAY FROM "start_date")::INTEGER,
    "recurrence_mode" = CASE WHEN "end_date" IS NULL THEN 'ALWAYS'::"RecurrenceMode" ELSE 'LIMITED'::"RecurrenceMode" END;

ALTER TABLE "recurring_transactions"
  ADD CONSTRAINT "recurring_transactions_occurrences_limit_positive"
    CHECK ("occurrences_limit" IS NULL OR "occurrences_limit" > 0) NOT VALID,
  ADD CONSTRAINT "recurring_transactions_anchor_day_range"
    CHECK ("anchor_day" BETWEEN 1 AND 31) NOT VALID,
  ADD CONSTRAINT "recurring_transactions_mode_limit_consistent"
    CHECK (("recurrence_mode" = 'LIMITED' AND ("occurrences_limit" IS NOT NULL OR "end_date" IS NOT NULL))
        OR ("recurrence_mode" = 'ONCE' AND "occurrences_limit" = 1)
        OR ("recurrence_mode" = 'ALWAYS' AND "occurrences_limit" IS NULL AND "end_date" IS NULL)) NOT VALID;
