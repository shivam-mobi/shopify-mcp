/**
 * Product cards for the chat UI, loaded from MySQL (the source of truth).
 * Meilisearch only decides which product ids to show and in what order.
 */
import prisma from "../../db.server.js";

const STOREFRONT_URL = (process.env.STOREFRONT_URL || "").replace(/\/+$/, "");

export const PRODUCT_INCLUDE = {
  brand: true,
  gender: true,
  productType: true,
  fragranceFamily: true,
  scentType: true,
  variants: {
    include: { applicableOffer: true },
    orderBy: { position: "asc" }
  },
  images: { orderBy: { position: "asc" } },
  notes: {
    include: { note: true, type: true },
    orderBy: [{ type: { position: "asc" } }, { position: "asc" }]
  },
  categories: { include: { category: true } },
  tags: { include: { tag: true } },
  review: true
};

/** Same rule as the chat cards: inventory 0 is out of stock even if Shopify still allows sale. */
export function isVariantInStock(variant) {
  return variant?.availableForSale === true && Number(variant.inventoryQuantity) !== 0;
}

function notesByType(notes = []) {
  const grouped = { key: [], top: [], middle: [], base: [] };
  for (const row of notes) {
    const code = row.type?.code;
    const name = row.note?.name;
    if (grouped[code] && name) grouped[code].push(name);
  }
  return grouped;
}

function numericShopifyId(value) {
  const raw = String(value || "").trim();
  const match = raw.match(/(\d+)\s*$/);
  return match ? match[1] : "";
}

function toVariantGid(shopifyVariantId) {
  const id = String(shopifyVariantId || "").trim();
  if (!id) return "";
  return id.startsWith("gid://") ? id : `gid://shopify/ProductVariant/${id}`;
}

function toProductGid(shopifyProductId) {
  const id = String(shopifyProductId || "").trim();
  if (!id) return "";
  return id.startsWith("gid://") ? id : `gid://shopify/Product/${id}`;
}

export function formatProductCard(product, similarity = null) {
  const notes = notesByType(product.notes);
  const genderName = product.gender?.name || "";
  const genderTag = genderName ? `gender_${genderName.toLowerCase().replace(/\s+/g, "_")}` : null;
  const productTags = (product.tags || []).map((t) => t.tag?.name).filter(Boolean);
  const cardTags = [...new Set([genderTag, ...productTags].filter(Boolean))];
  const imageNodes = (product.images || []).filter((img) => img.url);
  const productUrl = STOREFRONT_URL
    ? `${STOREFRONT_URL}/products/${product.handle}`
    : `/products/${product.handle}`;

  const variants = (product.variants || []).map((variant, index) => {
    const amount = Math.round(Number(variant.price) * 100);
    const compare =
      variant.compareAtPrice != null ? Math.round(Number(variant.compareAtPrice) * 100) : null;
    const variantImageNodes = imageNodes.filter((img) => img.variantId === variant.id);
    const assignedImages = variantImageNodes.length > 0 ? variantImageNodes : imageNodes;
    const variantImages = assignedImages.map((img) => ({
      url: img.url,
      altText: img.alt || product.title,
      position: img.position ?? 1
    }));
    const variantNumId = numericShopifyId(variant.shopifyVariantId);
    const variantUrl = variantNumId ? `${productUrl}?variant=${variantNumId}` : productUrl;
    const comparePriceObj =
      compare != null && Number.isFinite(compare) ? { amount: compare, currency: "USD" } : null;

    return {
      id: toVariantGid(variant.shopifyVariantId),
      title: variant.title || variant.option1 || "",
      sku: variant.sku || "",
      position: variant.position ?? index + 1,
      price: { amount, currency: "USD" },
      compare_at_price: comparePriceObj,
      applicable_offer: variant.applicableOffer?.name || null,
      availableForSale: variant.availableForSale === true,
      inventoryQuantity: variant.inventoryQuantity,
      images: variantImages,
      url: variantUrl
    };
  });

  const activeOffer =
    variants.find((v) => v.applicable_offer && v.availableForSale)?.applicable_offer ||
    variants.find((v) => v.applicable_offer)?.applicable_offer ||
    null;

  return {
    id: toProductGid(product.shopifyProductId),
    handle: product.handle,
    title: product.title,
    url: productUrl,
    description: product.description || "",
    vendor: product.brand?.name || "",
    brand: product.brand?.name || "",
    productType: product.productType?.name || "",
    product_type: product.productType?.name || "",
    fragrance_family: product.fragranceFamily?.name || null,
    scent_type: product.scentType?.name || null,
    applicable_offer: activeOffer,
    key_notes: notes.key.join(", ") || null,
    top_notes: notes.top.join(", ") || null,
    middle_notes: notes.middle.join(", ") || null,
    base_notes: notes.base.join(", ") || null,
    tags: cardTags,
    availableForSale: variants.some((v) => v.availableForSale),
    variants,
    average_rating: product.review ? Number(product.review.averageRating) : null,
    total_reviews: product.review ? Number(product.review.totalReviews) : null,
    similarity
  };
}

/**
 * Loads product cards for the given local product ids, keeping their order.
 * @param {Map<string, object>} [extras] extra card fields per product id (e.g. match_type)
 */
export async function loadProductCards(ids = [], scores = new Map(), extras = new Map()) {
  if (!ids.length) return [];
  const products = await prisma.product.findMany({
    where: { id: { in: ids } },
    include: PRODUCT_INCLUDE
  });
  const byId = new Map(products.map((product) => [product.id, product]));
  return ids
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map((product) => ({ ...formatProductCard(product, scores.get(product.id) ?? null), ...extras.get(product.id) }));
}

/**
 * Load product cards from the local catalog by Shopify product or variant GID.
 */
export async function getLocalProductDetails(ids = []) {
  const variantIds = [];
  const productIds = [];

  for (const raw of ids) {
    const value = String(raw || "").trim();
    const numeric = numericShopifyId(value);
    if (!numeric) continue;
    if (/ProductVariant/i.test(value)) {
      variantIds.push(numeric);
    } else if (/\/Product\//i.test(value)) {
      productIds.push(numeric);
    } else {
      variantIds.push(numeric);
      productIds.push(numeric);
    }
  }

  const variantRows = variantIds.length
    ? await prisma.productVariant.findMany({
        where: { shopifyVariantId: { in: [...new Set(variantIds)] } },
        select: { shopifyProductId: true, shopifyVariantId: true }
      })
    : [];

  const shopifyProductIds = [
    ...new Set([...productIds, ...variantRows.map((row) => row.shopifyProductId)])
  ];

  if (!shopifyProductIds.length) return [];

  const products = await prisma.product.findMany({
    where: { shopifyProductId: { in: shopifyProductIds } },
    include: PRODUCT_INCLUDE
  });

  const productByShopifyId = new Map(products.map((product) => [product.shopifyProductId, product]));
  const variantToProduct = new Map(
    variantRows.map((row) => [row.shopifyVariantId, row.shopifyProductId])
  );

  const ordered = [];
  const seen = new Set();
  for (const raw of ids) {
    const numeric = numericShopifyId(raw);
    const shopifyProductId =
      variantToProduct.get(numeric) ||
      (productByShopifyId.has(numeric) ? numeric : null);
    if (!shopifyProductId || seen.has(shopifyProductId)) continue;
    const product = productByShopifyId.get(shopifyProductId);
    if (!product) continue;
    seen.add(shopifyProductId);
    ordered.push(formatProductCard(product));
  }

  for (const product of products) {
    if (seen.has(product.shopifyProductId)) continue;
    ordered.push(formatProductCard(product));
  }

  return ordered;
}
