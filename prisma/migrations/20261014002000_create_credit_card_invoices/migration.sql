DO $$
BEGIN
  CREATE TYPE "InvoiceStatus" AS ENUM ('OPEN', 'CLOSED', 'PAID');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "transactions" ADD COLUMN "invoice_id" UUID;

CREATE TABLE "credit_card_invoices" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "household_id" UUID NOT NULL,
  "card_account_id" UUID NOT NULL,
  "period_start" DATE NOT NULL,
  "period_end" DATE NOT NULL,
  "due_date" DATE NOT NULL,
  "status" "InvoiceStatus" NOT NULL DEFAULT 'OPEN',
  "currency" VARCHAR(3) NOT NULL,
  "total_amount" DECIMAL(15,2) NOT NULL DEFAULT 0,
  "closed_at" TIMESTAMPTZ(3),
  "paid_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "credit_card_invoices_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "credit_card_invoices_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "households"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "credit_card_invoices_card_account_id_fkey" FOREIGN KEY ("card_account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "credit_card_invoices_card_period_start_key" UNIQUE ("card_account_id", "period_start"),
  CONSTRAINT "credit_card_invoices_currency_supported_check" CHECK ("currency" IN ('BRL', 'USD'))
);

CREATE INDEX "credit_card_invoices_household_period_idx" ON "credit_card_invoices"("household_id", "period_start");
CREATE INDEX "credit_card_invoices_card_period_end_idx" ON "credit_card_invoices"("card_account_id", "period_end");

CREATE TABLE "invoice_payments" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "invoice_id" UUID NOT NULL,
  "transaction_id" UUID NOT NULL,
  "amount" DECIMAL(15,2) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "invoice_payments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "invoice_payments_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "credit_card_invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "invoice_payments_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "invoice_payments_transaction_id_key" UNIQUE ("transaction_id")
);
CREATE INDEX "invoice_payments_invoice_idx" ON "invoice_payments"("invoice_id");

CREATE TABLE "invoice_migration_issues" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "transaction_id" UUID NOT NULL,
  "reason" VARCHAR(64) NOT NULL,
  "legacy_value" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "invoice_migration_issues_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "invoice_migration_issues_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "invoice_migration_issues_transaction_id_key" UNIQUE ("transaction_id")
);

CREATE INDEX "transactions_invoice_id_idx" ON "transactions"("invoice_id");
ALTER TABLE "transactions"
  ADD CONSTRAINT "transactions_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "credit_card_invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TEMP TABLE "_invoice_charge_cycles" AS
WITH source AS (
  SELECT
    t."id" AS transaction_id,
    t."household_id",
    a."id" AS card_account_id,
    t."date" AS occurred_on,
    t."type"::text AS transaction_type,
    t."amount",
    a."currency",
    a."closing_day",
    a."due_day",
    date_trunc('month', t."date"::timestamp)::date AS month_start,
    (date_trunc('month', t."date"::timestamp) + interval '1 month')::date AS next_month_start,
    ((date_trunc('month', t."date"::timestamp) + interval '1 month - 1 day')::date - date_trunc('month', t."date"::timestamp)::date + 1) AS month_days
  FROM "transactions" t
  JOIN "accounts" a ON a."id" = t."account_id"
  WHERE a."type" = 'CREDIT'
    AND t."type" IN ('EXPENSE', 'INCOME')
    AND (t."attachment_url" IS NULL OR t."attachment_url" NOT LIKE 'invoice_pay:%')
), close_dates AS (
  SELECT
    source.*,
    CASE WHEN closing_day IS NULL THEN next_month_start
      ELSE make_date(EXTRACT(YEAR FROM month_start)::int, EXTRACT(MONTH FROM month_start)::int, LEAST(closing_day, month_days::int))
    END AS close_this,
    CASE WHEN closing_day IS NULL THEN next_month_start
      ELSE make_date(
        EXTRACT(YEAR FROM next_month_start)::int,
        EXTRACT(MONTH FROM next_month_start)::int,
        LEAST(closing_day, (date_trunc('month', next_month_start::timestamp) + interval '1 month - 1 day')::date - next_month_start + 1)
      )
    END AS close_next,
    CASE WHEN closing_day IS NULL THEN month_start
      ELSE make_date(
        EXTRACT(YEAR FROM (month_start - interval '1 month'))::int,
        EXTRACT(MONTH FROM (month_start - interval '1 month'))::int,
        LEAST(closing_day, (date_trunc('month', (month_start - interval '1 month')::timestamp) + interval '1 month - 1 day')::date - (month_start - interval '1 month')::date + 1)
      )
    END AS close_previous
  FROM source
), cycles AS (
  SELECT
    close_dates.*,
    CASE WHEN closing_day IS NULL THEN month_start
      WHEN occurred_on < close_this THEN close_previous
      ELSE close_this
    END AS period_start,
    CASE WHEN closing_day IS NULL THEN next_month_start
      WHEN occurred_on < close_this THEN close_this
      ELSE close_next
    END AS period_end
  FROM close_dates
), with_due AS (
  SELECT
    cycles.*,
    COALESCE(due_day, closing_day, 1) AS effective_due_day,
    date_trunc('month', period_end::timestamp)::date AS due_month_start
  FROM cycles
)
SELECT
  transaction_id,
  household_id,
  card_account_id,
  period_start,
  period_end,
  currency,
  CASE WHEN make_date(
      EXTRACT(YEAR FROM due_month_start)::int,
      EXTRACT(MONTH FROM due_month_start)::int,
      LEAST(effective_due_day, (date_trunc('month', due_month_start::timestamp) + interval '1 month - 1 day')::date - due_month_start + 1)
    ) > period_end
    THEN make_date(
      EXTRACT(YEAR FROM due_month_start)::int,
      EXTRACT(MONTH FROM due_month_start)::int,
      LEAST(effective_due_day, (date_trunc('month', due_month_start::timestamp) + interval '1 month - 1 day')::date - due_month_start + 1)
    )
    ELSE make_date(
      EXTRACT(YEAR FROM due_month_start + interval '1 month')::int,
      EXTRACT(MONTH FROM due_month_start + interval '1 month')::int,
      LEAST(effective_due_day, (date_trunc('month', (due_month_start + interval '1 month')::timestamp) + interval '1 month - 1 day')::date - (due_month_start + interval '1 month')::date + 1)
    )
  END AS due_date,
  transaction_type,
  amount
