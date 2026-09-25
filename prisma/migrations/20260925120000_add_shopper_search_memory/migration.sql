-- CreateTable
CREATE TABLE "ShopperSearchMemory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopperId" TEXT NOT NULL,
    "intent" TEXT NOT NULL,
    "vehicleYear" INTEGER,
    "vehicleMake" TEXT,
    "vehicleModel" TEXT,
    "vehicleEngine" TEXT,
    "homeFilterSize" TEXT,
    "homeMerv" TEXT,
    "useCount" INTEGER NOT NULL DEFAULT 1,
    "lastUsedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "ShopperSearchMemory_shopperId_intent_lastUsedAt_idx" ON "ShopperSearchMemory"("shopperId", "intent", "lastUsedAt");
