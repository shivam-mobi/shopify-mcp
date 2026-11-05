/**
 * LLM tool: search_product — Meilisearch-backed product search.
 */
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import {
  APPLICABLE_OFFERS,
  CATEGORY_NAMES,
  SORT_OPTIONS,
  parseSearchProductArgs,
  searchProducts
} from "./search-product.server.js";
import { printSearchProductConsole } from "./search-product-console.server.js";
import { CATEGORY_GROUPS } from "./products-index.config.js";

const CATEGORY_DESCRIPTIONS = Object.entries(CATEGORY_GROUPS)
  .map(([name, group]) => `${name} = ${group.description}`)
  .join("; ");

export const SEARCH_PRODUCT_TOOL_NAME = "search_product";

const ROOT_LOG_FILE = join(process.cwd(), "search-product-log.json");
const SEARCH_LOG_DIR = join(process.cwd(), "uploads", "search-product-logs");

function logSearchProductCall({ request, shopperText, result, debug, error }) {
  try {
    mkdirSync(SEARCH_LOG_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const payload = {
      at: new Date().toISOString(),
      request,
      shopperText: shopperText || null,
      debug: debug || null,
      error: error || null,
      response: result
        ? {
            search_stage: result.search_stage,
            match_quality: result.match_quality,
            relaxed_filters: result.relaxed_filters,
            applied: result.applied,
            note: result.note,
            pagination: result.pagination,
            products: (result.products || []).map((product) => ({
              id: product.id,
              title: product.title,
              brand: product.brand,
              score: product.similarity
            }))
          }
        : null
    };
    const json = JSON.stringify(payload, null, 2);
    writeFileSync(ROOT_LOG_FILE, json);
    writeFileSync(join(SEARCH_LOG_DIR, `${stamp}.json`), json);
    writeFileSync(join(SEARCH_LOG_DIR, "last.json"), json);
  } catch (err) {
    console.warn("[search_product] could not write log file:", err.message);
  }
}

function toolResult(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload
  };
}

export function isSearchProductTool(toolName) {
  return toolName === SEARCH_PRODUCT_TOOL_NAME;
}

export function getSearchProductTools() {
  return [
    {
      name: SEARCH_PRODUCT_TOOL_NAME,
      description:
        "Search Perfumania's in-stock products. Put the shopper's intent in filters and sort; " +
        "put only descriptive words in query (scent, notes, mood, season, occasion, or a product line like 'Light Blue'). " +
        "Never put brand, gender, price, kids, or ranking words (popular, best, cheap, new) in query. " +
        "Anything the shopper does NOT want (not sweet, no oud, without vanilla, should not be floral) → filters: { exclude: ['sweet'] }; " +
        "always pass it when they say it, also on later searches in the same conversation. " +
        "Use the whole conversation; a new ask replaces earlier filters. " +
        "Show more: repeat the same arguments plus pagination: { cursor } from the last result. " +
        "If the last result had has_next_page false, do not search again: say those are all the matches and offer to widen the search. " +
        "Product cards render in the chat: reply in one short sentence, do not list titles or prices. " +
        "If match_quality is 'relaxed' or 'related', or a note is returned, say these are the closest matches; " +
        "if match_quality is 'none', follow the note.",
      input_schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: {
            type: "string",
            description:
              "Descriptive words only: scent, notes, mood, season, occasion (e.g. 'vanilla caramel', 'fresh citrus summer', 'warm woody date night', 'light blue'). " +
              "All desired fragrance notes go here, never in filters. Omit when the ask is only filters/sort. " +
              "Never put what the shopper does NOT want here; that goes in filters.exclude."
          },
          sort: {
            type: "string",
            enum: Object.keys(SORT_OPTIONS),
            description:
              "popular: popular/best sellers/top/trending. top_rated: best reviewed. price_asc: cheap/affordable/budget. " +
              "price_desc: luxury/most expensive. newest: new/latest arrivals. discount_desc: biggest discount/deepest discount/best deals/sale. relevance: default."
          },
          filters: {
            type: "object",
            additionalProperties: false,
            description:
              "Exactly one filters object: put every filter (gender, brand, exclude, price, …) together in it, never a second filters key.",
            properties: {
              gender: {
                type: "string",
                enum: ["men", "women", "unisex", "boys", "girls", "kids"],
                description:
                  "From intent: he/him/husband/boyfriend/dad → men; she/her/wife/girlfriend/mom → women; " +
                  "son/boy/grandson → boys; daughter/girl/granddaughter → girls; kids/children/child/baby → kids. " +
                  "Never omit gender for son or daughter. unisex only if said. Omit gender only when unknown or for more than one person (couple, his and hers, both of us, family). " +
                  "Men/women results include unisex."
              },
              kids: {
                type: "boolean",
                description:
                  "true for generic kids/children/baby products when specific gender (boys/girls) is not specified. Prefer gender: 'boys' for son/boy and gender: 'girls' for daughter/girl."
              },
              brand: { type: "string", description: "Brand name as the shopper said it, e.g. 'Gucci'." },
              product_type: {
                type: "string",
                description: "e.g. Eau de Parfum, Eau de Toilette, Body Spray, Gift Set, Body Lotion."
              },
              fragrance_family: { type: "string", description: "e.g. Floral, Fresh, Woody, Oriental, Citrus." },
              exclude: {
                type: "array",
                items: { type: "string" },
                description:
                  "Scents, notes or styles the shopper does NOT want: 'not sweet', 'no oud', 'without vanilla', 'hate musk', " +
                  "'nothing too floral'. One word each, e.g. ['sweet'], ['oud', 'musky']. " +
                  "Example: 'fresh but not sweet' → query: 'fresh', filters: { exclude: ['sweet'] }."
              },
              categories: {
                type: "array",
                items: { type: "string", enum: CATEGORY_NAMES },
                description:
                  "Only when the shopper asks for that kind of collection; products in ANY listed category match. " +
                  "The men's/women's version is chosen from gender, so never pick a category by gender. " +
                  `Types: ${CATEGORY_DESCRIPTIONS}.`
              },
              applicable_offer: {
                type: "string",
                enum: APPLICABLE_OFFERS,
                description: "Only when the shopper asks for that promotion."
              },
              on_sale: { type: "boolean", description: "true for discounted / on sale products." },
              price: {
                type: "object",
                additionalProperties: false,
                description: "US dollars, e.g. under $50 → { max: 50 }.",
                properties: {
                  min: { type: "number" },
                  max: { type: "number" }
                }
              }
            }
          },
          pagination: {
            type: "object",
            additionalProperties: false,
            properties: {
              cursor: { type: "string", description: "The cursor value from the previous result's pagination: { cursor }." },
              limit: { type: "integer", minimum: 1, maximum: 50, default: 10 }
            }
          }
        }
      }
    }
  ];
}

