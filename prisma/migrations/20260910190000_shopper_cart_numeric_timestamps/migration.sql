-- Store ShopperCart timestamps as unix epoch milliseconds (numeric).

ALTER TABLE "ShopperCart" ADD COLUMN "createdAtMs" INTEGER;
ALTER TABLE "ShopperCart" ADD COLUMN "updatedAtMs" INTEGER;

UPDATE "ShopperCart"
SET
  "createdAtMs" = CAST(strftime('%s', "createdAt") AS INTEGER) * 1000,
  "updatedAtMs" = CAST(strftime('%s', "updatedAt") AS INTEGER) * 1000;

UPDATE "ShopperCart"
SET
  "createdAtMs" = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
  "updatedAtMs" = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
WHERE "createdAtMs" IS NULL OR "updatedAtMs" IS NULL;

ALTER TABLE "ShopperCart" DROP COLUMN "createdAt";
ALTER TABLE "ShopperCart" DROP COLUMN "updatedAt";

ALTER TABLE "ShopperCart" RENAME COLUMN "createdAtMs" TO "createdAt";
ALTER TABLE "ShopperCart" RENAME COLUMN "updatedAtMs" TO "updatedAt";
