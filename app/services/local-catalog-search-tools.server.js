/**
 * LLM tool: search_product — product search against the local MySQL catalog.
 */
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import {
  parseLocalCatalogSearchArgs,
  searchLocalCatalog
} from "./local-catalog-search.server.js";

const ROOT_LOG_FILE = join(process.cwd(), "search-product-log.json");
const SEARCH_LOG_DIR = join(process.cwd(), "uploads", "search-product-logs");

function logSearchProductCall({ request, parsed, result, debug, error }) {
  try {
    mkdirSync(SEARCH_LOG_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const payload = {
      at: new Date().toISOString(),
      actualQuery:
        debug?.ranking?.rankingQuery ||
        parsed?.query ||
        request?.catalog?.query ||
        "",
      queryVector: debug?.ranking?.queryVector || null,
      queryVectorDimensions: debug?.ranking?.queryVectorDimensions || 0,
      embeddingModel: debug?.ranking?.embeddingModel || null,
      passed: {
        request,
        parsed: parsed || debug?.parsed || null
      },
      sql: debug?.sql || [],
      dbResponse: debug?.dbResponse || {},
      ranking: debug?.ranking || null,
      error: error || null,
      toolResponse: result
        ? {
            pagination: result.pagination || null,
            productCount: Array.isArray(result.products) ? result.products.length : 0,
            products: (result.products || []).map((product) => ({
              id: product.id,
              handle: product.handle,
              title: product.title,
              brand: product.brand,
              productType: product.productType,
              fragrance_family: product.fragrance_family,
              scent_type: product.scent_type,
              key_notes: product.key_notes,
              top_notes: product.top_notes,
              middle_notes: product.middle_notes,
              base_notes: product.base_notes,
              similarity: product.similarity,
              url: product.url,
              variants: (product.variants || []).map((variant) => ({
                id: variant.id,
                title: variant.title,
                price: variant.price,
                availableForSale: variant.availableForSale
              }))
            }))
          }
        : null
    };
    const json = JSON.stringify(payload, null, 2);
    writeFileSync(ROOT_LOG_FILE, json);
    writeFileSync(join(SEARCH_LOG_DIR, `${stamp}.json`), json);
    writeFileSync(join(SEARCH_LOG_DIR, "last.json"), json);
    console.log("[search_product] wrote", ROOT_LOG_FILE);
  } catch (err) {
    console.warn("[search_product] could not write log file:", err.message);
  }
}

export const LOCAL_CATALOG_SEARCH_TOOL_NAME = "search_product";

function toolResult(payload) {
  const text = JSON.stringify(payload);
  return {
    content: [{ type: "text", text }],
    structuredContent: payload
  };
}

function toolError(message) {
  return toolResult({
    status: "error",
    error: true,
    success: false,
    message: String(message || "Local catalog search failed"),
    products: [],
    pagination: { cursor: null, has_next_page: false, total_count: 0 }
  });
}

export function isLocalCatalogSearchTool(toolName) {
  return toolName === LOCAL_CATALOG_SEARCH_TOOL_NAME;
}

export function getLocalCatalogSearchTools() {
  return [
    {
      name: LOCAL_CATALOG_SEARCH_TOOL_NAME,
      description:
        "Search Perfumania products in the local catalog. This is the only product search tool. " +
        "Required: catalog.query. Optional: catalog.filters, catalog.pagination. " +
        "Values already sent in catalog.filters should not be repeated in catalog.query — those are already applied as filters. " +
        "Put filters inside catalog (catalog.filters), never as a sibling key named catalog.filters. " +
        "Example: filters.gender 'women' → query 'winter perfume', not 'winter perfume for wife' or 'winter perfume for her'. " +
        "catalog.query must include season, occasion, and mood from the shopper (summer, winter, office, date, gift), not only gender or scent family. " +
        "Example: wife + summer + fresh → query 'fresh summer perfume', filters.gender 'women'. " +
        "Price min/max in cents ($25 → 2500). Set catalog.filters.gender (men|women|unisex) when the recipient is known. " +
        "Show more: same query/filters plus pagination.cursor from the last result.",
      input_schema: {
        type: "object",
        additionalProperties: false,
        required: ["catalog"],
        properties: {
          catalog: {
            type: "object",
            additionalProperties: false,
            description: "Local catalog search parameters.",
            required: ["query"],
            properties: {
              query: {
                type: "string",
                description:
                  "Natural search text for vector ranking, including season/occasion/mood when the shopper said it (e.g. 'fresh summer perfume for her'). Also brand, notes, type."
              },
              filters: {
                type: "object",
                additionalProperties: false,
                properties: {
                  gender: {
                    type: "string",
                    enum: ["men", "women", "unisex"],
                    description: "Recipient when known."
                  },
                  brand: {
                    type: "string",
                    description: "Brand name, e.g. Gucci, Lattafa, Versace."
                  },
                  product_type: {
                    type: "string",
                    description: "Native product type, e.g. Eau de Parfum, Cologne, Gift Set."
                  },
                  fragrance_family: {
                    type: "string",
                    description: "Fragrance family, e.g. Floral, Fresh, Woody Earthy."
                  },
                  scent_type: {
                    type: "string",
                    description: "Scent type, e.g. Fruity Florals, Woody Spicy."
                  },
                  notes: {
                    type: "array",
                    items: { type: "string" },
                    description: "Note names to match, e.g. vanilla, rose, oud."
                  },
                  category: {
                    type: "string",
                    description: "Collection handle or name, e.g. womens-perfume, gift-set."
                  },
                  price: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      min: { type: "integer", description: "Minimum price in cents." },
                      max: { type: "integer", description: "Maximum price in cents." }
                    }
                  }
                }
              },
              pagination: {
                type: "object",
                additionalProperties: false,
                properties: {
                  cursor: {
                    type: "string",
                    description: "Next-page cursor from the previous search_product result."
                  },
                  limit: {
                    type: "integer",
                    description: "Results per page.",
                    default: 10,
                    minimum: 1
                  }
                }
              }
            }
          }
        }
      }
    }
  ];
}

export async function callLocalCatalogSearchTool(toolArgs = {}, options = {}) {
  const parsed = parseLocalCatalogSearchArgs(toolArgs);
  try {
    const { result, debug } = await searchLocalCatalog(toolArgs, {
      shopperText: options.shopperText
    });
    logSearchProductCall({ request: toolArgs, parsed, result, debug });
    return toolResult(result);
  } catch (error) {
    console.error("[search_product] failed", error);
    logSearchProductCall({
      request: toolArgs,
      parsed,
      debug: error.searchDebug || null,
      error: error.message
    });
    return toolError(error.message);
  }
}
