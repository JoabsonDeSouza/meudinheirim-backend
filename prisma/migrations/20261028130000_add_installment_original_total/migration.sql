ALTER TABLE "transactions"
ADD COLUMN "installment_total_amount" DECIMAL(15,2);

WITH installment_totals AS (
  SELECT "installment_id", SUM("amount") AS total_amount
  FROM "transactions"
  WHERE "installment_id" IS NOT NULL
  GROUP BY "installment_id"
)
UPDATE "transactions" AS t
SET "installment_total_amount" = installment_totals.total_amount
FROM installment_totals
WHERE t."installment_id" = installment_totals."installment_id";
