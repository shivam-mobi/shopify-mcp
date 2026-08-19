import { unauthenticated } from "../shopify.server.js";

const VARIANTS_BY_SKU_QUERY = `#graphql
  query VariantsBySku($query: String!) {
    productVariants(first: 25, query: $query) {
      nodes {
        id
        sku
        title
        price
        product {
          handle
          title
          featuredImage {
            url
          }
        }
      }
    }
  }
`;

function escapeSkuForQuery(sku) {
  const value = String(sku).trim();
  if (/^[A-Za-z0-9_-]+$/.test(value)) {
    return value;
  }
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function buildSkuSearchQuery(skus) {
  return skus
    .map((sku) => `sku:${escapeSkuForQuery(sku)}`)
    .join(" OR ");
}

function normalizeVariantNode(node) {
  if (!node?.sku) return null;

  const product = node.product ?? {};
  const handle = product.handle ?? "";
  const title = node.title || product.title || node.sku;

  return {
    sku: String(node.sku).trim(),
    product_title: title,
    product_price: node.price != null ? String(node.price) : "",
    images: product.featuredImage?.url ?? "",
    handle,
    brand: product.title ?? "",
    variant_id: node.id
  };
}

/**
 * Resolve fitment part SKUs to live Shopify product variants via Admin API.
 * Requires read_products scope and an installed app session for the shop.
 */
export async function fetchShopifyVariantsBySkus(shop, skus = []) {
  const uniqueSkus = [...new Set(
    skus.map((sku) => String(sku).trim()).filter(Boolean)
  )];

  if (!shop || !uniqueSkus.length) {
    return [];
  }

  try {
    const { admin } = await unauthenticated.admin(shop);
    const response = await admin.graphql(VARIANTS_BY_SKU_QUERY, {
      variables: {
        query: buildSkuSearchQuery(uniqueSkus)
      }
    });

    const payload = await response.json();

    if (payload.errors?.length) {
      console.error("Shopify Admin API errors:", payload.errors);
      return [];
    }

    const nodes = payload.data?.productVariants?.nodes ?? [];
    const bySku = new Map();

    for (const node of nodes) {
      const normalized = normalizeVariantNode(node);
      if (normalized?.sku) {
        bySku.set(normalized.sku.toLowerCase(), normalized);
      }
    }

    return uniqueSkus
      .map((sku) => bySku.get(sku.toLowerCase()))
      .filter(Boolean);
  } catch (error) {
    console.error(`Failed to fetch Shopify variants for ${shop}:`, error.message);
    return [];
  }
}
