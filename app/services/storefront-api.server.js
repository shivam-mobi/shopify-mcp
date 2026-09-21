/**
 * Storefront GraphQL (private token) — product details + fragrance metafields.
 * Used only by get_product_details (replaces lookup_catalog).
 */

const STOREFRONT_API_VERSION =
  process.env.SHOPIFY_STOREFRONT_API_VERSION || "2025-07";

const PRODUCT_DETAIL_FRAGMENT = `
  id
  title
  handle
  productType
  vendor
  description
  descriptionHtml
  tags
  onlineStoreUrl
  featuredImage { url altText }
  priceRange {
    minVariantPrice { amount currencyCode }
    maxVariantPrice { amount currencyCode }
  }
  compareAtPriceRange {
    minVariantPrice { amount currencyCode }
    maxVariantPrice { amount currencyCode }
  }
  options { name values }
  variants(first: 50) {
    nodes {
      id
      title
      sku
      availableForSale
      price { amount currencyCode }
      compareAtPrice { amount currencyCode }
      image { url altText }
      selectedOptions { name value }
    }
  }
  metafields(identifiers: [
    {namespace: "custom", key: "fragrance_family_new"}
    {namespace: "custom", key: "scent_type"}
    {namespace: "custom", key: "key_notes"}
    {namespace: "custom", key: "top_notes"}
    {namespace: "custom", key: "middle_notes"}
    {namespace: "custom", key: "base_notes"}
    {namespace: "custom", key: "product_review_summary"}
    {namespace: "custom", key: "product_type"}
  ]) {
    namespace
    key
    type
    value
  }
`;

function getStorefrontConfig() {
  const shopUrl =
    process.env.STOREFRONT_URL || process.env.SHOPIFY_STOREFRONT_URL || "";
  const token =
    process.env.STOREFRONT_PRIVATE_ACCESS_TOKEN ||
    process.env.SHOPIFY_STOREFRONT_PRIVATE_TOKEN ||
    "";
  const publicToken = process.env.STOREFRONT_PUBLIC_ACCESS_TOKEN || "";

  let shop = "";
  try {
    shop = shopUrl.includes("://")
      ? new URL(shopUrl).hostname
      : String(shopUrl).replace(/^https?:\/\//, "").split("/")[0];
  } catch {
    shop = "";
  }

  return { shop, token, publicToken, shopUrl: shopUrl.replace(/\/+$/, "") };
}

export async function storefrontGraphql(query, variables = {}) {
  const { shop, token, publicToken } = getStorefrontConfig();
  if (!shop || (!token && !publicToken)) {
    throw new Error(
      "STOREFRONT_URL and STOREFRONT_PRIVATE_ACCESS_TOKEN are required"
    );
  }

  const endpoint = `https://${shop}/api/${STOREFRONT_API_VERSION}/graphql.json`;
  const headers = { "Content-Type": "application/json" };
  if (token) {
    headers["Shopify-Storefront-Private-Token"] = token;
  } else {
    headers["X-Shopify-Storefront-Access-Token"] = publicToken;
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({ query, variables })
  });

  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      `Storefront API HTTP ${response.status}: ${JSON.stringify(json).slice(0, 400)}`
    );
  }
  if (Array.isArray(json.errors) && json.errors.length && !json.data) {
    throw new Error(
      `Storefront GraphQL error: ${json.errors.map((e) => e.message).join("; ")}`
    );
  }
  if (Array.isArray(json.errors) && json.errors.length) {
    console.warn(
      "[storefront-api]",
      json.errors.map((e) => e.message).join("; ")
    );
  }
  return json.data;
}

function parseMoney(money) {
  if (!money || money.amount == null) return null;
  const amount = Number(money.amount);
  if (!Number.isFinite(amount)) return null;
  const currency = money.currencyCode || "USD";
  return {
    amount,
    currency,
    amountCents: Math.round(amount * 100),
    formatted: `${currency} ${amount.toFixed(2)}`
  };
}

function parseReviewSummary(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  const parts = Object.fromEntries(
    text.split("|").map((chunk) => {
      const [k, ...rest] = chunk.split("=");
      return [String(k || "").trim(), String(rest.join("=") || "").trim()];
    })
  );
  const averageRating = Number(parts.averageRating);
  const totalReviews = Number(parts.totalReviews);
  return {
    raw: text,
    average_rating: Number.isFinite(averageRating) ? averageRating : null,
    total_reviews: Number.isFinite(totalReviews) ? totalReviews : null,
    stars: {
      "1": Number(parts["1star"]) || 0,
      "2": Number(parts["2star"]) || 0,
      "3": Number(parts["3star"]) || 0,
      "4": Number(parts["4star"]) || 0,
      "5": Number(parts["5star"]) || 0
    }
  };
}

function metafieldMap(metafields = []) {
  const map = {};
  for (const mf of metafields || []) {
    if (!mf?.key) continue;
    map[mf.key] = mf.value ?? null;
  }
  return map;
}

function fragranceFamilyLabel(raw) {
  const value = String(raw || "").trim();
  if (!value || value.includes("gid://shopify/Metaobject")) return null;
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      const labels = parsed
        .map((v) => String(v || "").trim())
        .filter((v) => v && !v.includes("gid://"));
      return labels.length ? labels.join(", ") : null;
    }
  } catch {
    // plain string
  }
  return value.includes("gid://") ? null : value;
}

