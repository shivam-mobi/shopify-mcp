-- AlterTable
ALTER TABLE "LlmRequestLog" ADD COLUMN "conversationId" TEXT;

-- CreateIndex
CREATE INDEX "LlmRequestLog_conversationId_idx" ON "LlmRequestLog"("conversationId");

-- CreateIndex
CREATE INDEX "LlmRequestLog_createdAt_idx" ON "LlmRequestLog"("createdAt");
