-- Collapse shopperKey into ShopperCart.id (= localStorage shopper id).
-- Conversation.shopperKey → Conversation.shopperId

-- Rebuild ShopperCart with id = former shopper identity (strip anon:/customer: prefixes).
CREATE TABLE "ShopperCart_new" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopifyCustomerId" TEXT,
    "customerFirstName" TEXT,
    "customerLastName" TEXT,
    "customerLoggedIn" BOOLEAN NOT NULL DEFAULT false,
    "activeConversationId" TEXT,
    "activeCartId" TEXT,
    "activeCheckoutId" TEXT,
    "checkoutUrl" TEXT,
    "shippingAddress" TEXT,
    "createdAt" INTEGER NOT NULL,
    "updatedAt" INTEGER NOT NULL
);

INSERT INTO "ShopperCart_new" (
  "id",
  "shopifyCustomerId",
  "customerFirstName",
  "customerLastName",
  "customerLoggedIn",
  "activeConversationId",
  "activeCartId",
  "activeCheckoutId",
  "checkoutUrl",
  "shippingAddress",
  "createdAt",
  "updatedAt"
)
SELECT
  CASE
    WHEN "shopperKey" LIKE 'anon:%' THEN substr("shopperKey", 6)
    WHEN "shopperKey" LIKE 'customer:%' THEN substr("shopperKey", 10)
    ELSE "shopperKey"
  END,
  "shopifyCustomerId",
  "customerFirstName",
  "customerLastName",
  "customerLoggedIn",
  "activeConversationId",
  "activeCartId",
  "activeCheckoutId",
  "checkoutUrl",
  "shippingAddress",
  "createdAt",
  "updatedAt"
FROM "ShopperCart"
WHERE "shopperKey" IS NOT NULL AND "shopperKey" != ''
GROUP BY 1;

DROP TABLE "ShopperCart";
ALTER TABLE "ShopperCart_new" RENAME TO "ShopperCart";

CREATE INDEX "ShopperCart_shopifyCustomerId_idx" ON "ShopperCart"("shopifyCustomerId");
CREATE INDEX "ShopperCart_activeConversationId_idx" ON "ShopperCart"("activeConversationId");

-- Rename Conversation.shopperKey → shopperId and normalize values.
ALTER TABLE "Conversation" ADD COLUMN "shopperId" TEXT;

UPDATE "Conversation"
SET "shopperId" = CASE
  WHEN "shopperKey" LIKE 'anon:%' THEN substr("shopperKey", 6)
  WHEN "shopperKey" LIKE 'customer:%' THEN substr("shopperKey", 10)
  ELSE "shopperKey"
END
WHERE "shopperKey" IS NOT NULL;

DROP INDEX IF EXISTS "Conversation_shopperKey_idx";
ALTER TABLE "Conversation" DROP COLUMN "shopperKey";
CREATE INDEX "Conversation_shopperId_idx" ON "Conversation"("shopperId");
