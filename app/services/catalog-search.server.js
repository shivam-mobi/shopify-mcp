/**
 * Catalog product search for Home Filters + Car Air Fresheners.
 * - home_filter  → Shopify Admin GraphQL (fixed product_type, accurate sizes)
 * - freshener    → Shopify MCP search_catalog only
 * Cabin / vehicle cabin air filters stay on get_fitment_next_step (MySQL).
 */
import {
  searchShopifyProductsByType,
  buildAdminProductSearchQuery
} from "./shopify-products.server.js";

export const CATALOG_SEARCH_TOOL_NAME = "search_store_products";

/** Shopify Admin / catalog product types (exact strings). */
export const PRODUCT_TYPE_HOME_FILTER = "Home Furnace Air Filter";
export const PRODUCT_TYPE_FRESHENER = "Car Air Freshers";

export const CATALOG_CATEGORY = {
  home_filter: {
    id: "home_filter",
    productType: PRODUCT_TYPE_HOME_FILTER,
    label: "home furnace air filters",
    source: "admin_api"
  },
  freshener: {
    id: "freshener",
    productType: PRODUCT_TYPE_FRESHENER,
    label: "car air fresheners",
    source: "mcp"
  }
};

const RAW_CATALOG_TOOL_NAMES = new Set(["search_catalog", "search_shop_catalog"]);

function toolResult(data) {
  return {
    content: [
      {
        type: "text",
        text: typeof data === "string" ? data : JSON.stringify(data)
      }
    ],
    structuredContent: typeof data === "object" ? data : undefined
  };
}

function toolError(message) {
  return toolResult({
    success: false,
    error: true,
    message: String(message || "Catalog search failed."),
    products: []
  });
}

