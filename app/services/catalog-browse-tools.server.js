/**
 * Admin API catalog browse by Shopify product type.
 */
import {
  fetchShopifyProductsByProductType,
  getCachedProductTypes,
  hasCachedProductType
} from "./shopify-products.server.js";
import {
  enrichProductsWithComparison,
  annotateRankedProductsForLlm,
  buildProductListingMetadata,
  PRODUCT_LISTING_CART_INSTRUCTION
} from "./product-compare.server.js";
import {
  enrichBrowseArgsWithHomeFilterSize,
  filterProductsBySearchTerm,
  buildSizedHomeFilterBrowseHintMessage
} from "./home-filter-search.server.js";

const CATALOG_BROWSE_TOOL_NAME = "browse_products_by_type";

const VEHICLE_CONTEXT_PATTERN =
  /\b(19|20)\d{2}\b|\bvin\b|\b(year|make|model|engine)\b/i;

const PRODUCT_TYPE_INTENT_RULES = [
  {
    priority: 100,
    textPatterns: [/\bfresheners?\b/i, /\bfebreze\b/i, /\bair fresheners?\b/i],
    productTypeMatchers: [/car air freshener/i]
  },
  {
    priority: 90,
    textPatterns: [
      /\bhome\b.*\bfilter\b/i,
      /\bfurnace\b/i,
      /\bhvac\b/i,
      /\bmerv\b/i,
      /\bhome filter\b/i
    ],
    productTypeMatchers: [/home furnace air filter/i]
  },
  {
    priority: 80,
    textPatterns: [/\bcabin\b.*\bfilter\b/i, /\bcabin air filter\b/i],
    excludePatterns: [/\bfresheners?\b/i, /\bfebreze\b/i],
    productTypeMatchers: [/cabin_air_filter/i, /cabin air filter/i],
    skipWhenVehicleContext: true
  }
];