FROM with_due;

INSERT INTO "credit_card_invoices" (
  "household_id", "card_account_id", "period_start", "period_end", "due_date", "status", "currency", "total_amount"
)
SELECT
  household_id,
  card_account_id,
  period_start,
  period_end,
  due_date,
  CASE WHEN period_end < CURRENT_DATE THEN 'CLOSED'::"InvoiceStatus" ELSE 'OPEN'::"InvoiceStatus" END,
  currency,
  GREATEST(SUM(CASE WHEN transaction_type = 'EXPENSE' THEN amount ELSE -amount END), 0)
FROM "_invoice_charge_cycles"
GROUP BY household_id, card_account_id, period_start, period_end, due_date, currency;

UPDATE "transactions" t
SET "invoice_id" = i."id"
FROM "_invoice_charge_cycles" c
JOIN "credit_card_invoices" i
  ON i."household_id" = c."household_id"
 AND i."card_account_id" = c."card_account_id"
 AND i."period_start" = c."period_start"
WHERE t."id" = c."transaction_id";

CREATE TEMP TABLE "_legacy_invoice_payments" AS
WITH parsed AS (
  SELECT
    t."id" AS transaction_id,
    t."household_id",
    t."amount",
    t."created_at",
    (regexp_match(t."attachment_url", '^invoice_pay:([0-9a-fA-F-]{36}):([0-9]{4})-(0|[1-9]|1[01])$')) AS marker
  FROM "transactions" t
  WHERE t."attachment_url" LIKE 'invoice_pay:%'
), decoded AS (
  SELECT
    parsed.*,
    marker[1]::uuid AS card_account_id,
    marker[2]::int AS year,
    marker[3]::int + 1 AS month
  FROM parsed
  WHERE marker IS NOT NULL
), card_period AS (
  SELECT
    decoded.*,
    a."currency",
    a."closing_day",
    a."due_day",
    make_date(year, month, 1) AS month_start,
    (make_date(year, month, 1) + interval '1 month')::date AS next_month_start,
    (date_trunc('month', make_date(year, month, 1)::timestamp) + interval '1 month - 1 day')::date - make_date(year, month, 1) + 1 AS month_days
  FROM decoded
  JOIN "accounts" a ON a."id" = decoded.card_account_id AND a."household_id" = decoded."household_id" AND a."type" = 'CREDIT'
), cycles AS (
  SELECT
    card_period.*,
    CASE WHEN closing_day IS NULL THEN month_start
      ELSE make_date(
        EXTRACT(YEAR FROM (month_start - interval '1 month'))::int,
        EXTRACT(MONTH FROM (month_start - interval '1 month'))::int,
        LEAST(closing_day, (date_trunc('month', (month_start - interval '1 month')::timestamp) + interval '1 month - 1 day')::date - (month_start - interval '1 month')::date + 1)
      )
    END AS period_start,
    CASE WHEN closing_day IS NULL THEN next_month_start
      ELSE make_date(year, month, LEAST(closing_day, month_days::int))
    END AS period_end
  FROM card_period
), with_due AS (
  SELECT cycles.*, COALESCE(due_day, closing_day, 1) AS effective_due_day,
    date_trunc('month', period_end::timestamp)::date AS due_month_start
  FROM cycles
), legacy_cycles AS (
  SELECT
    with_due.*,
    CASE WHEN make_date(EXTRACT(YEAR FROM due_month_start)::int, EXTRACT(MONTH FROM due_month_start)::int,
        LEAST(effective_due_day, (date_trunc('month', due_month_start::timestamp) + interval '1 month - 1 day')::date - due_month_start + 1)) > period_end
      THEN make_date(EXTRACT(YEAR FROM due_month_start)::int, EXTRACT(MONTH FROM due_month_start)::int,
        LEAST(effective_due_day, (date_trunc('month', due_month_start::timestamp) + interval '1 month - 1 day')::date - due_month_start + 1))
      ELSE make_date(EXTRACT(YEAR FROM due_month_start + interval '1 month')::int, EXTRACT(MONTH FROM due_month_start + interval '1 month')::int,
        LEAST(effective_due_day, (date_trunc('month', (due_month_start + interval '1 month')::timestamp) + interval '1 month - 1 day')::date - (due_month_start + interval '1 month')::date + 1))
    END AS due_date
  FROM with_due
)
SELECT * FROM legacy_cycles;

