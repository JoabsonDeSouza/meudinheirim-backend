CREATE TABLE "recurring_occurrence_exclusions" (
  "recurring_transaction_id" UUID NOT NULL,
  "occurrence_date" DATE NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "recurring_occurrence_exclusions_pkey" PRIMARY KEY ("recurring_transaction_id", "occurrence_date"),
  CONSTRAINT "recurring_occurrence_exclusions_recurring_transaction_id_fkey" FOREIGN KEY ("recurring_transaction_id") REFERENCES "recurring_transactions"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
