-- Move ShopifyAdminApiLog rows into McpCallLog, then drop the old table.
INSERT INTO "McpCallLog" (
  "id",
  "conversationId",
  "server",
  "method",
  "toolName",
  "endpoint",
  "request",
  "response",
  "statusCode",
  "durationMs",
  "createdAt"
)
SELECT
  "id",
  NULL,
  'admin',
  'graphql',
  "operation",
  "endpoint",
  json_object(
    'shop', "shop",
    'authMode', "authMode",
    'operation', "operation",
    'body', "request"
  ),
  CASE
    WHEN "error" IS NOT NULL AND trim("error") != ''
      THEN json_object('error', "error", 'body', "response")
    ELSE "response"
  END,
  "statusCode",
  "durationMs",
  "createdAt"
FROM "ShopifyAdminApiLog";

DROP TABLE "ShopifyAdminApiLog";

CREATE INDEX "McpCallLog_server_idx" ON "McpCallLog"("server");