export function extractFragranceMetafields(product) {
  const mf = metafieldMap(product?.metafields);
  const review = parseReviewSummary(mf.product_review_summary);
  return {
    fragrance_family: fragranceFamilyLabel(mf.fragrance_family_new),
    scent_type: String(mf.scent_type || "").trim() || null,
    key_notes: String(mf.key_notes || "").trim() || null,
    top_notes: String(mf.top_notes || "").trim() || null,
    middle_notes: String(mf.middle_notes || "").trim() || null,
    base_notes: String(mf.base_notes || "").trim() || null,
    product_type_metafield: String(mf.product_type || "").trim() || null,
    product_review_summary: review,
    average_rating: review?.average_rating ?? null,
    total_reviews: review?.total_reviews ?? null
  };
}

export function mapStorefrontProductToCatalog(product) {
  if (!product?.id) return null;
  const fragrance = extractFragranceMetafields(product);
  const variants = (product.variants?.nodes || []).map((v) => {
    const price = parseMoney(v.price);
    const compare = parseMoney(v.compareAtPrice);
    return {
      id: v.id,
      title: v.title,
      sku: v.sku,
      available: v.availableForSale === true,
      availability: { available: v.availableForSale === true },
      price: price
        ? { amount: price.amountCents, currency: price.currency }
        : null,
      list_price: compare
        ? { amount: compare.amountCents, currency: compare.currency }
        : null,
      media: v.image?.url
        ? [{ type: "image", url: v.image.url, alt_text: v.image.altText || "" }]
        : [],
      options: (v.selectedOptions || []).map((o) => ({
        name: o.name,
        label: o.value
      }))
    };
  });

  const minPrice = parseMoney(product.priceRange?.minVariantPrice);
  const maxPrice = parseMoney(product.priceRange?.maxVariantPrice);
  const minList = parseMoney(product.compareAtPriceRange?.minVariantPrice);
  const maxList = parseMoney(product.compareAtPriceRange?.maxVariantPrice);

  return {
    id: product.id,
    title: product.title,
    handle: product.handle,
    vendor: product.vendor,
    productType: product.productType || "",
    product_type: fragrance.product_type_metafield || product.productType || "",
    description: { html: product.descriptionHtml || product.description || "" },
    descriptionHtml: product.descriptionHtml || "",
    tags: Array.isArray(product.tags) ? product.tags : [],
    url: product.onlineStoreUrl || null,
    media: product.featuredImage?.url
      ? [
          {
            type: "image",
            url: product.featuredImage.url,
            alt_text: product.featuredImage.altText || ""
          }
        ]
      : [],
    options: (product.options || []).map((opt) => ({
      name: opt.name,
      values: (opt.values || []).map((label) => ({ label }))
    })),
    variants,
    price_range: minPrice
      ? {
          min: { amount: minPrice.amountCents, currency: minPrice.currency },
          max: maxPrice
            ? { amount: maxPrice.amountCents, currency: maxPrice.currency }
            : { amount: minPrice.amountCents, currency: minPrice.currency }
        }
      : null,
    list_price_range: minList
      ? {
          min: { amount: minList.amountCents, currency: minList.currency },
          max: maxList
            ? { amount: maxList.amountCents, currency: maxList.currency }
            : { amount: minList.amountCents, currency: minList.currency }
        }
      : null,
    ...fragrance,
    showDetailProfile: true
  };
}

function toProductGid(id) {
  const raw = String(id || "").trim();
  if (!raw) return null;
  if (raw.startsWith("gid://shopify/Product/")) return raw;
  if (raw.startsWith("gid://shopify/ProductVariant/")) return null;
  if (/^\d+$/.test(raw)) return `gid://shopify/Product/${raw}`;
  return raw;
}

function toVariantGid(id) {
  const raw = String(id || "").trim();
  if (!raw) return null;
  if (raw.startsWith("gid://shopify/ProductVariant/")) return raw;
  if (/^\d+$/.test(raw)) return `gid://shopify/ProductVariant/${raw}`;
  return null;
}

export async function resolveProductIdsFromMixedIds(ids = []) {
  const list = (Array.isArray(ids) ? ids : [ids]).map(String).filter(Boolean);
  const productIds = new Set();
  const variantIds = [];

  for (const id of list) {
    if (id.includes("/Product/") && !id.includes("ProductVariant")) {
      const gid = toProductGid(id);
      if (gid) productIds.add(gid);
      continue;
    }
    const variantGid = toVariantGid(id);
    if (variantGid) variantIds.push(variantGid);
    else {
      const gid = toProductGid(id);
      if (gid) productIds.add(gid);
    }
  }

  if (variantIds.length) {
    const data = await storefrontGraphql(
      `query($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on ProductVariant {
            id
            product { id }
          }
        }
      }`,
      { ids: variantIds }
    );
    for (const node of data?.nodes || []) {
      if (node?.product?.id) productIds.add(node.product.id);
    }
  }

  return [...productIds];
}

export async function fetchStorefrontProductsByIds(productIds = []) {
  const ids = [...new Set(productIds.map(toProductGid).filter(Boolean))];
  if (!ids.length) return [];

  const data = await storefrontGraphql(
    `query($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on Product {
          ${PRODUCT_DETAIL_FRAGMENT}
        }
      }
    }`,
    { ids }
  );

  return (data?.nodes || [])
    .filter((n) => n?.id)
    .map(mapStorefrontProductToCatalog)
    .filter(Boolean);
}

export async function fetchStorefrontProductDetails(ids = []) {
  const productIds = await resolveProductIdsFromMixedIds(ids);
  return fetchStorefrontProductsByIds(productIds);
}
