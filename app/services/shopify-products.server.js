const VARIANTS_BY_IDS_QUERY = `#graphql
  query VariantsByIds($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on ProductVariant {
        id
        title
        price
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

  return {
    variantId: String(node.id),
    sku: node.sku ? String(node.sku).trim() : "",
    title,
    price: formatPrice(node.price),
    image_url: imageUrl,
    handle,
    url: handle ? `/products/${handle}` : "",
    availableForSale,
    inStock,
    inventoryQuantity,
    inventoryPolicy: node.inventoryPolicy || null
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

async function adminGraphqlWithToken(shop, query, variables) {
  const token = getAdminAccessToken();
  if (!token) {
    throw new Error("Missing SHOPIFY_ADMIN_ACCESS_TOKEN");
  }

  const apiVersion = process.env.SHOPIFY_API_VERSION || DEFAULT_API_VERSION;
  const url = `https://${shop}/admin/api/${apiVersion}/graphql.json`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token
    },
    body: JSON.stringify({ query, variables })
  });

  const payload = await response.json();

  if (!response.ok) {
    const message =
      payload?.errors?.[0]?.message ||
      payload?.error ||
      `HTTP ${response.status}`;
    throw new Error(`Admin GraphQL failed: ${message}`);
  }

  return payload;
}

/**
 * Fetch live title, price, and image for ProductVariant GIDs via Admin API.
 * Prefers SHOPIFY_ADMIN_ACCESS_TOKEN; falls back to Partner offline session.
 */
export async function fetchShopifyVariantsByIds(shop, variantIds = []) {
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
    return new Map();
  }

  if (!/\.myshopify\.com$/i.test(shopDomain)) {
    console.error(
      `[shopify] Invalid shop for Admin API: "${shopDomain}". Expected *.myshopify.com`
    );
    return new Map();
  }

  const byGid = new Map();
  const token = getAdminAccessToken();

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

      const payload = token
        ? await adminGraphqlWithToken(shopDomain, VARIANTS_BY_IDS_QUERY, variables)
        : await (await admin.graphql(VARIANTS_BY_IDS_QUERY, { variables })).json();

      console.log(
        "[shopify] GraphQL response summary:",
        JSON.stringify(
          {
            errors: payload.errors || null,
            nodeCount: payload.data?.nodes?.length ?? 0,
            nonNullNodes: (payload.data?.nodes ?? []).filter(Boolean).length,
            sampleNodes: (payload.data?.nodes ?? [])
              .filter(Boolean)
              .slice(0, 3)
              .map((node) => ({
                id: node.id,
                sku: node.sku,
                title: node.product?.title || node.title,
                price: node.price,
                status: node.product?.status,
                availableForSale: node.availableForSale,
                inventoryQuantity: node.inventoryQuantity
              }))
          },
          null,
          2
        )
      );

      if (payload.errors?.length) {
        console.error("Shopify Admin API errors:", payload.errors);
        continue;
      }

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
  }

  console.log("[shopify] Resolved variants map size=", byGid.size);
  return byGid;
}