function toolResult(content) {
  return {
    content: [{
      type: "text",
      text: typeof content === "string" ? content : JSON.stringify(content)
    }]
  };
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasVehicleContext(text) {
  return VEHICLE_CONTEXT_PATTERN.test(String(text || ""));
}

function findCachedProductType(cachedTypes, matchers = []) {
  for (const type of cachedTypes) {
    for (const matcher of matchers) {
      if (matcher instanceof RegExp) {
        if (matcher.test(type)) return type;
        continue;
      }

      if (normalizeText(type) === normalizeText(matcher)) {
        return type;
      }
    }
  }

  return null;
}

/**
 * Resolve a cached product type from explicit value or natural-language category text.
 */
export function resolveProductTypeForBrowse({
  product_type = "",
  category = ""
} = {}) {
  const cachedTypes = getCachedProductTypes();
  if (!cachedTypes.length) {
    return null;
  }

  const explicit = String(product_type || "").trim();
  if (explicit) {
    if (hasCachedProductType(explicit)) {
      return explicit;
    }

    const exactInsensitive = cachedTypes.find(
      (type) => normalizeText(type) === normalizeText(explicit)
    );
    if (exactInsensitive) {
      return exactInsensitive;
    }
  }

  const combined = `${category} ${explicit}`.trim();
  if (!combined) {
    return null;
  }

  const sortedRules = [...PRODUCT_TYPE_INTENT_RULES].sort(
    (a, b) => b.priority - a.priority
  );

  for (const rule of sortedRules) {
    if (rule.excludePatterns?.some((pattern) => pattern.test(combined))) {
      continue;
    }

    if (!rule.textPatterns.some((pattern) => pattern.test(combined))) {
      continue;
    }

    if (rule.skipWhenVehicleContext && hasVehicleContext(combined)) {
      continue;
    }

    const matchedType = findCachedProductType(cachedTypes, rule.productTypeMatchers);
    if (matchedType) {
      return matchedType;
    }
  }

  const normalizedCombined = normalizeText(combined);
  for (const type of cachedTypes) {
    const normalizedType = normalizeText(String(type).replace(/_/g, " "));
    if (
      normalizedCombined.includes(normalizedType) ||
      normalizedType.includes(normalizedCombined)
    ) {
      return type;
    }
  }

  return null;
}

function formatBrowseProducts(products, productType, search = null) {
  const formatted = products.map((product) => ({
    id: product.variantId,
    title: product.title,
    price: product.price,
    priceAmount: product.priceAmount ?? null,
    compareAtPrice: product.compareAtPrice || null,
    image_url: product.image_url,
    description: product.descriptionHtml || "",
    url: product.url,
    variantId: product.variantId,
    productId: product.productId || null,
    sku: product.sku || "",
    handle: product.handle,
    vendor: product.vendor || "",
    availableForSale: product.availableForSale === true,
    inStock: product.inStock === true,
    inventoryQuantity:
      typeof product.inventoryQuantity === "number" ? product.inventoryQuantity : null,
    filterType: product.filterType || "standard",
    isHepa: product.isHepa === true,
    hasAntibacterial: product.hasAntibacterial === true,
    hasCharcoal: product.hasCharcoal === true,
    hasParticulate: product.hasParticulate === true,
    yGroup: product.yGroup || "",
    features: Array.isArray(product.features) ? product.features : [],
    tags: Array.isArray(product.tags) ? product.tags : []
  }));

  const ranked = enrichProductsWithComparison(formatted);
  const productsForLlm = annotateRankedProductsForLlm(ranked);
  const listingMeta = buildProductListingMetadata(ranked);
  const hasProducts = products.length > 0;

  return {
    status: hasProducts ? "success" : "not_found",
    source: CATALOG_BROWSE_TOOL_NAME,
    product_type: productType,
    search: search || null,
    products: productsForLlm,
    ...listingMeta,
    ui_instruction: hasProducts
      ? "CRITICAL: Top Matching Products cards, Quick comparison, and Best pick UI are already shown in chat. " +
        "FORBIDDEN in your reply: product names, prices, 'Priced at $…', descriptions, feature bullets, numbered lists, or naming a specific product. " +
        "Do NOT say 'here are the options' and then list them. Reply in 1-2 short sentences only, then ask if they want to add one to the cart. " +
        PRODUCT_LISTING_CART_INSTRUCTION
      : `No products were found for product type "${productType}". Reply in 1 short sentence only.`
  };
}

export async function browseProductsByType(
  args = {},
  { shop = null, conversationId = null } = {}
) {
  const productType = resolveProductTypeForBrowse(args);
  const search = String(args.search || args.size || "").trim();

  if (!productType) {
    const availableTypes = getCachedProductTypes();
    return toolResult({
      status: "need_product_type",
      available_product_types: availableTypes,
      message:
        availableTypes.length > 0
          ? "Could not match that category to a store product type. Pass product_type from available_product_types or a clearer category."
          : "Product types are not loaded yet. Try again in a moment."
    });
  }

  const { products, searchQuery } = await fetchShopifyProductsByProductType(
    shop,
    productType,
    { conversationId, search }
  );

  const filteredProducts = filterProductsBySearchTerm(products, search);

  console.log("[catalog-browse] products loaded", {
    productType,
    search: search || null,
    searchQuery,
    count: filteredProducts.length,
    beforeFilter: products.length
  });

  return toolResult(formatBrowseProducts(filteredProducts, productType, search || null));
}

export function getCatalogBrowseTools() {
  const productTypes = getCachedProductTypes();
  const typeList = productTypes.length
    ? productTypes.join(", ")
    : "loaded at server startup";

  const productTypeProperty = {
    type: "string",
    description:
      `Exact Shopify product type. Available types: ${typeList}. ` +
      "Prefer this when you know the type."
  };

  if (productTypes.length > 0) {
    productTypeProperty.enum = productTypes;
  }

  return [{
    name: CATALOG_BROWSE_TOOL_NAME,
    description:
      "Browse store products by Shopify product type using the Admin API. " +
      "Use for car air fresheners, cabin air filter browse without a vehicle, and home furnace filters. " +
      "For sized home furnace filters (10x10, 16x25x1, etc.), pass product_type \"Home Furnace Air Filter\" AND search with the dimensions. " +
      "Do NOT use search_catalog for these categories. " +
      "Do NOT use for vehicle fitment — use get_fitment_next_step when year/make/model/VIN is involved.",
    input_schema: {
      type: "object",
      properties: {
        product_type: productTypeProperty,
        search: {
          type: "string",
          description:
            "Optional size or keyword to narrow results (e.g. 10x10, 16x25x1). Required for sized home furnace filter requests."
        },
        category: {
          type: "string",
          description:
            "Natural-language category when product_type is unclear, e.g. 'cabin filter air fresheners' or 'home furnace filters'."
        }
      }
    }
  }];
}

export async function callCatalogBrowseTool(
  toolName,
  toolArgs = {},
  { shop = null, conversationId = null, messages = [], currentUserMessage = "" } = {}
) {
  if (toolName !== CATALOG_BROWSE_TOOL_NAME) {
    throw new Error(`Unknown catalog browse tool: ${toolName}`);
  }

  const enrichedArgs = enrichBrowseArgsWithHomeFilterSize(toolArgs, messages, {
    currentUserMessage
  });

  if (
    enrichedArgs.search &&
    !String(toolArgs.search || toolArgs.size || "").trim()
  ) {
    console.log("[catalog-browse] enriched browse args with home filter search", {
      before: toolArgs,
      after: enrichedArgs
    });
  }

  return browseProductsByType(enrichedArgs, { shop, conversationId });
}

export function isCatalogBrowseTool(toolName) {
  return toolName === CATALOG_BROWSE_TOOL_NAME;
}

export function buildCatalogBrowseHintMessage(
  userMessage = "",
  conversationMessages = []
) {
  const sizedHomeHint = buildSizedHomeFilterBrowseHintMessage(conversationMessages, {
    currentUserMessage: userMessage
  });
  if (sizedHomeHint) {
    return sizedHomeHint;
  }

  const productType = resolveProductTypeForBrowse({ category: userMessage });
  if (!productType || hasVehicleContext(userMessage)) {
    return null;
  }

  return {
    role: "system",
    content:
      "The customer is browsing a product category (not vehicle fitment). " +
      `Call browse_products_by_type with product_type: "${productType}" (or category describing their request).`
  };
}

export default {
  browseProductsByType,
  getCatalogBrowseTools,
  callCatalogBrowseTool,
  isCatalogBrowseTool,
  resolveProductTypeForBrowse,
  buildCatalogBrowseHintMessage
};
