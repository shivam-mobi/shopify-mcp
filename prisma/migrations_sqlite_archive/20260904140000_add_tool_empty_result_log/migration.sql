-- CreateTable
CREATE TABLE "ToolEmptyResultLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "conversationId" TEXT,
    "shop" TEXT,
    "userQuery" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "toolArgs" TEXT,
    "response" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "ToolEmptyResultLog_toolName_idx" ON "ToolEmptyResultLog"("toolName");

-- CreateIndex
CREATE INDEX "ToolEmptyResultLog_conversationId_idx" ON "ToolEmptyResultLog"("conversationId");

-- CreateIndex
CREATE INDEX "ToolEmptyResultLog_createdAt_idx" ON "ToolEmptyResultLog"("createdAt");

-- CreateIndex
CREATE INDEX "ToolEmptyResultLog_reason_idx" ON "ToolEmptyResultLog"("reason");
