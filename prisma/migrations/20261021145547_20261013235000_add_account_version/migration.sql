-- DropIndex
DROP INDEX "transactions_household_occurred_at_id_idx";

-- AlterTable
ALTER TABLE "credit_card_invoices" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "updated_at" DROP DEFAULT,
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "invoice_migration_issues" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "invoice_payments" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "recurring_occurrences" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "sync_changes" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "sync_mutations" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "transactions" ALTER COLUMN "client_mutation_id" DROP DEFAULT;

-- RenameIndex
ALTER INDEX "credit_card_invoices_card_period_end_idx" RENAME TO "credit_card_invoices_card_account_id_period_end_idx";

-- RenameIndex
ALTER INDEX "credit_card_invoices_card_period_start_key" RENAME TO "credit_card_invoices_card_account_id_period_start_key";

-- RenameIndex
ALTER INDEX "credit_card_invoices_household_period_idx" RENAME TO "credit_card_invoices_household_id_period_start_idx";

-- RenameIndex
ALTER INDEX "invoice_payments_invoice_idx" RENAME TO "invoice_payments_invoice_id_idx";

-- RenameIndex
ALTER INDEX "recurring_occurrences_recurring_date_key" RENAME TO "recurring_occurrences_recurring_transaction_id_occurrence_d_key";

-- RenameIndex
ALTER INDEX "sync_changes_entity_idx" RENAME TO "sync_changes_entity_type_entity_id_idx";

-- RenameIndex
ALTER INDEX "sync_changes_household_sequence_idx" RENAME TO "sync_changes_household_id_sequence_idx";

-- RenameIndex
ALTER INDEX "sync_mutations_entity_idx" RENAME TO "sync_mutations_entity_type_entity_id_idx";
