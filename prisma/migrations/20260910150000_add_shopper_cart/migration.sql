-- Shared cart/checkout/address across conversations for the same shopper.
ALTER TABLE "Conversation" ADD COLUMN "shopperKey" TEXT;

CREATE TABLE "ShopperCart" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopperKey" TEXT NOT NULL,
    "shopDomain" TEXT,
    "shopifyCustomerId" TEXT,
    "activeCartId" TEXT,
    "activeCheckoutId" TEXT,
    "checkoutUrl" TEXT,
    "shippingAddress" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "ShopperCart_shopperKey_key" ON "ShopperCart"("shopperKey");
CREATE INDEX "ShopperCart_shopDomain_idx" ON "ShopperCart"("shopDomain");
CREATE INDEX "ShopperCart_shopifyCustomerId_shopDomain_idx" ON "ShopperCart"("shopifyCustomerId", "shopDomain");
CREATE INDEX "Conversation_shopperKey_idx" ON "Conversation"("shopperKey");
