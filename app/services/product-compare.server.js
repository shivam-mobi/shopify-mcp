/**
 * Product comparison helpers for fitment/catalog results.
 * Derives filter attributes from Shopify tags/title/description and ranks a "best" pick.
 */

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

/**
 * Enrich products with compare fields, sort (best first among in-stock), mark isBest.
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

  enriched.sort((a, b) => {
    const stockDiff = Number(b.inStock === true) - Number(a.inStock === true);
    if (stockDiff !== 0) return stockDiff;
    return (b.compareScore || 0) - (a.compareScore || 0);
  });

  if (enriched.length > 0) {
    enriched[0].isBest = true;
    enriched[0].bestReason = buildBestReason(enriched[0]);
  }

  return enriched;
}

export default {
  buildCompareAttributes,
  scoreProductForComparison,
  enrichProductsWithComparison
};
