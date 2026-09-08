/**
 * Product comparison helpers for fitment/catalog results.
 * Derives filter attributes from Shopify tags/title/description and ranks a "best" pick.
 */
import { toVariantGid } from "./shopify-products.server.js";

export const PRODUCT_LISTING_CART_INSTRUCTION =
  "When the customer asks to add the best pick, best product, or top recommendation, " +
  "call add_to_cart with best_pick_variant_id from THIS tool result only (the product where is_best_pick is true — may differ from position 1). " +
  "For 'first product' or '#1', use first_product_variant_id (position 1 in the list). " +
  "For 'add product #2' or 'second one', use the product where position=2 and pass its variant_id. " +
  "If the customer message includes variant_id: gid://shopify/ProductVariant/..., use THAT exact variant_id — do not substitute another scent/product. " +
  "Match by products[].title when they name a scent or product (e.g. Black Rock vs Fresh Linen) — titles are for matching only, never list them in chat. " +
  "Never use variant_ids from older product searches earlier in this conversation.";

/** Vendors shown first in the product list (display order only — not used for best pick). */
const PREFERRED_DISPLAY_FIRST_VENDORS = ["FEBREZE"];

export function normalizeVendorName(vendor = "") {
  return String(vendor || "").trim().toUpperCase();
}

export function isPreferredDisplayFirstVendor(vendor = "") {
  const normalized = normalizeVendorName(vendor);
  if (!normalized) return false;
  return PREFERRED_DISPLAY_FIRST_VENDORS.some(
    (preferred) => normalized === preferred || normalized.includes(preferred)
  );
}

/** @deprecated Use isPreferredDisplayFirstVendor — kept for callers that only need display ordering. */
export function isPreferredBestPickVendor(vendor = "") {
  return isPreferredDisplayFirstVendor(vendor);
}

function normalizeTagList(tags) {
  if (Array.isArray(tags)) {
    return tags.map((tag) => String(tag || "").trim()).filter(Boolean);
  }
  if (typeof tags === "string") {
    return tags
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean);
  }
  return [];
}

