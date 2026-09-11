/**
 * Product listing helpers for catalog search results.
 * Formats variant IDs and display order for Top Matching Products cards.
 */
function toVariantGid(variantId) {
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

export const PRODUCT_LISTING_CART_INSTRUCTION =
  "When the customer asks to add the first product, first card, #1, or top matching product, " +
  "call add_to_cart with first_product_variant_id from THIS tool result only (position 1 in the list). " +
  "For 'add product #2' or 'second one', use the product where position=2 and pass its variant_id. " +
  "If the customer message includes variant_id: gid://shopify/ProductVariant/..., use THAT exact variant_id — do not substitute another product. " +
  "Match by products[].title when they name a product — titles are for matching only, never list them in chat. " +
  "Never use variant_ids from older product searches earlier in this conversation.";

/** Vendors shown first in the product list (display order only). */
const PREFERRED_DISPLAY_FIRST_VENDORS = [];

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

/**
 * MCP catalog often nests copy as description: { html: "..." }.
 * Admin / fitment use descriptionHtml or a plain string.
 */
export function resolveProductDescriptionHtml(product = {}) {
  if (!product || typeof product !== "object") {
    return "";
  }

  const candidates = [
    product.descriptionHtml,
    product.body_html,
    product.bodyHtml,
    typeof product.description === "string" ? product.description : null,
    product.description?.html,
    product.description?.body,
    product.description?.text,
    typeof product.note === "string" ? product.note : null
  ];

  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }

  return "";
}

