-- DropIndex
DROP INDEX "household_members_shared_account_ids_idx";

-- AlterTable
ALTER TABLE "categories" ALTER COLUMN "id" DROP DEFAULT;
