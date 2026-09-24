/**
 * get_product_details — Storefront private API replacement for lookup_catalog.
 */

import { fetchStorefrontProductDetails } from "./storefront-api.server.js";

const LOOKUP_CATALOG_NAME = "lookup_catalog";
const GET_PRODUCT_DETAILS = "get_product_details";

function toolResult(payload) {
  const text = JSON.stringify(payload);
  return {
    content: [{ type: "text", text }],
    structuredContent: payload
  };
}

function toolError(message) {
  return toolResult({
    error: true,
    success: false,
    message: String(message || "get_product_details failed")
  });
}

export function getStorefrontCatalogTools() {
  return [
    {
      name: GET_PRODUCT_DETAILS,
      description:
        "Get rich product details from the Storefront API (replaces lookup_catalog). " +
        "Use for ANY follow-up about products already shown in search cards: reviews, ratings, scent/notes, " +
        "fragrance family, concentration/sizes, compare, which one, differences, longevity, gift fit, etc. " +
        "Pass variant GIDs from the latest search_catalog products[]. " +
        "BATCH (CRITICAL): ids[] accepts MANY GIDs in ONE call — fetch everything you need to answer once. " +
        "NEVER emit multiple get_product_details tool calls with one id each. " +
        "display_ids[] (optional): variant GIDs for Product Details CARDS in the UI when your reply focuses on " +
        "specific product(s). ids[] = data; display_ids[] = cards. Copy GIDs exactly from ids[]. " +
        "Omit display_ids to show detail cards for all products in ids[]. Listing cards stay visible above. " +
        "Returns metafields for YOUR understanding — cards show notes/reviews to the customer; do not paste field lists in chat. " +
        "Never use lookup_catalog.",
      input_schema: {
        type: "object",
        properties: {
          ids: {
            type: "array",
            description:
              "One or more Product and/or ProductVariant GIDs in a SINGLE call " +
              "(gid://shopify/Product/... or ProductVariant/...). " +
              "For multiple products, pass ALL needed ids here — do not call this tool repeatedly with one id.",
            items: { type: "string" }
          },
          id: {
            type: "string",
            description:
              "Single product or variant GID only when exactly one product needs details. " +
              "Prefer ids[] with all GIDs when more than one product is involved."
          },
          display_ids: {
            type: "array",
            description:
              "Optional variant GIDs for Product Details CARDS in the chat UI (subset of ids[]). " +
              "Use when your answer highlights specific shown products — copy each GID exactly from ids[]. " +
              "When naming multiple products in text, list each variant here (max 5). " +
              "Omit to show detail cards for every id in ids[] (up to UI limit).",
            items: { type: "string" }
          }
        }
      }
    }
  ];
}

export function isStorefrontCatalogTool(toolName) {
  return toolName === GET_PRODUCT_DETAILS;
}

/** Hide MCP lookup_catalog so the LLM only uses get_product_details. */
export function filterLookupCatalogForLlm(tools = []) {
  return tools.filter((tool) => tool?.name !== LOOKUP_CATALOG_NAME);
}

export async function callStorefrontCatalogTool(toolName, toolArgs = {}) {
  if (toolName !== GET_PRODUCT_DETAILS) {
    return toolError(`Unknown storefront tool: ${toolName}`);
  }

  try {
    const ids = [
      ...(Array.isArray(toolArgs.ids) ? toolArgs.ids : []),
      ...(toolArgs.id ? [toolArgs.id] : []),
      ...(Array.isArray(toolArgs.catalog?.ids) ? toolArgs.catalog.ids : [])
    ]
      .map((id) => String(id || "").trim())
      .filter(Boolean);

    if (!ids.length) {
      return toolError(
        "get_product_details requires ids[] or id (product/variant GID)"
      );
    }

    const products = await fetchStorefrontProductDetails(ids);
    return toolResult({
      status: "success",
      source: GET_PRODUCT_DETAILS,
      products,
      result_count: products.length,
      query_match: products.length > 0,
      instruction:
        "INTERNAL ONLY: products[] has full detail for your understanding. " +
        "Product Details cards appear BELOW your reply; Top Matching Products listing stays above. " +
        "Do NOT paste Price / notes / rating field lists into chat — answer briefly; point to cards below. " +
        "ids[] batch-fetches; display_ids[] controls which detail cards show (optional). " +
        "One get_product_details call per customer question — never one call per product."
    });
  } catch (error) {
    console.error("[storefront-catalog-tools]", toolName, error);
    return toolError(error?.message || "get_product_details failed");
  }
}

export { GET_PRODUCT_DETAILS, LOOKUP_CATALOG_NAME };
