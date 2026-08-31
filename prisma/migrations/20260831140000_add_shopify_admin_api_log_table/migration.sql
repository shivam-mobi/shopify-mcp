-- CreateTable
CREATE TABLE "ShopifyAdminApiLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "authMode" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "request" TEXT NOT NULL,
    "response" TEXT NOT NULL,
    "statusCode" INTEGER NOT NULL,
    "durationMs" INTEGER,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "ShopifyAdminApiLog_shop_idx" ON "ShopifyAdminApiLog"("shop");

-- CreateIndex
CREATE INDEX "ShopifyAdminApiLog_operation_idx" ON "ShopifyAdminApiLog"("operation");

-- CreateIndex
CREATE INDEX "ShopifyAdminApiLog_createdAt_idx" ON "ShopifyAdminApiLog"("createdAt");