function parsePriceNumber(price) {
  if (typeof price === "number" && Number.isFinite(price)) return price;
  if (price == null) return null;
  const match = String(price).replace(/,/g, "").match(/(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : null;
}

const KNOWN_FRESHENER_SCENTS =
  /fresh\s*linen|black\s*rock|vanilla\s*orchid|tropical\s*peach|new\s*car|lavender/i;

/**
 * Detect cabin-filter air fresheners so compare uses scent attrs, not HEPA/charcoal.
 * Cabin / home filters must not match this.
 */
export function isFreshenerProduct({
  tags = [],
  title = "",
  productType = "",
  product_type = ""
} = {}) {
  const type = String(productType || product_type || "").trim();
  if (/freshener|freshers/i.test(type)) return true;

  const tagList = normalizeTagList(tags);
  if (
    tagList.some(
      (tag) =>
        /^scent$/i.test(tag) ||
        /^YGroup_Scent$/i.test(tag) ||
        /^freshener/i.test(tag)
    )
  ) {
    return true;
  }

  return /\b(air\s*)?fresheners?\b/i.test(String(title || ""));
}

function extractFragrance(title = "") {
  const raw = String(title || "").trim();
  if (!raw) return null;

  const known = raw.match(KNOWN_FRESHENER_SCENTS);
  if (known) {
    return known[0].replace(/\s+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }

  const parts = raw.split(/\s+[-–—]\s+/);
  if (parts.length >= 2) {
    const last = parts[parts.length - 1].trim();
    if (last && last.length <= 40 && !/^\d+\s*-?\s*pack\b/i.test(last)) {
      return last;
    }
  }

  return null;
}

function extractDurationDays(text = "") {
  const match = String(text || "").match(/up\s+to\s+(\d+)\s*days?|(\d+)\s*days?/i);
  if (!match) return null;
  const days = Number(match[1] || match[2]);
  return Number.isFinite(days) ? days : null;
}

function buildFreshenerCompareAttributes({
  tags = [],
  title = "",
  descriptionHtml = "",
  vendor = "",
  sku = ""
} = {}) {
  const tagList = normalizeTagList(tags);
  const plain = stripHtml(descriptionHtml);
  const textBlob = `${title} ${plain}`.toLowerCase();

  const fragrance = extractFragrance(title);
  const durationDays = extractDurationDays(`${title} ${plain}`);
  const hasOdorEliminator =
    /odor\s*(eliminat|neutraliz)|odor\s*control|neutraliz(?:er|ing)?\s+technolog/i.test(
      textBlob
    );

  const yGroupTag = tagList.find((tag) => /^YGroup_/i.test(tag));
  const yGroup = yGroupTag ? yGroupTag.replace(/^YGroup_/i, "").trim() : "";

  const features = [];
  if (fragrance) features.push(`Fragrance: ${fragrance}`);
  if (durationDays != null) features.push(`Up to ${durationDays} days`);
  if (hasOdorEliminator) features.push("Odor eliminator / neutralizer");

  return {
    vendor: vendor || "",
    sku: sku || "",
    productCategory: "freshener",
    fragrance: fragrance || null,
    durationDays,
    hasOdorEliminator,
    // Keep filter fields falsey so UI/scoring never treat fresheners as filters.
    filterType: "freshener",
    isHepa: false,
    hasAntibacterial: false,
    hasCharcoal: false,
    hasParticulate: false,
    yGroup,
    features: features.slice(0, 4),
    tags: tagList
  };
}

/**
 * Build comparison attributes from Shopify product fields.
 * Fresheners → fragrance / duration / odor eliminator.
 * Filters → HEPA / charcoal / antibacterial (unchanged).
 */
export function buildCompareAttributes({
  tags = [],
  title = "",
  descriptionHtml = "",
  vendor = "",
  sku = "",
  productType = "",
  product_type = ""
} = {}) {
  if (
    isFreshenerProduct({
      tags,
      title,
      productType,
      product_type
    })
  ) {
    return buildFreshenerCompareAttributes({
      tags,
      title,
      descriptionHtml,
      vendor,
      sku
    });
  }

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
    productCategory: "filter",
    fragrance: null,
    durationDays: null,
    hasOdorEliminator: false,
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

function sortProductsForDisplay(products = []) {
  return [...products].sort((a, b) => {
    const displayFirstDiff =
      Number(isPreferredDisplayFirstVendor(b.vendor)) -
      Number(isPreferredDisplayFirstVendor(a.vendor));
    if (displayFirstDiff !== 0) return displayFirstDiff;

    return Number(b.inStock === true) - Number(a.inStock === true);
  });
}

/**
 * Format catalog products for Top Matching Products cards (in-stock first).
 */
export function enrichProductsWithComparison(products = []) {
  if (!Array.isArray(products) || products.length === 0) {
    return [];
  }

  const enriched = products.map((product) => {
    const looksFreshener = isFreshenerProduct(product);
    // Recompute fresheners even if stale filter attrs were copied earlier.
    const hasFilterAttrs =
      !looksFreshener &&
      product.productCategory !== "freshener" &&
      (product.filterType != null || product.isHepa != null);

    const attrs = hasFilterAttrs
      ? {
          vendor: product.vendor || "",
          sku: product.sku || product.partNumber || "",
          productCategory: product.productCategory || "filter",
          fragrance: product.fragrance || null,
          durationDays:
            typeof product.durationDays === "number" ? product.durationDays : null,
          hasOdorEliminator: product.hasOdorEliminator === true,
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
          descriptionHtml: resolveProductDescriptionHtml(product),
          vendor: product.vendor,
          sku: product.sku || product.partNumber,
          productType: product.productType || product.product_type || "",
          product_type: product.product_type || product.productType || ""
        });

    return {
      ...product,
      ...attrs,
      priceAmount:
        typeof product.priceAmount === "number"
          ? product.priceAmount
          : parsePriceNumber(product.price)
    };
  });

  return sortProductsForDisplay(enriched);
}

/**
 * Normalize variant id from a product record to a ProductVariant GID.
 */
export function resolveProductVariantId(product = {}) {
  const raw = product.variant_id || product.variantId || product.id || null;
  return toVariantGid(raw);
}

/**
 * Add position and variant_id to each listed product for LLM tool history.
 */
export function annotateRankedProductsForLlm(rankedProducts = []) {
  return rankedProducts.map((product, index) => ({
    ...product,
    position: index + 1,
    variant_id: resolveProductVariantId(product)
  }));
}

/**
 * Minimal product rows for LLM tool history — cart/add matching only, not for chat display.
 * Includes title so similar variants (e.g. freshener scents) can be matched correctly.
 * Omits price, description, and features so the model does not repeat the UI cards.
 */
export function buildLlmProductSummary(rankedProducts = []) {
  return rankedProducts.map((product, index) => {
    const title = String(product.title || product.name || "").trim() || null;

    return {
      position: index + 1,
      variant_id: resolveProductVariantId(product),
      title,
      inStock: product.inStock === true,
      filterType: product.filterType || null,
      productCategory: product.productCategory || null,
      fragrance: product.fragrance || null,
      durationDays:
        typeof product.durationDays === "number" ? product.durationDays : null,
      hasOdorEliminator: product.hasOdorEliminator === true ? true : null,
      vendor: product.vendor || null
    };
  });
}

/**
 * First-product metadata for LLM cart adds (hidden from storefront UI).
 */
export function buildProductListingMetadata(rankedProducts = []) {
  const first = rankedProducts[0] || null;
  const firstVariantId = first ? resolveProductVariantId(first) : null;

  return {
    first_product_variant_id: firstVariantId,
    cart_instruction: PRODUCT_LISTING_CART_INSTRUCTION
  };
}

export default {
  buildCompareAttributes,
  isFreshenerProduct,
  resolveProductDescriptionHtml,
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
