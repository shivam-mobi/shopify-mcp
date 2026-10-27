/**
 * Local product catalog search (MySQL products + vector rank).
 * Accepts the same catalog.query / filters / pagination shape as Shopify search_catalog,
 * plus Perfumania filters (brand, product_type, fragrance_family, scent_type, notes, category, applicable_offer, must_match).
 */
import prisma from "../db.server.js";
import { generateEmbedding, getEmbeddingModel, dotProduct } from "./embeddings.server.js";
import { normalizeCatalogSearchArgs } from "./catalog-search-args.server.js";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const STOREFRONT_URL = (process.env.STOREFRONT_URL || "").replace(/\/+$/, "");
const APPLICABLE_OFFERS = [
  "3 For $20",
  "2 For $25",
  "BOGO 50",
  "3 For $99",
  "2 For $75",
  "3 For $129"
];

function normalizeOfferKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function normalizeApplicableOffer(value) {
  const key = normalizeOfferKey(value);
  if (!key) return "";
  return APPLICABLE_OFFERS.find((name) => normalizeOfferKey(name) === key) || "";
}

const PRODUCT_INCLUDE = {
  brand: true,
  gender: true,
  productType: true,
  fragranceFamily: true,
  scentType: true,
  applicableOffer: true,
  variants: { orderBy: { position: "asc" } },
  images: { orderBy: { position: "asc" } },
  notes: {
    include: { note: true, type: true },
    orderBy: [{ type: { position: "asc" } }, { position: "asc" }]
  },
  categories: { include: { category: true } },
  review: true
};

function toCents(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function asList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || "").trim()).filter(Boolean);
  }
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeGender(value) {
  const g = String(value || "")
    .toLowerCase()
    .trim();
  if (g === "men" || g === "man" || g === "mens") return "men";
  if (g === "women" || g === "woman" || g === "womens") return "women";
  if (g === "unisex") return "unisex";
  if (g === "null" || g === "none" || g === "undefined") return null;
  return null;
}

export function parseLocalCatalogSearchArgs(input = {}) {
  const normalized = normalizeCatalogSearchArgs(input) || {};
  const catalog =
    normalized.catalog && typeof normalized.catalog === "object"
      ? normalized.catalog
      : normalized;
  const filters = catalog.filters && typeof catalog.filters === "object" ? catalog.filters : {};
  const pagination =
    catalog.pagination && typeof catalog.pagination === "object" ? catalog.pagination : {};
  const price = filters.price && typeof filters.price === "object" ? filters.price : {};

  let limit = Number(pagination.limit ?? input.limit);
  if (!Number.isFinite(limit) || limit < 1) limit = DEFAULT_LIMIT;
  limit = Math.min(Math.floor(limit), MAX_LIMIT);

  let offset = 0;
  const cursor = String(pagination.cursor || input.cursor || "").trim();
  if (cursor) {
    const n = Number(cursor);
    if (Number.isFinite(n) && n >= 0) offset = Math.floor(n);
  }

  return {
    query: String(catalog.query || input.query || "").trim(),
    gender: normalizeGender(filters.gender || input.gender),
    brand: String(filters.brand || input.brand || "").trim(),
    productType: String(filters.product_type || filters.productType || input.product_type || "").trim(),
    fragranceFamily: String(
      filters.fragrance_family || filters.fragranceFamily || input.fragrance_family || ""
    ).trim(),
    scentType: String(filters.scent_type || filters.scentType || input.scent_type || "").trim(),
    notes: asList(filters.notes || input.notes),
    category: String(filters.category || filters.collection || input.category || "").trim(),
    applicableOffer: normalizeApplicableOffer(
      filters.applicable_offer || filters.applicableOffer || input.applicable_offer
    ),
    mustMatch: asList(filters.must_match || filters.mustMatch || input.must_match),
    minCents: toCents(price.min ?? input.price_min),
    maxCents: toCents(price.max ?? input.price_max),
    limit,
    offset
  };
}

const BRAND_CACHE_MS = 10 * 60 * 1000;
const BRAND_MATCH_MIN = 0.8;
const QUERY_FILLER = new Set([
  "i",
  "want",
  "to",
  "buy",
  "bu",
  "get",
  "me",
  "a",
  "an",
  "the",
  "for",
  "some",
  "please",
  "pls",
  "need",
  "looking",
  "perfume",
  "cologne",
  "fragrance",
  "fragrances",
  "perfumes",
  "colognes",
  "of",
  "my",
  "and",
  "have",
  "show",
  "more"
]);

