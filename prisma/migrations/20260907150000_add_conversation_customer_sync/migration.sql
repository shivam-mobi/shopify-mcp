-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN "shopifyCustomerId" TEXT;
ALTER TABLE "Conversation" ADD COLUMN "shopDomain" TEXT;

-- CreateIndex
CREATE INDEX "Conversation_shopifyCustomerId_shopDomain_updatedAt_idx" ON "Conversation"("shopifyCustomerId", "shopDomain", "updatedAt");
