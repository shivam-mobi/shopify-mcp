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
      searchStage: debug?.searchStage || result?.search_stage || null,
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
              applicable_offer: product.applicable_offer,
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
        "Required: catalog.filters. Optional: catalog.query, catalog.pagination. " +
        "Values already sent in catalog.filters should not be repeated in catalog.query — those are already applied as filters. " +
        "When catalog.filters.category is set, omit catalog.query. " +
        "Put filters inside catalog (catalog.filters), never as a sibling key named catalog.filters. " +
        "Example: filters.gender 'women' → query 'winter perfume', not 'winter perfume for wife' or 'winter perfume for her'. " +
        "catalog.query must include season, occasion, and mood from the shopper (summer, winter, office, date, gift), not only gender or scent family. " +
        "Example: wife + summer + fresh → query 'fresh summer perfume', filters.gender 'women'. " +
        "Price min/max in cents ($25 → 2500). " +
        "Set catalog.filters.gender from intent: wife/girlfriend/her/mom/women → women; husband/boyfriend/him/dad/men → men. " +
        "Pass unisex only if they said unisex. Kids/children/baby: omit gender. If gender is unknown, omit gender — never default to unisex. " +
        "A new ask replaces previous gender, price, must_match, and category. " +
        "If a shopper word is not gender, price, category, or applicable_offer, and there is no other filter for it, put it in catalog.filters.must_match. " +
        "Kids/children/baby → catalog.filters.must_match [\"kids\", \"children\"] (never catalog.must_match) and omit gender. " +
        "Product or line names → must_match. Brand → filters.brand. Notes → filters.notes. " +
        "Wife/her/husband is gender, not must_match. " +
        "Skip filler (perfume, cologne, fragrance, for, the). Do not copy the full sentence. " +
        "Mood/season/occasion stay in catalog.query only. " +
        "Use short root words (rainy → rain, citrusy → citrus). " +
        "If the ask matches a collection, set catalog.filters.category to that handle and omit catalog.query. " +
        "new women's / women's new arrivals → womens-perfume-new-arrivals; " +
        "best sellers women / best selling women's → best-selling-perfumes-for-women; " +
        "women bundles / bundle deals for women → bundle-deals-for-women; " +
        "women clearance / women's sale → clearance-for-women-perfume; " +
        "new men's / men's new arrivals → mens-cologne-new-arrivals; " +
        "best sellers men / best selling men's → best-selling-colognes-for-men; " +
        "men bundles / bundle deals for men → bundle-deals-for-men; " +
        "men clearance / men's sale → clearance-for-mens-cologne; " +
        "gift set / gift sets → gift-set; " +
        "beauty → beauty; " +
        "exclusive / only at Perfumania → only-at-perfumania; " +
        "spray / sprays / body spray / body mist → body-sprays; " +
        "EDP / eau de parfum → eau-de-parfum-edp-s; " +
        "EDT / eau de toilette → eau-de-toilette-edt-s; " +
        "women's perfume → womens-perfume. " +
        "Set catalog.filters.applicable_offer to one fixed name when they ask for a deal: " +
        "3 For $20, 2 For $25, BOGO 50, 3 For $99, 2 For $75, 3 For $129. " +
        "Show more: same query/filters plus pagination.cursor from the last result. " +
        "After this tool returns products, do not list titles, prices, sizes, or numbers in the reply. " +
        "Cards are already on screen. Reply in 1 short sentence about the ask, then ask if they want to add one.",
      input_schema: {
        type: "object",
        additionalProperties: false,
        required: ["catalog"],
        properties: {
          catalog: {
            type: "object",
            additionalProperties: false,
            description: "Local catalog search parameters.",
            required: ["filters"],
            properties: {
              query: {
                type: "string",
                description:
                  "Natural search text for vector ranking, including season/occasion/mood when the shopper said it (e.g. 'fresh summer perfume for her'). Also brand, notes, type. " +
                  "Omit this field when catalog.filters.category is set."
              },
              filters: {
                type: "object",
                additionalProperties: false,
                properties: {
                  gender: {
                    type: "string",
                    enum: ["men", "women", "unisex"],
                    description:
                      "From shopper intent, not only the words men/women/unisex. " +
                      "women: she, her, wife, girlfriend, mom. men: he, him, husband, boyfriend, dad. " +
                      "unisex: only if they said unisex. " +
                      "Kids, children, baby, or unknown gender: omit this field. Never default to unisex. " +
                      "men → men + unisex + no gender; women → women + unisex + no gender; unisex → unisex + no gender only."
                  },
                  brand: {
                    type: "string",
                    description:
                      "Brand name copied from the shopper, as a free string — not an enum. " +
                      "Any brand is valid. " +
                      "Use the full name in one field."
                  },
                  product_type: {
                    type: "string",
                    description: "Native product type, e.g. Eau de Parfum, Cologne, Gift Set."
                  },
                  fragrance_family: {
                    type: "string",
                    description:
                      "One fragrance family name as a string, not an array, e.g. Floral, Fresh, Woody Earthy."
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
                  applicable_offer: {
                    type: "string",
                    enum: [
                      "3 For $20",
                      "2 For $25",
                      "BOGO 50",
                      "3 For $99",
                      "2 For $75",
                      "3 For $129"
                    ],
                    description:
                      "Fixed applicable-offer name. Pass only these values: " +
                      "3 For $20, 2 For $25, BOGO 50, 3 For $99, 2 For $75, 3 For $129. " +
                      "Use when the shopper asks for that deal. Omit if none match."
                  },
                  must_match: {
                    type: "array",
                    items: { type: "string" },
                    description:
                      "Put this inside catalog.filters.must_match — never catalog.must_match. " +
                      "Words that are not gender, price, category, or a deal, and can appear on the product. " +
                      "Kids/children/baby → [\"kids\", \"children\"]. Product or line name → those words. " +
                      "Brand → filters.brand, not must_match. Notes → filters.notes. " +
                      "Omit perfume, cologne, fragrance, for, the, and gender words. " +
                      "Wife/girlfriend/her/mom → gender women. Husband/boyfriend/him/dad → gender men. " +
                      "Mood/season/occasion-only → omit must_match, use catalog.query. " +
                      "Do not copy the full shopper sentence or must_match from the previous turn."
                  },
                  category: {
                    type: "string",
                    enum: [
                      "womens-perfume-new-arrivals",
                      "best-selling-perfumes-for-women",
                      "bundle-deals-for-women",
                      "clearance-for-women-perfume",
                      "womens-perfume",
                      "mens-cologne-new-arrivals",
                      "best-selling-colognes-for-men",
                      "bundle-deals-for-men",
                      "clearance-for-mens-cologne",
                      "gift-set",
                      "beauty",
                      "only-at-perfumania",
                      "body-sprays",
                      "eau-de-parfum-edp-s",
                      "eau-de-toilette-edt-s"
                    ],
                    description:
                      "Shopify collection handle. Required when the shopper ask matches a collection. " +
                      "When this is set, omit catalog.query. " +
                      "spray, sprays, body spray, body mist → body-sprays. " +
                      "EDP / eau de parfum → eau-de-parfum-edp-s. EDT / eau de toilette → eau-de-toilette-edt-s. " +
                      "womens-perfume-new-arrivals (new women's), " +
                      "best-selling-perfumes-for-women (best sellers women), bundle-deals-for-women (women bundles), " +
                      "clearance-for-women-perfume (women clearance), womens-perfume (women's perfume), mens-cologne-new-arrivals (new men's), " +
                      "best-selling-colognes-for-men (best sellers men), bundle-deals-for-men (men bundles), " +
                      "clearance-for-mens-cologne (men clearance), gift-set (gift sets), beauty (beauty), " +
                      "only-at-perfumania (exclusive / only at Perfumania). Omit if none match."
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
