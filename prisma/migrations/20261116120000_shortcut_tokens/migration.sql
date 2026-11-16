-- CreateTable
CREATE TABLE "shortcut_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "household_id" UUID NOT NULL,
    "device_name" VARCHAR(60) NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY['transactions:create']::TEXT[],
    "max_amount_minor" INTEGER NOT NULL,
    "last_used_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shortcut_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shortcut_token_events" (
    "id" UUID NOT NULL,
    "token_id" UUID NOT NULL,
    "action" VARCHAR(16) NOT NULL,
    "outcome" VARCHAR(32) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shortcut_token_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "shortcut_tokens_token_hash_key" ON "shortcut_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "shortcut_tokens_user_id_revoked_at_idx" ON "shortcut_tokens"("user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "shortcut_token_events_token_id_created_at_idx" ON "shortcut_token_events"("token_id", "created_at");

-- AddForeignKey
ALTER TABLE "shortcut_tokens" ADD CONSTRAINT "shortcut_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shortcut_tokens" ADD CONSTRAINT "shortcut_tokens_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shortcut_token_events" ADD CONSTRAINT "shortcut_token_events_token_id_fkey" FOREIGN KEY ("token_id") REFERENCES "shortcut_tokens"("id") ON DELETE CASCADE ON UPDATE CASCADE;

