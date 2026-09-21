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
    {namespace: "custom", key: "fragrance_family"}
    {namespace: "custom", key: "scent_type_new"}
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
    reference {
      ... on Metaobject {
        handle
        type
        fields { key value }
      }
    }
    references(first: 10) {
      nodes {
        ... on Metaobject {
          handle
          type
          fields { key value }
        }
      }
    }
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
    map[`${mf.key}__meta`] = mf;
  }
  return map;
}

function metaobjectDisplayLabel(metaobject) {
  if (!metaobject || typeof metaobject !== "object") return null;
  const fields = Array.isArray(metaobject.fields) ? metaobject.fields : [];
  const byKey = Object.fromEntries(
    fields
      .filter((f) => f?.key)
      .map((f) => [String(f.key), String(f.value || "").trim()])
  );
  const preferred =
    byKey.label ||
    byKey.name ||
    byKey.title ||
    byKey.display_name ||
    byKey.value ||
    "";
  if (preferred) return preferred;
  const handle = String(metaobject.handle || "").trim();
  if (handle) {
    return handle
      .replace(/[-_]+/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }
  return null;
}

function fragranceFamilyLabel(raw, metafield = null) {
  // Prefer resolved Storefront metaobject reference(s)
  if (metafield?.reference) {
    const single = metaobjectDisplayLabel(metafield.reference);
    if (single) return single;
  }
  const refs = metafield?.references?.nodes;
  if (Array.isArray(refs) && refs.length) {
    const labels = refs.map(metaobjectDisplayLabel).filter(Boolean);
    if (labels.length) return labels.join(", ");
  }

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

function parseMetaobjectGids(raw) {
  const value = String(raw || "").trim();
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.map((v) => String(v || "").trim()).filter((v) => v.includes("gid://"));
    }
  } catch {
    // single gid
  }
  return value.includes("gid://") ? [value] : [];
}

function handleToLabel(handleLike) {
  const raw = String(handleLike || "").trim();
  if (!raw) return null;
  const handle = raw.includes(".") ? raw.split(".").pop() : raw;
  if (!handle || handle.includes("gid://")) return null;
  return handle
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

// Seed map from known Perfumania fragrance_family_new metaobjects (Admin can't read
// metaobjects without read_metaobjects scope — learn more at runtime when possible).
const FRAGRANCE_FAMILY_GID_LABELS = {
  "gid://shopify/Metaobject/123821228165": "Fresh",
  "gid://shopify/Metaobject/123821326469": "Warm & Spicy (Oriental)",
  "gid://shopify/Metaobject/123821293701": "Woody & Earthy",
  "gid://shopify/Metaobject/123821260933": "Floral"
};

const SCENT_TYPE_GID_LABELS = {
  "gid://shopify/Metaobject/123821916293": "Fresh Aquatics.",
  "gid://shopify/Metaobject/123822473349": "Woody & Warm Spices.",
  "gid://shopify/Metaobject/123822080133": "Fruity Florals.",
  "gid://shopify/Metaobject/123822211205": "Powdery Florals & Aldehydes.",
  "gid://shopify/Metaobject/123821588613": "Amber & Soft Oriental.",
  "gid://shopify/Metaobject/123822014597": "Fresh Florals.",
  "gid://shopify/Metaobject/123821817989": "Cool Spices."
};

function labelsFromGids(gids, map) {
  const labels = [];
  for (const gid of gids || []) {
    if (map[gid]) labels.push(map[gid]);
  }
  return labels.length ? [...new Set(labels)].join(", ") : null;
}

export function extractFragranceMetafields(product) {
  const mf = metafieldMap(product?.metafields);
  const review = parseReviewSummary(mf.product_review_summary);
  const familyGids = parseMetaobjectGids(mf.fragrance_family_new);
  const scentGids = parseMetaobjectGids(mf.scent_type_new);

  // Prefer fragrance_family_new (metaobject) when Storefront can resolve it;
  // fall back to plain custom.fragrance_family text, then known GID labels.
  const fromNew = fragranceFamilyLabel(
    mf.fragrance_family_new,
    mf.fragrance_family_new__meta
  );
  const fromPlain = String(mf.fragrance_family || "").trim() || null;
  const fromFamilyGids = labelsFromGids(familyGids, FRAGRANCE_FAMILY_GID_LABELS);

  const scentFromRef = fragranceFamilyLabel(
    mf.scent_type_new,
    mf.scent_type_new__meta
  );
  const scentPlain = String(mf.scent_type || "").trim() || null;
  const scentFromGids = labelsFromGids(scentGids, SCENT_TYPE_GID_LABELS);

  return {
    fragrance_family: fromNew || fromPlain || fromFamilyGids,
    scent_type: scentFromRef || scentPlain || scentFromGids,
    key_notes: String(mf.key_notes || "").trim() || null,
    top_notes: String(mf.top_notes || "").trim() || null,
    middle_notes: String(mf.middle_notes || "").trim() || null,
    base_notes: String(mf.base_notes || "").trim() || null,
    product_type_metafield: String(mf.product_type || "").trim() || null,
    product_review_summary: review,
    average_rating: review?.average_rating ?? null,
    total_reviews: review?.total_reviews ?? null,
    _family_gids: familyGids,
    _scent_gids: scentGids
  };
}

async function adminGraphql(query, variables = {}) {
  const { shop } = getStorefrontConfig();
  const token = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || "";
  if (!shop || !token) return null;

  const endpoint = `https://${shop}/admin/api/${STOREFRONT_API_VERSION}/graphql.json`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token
    },
    body: JSON.stringify({ query, variables })
  });
  const json = await response.json().catch(() => ({}));
  if (Array.isArray(json.errors) && json.errors.length) {
    console.warn(
      "[storefront-api] admin",
      json.errors.map((e) => e.message).join("; ")
    );
  }
  return json.data || null;
}