function stripHtml(html = "") {
  return String(html)
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parsePriceNumber(price) {
  if (typeof price === "number" && Number.isFinite(price)) return price;
  if (price == null) return null;
  const match = String(price).replace(/,/g, "").match(/(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : null;
}

/**
 * Build comparison attributes from Shopify product fields.
 */
export function buildCompareAttributes({
  tags = [],
  title = "",
  descriptionHtml = "",
  vendor = "",
  sku = ""
} = {}) {
  const tagList = normalizeTagList(tags);
  const tagBlob = tagList.map((tag) => tag.toLowerCase()).join(" | ");
  const textBlob = `${title} ${stripHtml(descriptionHtml)} ${tagBlob}`.toLowerCase();

  const isHepa =
    /\bhepa\b/i.test(tagBlob) && !/\bnon[-_]?hepa\b/i.test(tagBlob)
      ? true
      : /\bnon[-_]?hepa\b/i.test(tagBlob)
        ? false
        : /\bhepa\b/i.test(textBlob) && !/\bnon[-_]?hepa\b/i.test(textBlob);

  const hasAntibacterial = /antibacterial|anti[- ]bacterial|micro technology/i.test(textBlob);
  const hasCharcoal = /charcoal|activated carbon|odor/i.test(textBlob);
  const hasParticulate = /particulate|pollen|dust/i.test(textBlob);

  const yGroupTag = tagList.find((tag) => /^YGroup_/i.test(tag));
  const yGroup = yGroupTag ? yGroupTag.replace(/^YGroup_/i, "").trim() : "";

  const filterType = isHepa
    ? "hepa"
    : /\bnon[-_]?hepa\b/i.test(tagBlob)
      ? "non-hepa"
      : hasCharcoal
        ? "charcoal"
        : "standard";

  const features = [];
  if (isHepa) features.push("HEPA filtration");
  if (hasParticulate) features.push("Particulate / pollen capture");
  if (hasCharcoal) features.push("Activated charcoal / odor control");
  if (hasAntibacterial) features.push("Antibacterial technology");
  if (!features.length && descriptionHtml) {
    const plain = stripHtml(descriptionHtml);
    if (plain) features.push(plain.slice(0, 120) + (plain.length > 120 ? "…" : ""));
  }

  return {
    vendor: vendor || "",
    sku: sku || "",
    filterType,
    isHepa: Boolean(isHepa),
    hasAntibacterial,
    hasCharcoal,
    hasParticulate,
    yGroup,
    features: features.slice(0, 4),
    tags: tagList
  };
}

/**
 * Rank score used to pick the "best" product in a result set.
 */
export function scoreProductForComparison(product = {}) {
  let score = 0;

  if (product.inStock === true && product.availableForSale !== false) score += 40;
  if (product.isHepa === true) score += 30;
  if (product.hasAntibacterial === true) score += 15;
  if (product.hasCharcoal === true) score += 10;
  if (product.hasParticulate === true) score += 5;

  const price = parsePriceNumber(product.priceAmount ?? product.price);
  if (price != null) {
    // Mild preference for lower price among similar quality
    score += Math.max(0, 20 - Math.min(price, 20));
  }

  return score;
}

function buildBestReason(product) {
  const reasons = [];
  if (product.isHepa) reasons.push("HEPA");
  if (product.hasAntibacterial) reasons.push("antibacterial");
  if (product.hasCharcoal) reasons.push("odor control");
  if (product.inStock) reasons.push("in stock");
  if (!reasons.length) return "Best overall match";
  return `Best pick: ${reasons.join(" · ")}`;
}

function productIdentityKey(product = {}) {
  return resolveProductVariantId(product) || product.partNumber || product.sku || product.id || null;
}

function pickBestProduct(products = []) {
  if (!products.length) return null;

  const inStock = products.filter(
    (product) => product.inStock === true && product.availableForSale !== false
  );
  const pool = inStock.length ? inStock : products;

  return pool.reduce((best, product) => {
    const bestScore = best?.compareScore || 0;
    const productScore = product?.compareScore || 0;
    return productScore > bestScore ? product : best;
  }, pool[0]);
}

function sortProductsForDisplay(products = []) {
  return [...products].sort((a, b) => {
    const displayFirstDiff =
      Number(isPreferredDisplayFirstVendor(b.vendor)) -
      Number(isPreferredDisplayFirstVendor(a.vendor));
    if (displayFirstDiff !== 0) return displayFirstDiff;

    const stockDiff = Number(b.inStock === true) - Number(a.inStock === true);
    if (stockDiff !== 0) return stockDiff;

    return (b.compareScore || 0) - (a.compareScore || 0);
  });
}

/**
 * Enrich products with compare fields, sort for display (Febreze first), mark isBest by neutral score.
 */
export function enrichProductsWithComparison(products = []) {
  if (!Array.isArray(products) || products.length === 0) {
    return [];
  }

  const enriched = products.map((product) => {
    const attrs =
      product.filterType != null || product.isHepa != null
        ? {
            vendor: product.vendor || "",
            sku: product.sku || product.partNumber || "",
            filterType: product.filterType || "standard",
            isHepa: product.isHepa === true,
            hasAntibacterial: product.hasAntibacterial === true,
            hasCharcoal: product.hasCharcoal === true,
            hasParticulate: product.hasParticulate === true,
            yGroup: product.yGroup || "",
            features: Array.isArray(product.features) ? product.features : [],
            tags: Array.isArray(product.tags) ? product.tags : []
          }
        : buildCompareAttributes({
            tags: product.tags,
            title: product.title,
            descriptionHtml: product.descriptionHtml || product.description || "",
            vendor: product.vendor,
            sku: product.sku || product.partNumber
          });

    const merged = {
      ...product,
      ...attrs,
      priceAmount:
        typeof product.priceAmount === "number"
          ? product.priceAmount
          : parsePriceNumber(product.price),
      isBest: false,
      bestReason: null,
      compareScore: 0
    };

    merged.compareScore = scoreProductForComparison(merged);
    return merged;
  });

  const bestProduct = pickBestProduct(enriched);
  const bestKey = bestProduct ? productIdentityKey(bestProduct) : null;
  const sorted = sortProductsForDisplay(enriched);

  return sorted.map((product) => {
    const key = productIdentityKey(product);
    const isBest = Boolean(bestKey && key && key === bestKey);

    return {
      ...product,
      isBest,
      bestReason: isBest ? buildBestReason(product) : null
    };
  });
}

/**
 * Normalize variant id from a product record to a ProductVariant GID.
 */
export function resolveProductVariantId(product = {}) {
  const raw = product.variant_id || product.variantId || product.id || null;
  return toVariantGid(raw);
}

/**
 * Add position, variant_id, and is_best_pick to each ranked product for LLM tool history.
 */
export function annotateRankedProductsForLlm(rankedProducts = []) {
  return rankedProducts.map((product, index) => ({
    ...product,
    position: index + 1,
    variant_id: resolveProductVariantId(product),
    is_best_pick: product.isBest === true
  }));
}

/**
 * Minimal product rows for LLM tool history — cart/add matching only, not for chat display.
 * Includes title so similar variants (e.g. freshener scents) can be matched correctly.
 * Omits price, description, and features so the model does not repeat the UI cards.
 */
export function buildLlmProductSummary(rankedProducts = []) {
  return rankedProducts.map((product, index) => {
    const pdfUrl = String(product.pdfUrl || product.pdf_url || "").trim() || null;
    const youtubeUrl = String(product.youtubeUrl || product.youtube_url || "").trim() || null;
    const pdfTitle = String(product.pdfTitle || product.pdf_title || "").trim() || null;
    const title = String(product.title || product.name || "").trim() || null;

    return {
      position: index + 1,
      variant_id: resolveProductVariantId(product),
      title,
      is_best_pick: product.isBest === true,
      inStock: product.inStock === true,
      filterType: product.filterType || null,
      vendor: product.vendor || null,
      ...(pdfUrl
        ? {
            installation_pdf_url: pdfUrl,
            installation_pdf_title: pdfTitle || "Installation Guide (PDF)"
          }
        : {}),
      ...(youtubeUrl ? { installation_video_url: youtubeUrl } : {})
    };
  });
}

/**
 * Best pick / first product metadata for LLM cart adds (hidden from storefront UI).
 */
export function buildProductListingMetadata(rankedProducts = []) {
  const best = rankedProducts.find((p) => p.isBest) || rankedProducts[0] || null;
  const first = rankedProducts[0] || null;
  const bestVariantId = best ? resolveProductVariantId(best) : null;
  const firstVariantId = first ? resolveProductVariantId(first) : null;

  return {
    best_pick_variant_id: bestVariantId,
    best_pick_title: best?.title || null,
    first_product_variant_id: firstVariantId,
    bestProductId: bestVariantId,
    bestProductTitle: best?.title || null,
    cart_instruction: PRODUCT_LISTING_CART_INSTRUCTION
  };
}

export default {
  buildCompareAttributes,
  scoreProductForComparison,
  enrichProductsWithComparison,
  resolveProductVariantId,
  annotateRankedProductsForLlm,
  buildLlmProductSummary,
  buildProductListingMetadata,
  normalizeVendorName,
  isPreferredDisplayFirstVendor,
  isPreferredBestPickVendor,
  PRODUCT_LISTING_CART_INSTRUCTION
};