let brandNameCache = null;
let brandCacheAt = 0;

function normalizeWords(text, dropFiller = false) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word && (!dropFiller || !QUERY_FILLER.has(word)));
}

async function getBrandNames() {
  if (brandNameCache && Date.now() - brandCacheAt < BRAND_CACHE_MS) {
    return brandNameCache;
  }
  const rows = await prisma.brand.findMany({ select: { name: true } });
  brandNameCache = rows
    .map((row) => {
      const name = String(row.name || "").trim();
      const tokens = normalizeWords(name);
      if (!name || !tokens.length) return null;
      return { name, tokens, compact: tokens.join("") };
    })
    .filter(Boolean);
  brandCacheAt = Date.now();
  return brandNameCache;
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const n = a.length;
  const m = b.length;
  if (!n) return m;
  if (!m) return n;
  const d = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 0; i <= n; i++) d[i][0] = i;
  for (let j = 0; j <= m; j++) d[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[n][m];
}

function tokenSimilarity(left, right) {
  if (left === right) return 1;
  if (!left || !right) return 0;
  const maxLen = Math.max(left.length, right.length);
  const minLen = Math.min(left.length, right.length);
  if (!maxLen || minLen / maxLen < BRAND_MATCH_MIN) return 0;
  return 1 - levenshtein(left, right) / maxLen;
}

function bestTokenScore(queryTokens, brandToken) {
  let best = 0;
  for (const queryToken of queryTokens) {
    const score = tokenSimilarity(queryToken, brandToken);
    if (score > best) best = score;
    if (best === 1) return best;
  }
  return best;
}

function requiredBrandTokens(tokens) {
  const required = tokens.filter((token) => !QUERY_FILLER.has(token));
  return required.length ? required : tokens;
}

function pickBestBrand(hits) {
  let best = null;
  for (const hit of hits) {
    if (
      !best ||
      hit.matchedWords > best.matchedWords ||
      (hit.matchedWords === best.matchedWords && hit.score > best.score)
    ) {
      best = hit;
    }
  }
  return best?.name || null;
}

