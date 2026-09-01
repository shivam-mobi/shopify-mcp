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
          id
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

const NODES_BATCH_SIZE = 50;
const DEFAULT_API_VERSION = "2025-10";
const ADMIN_OPERATION_VARIANTS_BY_IDS = "VariantsByIds";

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

/**
 * Normalize values to Shopify Product GIDs.
 */
export function toProductGid(productId) {
  if (productId == null || productId === "") return null;

  const value = String(productId).trim();
  if (!value) return null;

  if (value.startsWith("gid://shopify/Product/")) {
    return value;
  }

  if (/^\d+$/.test(value)) {
    return `gid://shopify/Product/${value}`;
  }

  const match = value.match(/Product\/(\d+)/);
  if (match) {
    return `gid://shopify/Product/${match[1]}`;
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
    productId: product.id ? String(product.id) : null,
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
