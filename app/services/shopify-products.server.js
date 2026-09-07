import { buildCompareAttributes } from "./product-compare.server.js";
import { storeMcpCallLog } from "../db.server.js";

const VARIANTS_BY_IDS_QUERY = `#graphql
  query VariantsByIds($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on ProductVariant {
        id
        title
        price
        compareAtPrice
        sku
        availableForSale
        inventoryQuantity
        inventoryPolicy
        image {
          url
        }
        inventoryItem {
          tracked
        }
        product {
          title
          handle
          status
          vendor
          tags
          descriptionHtml
          onlineStoreUrl
          featuredImage {
            url
          }
        }
      }
    }
  }
`;

const PRODUCTS_SEARCH_QUERY = `#graphql
  query ProductsSearch($query: String!, $first: Int!) {
    products(first: $first, query: $query, sortKey: RELEVANCE) {
      edges {
        node {
          id
          title
          handle
          status
          productType
          vendor
          tags
          descriptionHtml
          onlineStoreUrl
          featuredImage {
            url
          }
          variants(first: 15) {
            edges {
              node {
                id
                title
                price
                compareAtPrice
                sku
                availableForSale
                inventoryQuantity
                inventoryPolicy
                image {
                  url
                }
                inventoryItem {
                  tracked
                }
              }
            }
          }
        }
      }
    }
  }
`;

const NODES_BATCH_SIZE = 50;
const DEFAULT_API_VERSION = "2025-10";
const ADMIN_OPERATION_VARIANTS_BY_IDS = "VariantsByIds";
const ADMIN_OPERATION_PRODUCTS_SEARCH = "ProductsSearch";

function summarizeAdminGraphqlResponse(payload) {
  if (!payload || typeof payload !== "object") {
    return payload;
  }

  if (payload.error && !payload.data) {
    return payload;
  }

  const nodes = payload.data?.nodes;
  if (!Array.isArray(nodes)) {
    return {
      ...(payload.errors?.length ? { errors: payload.errors } : {}),
      dataKeys: payload.data ? Object.keys(payload.data) : []
    };
  }

  return {
    ...(payload.errors?.length ? { errors: payload.errors } : {}),
    nodeCount: nodes.length,
    nonNullNodes: nodes.filter(Boolean).length,
    sampleNodes: nodes
      .filter(Boolean)
      .slice(0, 5)
      .map((node) => ({
        id: node.id,
        sku: node.sku,
        title: node.product?.title || node.title,
        price: node.price,
        status: node.product?.status,
        availableForSale: node.availableForSale,
        inventoryQuantity: node.inventoryQuantity
      }))
  };
}

async function callAdminGraphql({
  shop,
  query,
  variables,
  operation,
  authMode,
  admin = null,
  conversationId = null
}) {
  const apiVersion = process.env.SHOPIFY_API_VERSION || DEFAULT_API_VERSION;
  const endpoint = `https://${shop}/admin/api/${apiVersion}/graphql.json`;
  const startedAt = Date.now();
  let statusCode = 0;
  let responseBody = null;
  let errorMessage = null;

  const requestPayload = {
    operation,
    variables,
    authMode
  };

  try {
    if (authMode === "access_token") {
      const token = getAdminAccessToken();
      if (!token) {
        throw new Error("Missing SHOPIFY_ADMIN_ACCESS_TOKEN");
      }

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": token
        },
        body: JSON.stringify({ query, variables })
      });

      statusCode = response.status;
      responseBody = await response.json();

      if (!response.ok) {
        const message =
          responseBody?.errors?.[0]?.message ||
          responseBody?.error ||
          `HTTP ${response.status}`;
        throw new Error(`Admin GraphQL failed: ${message}`);
      }
    } else {
      responseBody = await (await admin.graphql(query, { variables })).json();
      statusCode = responseBody?.errors?.length ? 400 : 200;

      if (responseBody?.errors?.length) {
        const message = responseBody.errors
          .map((entry) => entry?.message || String(entry))
          .filter(Boolean)
          .join("; ");
        throw new Error(message || "Shopify Admin API returned errors");
      }
    }

    return responseBody;
  } catch (error) {
    errorMessage = error.message;
    statusCode = Number.isInteger(error.status) ? error.status : statusCode || 0;
    if (!responseBody) {
      responseBody = {
        error: error.message,
        code: error.code || null
      };
    }
    throw error;
  } finally {
    void storeMcpCallLog({
      conversationId,
      server: "admin",
      method: "graphql",
      toolName: operation,
      endpoint,
      request: {
        shop,
        ...requestPayload
      },
      response: errorMessage
        ? {
            error: errorMessage,
            body: summarizeAdminGraphqlResponse(responseBody)
          }
        : summarizeAdminGraphqlResponse(responseBody),
      statusCode,
      durationMs: Date.now() - startedAt
    });
  }
}

