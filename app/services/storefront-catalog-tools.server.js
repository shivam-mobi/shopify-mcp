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
        "Use when the customer asks for product details, sizes, notes, scent type, fragrance info, or reviews. " +
        "Pass product or variant GIDs from the latest search_catalog products[]. " +
        "Returns variants + metafields for YOUR understanding. A Product Details card is shown in the UI — " +
        "do NOT paste Price/Notes/Rating lists into chat; reply in 1-2 short sentences only. " +
        "Never use lookup_catalog.",
      input_schema: {
        type: "object",
        properties: {
          ids: {
            type: "array",
            description:
              "Product and/or ProductVariant GIDs (gid://shopify/Product/... or ProductVariant/...)",
            items: { type: "string" }
          },
          id: {
            type: "string",
            description: "Single product or variant GID (alternative to ids[])"
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
        "The Product Details card is shown BELOW your reply (text first, then the card). " +
        "Do NOT paste Price / Fragrance Type / Family / Key Notes / Top-Middle-Base Notes / Rating into chat. " +
        "NEVER say details are above. Reply in 1-2 short sentences only (e.g. details are shown below — want to add it to cart?)."
    });
  } catch (error) {
    console.error("[storefront-catalog-tools]", toolName, error);
    return toolError(error?.message || "get_product_details failed");
  }
}

export { GET_PRODUCT_DETAILS, LOOKUP_CATALOG_NAME };
