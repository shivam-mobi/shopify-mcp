/**
 * Builds Meilisearch product documents from MySQL. Edit buildProductDocument to add
 * or change fields, list new filter/sort fields in products-index.config.js, then run
 * npm run meili:config && npm run meili:sync.
 */
import prisma from "../../db.server.js";
import { PRODUCT_EMBEDDER, PRODUCT_EMBEDDING_DIMENSIONS, POPULARITY } from "./products-index.config.js";
import { isVariantInStock, formatProductCard, PRODUCT_INCLUDE } from "./product-cards.server.js";

const DESCRIPTION_MAX_CHARS = 1200;

const DOCUMENT_INCLUDE = PRODUCT_INCLUDE;

/** Shopify tags that duplicate other fields or carry no meaning for search. */
const SKIPPED_TAG_PATTERN =
  /^(brand_|gender_|type_|topnote_|middlenote_|basenote_|keynote_|under \$|\$\d|\d+(\.\d+)?$)/i;

function tagsFromEmbeddingContent(content) {
  const line = String(content || "")
    .split("\n")
    .find((row) => row.startsWith("Tags:"));
  if (!line) return [];
  return line
    .slice("Tags:".length)
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function cleanDescription(text) {
  const plain = String(text || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > DESCRIPTION_MAX_CHARS ? `${plain.slice(0, DESCRIPTION_MAX_CHARS)}…` : plain;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

/** Store-wide numbers the popularity score needs (average rating, review volume). */
export async function loadPopularityStats() {
  const [row] = await prisma.$queryRawUnsafe(
    `SELECT SUM(r.average_rating * r.total_reviews) / NULLIF(SUM(r.total_reviews), 0) AS avgRating,
      MAX(r.total_reviews) AS maxReviews
FROM product_reviews r
INNER JOIN products p ON p.id = r.product_id
WHERE p.status = 'active'`
  );
  return {
    avgRating: row?.avgRating != null ? Number(row.avgRating) : 4,
    maxReviews: Number(row?.maxReviews || 0)
  };
}

function popularityScore({ rating, reviews, bestSeller }, stats) {
  const prior = POPULARITY.ratingPriorCount;
  const bayesian = (prior * stats.avgRating + (rating ?? stats.avgRating) * reviews) / (prior + reviews);
  const volume = stats.maxReviews ? Math.log1p(reviews) / Math.log1p(stats.maxReviews) : 0;
  const score =
    POPULARITY.reviewVolumeWeight * volume +
    POPULARITY.ratingWeight * (bayesian / 5) +
    POPULARITY.bestSellerWeight * (bestSeller ? 1 : 0);
  return Number(score.toFixed(5));
}

async function loadEmbeddings(ids) {
  if (!ids.length) return new Map();
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, VECTOR_TO_STRING(embedding) AS vector
FROM products
WHERE embedding IS NOT NULL AND id IN (${ids.map(() => "?").join(", ")})`,
    ...ids
  );
  const vectors = new Map();
  for (const row of rows) {
    try {
      const vector = JSON.parse(row.vector);
      if (Array.isArray(vector) && vector.length === PRODUCT_EMBEDDING_DIMENSIONS) {
        vectors.set(row.id, vector);
      }
    } catch {
      // missing vector: the product is still searchable by keyword
    }
  }
  return vectors;
}

export function buildProductDocument(product, vector, stats) {
  const variants = product.variants || [];
  const inStockVariants = variants.filter(isVariantInStock);
  const priced = (inStockVariants.length ? inStockVariants : variants)
    .map((variant) => ({
      price: Number(variant.price),
      compareAt: variant.compareAtPrice != null ? Number(variant.compareAtPrice) : null
    }))
    .filter((variant) => Number.isFinite(variant.price) && variant.price > 0);
  const prices = priced.map((variant) => variant.price);
  const price = prices.length ? Math.min(...prices) : null;
  const offerPrices = (inStockVariants.length ? inStockVariants : variants)
    .filter((variant) => Boolean(variant.applicableOfferId || variant.applicableOffer?.name))
    .map((variant) => Number(variant.price))
    .filter((amount) => Number.isFinite(amount) && amount > 0);
  const discounts = priced
    .filter((variant) => variant.compareAt && variant.compareAt > variant.price)
    .map((variant) => Math.round((1 - variant.price / variant.compareAt) * 100));

  const rawTags = tagsFromEmbeddingContent(product.embeddingContent);
  const lowerTags = rawTags.map((tag) => tag.toLowerCase());
  const collections = (product.categories || []).map((row) => row.category).filter(Boolean);
  const collectionHandles = collections.map((category) => category.handle);
  const bestSeller = collectionHandles.some((handle) =>
    handle.startsWith(POPULARITY.bestSellerCollectionPrefix)
  );
  const rating = product.review ? Number(product.review.averageRating) : null;
  const reviews = product.review ? Number(product.review.totalReviews) : 0;
  const gender = String(product.gender?.name || "").toLowerCase();

  return {
    id: product.id,
    shopify_product_id: product.shopifyProductId,
    handle: product.handle,
    title: product.title,
    brand: product.brand?.name || null,
    gender: gender || "unknown",
    kids:
      ["boys", "girls", "kids"].includes(gender) ||
      lowerTags.some((tag) => tag === "gender_kids" || tag === "type_kids" || tag.includes("kids")),
    product_type: product.productType?.name || null,
    fragrance_family: product.fragranceFamily?.name || null,
    scent_type: product.scentType?.name || null,
    applicable_offer:
      inStockVariants.find((v) => v.applicableOffer?.name)?.applicableOffer?.name ||
      variants.find((v) => v.applicableOffer?.name)?.applicableOffer?.name ||
      null,
    notes: unique((product.notes || []).map((row) => row.note?.name)),
    key_notes: unique(
      (product.notes || []).filter((row) => row.type?.code === "key").map((row) => row.note?.name)
    ),
    collections: unique(collections.map((category) => category.name)),
    collection_handles: unique(collectionHandles),
    tags: unique(rawTags.filter((tag) => !SKIPPED_TAG_PATTERN.test(tag))),
    description: cleanDescription(product.description),
    price,
    max_price: prices.length ? Math.max(...prices) : null,
    /** Every in-stock size's price, so a budget matches a product when any size fits it. */
    variant_prices: inStockVariants.length ? unique(prices) : [],
    offer_variant_prices: unique(offerPrices),
    on_sale: discounts.length > 0,
    discount_percent: discounts.length ? Math.max(...discounts) : 0,
    in_stock: inStockVariants.length > 0,
    online_only: lowerTags.includes("online-only-item"),
    rating,
    review_count: reviews,
    best_seller: bestSeller,
    popularity: popularityScore({ rating, reviews, bestSeller }, stats),
    created_at: Math.floor(new Date(product.createdAt).getTime() / 1000),
    card: formatProductCard(product),
    _vectors: { [PRODUCT_EMBEDDER]: vector || null }
  };
}

/**
 * Yields batches of documents for active products.
 * @param {{ handles?: string[], batchSize?: number }} options
 */
export async function* productDocumentBatches({ handles = [], batchSize = 250 } = {}) {
  const stats = await loadPopularityStats();
  const where = { status: "active", ...(handles.length ? { handle: { in: handles } } : {}) };
  let cursor = null;
  for (;;) {
    const products = await prisma.product.findMany({
      where,
      include: DOCUMENT_INCLUDE,
      orderBy: { id: "asc" },
      take: batchSize,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {})
    });
    if (!products.length) return;
    const vectors = await loadEmbeddings(products.map((product) => product.id));
    yield products.map((product) => buildProductDocument(product, vectors.get(product.id), stats));
    if (products.length < batchSize) return;
    cursor = products[products.length - 1].id;
  }
}
