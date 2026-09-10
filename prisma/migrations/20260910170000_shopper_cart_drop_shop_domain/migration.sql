-- Single-shop app: ShopperCart does not need shopDomain.
DROP INDEX IF EXISTS "ShopperCart_shopDomain_idx";
DROP INDEX IF EXISTS "ShopperCart_shopifyCustomerId_shopDomain_idx";

ALTER TABLE "ShopperCart" DROP COLUMN "shopDomain";

CREATE INDEX "ShopperCart_shopifyCustomerId_idx" ON "ShopperCart"("shopifyCustomerId");
