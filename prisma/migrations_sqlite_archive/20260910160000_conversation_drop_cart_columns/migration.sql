-- Conversation keeps chat/customer metadata only.
-- Cart / checkout / shipping live solely on ShopperCart.

-- Best-effort: give conversations with leftover cart fields a shopperKey before drop.
UPDATE "Conversation"
SET "shopperKey" = 'conversation:' || "id"
WHERE "shopperKey" IS NULL
  AND (
    "activeCartId" IS NOT NULL
    OR "activeCheckoutId" IS NOT NULL
    OR "checkoutUrl" IS NOT NULL
    OR "shippingAddress" IS NOT NULL
  );

-- Seed ShopperCart from Conversation for keys that do not exist yet.
INSERT INTO "ShopperCart" (
  "id",
  "shopperKey",
  "shopDomain",
  "shopifyCustomerId",
  "activeCartId",
  "activeCheckoutId",
  "checkoutUrl",
  "shippingAddress",
  "createdAt",
  "updatedAt"
)
SELECT
  lower(hex(randomblob(16))),
  c."shopperKey",
  c."shopDomain",
  c."shopifyCustomerId",
  c."activeCartId",
  c."activeCheckoutId",
  c."checkoutUrl",
  c."shippingAddress",
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "Conversation" c
WHERE c."shopperKey" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "ShopperCart" s WHERE s."shopperKey" = c."shopperKey"
  );

-- Drop duplicate columns from Conversation (SQLite 3.35+).
ALTER TABLE "Conversation" DROP COLUMN "activeCartId";
ALTER TABLE "Conversation" DROP COLUMN "activeCheckoutId";
ALTER TABLE "Conversation" DROP COLUMN "checkoutUrl";
ALTER TABLE "Conversation" DROP COLUMN "shippingAddress";
