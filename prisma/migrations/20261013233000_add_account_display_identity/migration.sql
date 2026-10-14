ALTER TABLE "accounts"
  ADD COLUMN "institution" VARCHAR(100),
  ADD COLUMN "brand" VARCHAR(50),
  ADD COLUMN "card_network" VARCHAR(20),
  ADD COLUMN "last4" VARCHAR(4);

ALTER TABLE "accounts"
  ADD CONSTRAINT "accounts_last4_format_check"
  CHECK ("last4" IS NULL OR "last4" ~ '^[0-9]{4}$') NOT VALID;

ALTER TABLE "accounts"
  ADD CONSTRAINT "accounts_currency_supported_check"
  CHECK ("currency" IN ('BRL', 'USD')) NOT VALID;
