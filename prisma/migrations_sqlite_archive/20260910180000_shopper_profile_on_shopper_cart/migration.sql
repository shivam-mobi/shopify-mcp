-- Move repeating shopper profile fields off Conversation onto ShopperCart.

ALTER TABLE "ShopperCart" ADD COLUMN "customerFirstName" TEXT;
ALTER TABLE "ShopperCart" ADD COLUMN "customerLastName" TEXT;
ALTER TABLE "ShopperCart" ADD COLUMN "customerLoggedIn" BOOLEAN NOT NULL DEFAULT false;

-- Best-effort backfill from Conversation when a shopperKey exists.
UPDATE "ShopperCart"
SET
  "shopifyCustomerId" = COALESCE("ShopperCart"."shopifyCustomerId", c."shopifyCustomerId"),
  "customerFirstName" = COALESCE("ShopperCart"."customerFirstName", c."customerFirstName"),
  "customerLastName" = COALESCE("ShopperCart"."customerLastName", c."customerLastName"),
  "customerLoggedIn" = CASE
    WHEN c."customerLoggedIn" = 1 OR "ShopperCart"."customerLoggedIn" = 1 THEN 1
    ELSE 0
  END
FROM "Conversation" c
WHERE c."shopperKey" = "ShopperCart"."shopperKey";

-- Drop profile columns from Conversation (chat history + shopperKey only).
DROP INDEX IF EXISTS "Conversation_shopifyCustomerId_shopDomain_updatedAt_idx";

ALTER TABLE "Conversation" DROP COLUMN "customerFirstName";
ALTER TABLE "Conversation" DROP COLUMN "customerLastName";
ALTER TABLE "Conversation" DROP COLUMN "customerLoggedIn";
ALTER TABLE "Conversation" DROP COLUMN "shopifyCustomerId";
ALTER TABLE "Conversation" DROP COLUMN "shopDomain";
