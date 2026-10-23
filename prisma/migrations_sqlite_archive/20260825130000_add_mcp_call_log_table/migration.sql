-- CreateTable
CREATE TABLE "McpCallLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "conversationId" TEXT,
    "server" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "toolName" TEXT,
    "endpoint" TEXT NOT NULL,
    "request" TEXT NOT NULL,
    "response" TEXT NOT NULL,
    "statusCode" INTEGER NOT NULL,
    "durationMs" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "McpCallLog_conversationId_idx" ON "McpCallLog"("conversationId");

-- CreateIndex
CREATE INDEX "McpCallLog_toolName_idx" ON "McpCallLog"("toolName");

-- CreateIndex
CREATE INDEX "McpCallLog_createdAt_idx" ON "McpCallLog"("createdAt");
