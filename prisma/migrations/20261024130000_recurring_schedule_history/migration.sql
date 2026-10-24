ALTER TABLE "recurring_transactions"
  ADD COLUMN "effective_from_date" DATE NOT NULL DEFAULT CURRENT_DATE,
  ADD COLUMN "occurrences_count_offset" INTEGER NOT NULL DEFAULT 0;

UPDATE "recurring_transactions"
SET "effective_from_date" = "start_date";

CREATE TABLE "recurring_schedule_versions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "recurring_transaction_id" UUID NOT NULL,
  "effective_from_date" DATE NOT NULL,
  "effective_to_date" DATE NOT NULL,
  "start_date" DATE NOT NULL,
  "end_date" DATE,
  "account_id" UUID NOT NULL,
  "category_name" VARCHAR(50) NOT NULL,
  "amount" DECIMAL(15,2) NOT NULL,
  "description" TEXT,
  "frequency" "RecurrenceFrequency" NOT NULL,
  "kind" "RecurringKind" NOT NULL,
  "recurrence_mode" "RecurrenceMode" NOT NULL,
  "occurrences_limit" INTEGER,
  "occurrences_count_offset" INTEGER NOT NULL,
  "anchor_day" INTEGER NOT NULL,
  "time_zone" VARCHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "recurring_schedule_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "recurring_schedule_versions_date_order" CHECK ("effective_to_date" >= "effective_from_date"),
  CONSTRAINT "recurring_schedule_versions_limit_positive" CHECK ("occurrences_limit" IS NULL OR "occurrences_limit" > 0),
  CONSTRAINT "recurring_schedule_versions_anchor_day_range" CHECK ("anchor_day" BETWEEN 1 AND 31),
  CONSTRAINT "recurring_schedule_versions_recurring_transaction_id_fkey"
    FOREIGN KEY ("recurring_transaction_id") REFERENCES "recurring_transactions"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "recurring_schedule_versions_recurring_from_key"
  ON "recurring_schedule_versions"("recurring_transaction_id", "effective_from_date");
CREATE INDEX "recurring_schedule_versions_recurring_period_idx"
  ON "recurring_schedule_versions"("recurring_transaction_id", "effective_from_date", "effective_to_date");