INSERT INTO "credit_card_invoices" (
  "household_id", "card_account_id", "period_start", "period_end", "due_date", "status", "currency", "total_amount"
)
SELECT DISTINCT household_id, card_account_id, period_start, period_end, due_date,
  CASE WHEN period_end < CURRENT_DATE THEN 'CLOSED'::"InvoiceStatus" ELSE 'OPEN'::"InvoiceStatus" END,
  currency, 0
FROM "_legacy_invoice_payments"
ON CONFLICT ("card_account_id", "period_start") DO NOTHING;

INSERT INTO "invoice_payments" ("invoice_id", "transaction_id", "amount", "created_at")
SELECT i."id", p.transaction_id, p.amount, p.created_at
FROM "_legacy_invoice_payments" p
JOIN "credit_card_invoices" i
  ON i."household_id" = p."household_id"
 AND i."card_account_id" = p.card_account_id
 AND i."period_start" = p.period_start
ON CONFLICT ("transaction_id") DO NOTHING;

UPDATE "transactions" t
SET "invoice_id" = p."invoice_id",
    "attachment_url" = NULL
FROM "invoice_payments" p
WHERE p."transaction_id" = t."id";

UPDATE "credit_card_invoices" i
SET "status" = CASE
      WHEN COALESCE(p.total_paid, 0) > 0 AND COALESCE(p.total_paid, 0) >= i."total_amount" THEN 'PAID'::"InvoiceStatus"
      WHEN i."period_end" < CURRENT_DATE THEN 'CLOSED'::"InvoiceStatus"
      ELSE 'OPEN'::"InvoiceStatus"
    END,
    "paid_at" = p.last_payment_at
FROM (
  SELECT "invoice_id", SUM("amount") AS total_paid, MAX("created_at") AS last_payment_at
  FROM "invoice_payments"
  GROUP BY "invoice_id"
) p
WHERE p."invoice_id" = i."id";

INSERT INTO "invoice_migration_issues" ("transaction_id", "reason", "legacy_value")
SELECT t."id", 'UNRECOGNIZED_ATTACHMENT_REFERENCE', t."attachment_url"
FROM "transactions" t
WHERE t."attachment_url" IS NOT NULL
  AND t."attachment_url" NOT LIKE 'invoice_pay:%'
ON CONFLICT ("transaction_id") DO NOTHING;

INSERT INTO "invoice_migration_issues" ("transaction_id", "reason", "legacy_value")
SELECT t."id", 'UNMATCHED_INVOICE_PAYMENT_REFERENCE', t."attachment_url"
FROM "transactions" t
WHERE t."attachment_url" LIKE 'invoice_pay:%'
  AND t."invoice_id" IS NULL
ON CONFLICT ("transaction_id") DO NOTHING;

UPDATE "transactions"
SET "attachment_url" = NULL
WHERE "attachment_url" IS NOT NULL;

DROP TABLE "_legacy_invoice_payments";
DROP TABLE "_invoice_charge_cycles";