/**
 * Normalize MySQL variant_id values to Shopify ProductVariant GIDs.
 */
export function toVariantGid(variantId) {
  if (variantId == null || variantId === "") return null;

  const value = String(variantId).trim();
  if (!value) return null;

  if (value.startsWith("gid://shopify/ProductVariant/")) {
    return value;
  }

  if (/^\d+$/.test(value)) {
    return `gid://shopify/ProductVariant/${value}`;
  }

  const match = value.match(/ProductVariant\/(\d+)/);
  if (match) {
    return `gid://shopify/ProductVariant/${match[1]}`;
  }

  return null;
}

function getStorefrontBaseUrl() {
  const raw = (
    process.env.STOREFRONT_URL ||
    process.env.SHOPIFY_STOREFRONT_URL ||
    ""
  ).trim().replace(/\/+$/, "");
  return raw || null;
}

function buildProductUrl(handle, onlineStoreUrl) {
  if (onlineStoreUrl && /^https?:\/\//i.test(String(onlineStoreUrl))) {
    return String(onlineStoreUrl).trim();
  }

  const path = handle ? `/products/${String(handle).replace(/^\//, "")}` : "";
  if (!path) return "";

  const base = getStorefrontBaseUrl();
  return base ? `${base}${path}` : path;
}

function formatPrice(price) {
  if (price == null || price === "") return "";
  const raw = String(price).trim();
  if (!raw) return "";
  return raw.startsWith("$") ? raw : `$${raw}`;
}

function normalizeVariantNode(node) {
  if (!node?.id) return null;

  const product = node.product ?? {};

  // Only ACTIVE products (skip DRAFT / ARCHIVED)
  const status = String(product.status || "").toUpperCase();
  if (status && status !== "ACTIVE") {
    console.log("[shopify] Skipping non-active product", {
      variantId: node.id,
      sku: node.sku,
      title: product.title || node.title,
      status: product.status
    });
    return null;
  }

  const handle = product.handle ?? "";
  const title = product.title || node.title || node.sku || "";
  const imageUrl = node.image?.url || product.featuredImage?.url || "";
  const inventoryQuantity =
    typeof node.inventoryQuantity === "number" ? node.inventoryQuantity : null;
  const tracked = Boolean(node.inventoryItem?.tracked);
  // Prefer Shopify's availableForSale; fall back to quantity when tracked
  const availableForSale =
    typeof node.availableForSale === "boolean"
      ? node.availableForSale
      : tracked
        ? (inventoryQuantity ?? 0) > 0
        : true;
  // Qty 0 always means out of stock for display/cart (even if policy allows overselling)
  const inStock =
    availableForSale === true &&
    (inventoryQuantity == null || inventoryQuantity > 0);

  const sku = node.sku ? String(node.sku).trim() : "";
  const compareAttrs = buildCompareAttributes({
    tags: product.tags,
    title,
    descriptionHtml: product.descriptionHtml || "",
    vendor: product.vendor || "",
    sku
  });

  const priceAmount = node.price != null ? Number(node.price) : null;
  const compareAtPrice =
    node.compareAtPrice != null && node.compareAtPrice !== ""
      ? formatPrice(node.compareAtPrice)
      : null;

  return {
    variantId: String(node.id),
    sku,
    title,
    price: formatPrice(node.price),
    priceAmount: Number.isFinite(priceAmount) ? priceAmount : null,
    compareAtPrice,
    image_url: imageUrl,
    handle,
    url: buildProductUrl(handle, product.onlineStoreUrl),
    availableForSale,
    inStock,
    inventoryQuantity,
    inventoryPolicy: node.inventoryPolicy || null,
    descriptionHtml: product.descriptionHtml || "",
    vendor: product.vendor || "",
    ...compareAttrs
  };
}

function resolveShopDomain(shop) {
  const candidate =
    shop ||
    process.env.SHOPIFY_STORE_DOMAIN ||
    process.env.SHOPIFY_SHOP ||
    "";

  const value = String(candidate).trim().toLowerCase();
  if (!value) return null;

  if (value.includes("://")) {
    try {
      return new URL(value).hostname;
    } catch {
      return null;
    }
  }

  return value.replace(/\/$/, "");
}

function getAdminAccessToken() {
  return (
    process.env.SHOPIFY_ADMIN_ACCESS_TOKEN ||
    process.env.SHOPIFY_ACCESS_TOKEN ||
    ""
  ).trim();
}