/**
 * Fill missing fragrance_family / scent_type from Admin plain metafields,
 * global scent handle, and learned GID labels (metaobjects aren't readable
 * without read_metaobjects scope).
 */
async function enrichFragranceLabelsFromAdmin(products = []) {
  const need = (products || []).filter(
    (p) => p?.id && (!p.fragrance_family || !p.scent_type)
  );
  if (!need.length) return products;

  const ids = need.map((p) => p.id);
  const data = await adminGraphql(
    `query($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on Product {
          id
          fragrance_family: metafield(namespace: "custom", key: "fragrance_family") { value }
          fragrance_family_new: metafield(namespace: "custom", key: "fragrance_family_new") { value }
          scent_type: metafield(namespace: "custom", key: "scent_type") { value }
          scent_type_new: metafield(namespace: "custom", key: "scent_type_new") { value }
          scent_type_handle: metafield(namespace: "global", key: "-customscent_type_new-[listmetaobject_reference]") { value }
        }
      }
    }`,
    { ids }
  );

  const byId = new Map();
  for (const node of data?.nodes || []) {
    if (!node?.id) continue;
    const famPlain = String(node.fragrance_family?.value || "").trim() || null;
    const scentPlain = String(node.scent_type?.value || "").trim() || null;
    const familyGids = parseMetaobjectGids(node.fragrance_family_new?.value);
    const scentGids = parseMetaobjectGids(node.scent_type_new?.value);
    const scentHandle = handleToLabel(node.scent_type_handle?.value);

    // Learn GID labels when both plain + new exist
    if (famPlain && familyGids.length) {
      for (const gid of familyGids) FRAGRANCE_FAMILY_GID_LABELS[gid] = famPlain;
    }
    if (scentPlain && scentGids.length) {
      for (const gid of scentGids) SCENT_TYPE_GID_LABELS[gid] = scentPlain;
    }

    byId.set(node.id, {
      fragrance_family:
        famPlain || labelsFromGids(familyGids, FRAGRANCE_FAMILY_GID_LABELS),
      scent_type:
        scentPlain ||
        labelsFromGids(scentGids, SCENT_TYPE_GID_LABELS) ||
        scentHandle
    });
  }

  return products.map((product) => {
    const extra = byId.get(product.id);
    if (!extra) return product;
    const next = { ...product };
    if (!next.fragrance_family && extra.fragrance_family) {
      next.fragrance_family = extra.fragrance_family;
    }
    if (!next.scent_type && extra.scent_type) {
      next.scent_type = extra.scent_type;
    }
    // Re-resolve from learned maps using GIDs captured at map time
    if (!next.fragrance_family && product._family_gids?.length) {
      next.fragrance_family = labelsFromGids(
        product._family_gids,
        FRAGRANCE_FAMILY_GID_LABELS
      );
    }
    if (!next.scent_type && product._scent_gids?.length) {
      next.scent_type = labelsFromGids(product._scent_gids, SCENT_TYPE_GID_LABELS);
    }
    delete next._family_gids;
    delete next._scent_gids;
    return next;
  });
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

  const mapped = (data?.nodes || [])
    .filter((n) => n?.id)
    .map(mapStorefrontProductToCatalog)
    .filter(Boolean);

  const enriched = await enrichFragranceLabelsFromAdmin(mapped);
  return enriched.map((product) => {
    const cleaned = { ...product };
    delete cleaned._family_gids;
    delete cleaned._scent_gids;
    return cleaned;
  });
}

export async function fetchStorefrontProductDetails(ids = []) {
  const productIds = await resolveProductIdsFromMixedIds(ids);
  return fetchStorefrontProductsByIds(productIds);
}
