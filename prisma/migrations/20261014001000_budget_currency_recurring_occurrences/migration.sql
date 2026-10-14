ALTER TABLE "budgets"
  ADD COLUMN "currency" VARCHAR(3) NOT NULL DEFAULT 'BRL';

ALTER TABLE "budgets"
  DROP CONSTRAINT IF EXISTS "budgets_household_id_category_name_month_key";

DROP INDEX IF EXISTS "budgets_household_id_category_name_month_key";

ALTER TABLE "budgets"
  ADD CONSTRAINT "budgets_household_id_category_name_month_currency_key"
  UNIQUE ("household_id", "category_name", "month", "currency");

ALTER TABLE "budgets"
  ADD CONSTRAINT "budgets_currency_supported_check"
  CHECK ("currency" IN ('BRL', 'USD')) NOT VALID;

ALTER TABLE "recurring_transactions"
  ADD COLUMN "time_zone" VARCHAR(64) NOT NULL DEFAULT 'UTC';

CREATE TABLE "recurring_occurrences" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "recurring_transaction_id" UUID NOT NULL,
  "occurrence_date" DATE NOT NULL,
  "transaction_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "recurring_occurrences_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "recurring_occurrences_transaction_id_key" UNIQUE ("transaction_id"),
  CONSTRAINT "recurring_occurrences_recurring_transaction_id_fkey"
    FOREIGN KEY ("recurring_transaction_id") REFERENCES "recurring_transactions"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "recurring_occurrences_transaction_id_fkey"
    FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "recurring_occurrences_recurring_date_key" UNIQUE ("recurring_transaction_id", "occurrence_date")
);

CREATE INDEX "recurring_occurrences_occurrence_date_idx" ON "recurring_occurrences"("occurrence_date");

-- Backfill one identity marker per existing recurring occurrence. Duplicate legacy
-- transactions remain untouched; future retries will use the unique marker.
INSERT INTO "recurring_occurrences" ("recurring_transaction_id", "occurrence_date", "transaction_id")
SELECT DISTINCT ON ("recurring_transaction_id", "date")
  "recurring_transaction_id", "date", "id"
FROM "transactions"
WHERE "recurring_transaction_id" IS NOT NULL
ORDER BY "recurring_transaction_id", "date", "created_at", "id";
