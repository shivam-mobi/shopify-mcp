-- CreateTable
CREATE TABLE "LlmRequestLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "request" TEXT NOT NULL,
    "response" TEXT NOT NULL,
    "statusCode" INTEGER NOT NULL,
    "provider" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
