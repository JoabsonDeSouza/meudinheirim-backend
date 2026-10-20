ALTER TABLE "transactions"
  ADD COLUMN "occurred_at" TIMESTAMPTZ(3),
  ADD COLUMN "deleted_at" TIMESTAMPTZ(3),
  ADD COLUMN "time_zone" VARCHAR(64) NOT NULL DEFAULT 'UTC';

UPDATE "transactions"
SET "occurred_at" = ("date"::timestamp AT TIME ZONE 'UTC')
WHERE "occurred_at" IS NULL;

ALTER TABLE "transactions"
  ALTER COLUMN "occurred_at" SET NOT NULL;

ALTER TABLE "transactions"
  ALTER COLUMN "occurred_at" SET DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX "transactions_household_occurred_at_id_idx"
  ON "transactions"("household_id", "occurred_at" DESC, "id" DESC);