function sequenceMatches(queryTokens, slice) {
  if (slice.length > queryTokens.length) return false;
  for (let i = 0; i <= queryTokens.length - slice.length; i++) {
    let ok = true;
    for (let k = 0; k < slice.length; k++) {
      if (tokenSimilarity(queryTokens[i + k], slice[k]) < BRAND_MATCH_MIN) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

function identityBrandHits(queryTokens, queryCompact, brands) {
  const queryJoined = queryTokens.join(" ");
  const hits = [];
  for (const brand of brands) {
    const brandJoined = brand.tokens.join(" ");
    const sameTokens = brandJoined === queryJoined;
    const sameCompact =
      brand.compact === queryCompact && brand.tokens.length === queryTokens.length;
    if (!sameTokens && !sameCompact) continue;
    hits.push({ name: brand.name, matchedWords: brand.tokens.length, score: 1 });
  }
  return hits;
}

function exactBrandHits(queryTokens, queryCompact, brands) {
  const queryJoined = ` ${queryTokens.join(" ")} `;
  const hits = [];
  for (const brand of brands) {
    const required = requiredBrandTokens(brand.tokens);
    const allExact = required.every((token) => queryTokens.includes(token));
    const compactHit =
      queryTokens.includes(brand.compact) || queryCompact === brand.compact;
    const phraseHit = queryJoined.includes(` ${brand.tokens.join(" ")} `);
    if (!allExact && !compactHit && !phraseHit) continue;
    hits.push({ name: brand.name, matchedWords: required.length, score: 1 });
  }
  return hits;
}

function fuzzyBrandHits(queryTokens, brands) {
  const hits = [];
  for (const brand of brands) {
    const required = requiredBrandTokens(brand.tokens);
    let matchedWords = 0;
    let total = 0;
    for (const token of required) {
      const best = bestTokenScore(queryTokens, token);
      total += best;
      if (best >= BRAND_MATCH_MIN) matchedWords += 1;
    }
    if (!required.length || matchedWords !== required.length) continue;
    hits.push({
      name: brand.name,
      matchedWords,
      score: total / required.length
    });
  }
  return hits;
}

function partialBrandHits(queryTokens, brands) {
  const hits = [];
  for (const brand of brands) {
    const required = requiredBrandTokens(brand.tokens);
    if (required.length < 2) continue;
    let bestRun = 0;
    for (let start = 0; start < required.length; start++) {
      for (let end = start + 2; end <= required.length; end++) {
        const slice = required.slice(start, end);
        if (sequenceMatches(queryTokens, slice)) {
          bestRun = Math.max(bestRun, slice.length);
        }
      }
    }
    if (bestRun < 2) continue;
    hits.push({
      name: brand.name,
      matchedWords: bestRun,
      score: bestRun / required.length
    });
  }
  return hits;
}

export async function detectBrandFromQuery(text) {
  const queryTokens = normalizeWords(text, true);
  if (!queryTokens.length) return null;
  const brands = await getBrandNames();
  const queryCompact = queryTokens.join("");
  return (
    pickBestBrand(identityBrandHits(queryTokens, queryCompact, brands)) ||
    pickBestBrand(exactBrandHits(queryTokens, queryCompact, brands)) ||
    pickBestBrand(fuzzyBrandHits(queryTokens, brands)) ||
    pickBestBrand(partialBrandHits(queryTokens, brands))
  );
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

function formatLocalProduct(product, similarity = null) {
  const notes = notesByType(product.notes);
  const genderName = product.gender?.name || "";
  const genderTag = genderName ? `gender_${genderName.toLowerCase().replace(/\s+/g, "_")}` : null;
  const imageNodes = (product.images || []).filter((img) => img.url);
  const variants = (product.variants || []).map((variant) => {
    const amount = Math.round(Number(variant.price) * 100);
    const compare =
      variant.compareAtPrice != null ? Math.round(Number(variant.compareAtPrice) * 100) : null;
    const image = imageNodes.find((img) => img.variantId === variant.id) || imageNodes[0];
    return {
      id: toVariantGid(variant.shopifyVariantId),
      title: variant.title || variant.option1 || "",
      sku: variant.sku || "",
      price: { amount, currency: "USD" },
      list_price:
        compare != null && Number.isFinite(compare) ? { amount: compare, currency: "USD" } : null,
      availableForSale: variant.availableForSale === true,
      inventoryQuantity: variant.inventoryQuantity,
      image: image?.url ? { url: image.url, altText: image.alt || product.title } : null
    };
  });

  return {
    id: toProductGid(product.shopifyProductId),
    handle: product.handle,
    title: product.title,
    url: STOREFRONT_URL ? `${STOREFRONT_URL}/products/${product.handle}` : `/products/${product.handle}`,
    description: product.description || "",
    vendor: product.brand?.name || "",
    brand: product.brand?.name || "",
    productType: product.productType?.name || "",
    product_type: product.productType?.name || "",
    fragrance_family: product.fragranceFamily?.name || null,
    scent_type: product.scentType?.name || null,
    applicable_offer: product.applicableOffer?.name || null,
    key_notes: notes.key.join(", ") || null,
    top_notes: notes.top.join(", ") || null,
    middle_notes: notes.middle.join(", ") || null,
    base_notes: notes.base.join(", ") || null,
    tags: genderTag ? [genderTag] : [],
    availableForSale: variants.some((v) => v.availableForSale),
    media: imageNodes.map((img) => ({ type: "image", url: img.url })),
    images: imageNodes.map((img) => ({ url: img.url, alt: img.alt })),
    variants,
    average_rating: product.review ? Number(product.review.averageRating) : null,
    total_reviews: product.review ? Number(product.review.totalReviews) : null,
    similarity
  };
}

function interpolateSql(sql, params = []) {
  let index = 0;
  return String(sql).replace(/\?/g, () => {
    const value = params[index++];
    if (value === undefined) return "?";
    if (value === null) return "NULL";
    if (typeof value === "number") return String(value);
    return `'${String(value).replace(/'/g, "''")}'`;
  });
}

function compactDbProduct(product) {
  return {
    id: product.id,
    shopifyProductId: product.shopifyProductId,
    handle: product.handle,
    title: product.title,
    status: product.status,
    brand: product.brand?.name || null,
    gender: product.gender?.name || null,
    productType: product.productType?.name || null,
    fragranceFamily: product.fragranceFamily?.name || null,
    scentType: product.scentType?.name || null,
    applicableOffer: product.applicableOffer?.name || null,
    variantCount: Array.isArray(product.variants) ? product.variants.length : 0,
    variants: (product.variants || []).map((variant) => ({
      id: variant.id,
      shopifyVariantId: variant.shopifyVariantId,
      title: variant.title,
      price: variant.price != null ? String(variant.price) : null,
      availableForSale: variant.availableForSale === true,
      inventoryQuantity: variant.inventoryQuantity
    }))
  };
}

function buildFilterSql(args) {
  const where = [`p.status = 'active'`, `p.embedding IS NOT NULL`];
  const params = [];

  if (args.gender) {
    if (args.gender === "unisex") {
      where.push(`(LOWER(g.name) = 'unisex' OR p.gender_id IS NULL)`);
    } else {
      where.push(`(LOWER(g.name) = ? OR LOWER(g.name) = 'unisex' OR p.gender_id IS NULL)`);
      params.push(args.gender);
    }
  }

  if (args.brand) {
    where.push(`LOWER(b.name) LIKE ?`);
    params.push(`%${args.brand.toLowerCase()}%`);
  }

  if (args.productType) {
    where.push(`LOWER(pt.name) LIKE ?`);
    params.push(`%${args.productType.toLowerCase()}%`);
  }

  if (args.fragranceFamily) {
    where.push(`LOWER(ff.name) LIKE ?`);
    params.push(`%${args.fragranceFamily.toLowerCase()}%`);
  }

  if (args.scentType) {
    where.push(`LOWER(st.name) LIKE ?`);
    params.push(`%${args.scentType.toLowerCase()}%`);
  }

  if (args.applicableOffer) {
    where.push(`LOWER(ao.name) = ?`);
    params.push(args.applicableOffer.toLowerCase());
  }

  if (args.category) {
    const needle = args.category.toLowerCase();
    where.push(`EXISTS (
      SELECT 1 FROM product_category_products pcp
      INNER JOIN product_categories pc ON pc.id = pcp.category_id
      WHERE pcp.product_id = p.id
        AND (LOWER(pc.handle) = ? OR LOWER(pc.name) LIKE ?)
    )`);
    params.push(needle, `%${needle}%`);
  }

  if (args.notes.length) {
    const placeholders = args.notes.map(() => "?").join(", ");
    where.push(`EXISTS (
      SELECT 1 FROM product_notes pn
      INNER JOIN notes n ON n.id = pn.note_id
      WHERE pn.product_id = p.id
        AND LOWER(n.name) IN (${placeholders})
    )`);
    params.push(...args.notes.map((note) => note.toLowerCase()));
  }

  if (args.mustMatch?.length) {
    const clause = args.mustMatch.map(() => "p.embedding_content LIKE ?").join(" OR ");
    where.push(`(${clause})`);
    params.push(...args.mustMatch.map((term) => `%${term}%`));
  }

  const variantClauses = [`(v.available_for_sale = 1 OR v.inventory_quantity > 0)`];
  if (args.minCents != null) {
    variantClauses.push(`(v.price * 100) >= ?`);
    params.push(args.minCents);
  }
  if (args.maxCents != null) {
    variantClauses.push(`(v.price * 100) <= ?`);
    params.push(args.maxCents);
  }
  if (variantClauses.length) {
    where.push(`EXISTS (
      SELECT 1 FROM product_variants v
      WHERE v.shopify_product_id = p.shopify_product_id
        AND ${variantClauses.join(" AND ")}
    )`);
  }

  return { whereSql: where.join(" AND "), params };
}

function buildCandidateSql(args) {
  const { whereSql, params } = buildFilterSql(args);
  const sql = `SELECT p.id, VECTOR_TO_STRING(p.embedding) AS embeddingStr
FROM products p
LEFT JOIN product_genders g ON g.id = p.gender_id
LEFT JOIN brands b ON b.id = p.brand_id
LEFT JOIN product_types pt ON pt.id = p.product_type_id
LEFT JOIN fragrance_families ff ON ff.id = p.fragrance_family_id
LEFT JOIN scent_types st ON st.id = p.scent_type_id
LEFT JOIN applicable_offers ao ON ao.id = p.applicable_offer_id
WHERE ${whereSql}`;
  return {
    sql,
    params,
    interpolatedSql: interpolateSql(sql, params)
  };
}

async function loadCandidateRows(args) {
  const query = buildCandidateSql(args);
  const rows = await prisma.$queryRawUnsafe(query.sql, ...query.params);
  return { ...query, rows };
}

function buildRankingQuery(catalogQuery, shopperText = "") {
  const parts = [];
  const seen = new Set();
  for (const raw of [catalogQuery, shopperText]) {
    const text = String(raw || "").trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(text);
  }
  return parts.join("\n");
}

export async function searchLocalCatalog(input = {}, options = {}) {
  const args = parseLocalCatalogSearchArgs(input);
  const searchText = buildRankingQuery(args.query, options.shopperText);
  const debug = {
    parsed: args,
    sql: [],
    dbResponse: {}
  };

  if (!args.brand) {
    const detected =
      (await detectBrandFromQuery(args.query)) ||
      (await detectBrandFromQuery(options.shopperText));
    if (detected) {
      args.brand = detected;
      debug.parsed = args;
    }
  }

  let rows = [];
  try {
    const loaded = await loadCandidateRows(args);
    rows = loaded.rows || [];
    debug.sql.push({
      name: "filter_candidates",
      sql: loaded.sql,
      params: loaded.params,
      interpolatedSql: loaded.interpolatedSql
    });
    debug.dbResponse.filter_candidates = {
      rowCount: rows.length,
      productIds: rows.map((row) => row.id)
    };
  } catch (error) {
    debug.sql.push({
      name: "filter_candidates",
      ...buildCandidateSql(args),
      error: error.message
    });
    error.searchDebug = debug;
    throw error;
  }

  let ranked = rows.map((row) => ({ id: row.id, score: 0, embeddingStr: row.embeddingStr }));

  if (searchText) {
    const queryEmbedding = await generateEmbedding(searchText);
    debug.ranking = {
      method: "js_dot_product",
      catalogQuery: args.query,
      shopperText: String(options.shopperText || "").trim() || null,
      rankingQuery: searchText,
      embeddingGenerated: Boolean(queryEmbedding),
      embeddingModel: getEmbeddingModel(),
      queryVectorDimensions: Array.isArray(queryEmbedding) ? queryEmbedding.length : 0,
      queryVector: queryEmbedding || null
    };
    if (queryEmbedding) {
      ranked = [];
      for (const row of rows) {
        try {
          const vector = row.embeddingStr ? JSON.parse(row.embeddingStr) : null;
          if (!Array.isArray(vector) || !vector.length) continue;
          ranked.push({ id: row.id, score: dotProduct(queryEmbedding, vector) });
        } catch {
          // skip malformed vectors
        }
      }
      ranked.sort((a, b) => b.score - a.score);
    }
  } else {
    debug.ranking = {
      method: "none",
      catalogQuery: args.query,
      shopperText: String(options.shopperText || "").trim() || null,
      rankingQuery: searchText,
      embeddingGenerated: false,
      embeddingModel: getEmbeddingModel(),
      queryVectorDimensions: 0,
      queryVector: null
    };
  }

  const total = ranked.length;
  const page = ranked.slice(args.offset, args.offset + args.limit);
  const pageIds = page.map((row) => row.id);
  debug.dbResponse.ranked_page = page.map((row) => ({
    id: row.id,
    score: row.score
  }));

  let products = [];
  const productSql = pageIds.length
    ? interpolateSql(
        `SELECT * FROM products WHERE id IN (${pageIds.map(() => "?").join(", ")})`,
        pageIds
      )
    : null;
  debug.sql.push({
    name: "hydrate_products",
    method: "prisma.product.findMany",
    where: { id: { in: pageIds } },
    include: Object.keys(PRODUCT_INCLUDE),
    sql: productSql,
    params: pageIds,
    interpolatedSql: productSql
  });

  if (pageIds.length) {
    products = await prisma.product.findMany({
      where: { id: { in: pageIds } },
      include: PRODUCT_INCLUDE
    });
  }
  debug.dbResponse.hydrate_products = {
    rowCount: products.length,
    rows: products.map(compactDbProduct)
  };

  const order = new Map(page.map((row, index) => [row.id, index]));
  const scoreById = new Map(page.map((row) => [row.id, row.score]));
  products.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));

  const hasNext = args.offset + args.limit < total;
  return {
    result: {
      status: "success",
      source: "search_product",
      products: products.map((product) =>
        formatLocalProduct(product, scoreById.get(product.id) ?? null)
      ),
      pagination: {
        cursor: hasNext ? String(args.offset + args.limit) : null,
        has_next_page: hasNext,
        total_count: total,
        limit: args.limit,
        offset: args.offset
      }
    },
    debug
  };
}

function numericShopifyId(value) {
  const raw = String(value || "").trim();
  const match = raw.match(/(\d+)\s*$/);
  return match ? match[1] : "";
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
    ordered.push(formatLocalProduct(product));
  }

  for (const product of products) {
    if (seen.has(product.shopifyProductId)) continue;
    ordered.push(formatLocalProduct(product));
  }

  return ordered;
}
