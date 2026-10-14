ALTER TABLE "credit_card_invoices"
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "invoice_payments"
  ADD COLUMN "refunded_at" TIMESTAMPTZ(3),
  ADD COLUMN "refund_transaction_id" UUID;

ALTER TABLE "invoice_payments"
  ADD CONSTRAINT "invoice_payments_refund_transaction_id_key" UNIQUE ("refund_transaction_id"),
  ADD CONSTRAINT "invoice_payments_refund_transaction_id_fkey"
    FOREIGN KEY ("refund_transaction_id") REFERENCES "transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