/**
 * Fetch live title, price, and image for ProductVariant GIDs via Admin API.
 * Prefers SHOPIFY_ADMIN_ACCESS_TOKEN; falls back to Partner offline session.
 */
export async function fetchShopifyVariantsByIds(shop, variantIds = [], conversationId = null) {
  const uniqueGids = [...new Set(
    variantIds
      .map((id) => toVariantGid(id))
      .filter(Boolean)
  )];

  const shopDomain = resolveShopDomain(shop);

  console.log("[shopify] fetchShopifyVariantsByIds shop=", shopDomain);
  console.log("[shopify] raw variantIds count=", variantIds.length);
  console.log("[shopify] unique GIDs count=", uniqueGids.length);
  console.log("[shopify] unique GIDs sample=", uniqueGids.slice(0, 5));
  console.log(
    "[shopify] auth mode=",
    getAdminAccessToken() ? "access_token" : "offline_session"
  );

  if (!shopDomain || !uniqueGids.length) {
    console.warn("[shopify] Skipping GraphQL: missing shop or variant GIDs", {
      shop: shopDomain,
      uniqueGids: uniqueGids.length
    });
    if (uniqueGids.length > 0 && !shopDomain) {
      throw new Error("Missing shop domain for Shopify Admin API");
    }
    return new Map();
  }

  if (!/\.myshopify\.com$/i.test(shopDomain)) {
    const message = `Invalid shop for Admin API: "${shopDomain}". Expected *.myshopify.com`;
    console.error(`[shopify] ${message}`);
    throw new Error(message);
  }

  const byGid = new Map();
  const token = getAdminAccessToken();
  const authMode = token ? "access_token" : "offline_session";

  try {
    let admin = null;
    if (!token) {
      const { unauthenticated } = await import("../shopify.server.js");
      console.log("[shopify] Opening Admin API session for shop=", shopDomain);
      ({ admin } = await unauthenticated.admin(shopDomain));
    } else {
      console.log("[shopify] Using SHOPIFY_ADMIN_ACCESS_TOKEN for shop=", shopDomain);
    }

    for (let i = 0; i < uniqueGids.length; i += NODES_BATCH_SIZE) {
      const batch = uniqueGids.slice(i, i + NODES_BATCH_SIZE);
      const variables = { ids: batch };

      console.log(
        `[shopify] GraphQL batch ${Math.floor(i / NODES_BATCH_SIZE) + 1}: ${batch.length} ids`
      );

      const payload = await callAdminGraphql({
        shop: shopDomain,
        query: VARIANTS_BY_IDS_QUERY,
        variables,
        operation: ADMIN_OPERATION_VARIANTS_BY_IDS,
        authMode,
        admin,
        conversationId
      });

      console.log(
        "[shopify] GraphQL response summary:",
        JSON.stringify(summarizeAdminGraphqlResponse(payload), null, 2)
      );

      let skippedInactive = 0;
      for (const node of payload.data?.nodes ?? []) {
        const normalized = normalizeVariantNode(node);
        if (!normalized?.variantId) {
          if (node?.product?.status && String(node.product.status).toUpperCase() !== "ACTIVE") {
            skippedInactive += 1;
          }
          continue;
        }
        byGid.set(normalized.variantId, normalized);
        const numeric = normalized.variantId.match(/\/(\d+)$/)?.[1];
        if (numeric) {
          byGid.set(numeric, normalized);
          byGid.set(`gid://shopify/ProductVariant/${numeric}`, normalized);
        }
      }
      if (skippedInactive) {
        console.log(`[shopify] Skipped ${skippedInactive} non-ACTIVE variant(s) in this batch`);
      }
    }
  } catch (error) {
    console.error(`Failed to fetch Shopify variants for ${shopDomain}:`, error.message);
    console.error("[shopify] Full error:", error);
    throw error;
  }

  if (uniqueGids.length > 0 && byGid.size === 0) {
    throw new Error(
      `Shopify Admin API returned no product data for ${uniqueGids.length} variant(s)`
    );
  }

  console.log("[shopify] Resolved variants map size=", byGid.size);
  return byGid;
}

/** PUREFLOW home filters only stock these MERV tag levels. */
export const HOME_FILTER_MERV_TAGS = new Set(["merv-8", "merv-11", "merv-13"]);

/**
 * Extract Width/Height/Depth from labeled dimensions.
 * Customer synonyms: length → Height, thickness → Depth.
 * If both length and height are given, length→Height and height fills Width when Width is free.
 */