function resolveCategory(categoryArg = "") {
  const raw = String(categoryArg || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

  if (raw === "home_filter" || raw === "home" || raw === "furnace" || raw === "home_furnace") {
    return CATALOG_CATEGORY.home_filter;
  }
  if (
    raw === "freshener" ||
    raw === "fresheners" ||
    raw === "air_freshener" ||
    raw === "car_air_freshener" ||
    raw === "car_air_freshers"
  ) {
    return CATALOG_CATEGORY.freshener;
  }
  return null;
}

/** Parse sizes like 25x25, 25 x 25, 25×25x1 → canonical tokens. */
export function extractFilterSizes(text = "") {
  const matches = String(text || "").matchAll(
    /(\d{1,2})\s*[x×]\s*(\d{1,2})(?:\s*[x×]\s*(\d{1,2}))?/gi
  );
  const sizes = [];
  for (const m of matches) {
    const base = `${m[1]}x${m[2]}`.toLowerCase();
    sizes.push(base);
    if (m[3]) sizes.push(`${m[1]}x${m[2]}x${m[3]}`.toLowerCase());
  }
  return [...new Set(sizes)];
}

function normalizeSizeHaystack(text = "") {
  return String(text || "")
    .toLowerCase()
    .replace(/[×]/g, "x")
    .replace(/\s+/g, "");
}

/**
 * Prefer products that contain the exact requested size in title/sku.
 * If none match, return results unchanged (so browse still works).
 */
function preferExactSizeMatches(products, userQuery = "") {
  const sizes = extractFilterSizes(userQuery);
  if (!sizes.length || !products.length) return products;

  const exact = products.filter((p) => {
    const hay = normalizeSizeHaystack(
      `${p.title || ""} ${p.sku || ""} ${p.handle || ""}`
    );
    return sizes.some((size) => hay.includes(normalizeSizeHaystack(size)));
  });

  return exact.length ? exact : products;
}

function extractMcpProducts(response) {
  if (!response || response.error) return [];

  let data = response.structuredContent;
  if (!data && Array.isArray(response.content) && response.content[0]?.text) {
    try {
      data = JSON.parse(response.content[0].text);
    } catch {
      data = null;
    }
  }
  if (!data) return [];

  if (Array.isArray(data.products)) return data.products;
  if (Array.isArray(data.ucp?.products)) return data.ucp.products;
  if (Array.isArray(data.items)) return data.items;
  return [];
}

function productTypeOf(product = {}) {
  return String(
    product.productType ||
      product.product_type ||
      product.type ||
      product.category ||
      ""
  ).trim();
}

function matchesFreshenerProduct(product, expectedType) {
  const actual = productTypeOf(product).toLowerCase();
  const expected = String(expectedType || "").toLowerCase();
  if (actual && actual === expected) return true;

  const hay = `${product.title || ""} ${product.name || ""} ${(product.tags || []).join(" ")}`.toLowerCase();
  return /freshener|freshers|scent|lavender|vanilla|orchid|linen|peach|black rock|new car/.test(hay);
}

function buildFreshenerMcpQuery(category, query = "") {
  const q = String(query || "").trim();
  if (!q) return category.productType;
  if (q.toLowerCase().includes(category.productType.toLowerCase())) return q;
  if (/freshener|freshers|scent/i.test(q)) return q;
  return `${category.productType} ${q}`;
}

function successPayload({
  source,
  category,
  userQuery,
  searchQuery,
  products
}) {
  return toolResult({
    success: true,
    found: products.length > 0,
    source,
    category: category.id,
    product_type: category.productType,
    query: userQuery || null,
    search_query: searchQuery,
    products,
    status: products.length > 0 ? "success" : "not_found",
    ui_instruction:
      "CRITICAL: Product cards / comparison UI will show matching products when available. " +
      "FORBIDDEN in your reply: product names, prices, descriptions, or numbered product lists. " +
      "Reply in 1-2 short sentences only, then ask if they want to add one to the cart.",
    instruction:
      products.length > 0
        ? `Found ${products.length} ${category.label} via ${source}. Use variant ids from products for add_to_cart. Do not list products in chat text.`
        : `No ${category.label} matched for that query. Ask for a clearer size (home filters) or scent (fresheners), or offer cabin filter fitment help.`
  });
}

/**
 * Tools exposed to the LLM for home filter / freshener product search.
 */
export function getCatalogSearchTools() {
  return [
    {
      name: CATALOG_SEARCH_TOOL_NAME,
      description:
        "Search PUREFLOW catalog for Home Furnace Air Filters or Car Air Fresheners. " +
        "Use category=home_filter for home/furnace filters. " +
        "For home_filter query: YOU must pass size as WidthxHeightxDepth. " +
        "length means Height (2nd number), thickness means Depth (3rd). " +
        "Example follow-up: after 24x10x1 if customer says length is 30, query must be 24x30x1 not 30x10x1. " +
        "Use category=freshener for cabin-filter air fresheners (MCP catalog, optional scent in query). " +
        "Do NOT use this for vehicle cabin air filters — use get_fitment_next_step instead. " +
        "Do NOT call search_catalog directly.",
      input_schema: {
        type: "object",
        properties: {
          category: {
            type: "string",
            enum: ["home_filter", "freshener"],
            description:
              "home_filter = Home Furnace Air Filter (Admin API); freshener = Car Air Freshers (MCP)"
          },
          query: {
            type: "string",
            description:
              "Optional keywords for home filters: size as 20x25x1, or words width/length/height/thickness (length→height, thickness→depth), and MERV 8|11|13. For fresheners: scent name."
          }
        },
        required: ["category"]
      }
    }
  ];
}

export function isCatalogSearchTool(toolName) {
  return toolName === CATALOG_SEARCH_TOOL_NAME;
}

/** Hide raw MCP catalog search — wrapper routes home vs freshener. */
export function filterCatalogToolsForLlm(tools = []) {
  return tools.filter((tool) => !RAW_CATALOG_TOOL_NAMES.has(tool?.name));
}

async function searchHomeFiltersViaAdmin({
  category,
  userQuery,
  shop,
  conversationId
}) {
  const adminQuery = buildAdminProductSearchQuery(category.productType, userQuery);

  console.log("[catalog-search] home_filter → Admin API", {
    productType: category.productType,
    userQuery,
    adminQuery,
    shop
  });

  const {
    searchQuery,
    products: rawProducts,
    tags,
    unsupportedMerv = [],
    availableMerv = ["merv-8", "merv-11", "merv-13"]
  } = await searchShopifyProductsByType({
    shop,
    productType: category.productType,
    query: userQuery,
    first: 25,
    conversationId
  });

  // User asked for a MERV we don't carry, and no other valid MERV/size tags to search.
  if (unsupportedMerv.length && !(tags || []).some((t) => String(t).startsWith("merv-") || String(t).startsWith("Width_"))) {
    return toolResult({
      success: true,
      found: false,
      source: "admin_api",
      category: category.id,
      product_type: category.productType,
      query: userQuery || null,
      search_query: searchQuery || adminQuery,
      tags: [],
      unsupported_merv: unsupportedMerv,
      available_merv: availableMerv,
      products: [],
      status: "unsupported_merv",
      instruction:
        `PUREFLOW home filters are only available in MERV 8, 11, and 13 (tags merv-8, merv-11, merv-13). ` +
        `The customer asked for ${unsupportedMerv.join(", ")} which we do not carry. ` +
        `Tell them the available MERV options and ask which they want (optionally with a size like 20x25x1). ` +
        `Do not invent other MERV levels.`
    });
  }

  const products = preferExactSizeMatches(rawProducts, userQuery);

  console.log("[catalog-search] Admin results", {
    raw: rawProducts.length,
    afterSizePrefer: products.length,
    tags,
    unsupportedMerv,
    sample: products.slice(0, 5).map((p) => p.title)
  });

  const payload = successPayload({
    source: "admin_api",
    category,
    userQuery,
    searchQuery: searchQuery || adminQuery,
    products
  });

  try {
    const data = JSON.parse(payload.content[0].text);
    data.tags = tags || [];
    if (unsupportedMerv.length) {
      data.unsupported_merv = unsupportedMerv;
      data.available_merv = availableMerv;
      data.instruction =
        (data.instruction || "") +
        ` Note: customer also mentioned ${unsupportedMerv.join(", ")}, but PUREFLOW only carries MERV 8, 11, and 13.`;
    }
    payload.content[0].text = JSON.stringify(data);
    payload.structuredContent = data;
  } catch {
    // keep as-is
  }

  return payload;
}

async function searchFreshenersViaMcp({ mcpClient, category, userQuery }) {
  if (!mcpClient?.callTool) {
    return toolError("MCP client unavailable for freshener search.");
  }

  const searchQuery = buildFreshenerMcpQuery(category, userQuery);

  console.log("[catalog-search] freshener → MCP search_catalog", {
    productType: category.productType,
    searchQuery
  });

  let mcpResponse;
  try {
    mcpResponse = await mcpClient.callTool("search_catalog", {
      catalog: { query: searchQuery }
    });
  } catch (error) {
    console.error("[catalog-search] MCP freshener search failed", error);
    return toolError(error.message || "MCP freshener search failed.");
  }

  if (mcpResponse?.isError) {
    const errText = String(mcpResponse?.content?.[0]?.text || "MCP freshener search failed.");
    return toolError(errText);
  }

  if (mcpResponse?.error) {
    return toolError(
      mcpResponse.error?.data || mcpResponse.error?.message || "MCP freshener search failed."
    );
  }

  const rawProducts = extractMcpProducts(mcpResponse);
  const products = rawProducts.filter((p) =>
    matchesFreshenerProduct(p, category.productType)
  );

  console.log("[catalog-search] MCP freshener results", {
    raw: rawProducts.length,
    filtered: products.length
  });

  return successPayload({
    source: "mcp",
    category,
    userQuery,
    searchQuery,
    products
  });
}

/**
 * Route by category: home_filter → Admin API, freshener → MCP only.
 */
export async function callCatalogSearchTool(
  mcpClient,
  toolName,
  toolArgs = {},
  { shop = null, conversationId = null } = {}
) {
  if (toolName !== CATALOG_SEARCH_TOOL_NAME) {
    return toolError(`Unknown catalog search tool: ${toolName}`);
  }

  const category = resolveCategory(toolArgs.category);
  if (!category) {
    return toolError(
      "category is required: use home_filter or freshener. For vehicle cabin filters use get_fitment_next_step."
    );
  }

  const userQuery = String(toolArgs.query || "").trim();

  try {
    if (category.id === "home_filter") {
      return await searchHomeFiltersViaAdmin({
        category,
        userQuery,
        shop,
        conversationId
      });
    }

    return await searchFreshenersViaMcp({
      mcpClient,
      category,
      userQuery
    });
  } catch (error) {
    console.error("[catalog-search] failed", {
      category: category.id,
      message: error.message
    });
    return toolError(error.message || "Catalog search failed.");
  }
}

export default {
  getCatalogSearchTools,
  isCatalogSearchTool,
  callCatalogSearchTool,
  filterCatalogToolsForLlm,
  extractFilterSizes,
  CATALOG_SEARCH_TOOL_NAME,
  PRODUCT_TYPE_HOME_FILTER,
  PRODUCT_TYPE_FRESHENER
};
