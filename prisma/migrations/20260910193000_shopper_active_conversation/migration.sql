-- Track active chat thread on the shared shopper row.
ALTER TABLE "ShopperCart" ADD COLUMN "activeConversationId" TEXT;

CREATE INDEX "ShopperCart_activeConversationId_idx" ON "ShopperCart"("activeConversationId");

-- Fresh test data: clear shopper carts + unlink conversations.
-- Keep Message, McpCallLog, and tool logs untouched.
DELETE FROM "ShopperCart";
UPDATE "Conversation" SET "shopperKey" = NULL;