function extractLabeledDimensionTags(text = "") {
  let remaining = String(text || "");
  const found = {
    width: null,
    height: null,
    length: null,
    depth: null
  };

  const patterns = [
    { key: "width", re: /\b(?:width|wide)\s*[:=]?\s*(\d{1,2})(?:\s*(?:in|inch|inches|")\b)?/gi },
    { key: "width", re: /\b(\d{1,2})\s*(?:in|inch|inches|")?\s*(?:width|wide)\b/gi },
    { key: "length", re: /\b(?:length|long)\s*[:=]?\s*(\d{1,2})(?:\s*(?:in|inch|inches|")\b)?/gi },
    { key: "length", re: /\b(\d{1,2})\s*(?:in|inch|inches|")?\s*(?:length|long)\b/gi },
    { key: "height", re: /\b(?:height|tall)\s*[:=]?\s*(\d{1,2})(?:\s*(?:in|inch|inches|")\b)?/gi },
    { key: "height", re: /\b(\d{1,2})\s*(?:in|inch|inches|")?\s*(?:height|tall)\b/gi },
    {
      key: "depth",
      re: /\b(?:depth|thickness|thick|deep)\s*[:=]?\s*(\d{1,2})(?:\s*(?:in|inch|inches|")\b)?/gi
    },
    {
      key: "depth",
      re: /\b(\d{1,2})\s*(?:in|inch|inches|")?\s*(?:depth|thickness|thick|deep)\b/gi
    }
  ];

  for (const { key, re } of patterns) {
    for (const match of remaining.matchAll(re)) {
      if (found[key] == null) found[key] = match[1];
    }
    remaining = remaining.replace(re, " ");
  }

  // Map to Shopify tags: length → Height; thickness already in depth.
  let width = found.width;
  let height = found.height;
  const depth = found.depth;

  if (found.length != null) {
    // length means Height per store convention
    if (height == null) {
      height = found.length;
    } else if (width == null) {
      // both length + height given → length as Height, height as Width
      width = height;
      height = found.length;
    }
  }

  const tags = [];
  if (width != null) tags.push(`Width_${width}`);
  if (height != null) tags.push(`Height_${height}`);
  if (depth != null) tags.push(`Depth_${depth}`);

  remaining = remaining
    .replace(/\b(by|x|and|with)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  return { tags, remaining };
}

/**
 * Parse home-filter user text into Shopify tags + leftover keywords.
 * Size 10x10x1 → Width_10, Height_10, Depth_1
 * Size 25x25   → Width_25, Height_25
 * Labeled: width 10 length 20 thickness 1 → Width_10, Height_20, Depth_1
 * MERV 13 / merv-15 → merv-13 / unsupported merv-15
 */
export function parseHomeFilterSearchHints(extraQuery = "") {
  const text = String(extraQuery || "");
  const tags = [];
  const unsupportedMerv = [];
  let remaining = text;

  const mervRe = /\bmerv[\s\-_:]*([0-9]{1,2})\b/gi;
  for (const match of text.matchAll(mervRe)) {
    const tag = `merv-${match[1]}`;
    if (HOME_FILTER_MERV_TAGS.has(tag)) {
      tags.push(tag);
    } else {
      unsupportedMerv.push(tag);
    }
  }
  remaining = remaining.replace(mervRe, " ");

  const sizeRe =
    /\b([0-9]{1,2})\s*[x×]\s*([0-9]{1,2})(?:\s*[x×]\s*([0-9]{1,2}))?\b/i;
  const sizeMatch = remaining.match(sizeRe) || text.match(sizeRe);
  if (sizeMatch) {
    tags.push(`Width_${sizeMatch[1]}`);
    tags.push(`Height_${sizeMatch[2]}`);
    if (sizeMatch[3]) {
      tags.push(`Depth_${sizeMatch[3]}`);
    }
    remaining = remaining.replace(sizeMatch[0], " ");
  } else {
    // No WxHxD — try labeled words (length→height, thickness→depth)
    const labeled = extractLabeledDimensionTags(remaining);
    tags.push(...labeled.tags);
    remaining = labeled.remaining;
  }

  remaining = remaining
    .replace(/[^\w\s.-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Drop leftover words that are only noise after size/merv extraction
  remaining = remaining
    .replace(
      /\b(filter|filters|furnace|home|air|size|inch|inches|width|height|length|depth|thickness|thick|wide|tall|long|deep)\b/gi,
      " "
    )
    .replace(/\s+/g, " ")
    .trim();

  return {
    tags: [...new Set(tags)],
    unsupportedMerv: [...new Set(unsupportedMerv)],
    remaining,
    availableMerv: [...HOME_FILTER_MERV_TAGS]
  };
}

/**
 * Build Admin product search query with fixed product_type + size/MERV tags.
 * Example:
 *   product_type:"Home Furnace Air Filter" AND tag:Width_10 AND tag:Height_10 AND tag:Depth_1 AND status:active
 *   product_type:"Home Furnace Air Filter" AND tag:merv-13 AND status:active
 */
export function buildAdminProductSearchQuery(productType, extraQuery = "") {
  const type = String(productType || "").trim().replace(/"/g, '\\"');
  if (!type) {
    throw new Error("productType is required for Admin product search");
  }

  const { tags, remaining } = parseHomeFilterSearchHints(extraQuery);
  const parts = [`product_type:"${type}"`];

  for (const tag of tags) {
    // Quote tags that contain special chars; Width_10 / merv-13 are safe either way.
    const safe = String(tag).replace(/"/g, '\\"');
    parts.push(/[^a-zA-Z0-9_-]/.test(safe) ? `tag:"${safe}"` : `tag:${safe}`);
  }

  if (remaining) {
    parts.push(remaining.replace(/"/g, '\\"'));
  }

  parts.push("status:active");
  return parts.join(" AND ");
}

/**
 * Search active products via Admin GraphQL with a fixed product type.
 * Returns card-ready product objects (one per product, defaulting to first available variant).
 */
export async function searchShopifyProductsByType({
  shop,
  productType,
  query = "",
  first = 20,
  conversationId = null
} = {}) {
  const shopDomain = resolveShopDomain(shop);
  if (!shopDomain) {
    throw new Error("Missing shop domain for Shopify Admin API");
  }
  if (!/\.myshopify\.com$/i.test(shopDomain)) {
    throw new Error(
      `Invalid shop for Admin API: "${shopDomain}". Expected *.myshopify.com`
    );
  }

  const searchQuery = buildAdminProductSearchQuery(productType, query);
  const hints = parseHomeFilterSearchHints(query);
  const limit = Math.max(1, Math.min(Number(first) || 20, 50));
  const token = getAdminAccessToken();
  const authMode = token ? "access_token" : "offline_session";

  console.log("[shopify] ProductsSearch", {
    shop: shopDomain,
    productType,
    searchQuery,
    tags: hints.tags,
    remaining: hints.remaining,
    limit,
    authMode
  });

  let admin = null;
  if (!token) {
    const { unauthenticated } = await import("../shopify.server.js");
    ({ admin } = await unauthenticated.admin(shopDomain));
  }

  const payload = await callAdminGraphql({
    shop: shopDomain,
    query: PRODUCTS_SEARCH_QUERY,
    variables: { query: searchQuery, first: limit },
    operation: ADMIN_OPERATION_PRODUCTS_SEARCH,
    authMode,
    admin,
    conversationId
  });

  const edges = payload?.data?.products?.edges || [];
  const products = [];

  for (const edge of edges) {
    const node = edge?.node;
    if (!node) continue;

    const status = String(node.status || "").toUpperCase();
    if (status && status !== "ACTIVE") continue;

    // Prefer an in-stock variant; fall back to first variant.
    const variantEdges = node.variants?.edges || [];
    let chosen = null;
    for (const vEdge of variantEdges) {
      const v = vEdge?.node;
      if (!v?.id) continue;
      if (v.availableForSale !== false) {
        chosen = v;
        break;
      }
      if (!chosen) chosen = v;
    }
    if (!chosen) continue;

    const normalized = normalizeVariantNode({
      ...chosen,
      product: {
        title: node.title,
        handle: node.handle,
        status: node.status,
        vendor: node.vendor,
        tags: node.tags,
        descriptionHtml: node.descriptionHtml,
        onlineStoreUrl: node.onlineStoreUrl,
        featuredImage: node.featuredImage
      }
    });

    if (!normalized) continue;

    products.push({
      ...normalized,
      id: normalized.variantId,
      product_id: node.id,
      productType: node.productType || productType,
      product_type: node.productType || productType,
      tags: Array.isArray(node.tags) ? node.tags : []
    });
  }

  console.log("[shopify] ProductsSearch results", {
    productType,
    count: products.length,
    sample: products.slice(0, 3).map((p) => p.title)
  });

  return {
    searchQuery,
    tags: hints.tags,
    unsupportedMerv: hints.unsupportedMerv || [],
    availableMerv: hints.availableMerv || [...HOME_FILTER_MERV_TAGS],
    remaining: hints.remaining,
    products
  };
}
