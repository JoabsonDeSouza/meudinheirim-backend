ALTER TABLE "transactions"
  ADD COLUMN "client_mutation_id" UUID NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

CREATE TABLE "sync_mutations" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "client_mutation_id" UUID NOT NULL,
  "payload_hash" VARCHAR(64) NOT NULL,
  "entity_type" VARCHAR(32) NOT NULL,
  "entity_id" UUID NOT NULL,
  "response" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "sync_mutations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "sync_mutations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "sync_mutations_user_mutation_unique" UNIQUE ("user_id", "client_mutation_id")
);

CREATE INDEX "sync_mutations_entity_idx" ON "sync_mutations"("entity_type", "entity_id");

CREATE TABLE "sync_changes" (
  "sequence" BIGSERIAL NOT NULL,
  "household_id" UUID NOT NULL,
  "entity_type" VARCHAR(32) NOT NULL,
  "entity_id" UUID NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "payload" JSONB NOT NULL,
  "deleted_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "sync_changes_pkey" PRIMARY KEY ("sequence")
);

CREATE INDEX "sync_changes_household_sequence_idx" ON "sync_changes"("household_id", "sequence");
CREATE INDEX "sync_changes_entity_idx" ON "sync_changes"("entity_type", "entity_id");

-- Backfill a stable feed cursor for all existing transactions without changing ledger rows.
INSERT INTO "sync_changes" (
  "household_id", "entity_type", "entity_id", "version", "payload", "deleted_at", "created_at"
)
SELECT
  t."household_id",
  'transaction',
  t."id",
  t."version",
  jsonb_build_object(
    'id', t."id"::text,
    'version', t."version",
    'clientMutationId', t."client_mutation_id"::text,
    'clientMutationId', t."client_mutation_id"::text,
    'kind', lower(t."type"::text),
    'amount', jsonb_build_object(
      'minorUnits', (t."amount" * 100)::bigint,
      'currency', COALESCE(a."currency", fa."currency", ta."currency", 'BRL')
    ),
    'categoryCode', t."category_name",
    'accountId', t."account_id"::text,
    'fromAccountId', t."from_account_id"::text,
    'toAccountId', t."to_account_id"::text,
    'occurredAt', t."occurred_at",
    'timeZone', t."time_zone",
    'note', t."notes",
    'paid', t."paid",
    'createdAt', t."created_at",
    'updatedAt', t."updated_at",
    'deletedAt', t."deleted_at"
  ),
  t."deleted_at",
  t."updated_at"
FROM "transactions" t
LEFT JOIN "accounts" a ON a."id" = t."account_id"
LEFT JOIN "accounts" fa ON fa."id" = t."from_account_id"
LEFT JOIN "accounts" ta ON ta."id" = t."to_account_id";