const REPEAT_WINDOW_MS = 15 * 60 * 1000;
/** conversationId → the last search, to catch "show more" re-sent without a cursor. */
const lastSearches = new Map();

function searchKey(toolArgs) {
  const { query, sort, filters, offset } = parseSearchProductArgs(toolArgs);
  return { key: JSON.stringify({ query, sort, filters }), offset };
}

/**
 * The LLM sometimes answers "show more" by repeating the same search without a cursor.
 * When the previous identical search already returned every match, say so instead of re-sending the same cards.
 */
function repeatedCompleteSearch(conversationId, toolArgs) {
  if (!conversationId) return null;
  const { key, offset } = searchKey(toolArgs);
  const last = lastSearches.get(conversationId);
  if (!last || offset > 0 || last.key !== key || Date.now() - last.at > REPEAT_WINDOW_MS) return null;
  if (!last.allShown || !last.total) return null;
  return {
    ...last.result,
    match_quality: "none",
    search_stage: "repeat",
    note:
      `Same search as before: all ${last.total} matching products are already shown in the chat; there are no more. ` +
      "Tell the shopper that is everything for this search and offer to widen it (similar scents from other brands, or drop a filter).",
    products: [],
    pagination: { ...last.result.pagination, cursor: null, has_next_page: false }
  };
}

/**
 * Gender taken from an earlier message ("for my wife") still applies when the same search is
 * repeated for the next page ("show more" has no gender words).
 */
function inheritedGender(conversationId, toolArgs) {
  const last = conversationId ? lastSearches.get(conversationId) : null;
  if (!last?.genderFromMessage || Date.now() - last.at > REPEAT_WINDOW_MS) return null;
  return last.key === searchKey(toolArgs).key ? last.genderFromMessage : null;
}

function rememberSearch(conversationId, toolArgs, result, genderFromMessage) {
  if (!conversationId) return;
  const { key } = searchKey(toolArgs);
  lastSearches.set(conversationId, {
    key,
    at: Date.now(),
    total: result.pagination?.total_count || 0,
    allShown: !result.pagination?.has_next_page,
    genderFromMessage: genderFromMessage || null,
    result: { ...result, products: [] }
  });
  if (lastSearches.size > 5000) lastSearches.delete(lastSearches.keys().next().value);
}

export async function callSearchProductTool(toolArgs = {}, options = {}) {
  const started = Date.now();
  try {
    const repeat = repeatedCompleteSearch(options.conversationId, toolArgs);
    if (repeat) {
      logSearchProductCall({ request: toolArgs, shopperText: options.shopperText, result: repeat });
      return toolResult(repeat);
    }
    const { result, debug } = await searchProducts(toolArgs, {
      shopperMessage: options.shopperMessage || options.shopperText,
      inheritedGender: inheritedGender(options.conversationId, toolArgs)
    });
    rememberSearch(options.conversationId, toolArgs, result, debug.genderFromMessage);
    logSearchProductCall({ request: toolArgs, shopperText: options.shopperText, result, debug });
    await printSearchProductConsole({
      payload: toolArgs,
      result,
      debug,
      shopperText: options.shopperMessage || options.shopperText,
      elapsedMs: Date.now() - started
    });
    return toolResult(result);
  } catch (error) {
    console.error("[search_product] failed", error);
    logSearchProductCall({ request: toolArgs, shopperText: options.shopperText, error: error.message });
    return toolResult({
      status: "error",
      error: true,
      success: false,
      message: "Product search is temporarily unavailable.",
      products: [],
      pagination: { cursor: null, has_next_page: false, total_count: 0 }
    });
  }
}
