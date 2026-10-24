ALTER TABLE "accounts"
  ADD COLUMN "is_primary_card" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD CONSTRAINT "accounts_primary_card_credit_only"
    CHECK (NOT "is_primary_card" OR ("type" = 'CREDIT' AND "is_active" = TRUE));

CREATE UNIQUE INDEX "accounts_primary_card_household_currency_key"
  ON "accounts" ("household_id", "currency")
  WHERE "is_primary_card" = TRUE;
