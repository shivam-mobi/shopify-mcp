/**
 * Catalog search wrapper for the LLM (same pattern as cart-tools).
 * The model calls our search_catalog; we normalize args and call Shopify UCP MCP.
 */
import { normalizeCatalogSearchArgs } from "./catalog-search-args.server.js";

const MCP_CATALOG_TOOL_NAMES = ["search_catalog", "search_shop_catalog"];
const WRAPPER_TOOL_NAME = "search_catalog";

const RAW_CATALOG_TOOL_NAMES = new Set(MCP_CATALOG_TOOL_NAMES);

export const CATALOG_SEARCH_WRAPPER_TOOL_NAMES = [WRAPPER_TOOL_NAME];

export function isCatalogSearchWrapperTool(toolName) {
  return toolName === WRAPPER_TOOL_NAME;
}

export function filterCatalogSearchToolsForLlm(tools = []) {
  return tools.filter((tool) => !RAW_CATALOG_TOOL_NAMES.has(tool?.name));
}

function resolveMcpCatalogSearchToolName(mcpClient) {
  const ucp = mcpClient?.ucpTools || [];
  if (ucp.some((t) => t.name === "search_catalog")) {
    return "search_catalog";
  }
  if (ucp.some((t) => t.name === "search_shop_catalog")) {
    return "search_shop_catalog";
  }
  return "search_catalog";
}

/**
 * Infer gender from tool-call query only (not free-form chat text).
 */
function inferGenderFromCatalogText(text) {
  const s = String(text || "").toLowerCase();
  if (!s.trim()) return null;
  if (/\bunisex\b/.test(s)) return "unisex";
  if (
    /\b(women|woman|womens|women's|for her|wife|girlfriend|mom|mother|ladies|female|her)\b/.test(
      s
    )
  ) {
    return "women";
  }
  if (
    /\b(men|man|mens|men's|for him|husband|boyfriend|dad|father|guys|male|him)\b/.test(
      s
    )
  ) {
    return "men";
  }
  return null;
}

/**
 * Set catalog.filters.gender when missing but query implies recipient.
 */
export function ensureCatalogGenderFilter(toolArgs = {}) {
  const normalized = normalizeCatalogSearchArgs(toolArgs);
  if (!normalized?.catalog || typeof normalized.catalog !== "object") {
    return normalized;
  }

  const catalog = { ...normalized.catalog };
  const filters =
    catalog.filters != null && typeof catalog.filters === "object"
      ? { ...catalog.filters }
      : {};

  const existing = String(filters.gender || "")
    .toLowerCase()
    .trim();
  if (existing === "men" || existing === "women" || existing === "unisex") {
    return normalized;
  }

  const inferred = inferGenderFromCatalogText(catalog.query);

  if (!inferred) {
    return normalized;
  }

  filters.gender = inferred;
  catalog.filters = filters;
  console.log("[catalog-wrapper] inferred catalog.filters.gender from query", {
    gender: inferred
  });
  return { ...normalized, catalog };
}

/** Remove Perfumania-only filter keys before Shopify UCP. */
export function buildMcpCatalogSearchArgs(toolArgs = {}) {
  const normalized = normalizeCatalogSearchArgs(toolArgs);
  if (!normalized?.catalog || typeof normalized.catalog !== "object") {
    return normalized;
  }

  const catalog = { ...normalized.catalog };
  if (catalog.filters != null && typeof catalog.filters === "object") {
    const { gender: _gender, ...restFilters } = catalog.filters;
    catalog.filters = restFilters;
  }

  return { ...normalized, catalog };
}

export function getCatalogSearchWrapperTools() {
  return [];
}

export async function callCatalogSearchWrapperTool(mcpClient, toolArgs = {}) {
  const mcpToolName = resolveMcpCatalogSearchToolName(mcpClient);
  const mcpArgs = buildMcpCatalogSearchArgs(toolArgs);

  console.log("[catalog-wrapper] MCP catalog search", {
    mcpToolName,
    hasGenderFilter: Boolean(
      toolArgs?.catalog?.filters?.gender ?? toolArgs?.filters?.gender
    )
  });

  return mcpClient.callTool(mcpToolName, mcpArgs);
}
