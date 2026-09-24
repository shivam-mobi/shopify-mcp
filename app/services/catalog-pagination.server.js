/**
 * Server-side catalog pagination cursor: store Shopify cursor per conversation
 * and replace LLM-supplied cursors when the model invents/truncates them.
 */

const CATALOG_SEARCH_TOOL_NAMES = new Set([
  "search_catalog",
  "search_shop_catalog"
]);

export function isCatalogSearchToolName(toolName) {
  return CATALOG_SEARCH_TOOL_NAMES.has(toolName);
}

function getCatalogRoot(toolArgs) {
  if (!toolArgs || typeof toolArgs !== "object") return null;
  if (toolArgs.catalog != null && typeof toolArgs.catalog === "object") {
    return toolArgs.catalog;
  }
  return toolArgs;
}

/**
 * True when the LLM included a non-empty pagination.cursor (intends next page).
 */
export function llmRequestedCatalogPaginationCursor(toolArgs) {
  const catalog = getCatalogRoot(toolArgs);
  const cursor = catalog?.pagination?.cursor;
  return typeof cursor === "string" && cursor.trim().length > 0;
}

/**
 * If the LLM passed pagination.cursor and we have a stored cursor, replace it.
 * If the LLM omitted cursor, leave toolArgs unchanged (no injection from DB).
 */
export function applyStoredCatalogPaginationCursor(toolArgs, storedCursor) {
  if (!llmRequestedCatalogPaginationCursor(toolArgs)) {
    return toolArgs;
  }
  const stored =
    typeof storedCursor === "string" ? storedCursor.trim() : "";
  if (!stored) {
    return toolArgs;
  }

  const llmCursor = String(getCatalogRoot(toolArgs)?.pagination?.cursor || "").trim();
  if (llmCursor === stored) {
    return toolArgs;
  }

  if (toolArgs.catalog != null && typeof toolArgs.catalog === "object") {
    const catalog = { ...toolArgs.catalog };
    const pagination =
      catalog.pagination != null && typeof catalog.pagination === "object"
        ? { ...catalog.pagination }
        : {};
    pagination.cursor = stored;
    catalog.pagination = pagination;
    return { ...toolArgs, catalog };
  }

  const catalog = { ...toolArgs };
  const pagination =
    catalog.pagination != null && typeof catalog.pagination === "object"
      ? { ...catalog.pagination }
      : {};
  pagination.cursor = stored;
  catalog.pagination = pagination;
  return catalog;
}

function extractMcpPayload(toolUseResponse) {
  if (!toolUseResponse || typeof toolUseResponse !== "object") {
    return null;
  }
  if (toolUseResponse.structuredContent) {
    return toolUseResponse.structuredContent;
  }
  const raw = toolUseResponse.content?.[0]?.text;
  if (raw == null) return null;
  if (typeof raw === "object") return raw;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Read pagination.cursor from a raw MCP catalog search response.
 */
export function extractCatalogPaginationCursorFromResponse(toolUseResponse) {
  const data = extractMcpPayload(toolUseResponse);
  const pagination = data?.pagination;
  if (!pagination || typeof pagination !== "object") {
    return null;
  }
  const cursor = pagination.cursor;
  if (typeof cursor !== "string" || !cursor.trim()) {
    return null;
  }
  return cursor.trim();
}
