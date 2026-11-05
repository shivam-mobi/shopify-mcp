/**
 * search_product: structured filters + hybrid (keyword + vector) search in Meilisearch,
 * product cards hydrated from MySQL. Zero results relax soft filters, then the query.
 */
import * as fuzz from "fuzzball";
import { normalizeCatalogSearchArgs } from "../catalog-search-args.server.js";
import { generateEmbedding } from "../embeddings.server.js";
import { getProductsIndex } from "./meilisearch-client.server.js";
import { loadProductCards } from "./product-cards.server.js";
import {
  CATEGORY_GROUPS,
  PRODUCT_EMBEDDER,
  PRODUCTS_INDEX_SETTINGS,
  SEARCH_TUNING
} from "./products-index.config.js";

export const SORT_OPTIONS = {
  relevance: null,
  popular: ["popularity:desc"],
  top_rated: ["rating:desc", "review_count:desc"],
  price_asc: ["price:asc"],
  price_desc: ["max_price:desc"],
  newest: ["created_at:desc"],
  discount_desc: ["discount_percent:desc"]
};

export const CATEGORY_NAMES = Object.keys(CATEGORY_GROUPS);

export const APPLICABLE_OFFERS = ["3 For $20", "2 For $25", "BOGO 50", "3 For $99", "2 For $75", "3 For $129"];

const GENDER_VALUES = {
  men: ["men", "unisex", "unknown"],
  women: ["women", "unisex", "unknown"],
  unisex: ["unisex", "unknown"],
  boys: ["boys", "kids"],
  girls: ["girls", "kids"],
  kids: ["kids", "boys", "girls"]
};

const KIDS_WORDS = new Set(SEARCH_TUNING.kidsWords);
const SHARED_WORDS = new Set(SEARCH_TUNING.sharedWords);
const STOP_WORDS = new Set(PRODUCTS_INDEX_SETTINGS.stopWords);
const FACET_CACHE_MS = 10 * 60 * 1000;
const BRAND_FUZZ_MIN_SCORE = 85;
const EMBEDDING_CACHE_SIZE = 300;

const KEEP_SORT_WORDS = new Set(SEARCH_TUNING.keepSortWords);
const SORT_HINTS = new Map(
  Object.entries(SEARCH_TUNING.sortHints).flatMap(([sort, words]) =>
    words.filter((word) => !KEEP_SORT_WORDS.has(word)).map((word) => [word, sort])
  )
);
const GENDER_WORDS = new Map(
  Object.entries(SEARCH_TUNING.genderWords).flatMap(([gender, words]) => words.map((word) => [word, gender]))
);

const facetCache = new Map();
const embeddingCache = new Map();

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function asList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean);
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/** "$1,250.50", "100 USD", 100 → dollars; anything else (or <= 0) → null. */
function parseDollars(value) {
  if (value == null || value === "" || typeof value === "boolean") return null;
  const text = String(value).replace(/[$,\s]|usd|<=|>=|<|>|under|below|above|over/gi, "").trim();
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const n = Number(text);
  return n > 0 ? n : null;
}

/**
 * Budget in US dollars from the tool's price filter. Shared with the chat cards so the
 * search and the card's size selection always agree.
 * Accepts { min, max }, a bare number or "$100" (a max), and "50-100" (a range).
 * @returns {{ min: number|null, max: number|null } | null}
 */
export function parsePriceRange(price, fallback = {}) {
  let min = null;
  let max = null;
  if (price && typeof price === "object" && !Array.isArray(price)) {
    min = parseDollars(price.min ?? price.gte ?? price.from);
    max = parseDollars(price.max ?? price.lte ?? price.to);
  } else if (typeof price === "string" && /\d\s*(-|to)\s*\$?\d/i.test(price)) {
    const [low, high] = price.split(/\s*(?:-|to)\s*/i);
    min = parseDollars(low);
    max = parseDollars(high);
  } else if (typeof price === "string" && /(?:>=|>|above|over)\s*\$?\d/i.test(price)) {
    min = parseDollars(price);
  } else if (price != null) {
    max = parseDollars(price);
  }
  min = min ?? parseDollars(fallback.min_price ?? fallback.minPrice);
  max = max ?? parseDollars(fallback.max_price ?? fallback.maxPrice);
  if (min != null && max != null && min > max) [min, max] = [max, min];
  return min == null && max == null ? null : { min, max };
}

function inPriceRange(amount, range) {
  if (!range) return true;
  if (range.min != null && amount < range.min) return false;
  if (range.max != null && amount > range.max) return false;
  return true;
}

function normalizeGender(value) {
  const g = String(value || "").toLowerCase().trim();
  if (["men", "man", "mens", "male"].includes(g)) return "men";
  if (["women", "woman", "womens", "female"].includes(g)) return "women";
  if (["boys", "boy", "son"].includes(g)) return "boys";
  if (["girls", "girl", "daughter"].includes(g)) return "girls";
  if (["kids", "kid", "child", "children"].includes(g)) return "kids";
  if (g === "unisex") return "unisex";
  return null;
}

function normalizeOffer(value) {
  const key = String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (!key) return null;
  return APPLICABLE_OFFERS.find((name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "") === key) || null;
}

/** "Best Sellers" / "best-sellers" → "best_sellers"; anything else is kept as a collection handle. */
function normalizeCategory(value) {
  const lower = value.toLowerCase().trim();
  const groupKey = lower.replace(/[\s-]+/g, "_");
  return CATEGORY_GROUPS[groupKey] ? groupKey : lower;
}

const FILTER_KEYS = [
  "gender",
  "kids",
  "brand",
  "product_type",
  "productType",
  "fragrance_family",
  "fragranceFamily",
  "scent_type",
  "scentType",
  "notes",
  "categories",
  "category",
  "collection",
  "applicable_offer",
  "applicableOffer",
  "on_sale",
  "exclude",
  "price",
  "min_price",
  "max_price",
  "must_match",
  "mustMatch"
];

/**
 * The LLM sometimes puts filter fields next to filters ({ categories: [...] }).
 * Those are filters too; values inside filters win.
 */
function collectFilters(...sources) {
  const filters = {};
  for (const source of sources) {
    for (const key of FILTER_KEYS) {
      if (source[key] != null && filters[key] == null) filters[key] = source[key];
    }
  }
  return filters;
}

/** Accepts the tool's flat shape plus older ones still in saved chats ({ catalog: {...} }, must_match). */
export function parseSearchProductArgs(input = {}) {
  const normalized = normalizeCatalogSearchArgs(input) || {};
  const catalog = asObject(normalized.catalog && typeof normalized.catalog === "object" ? normalized.catalog : normalized);
  const filters = collectFilters(asObject(catalog.filters), catalog, asObject(normalized));
  const pagination = asObject(catalog.pagination);
  const price = parsePriceRange(filters.price, filters);

  const legacyWords = asList(filters.must_match || filters.mustMatch);
  const kidsFromLegacy = legacyWords.some((word) => KIDS_WORDS.has(word.toLowerCase()));
  const queryParts = [String(catalog.query || "").trim(), ...legacyWords.filter((w) => !KIDS_WORDS.has(w.toLowerCase()))];

  let limit = Number(pagination.limit);
  if (!Number.isFinite(limit) || limit < 1) limit = SEARCH_TUNING.defaultLimit;
  limit = Math.min(Math.floor(limit), SEARCH_TUNING.maxLimit);
  const offset = Math.max(0, Math.floor(Number(pagination.cursor) || 0));

  const sort = String(catalog.sort || filters.sort || "relevance").toLowerCase();

  return {
    query: [...new Set(queryParts.filter(Boolean))].join(" ").trim(),
    sort: SORT_OPTIONS[sort] !== undefined ? sort : "relevance",
    filters: {
      gender: normalizeGender(filters.gender),
      kids: filters.kids === true || filters.kids === "true" || kidsFromLegacy,
      brand: String(filters.brand || "").trim(),
      productType: String(filters.product_type || filters.productType || "").trim(),
      fragranceFamily: String(filters.fragrance_family || filters.fragranceFamily || "").trim(),
      scentType: String(filters.scent_type || filters.scentType || "").trim(),
      notes: asList(filters.notes),
      categories: [
        ...new Set([filters.categories, filters.category, filters.collection].flatMap(asList).map(normalizeCategory))
      ],
      applicableOffer: normalizeOffer(filters.applicable_offer || filters.applicableOffer),
      onSale: filters.on_sale === true || filters.on_sale === "true",
      exclude: [...new Set(asList(filters.exclude).map((word) => word.toLowerCase()))],
      price
    },
    limit,
    offset
  };
}

/**
 * Safety net for words the LLM left in the query: ranking words ("popular", "cheap")
 * become sort, kids and gender words become filters, and "couple" / "both" stop gender inference.
 */
function moveIntentWordsOutOfQuery(query, sort) {
  let hinted = null;
  let kids = false;
  let shared = false;
  const genders = new Set();
  const kept = [];
  for (const word of query.split(/\s+/).filter(Boolean)) {
    const key = word.toLowerCase().replace(/[^a-z]/g, "");
    const hint = SORT_HINTS.get(key);
    if (hint) {
      hinted = hinted || hint;
      continue;
    }
    if (GENDER_WORDS.has(key)) {
      genders.add(GENDER_WORDS.get(key));
      if (KIDS_WORDS.has(key)) {
        kids = true;
      }
      continue;
    }
    if (KIDS_WORDS.has(key)) {
      kids = true;
      continue;
    }
    if (SHARED_WORDS.has(key)) {
      shared = true;
      continue;
    }
    kept.push(word);
  }
  return {
    query: kept.join(" "),
    sort: sort !== "relevance" ? sort : hinted || "relevance",
    kids,
    gender: !shared && genders.size === 1 ? [...genders][0] : null
  };
}

/**
 * Gender from the shopper's current message ("Versace for my wife", "perfume for my son") when the LLM sent none.
 * Only one gender, and not for couples / family.
 */
function genderFromShopperMessage(message) {
  const intent = moveIntentWordsOutOfQuery(String(message || ""), "relevance");
  return intent.gender || (intent.kids ? "kids" : null);
}

/** "perfumes for him" has nothing to search for once gender is a filter: browse instead. */
function onlyStopWords(query) {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .every((word) => STOP_WORDS.has(word));
}

/** The brand is already a filter; leaving its words in the query only adds weak keyword matches. */
function withoutBrandWords(query, brandNames) {
  const brandWords = new Set(
    brandNames
      .filter(Boolean)
      .flatMap((name) => name.toLowerCase().split(/[^a-z0-9]+/))
      .filter(Boolean)
  );
  if (!brandWords.size) return query;
  return query
    .split(/\s+/)
    .filter((word) => word && !brandWords.has(word.toLowerCase().replace(/[^a-z0-9]/g, "")))
    .join(" ");
}

/** In-stock values of a facet (brands, collection handles), cached for a few minutes. */
async function facetValues(index, field) {
  const cached = facetCache.get(field);
  if (cached && Date.now() - cached.at < FACET_CACHE_MS && cached.values.length) return cached.values;
  const response = await index.search("", { limit: 0, facets: [field], filter: ["in_stock = true"] });
  const values = Object.keys(response.facetDistribution?.[field] || {});
  facetCache.set(field, { at: Date.now(), values });
  return values;
}

function brandValues(index) {
  return facetValues(index, "brand");
}

/**
 * Category types → collection handles for the shopper's gender (no gender: men + women + shared).
 * Raw collection handles are accepted as-is when products are in them; anything else is unknown.
 */
async function resolveCategories(index, categories, gender) {
  const handles = new Set();
  const names = [];
  const unknown = [];
  let collections = null;
  for (const value of categories) {
    const group = CATEGORY_GROUPS[value];
    if (group) {
      const sides = gender === "men" ? [group.men] : gender === "women" ? [group.women] : [group.men, group.women];
      [...sides, group.shared].flat().forEach((handle) => handles.add(handle));
      names.push(value);
      continue;
    }
    collections = collections || new Set(await facetValues(index, "collection_handles"));
    if (collections.has(value)) {
      handles.add(value);
      names.push(value);
    } else {
      unknown.push(value);
    }
  }
  return { handles: [...handles], names, unknown };
}

function compact(text) {
  return String(text || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Maps the LLM's brand text to a brand that exists in stock (exact, spacing, then fuzzy). */
async function resolveBrand(index, text) {
  if (!text) return { value: null };
  const values = await brandValues(index);
  const lower = text.toLowerCase();
  const exact = values.find((value) => value.toLowerCase() === lower || compact(value) === compact(text));
  if (exact) return { value: exact, method: "exact" };

  const hits = fuzz.extract(text, values, { scorer: fuzz.WRatio, limit: 3 });
  const [top, second] = hits;
  if (top && top[1] >= BRAND_FUZZ_MIN_SCORE && (!second || second[1] < top[1])) {
    return { value: top[0], method: "fuzzy", score: top[1] };
  }
  return { value: null, suggestions: hits.slice(0, 3).map(([name]) => name) };
}

/** Maps free text to indexed facet values ("Eau de Parfum" → all EDP product types). */
async function resolveFacet(index, facetName, text) {
  if (!text) return [];
  const response = await index.searchForFacetValues({
    facetName,
    facetQuery: SEARCH_TUNING.facetAliases[text.toLowerCase().trim()] || text,
    filter: "in_stock = true"
  });
  return (response.facetHits || []).map((hit) => hit.value);
}

function words(text) {
  return String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function excludeTerms(word) {
  return SEARCH_TUNING.excludeTerms[word] || [word];
}

/** True when the term's words appear together in the value as whole words (plural allowed on the last one). */
function containsTerm(value, term) {
  const valueWords = words(value);
  const termWords = words(term);
  if (!termWords.length) return false;
  const last = termWords.length - 1;
  return valueWords.some((_, start) =>
    termWords.every((termWord, i) => {
      const word = valueWords[start + i];
      return word === termWord || (i === last && (word === `${termWord}s` || word === `${termWord}es`));
    })
  );
}

/**
 * Facet values to exclude for one term. Meilisearch's facet search finds candidates (including
 * misspellings like "Vanile"); only values containing the term as a whole word are kept, since
 * facet search also returns prefixes and typos ("musk" → "Muses").
 */
async function excludedFacetValues(index, field, term) {
  const key = `exclude:${field}:${term}`;
  const cached = facetCache.get(key);
  if (cached && Date.now() - cached.at < FACET_CACHE_MS) return cached.values;
  const response = await index.searchForFacetValues({ facetName: field, facetQuery: term, filter: "in_stock = true" });
  const values = (response.facetHits || []).map((hit) => hit.value).filter((value) => containsTerm(value, term));
  facetCache.set(key, { at: Date.now(), values });
  return values;
}

/** "not sweet" → NOT notes IN ["Vanilla", "Caramel", …] AND NOT scent_type IN ["Warm & Sweet Gourmands.", …]. */
async function resolveExclusions(index, excluded) {
  const terms = [...new Set(excluded.flatMap(excludeTerms))];
  const parts = [];
  const byField = {};
  for (const field of SEARCH_TUNING.excludeFields) {
    const lists = await Promise.all(terms.map((term) => excludedFacetValues(index, field, term)));
    const values = [...new Set(lists.flat())];
    if (!values.length) continue;
    byField[field] = values.length;
    parts.push(`NOT ${inList(field, values)}`);
  }
  return { expr: parts.length ? parts.join(" AND ") : null, terms, byField };
}

/** Excluded words and negations do not belong in the query ("fresh not sweet" → "fresh"). */
function withoutExcludedWords(query, excluded) {
  if (!excluded.length) return query;
  const drop = new Set([...SEARCH_TUNING.negationWords, ...excluded.flatMap(words)]);
  return query
    .split(" ")
    .filter((word) => word && !drop.has(compact(word)))
    .join(" ");
}

function quote(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function inList(field, values) {
  return `${field} IN [${values.map(quote).join(", ")}]`;
}

async function resolveFilters(index, filters) {
  const clauses = [{ key: "in_stock", expr: "in_stock = true" }];
  const unresolved = [];
  const applied = {};

  if (filters.gender) {
    clauses.push({ key: "gender", expr: inList("gender", GENDER_VALUES[filters.gender]) });
    applied.gender = filters.gender;
  }
  if (filters.kids) {
    clauses.push({ key: "kids", expr: "kids = true" });
    applied.kids = true;
  }

  let brand = null;
  if (filters.brand) {
    brand = await resolveBrand(index, filters.brand);
    if (brand.value) {
      clauses.push({ key: "brand", expr: `brand = ${quote(brand.value)}` });
      applied.brand = brand.value;
    }
  }

  const facetFilters = [
    ["product_type", "productType", "product_type"],
    ["fragrance_family", "fragranceFamily", "fragrance_family"],
    ["scent_type", "scentType", "scent_type"]
  ];
  for (const [key, argKey, field] of facetFilters) {
    if (!filters[argKey]) continue;
    const values = await resolveFacet(index, field, filters[argKey]);
    if (values.length) {
      clauses.push({ key, expr: inList(field, values) });
      applied[key] = filters[argKey];
    } else {
      unresolved.push(filters[argKey]);
    }
  }

  if (filters.notes.length) {
    const values = new Set();
    for (const note of filters.notes) {
      const matches = await resolveFacet(index, "notes", note);
      if (matches.length) matches.forEach((value) => values.add(value));
      else unresolved.push(note);
    }
    if (values.size) {
      clauses.push({ key: "notes", expr: inList("notes", [...values]) });
      applied.notes = filters.notes;
    }
  }

  let categoryHandles = [];
  if (filters.categories.length) {
    const { handles, names, unknown } = await resolveCategories(index, filters.categories, filters.gender);
    if (handles.length) {
      clauses.push({ key: "category", expr: inList("collection_handles", handles) });
      applied.categories = names;
      categoryHandles = handles;
    }
    unknown.forEach((value) => unresolved.push(value.replace(/[-_]+/g, " ")));
  }
  if (filters.applicableOffer) {
    clauses.push({ key: "applicable_offer", expr: `applicable_offer = ${quote(filters.applicableOffer)}` });
    applied.applicable_offer = filters.applicableOffer;
  }
  if (filters.onSale) {
    clauses.push({ key: "on_sale", expr: "on_sale = true" });
    applied.on_sale = true;
  }
  let exclusion = null;
  if (filters.exclude.length) {
    exclusion = await resolveExclusions(index, filters.exclude);
    if (exclusion.expr) {
      clauses.push({ key: "exclude", expr: exclusion.expr });
      applied.exclude = filters.exclude;
    }
  }
  if (filters.price) {
    const { min, max } = filters.price;
    const priceField = filters.applicableOffer ? "offer_variant_prices" : "variant_prices";
    // One condition on the array, so a single in-stock size must satisfy both bounds.
    const expr =
      min != null && max != null
        ? `${priceField} ${min} TO ${max}`
        : min != null
          ? `${priceField} >= ${min}`
          : `${priceField} <= ${max}`;
    clauses.push({ key: "price", expr });
    applied.price = { min, max };
  }

  return { clauses, applied, unresolved, brand, categoryHandles, exclusion };
}

async function embedQuery(text) {
  const key = text.toLowerCase();
  if (embeddingCache.has(key)) {
    const cached = embeddingCache.get(key);
    embeddingCache.delete(key);
    embeddingCache.set(key, cached);
    return cached;
  }
  const vector = await generateEmbedding(text);
  if (!Array.isArray(vector) || !vector.length) return null;
  embeddingCache.set(key, vector);
  if (embeddingCache.size > EMBEDDING_CACHE_SIZE) {
    embeddingCache.delete(embeddingCache.keys().next().value);
  }
  return vector;
}

const HIT_ATTRIBUTES = [
  "id",
  "title",
  "price",
  "max_price",
  "variant_prices",
  "offer_variant_prices",
  "popularity",
  "rating",
  "review_count",
  "created_at",
  "discount_percent",
  "card"
];

/** Cheapest / dearest in-stock size inside the budget: the price the shopper can actually pay. */
function budgetPrice(hit, range, pick, hasOffer = false) {
  const source =
    hasOffer && hit.offer_variant_prices?.length
      ? hit.offer_variant_prices
      : hit.variant_prices || [];
  const prices = source.filter((amount) => inPriceRange(amount, range));
  if (!prices.length) return pick === "max" ? hit.max_price ?? hit.price : hit.price;
  return pick === "max" ? Math.max(...prices) : Math.min(...prices);
}

/** Applied in code; Array.sort is stable, so ties keep relevance order. */
function sortComparator(sort, range, hasOffer = false) {
  switch (sort) {
    case "popular":
      return (a, b) => (b.popularity ?? 0) - (a.popularity ?? 0);
    case "top_rated":
      return (a, b) => (b.rating ?? 0) - (a.rating ?? 0) || (b.review_count ?? 0) - (a.review_count ?? 0);
    case "price_asc":
      return (a, b) =>
        (budgetPrice(a, range, "min", hasOffer) ?? Infinity) -
        (budgetPrice(b, range, "min", hasOffer) ?? Infinity);
    case "price_desc":
      return (a, b) =>
        (budgetPrice(b, range, "max", hasOffer) ?? -Infinity) -
        (budgetPrice(a, range, "max", hasOffer) ?? -Infinity);
    case "newest":
      return (a, b) => (b.created_at ?? 0) - (a.created_at ?? 0);
    case "discount_desc":
      return (a, b) => (b.discount_percent ?? 0) - (a.discount_percent ?? 0);
    default:
      return null;
  }
}

/**
 * Meilisearch sorts by the product's overall cheapest (asc) or dearest (desc) size. With a
 * budget on the other side (price_asc + min, price_desc + max) that is not the in-budget price,
 * so those browses are re-sorted in code.
 */
function needsBudgetResort(sort, range) {
  if (!range) return false;
  return (sort === "price_asc" && range.min != null) || (sort === "price_desc" && range.max != null);
}

function baseParams(clauses) {
  return {
    filter: clauses.map((clause) => clause.expr),
    attributesToRetrieve: HIT_ATTRIBUTES,
    showRankingScore: true,
    matchingStrategy: SEARCH_TUNING.matchingStrategy
  };
}

function hybridParams(vector, semanticRatio) {
  return { hybrid: { embedder: PRODUCT_EMBEDDER, semanticRatio }, vector };
}

const STRONG_FIELDS = new Set(SEARCH_TUNING.relevance.strongFields);

/**
 * Keyword hits that contain every query word (close together for multi-word queries),
 * split by whether a strong field matched.
 */
// Kept for the disabled keyword tiers in queryCandidates.
// eslint-disable-next-line no-unused-vars
function wordMatches(hits) {
  const tuning = SEARCH_TUNING.relevance;
  const strong = [];
  const weak = [];
  for (const hit of hits) {
    const details = hit._rankingScoreDetails || {};
    const words = details.words;
    if (!words?.maxMatchingWords || words.matchingWords !== words.maxMatchingWords) continue;
    if (words.maxMatchingWords > 1 && (details.proximity?.score ?? 1) < tuning.minProximity) continue;
    const fields = Object.keys(hit._matchesPosition || {});
    (fields.some((field) => STRONG_FIELDS.has(field)) ? strong : weak).push(hit);
  }
  return { strong, weak };
}

/**
 * Cutoff relative to the best confident keyword hit and the best vector hit for this query
 * and filters, so weak vector matches never fill the list. Also returns the keyword hits.
 */
async function relevanceProbe(index, { query, vector, clauses }) {
  const [keywordResponse, semanticTop] = await Promise.all([
    index.search(query, {
      ...baseParams(clauses),
      limit: SEARCH_TUNING.maxCandidates,
      showRankingScoreDetails: true,
      showMatchesPosition: true
    }),
    vector
      ? index
          .search(query, { ...baseParams(clauses), limit: 1, ...hybridParams(vector, 1) })
          .then((response) => response.hits[0]?._rankingScore ?? null)
      : Promise.resolve(null)
  ]);
  const keywordTop = keywordResponse.hits[0]?._rankingScore ?? null;
  const tuning = SEARCH_TUNING.relevance;
  const keywordConfident = keywordTop != null && keywordTop >= tuning.keywordConfidentScore;
  const cutoffs = [];
  if (keywordConfident || (semanticTop == null && keywordTop != null)) {
    cutoffs.push(keywordTop - tuning.keywordWindow);
  }
  if (semanticTop != null) cutoffs.push(semanticTop - tuning.semanticWindow);
  return {
    keywordTop,
    semanticTop,
    keywordConfident,
    threshold: cutoffs.length ? Number(Math.max(tuning.minScore, Math.min(...cutoffs)).toFixed(4)) : null,
    keywordHits: keywordResponse.hits,
    keywordMs: keywordResponse.processingTimeMs
  };
}

/**
 * Relevant candidates for a query, in tiers:
 *   1. contain every query word in a strong field (title, brand, notes, family, type)
 *   2. contain every query word only in tags / collections / description — only when tier 1 is small
 *   3. the hybrid (keyword + meaning) results above the relevance cutoff, as before
 * Tiers 1–2 are "keyword" matches, tier 3 "similar". Every product the hybrid search keeps is still kept.
 */
async function queryCandidates(index, { query, vector, clauses, withFacets = false }) {
  const relevance = await relevanceProbe(index, { query, vector, clauses });
  const response = await index.search(query, {
    ...baseParams(clauses),
    limit: SEARCH_TUNING.maxCandidates,
    ...(vector ? hybridParams(vector, SEARCH_TUNING.semanticRatio) : {}),
    ...(relevance.threshold != null ? { rankingScoreThreshold: relevance.threshold } : {}),
    ...(withFacets ? { facets: SEARCH_TUNING.facets } : {})
  });

  // DISABLED: "always keep real keyword matches" (tiers 1–2). It counted typo / partial-word hits as
  // real matches ("creed" → "Rangoon Creeper", "credited"), adding low-score products below the cutoff.
  // Only the hybrid results above the relevance cutoff (tier 3) are used now. To re-enable, restore
  // these lines and the related check in searchProducts.
  // const { strong, weak } = wordMatches(relevance.keywordHits);
  // const keyword = strong.length < SEARCH_TUNING.relevance.weakMatchesWhenStrongBelow ? [...strong, ...weak] : strong;
  // const seen = new Set(keyword.map((hit) => hit.id));
  // const similar = response.hits.filter((hit) => !seen.has(hit.id));
  const keyword = [];
  const similar = response.hits;
  return {
    // keyword: keyword.map((hit) => ({ ...hit, _match: "keyword" })),
    // similar: similar.map((hit) => ({ ...hit, _match: "similar" })),
    keyword,
    similar,
    tiers: null,
    facetDistribution: response.facetDistribution,
    ms: (relevance.keywordMs || 0) + (response.processingTimeMs || 0),
    relevance
  };
}

/**
 * Query search. The shopper's sort applies inside each group, so a cheap "similar" product never
 * jumps ahead of products that contain the shopper's words.
 */
async function searchWithQuery(index, { query, vector, clauses, sort, priceRange, limit, offset, withFacets }) {
  const candidates = await queryCandidates(index, { query, vector, clauses, withFacets });
  const hasOffer = clauses.some((clause) => clause.key === "applicable_offer");
  const comparator = sortComparator(sort, priceRange, hasOffer);
  const ordered = [candidates.keyword, candidates.similar].flatMap((group) =>
    comparator ? [...group].sort(comparator) : group
  );
  return {
    hits: ordered.slice(offset, offset + limit),
    total: ordered.length,
    keywordCount: candidates.keyword.length,
    tiers: candidates.tiers,
    facetDistribution: candidates.facetDistribution,
    ms: candidates.ms,
    relevance: candidates.relevance
  };
}

/** Filter-only browse: Meilisearch sorts (popular by default) and pages. */
async function browse(index, { clauses, sort, priceRange, limit, offset, withFacets }) {
  const resort = needsBudgetResort(sort, priceRange);
  const hasOffer = clauses.some((clause) => clause.key === "applicable_offer");
  const response = await index.search("", {
    ...baseParams(clauses),
    hitsPerPage: resort ? SEARCH_TUNING.maxCandidates : limit,
    page: resort ? 1 : Math.floor(offset / limit) + 1,
    sort: SORT_OPTIONS[sort] || SORT_OPTIONS.popular,
    ...(withFacets ? { facets: SEARCH_TUNING.facets } : {})
  });
  const hits = resort
    ? [...response.hits].sort(sortComparator(sort, priceRange, hasOffer)).slice(offset, offset + limit)
    : response.hits;
  return {
    hits,
    total: response.totalHits || 0,
    facetDistribution: response.facetDistribution,
    ms: response.processingTimeMs,
    relevance: null
  };
}

/** Price span of the same search without the budget, so an empty result can name the closest prices. */
async function priceSpanWithoutBudget(index, { query, vector, clauses }) {
  const withoutPrice = clauses.filter((clause) => clause.key !== "price");
  let candidates;
  if (query) {
    const { keyword, similar } = await queryCandidates(index, { query, vector, clauses: withoutPrice });
    candidates = [...keyword, ...similar];
  } else {
    candidates = (await index.search("", { ...baseParams(withoutPrice), limit: SEARCH_TUNING.maxCandidates })).hits;
  }
  const hits = candidates.filter((hit) => hit.price != null);
  if (!hits.length) return null;
  return {
    count: hits.length,
    min: Math.min(...hits.map((hit) => hit.price)),
    max: Math.max(...hits.map((hit) => hit.max_price ?? hit.price))
  };
}

function formatUsd(amount) {
  return `$${Number(amount).toFixed(2)}`;
}

function budgetText({ min, max }) {
  if (min != null && max != null) return `between ${formatUsd(min)} and ${formatUsd(max)}`;
  return min != null ? `from ${formatUsd(min)}` : `up to ${formatUsd(max)}`;
}

/** Ordered attempts: exact → drop soft filters one by one → drop the query (browse). */
function relaxationPlan(clauses, query) {
  const plan = [{ clauses, query, relaxed: [] }];
  let current = clauses;
  const relaxed = [];
  for (const key of SEARCH_TUNING.relaxOrder) {
    if (SEARCH_TUNING.hardFilters.includes(key) || !current.some((clause) => clause.key === key)) continue;
    current = current.filter((clause) => clause.key !== key);
    relaxed.push(key);
    plan.push({ clauses: current, query, relaxed: [...relaxed] });
  }
  if (query) plan.push({ clauses: current, query: "", relaxed: [...relaxed, "query"] });
  return plan;
}

function topFacets(distribution = {}) {
  const facets = {};
  for (const [field, counts] of Object.entries(distribution)) {
    facets[field] = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, SEARCH_TUNING.facetValuesPerField)
      .map(([value, count]) => ({ value, count }));
  }
  return facets;
}

function resultNote({
  relaxed,
  brand,
  requestedBrand,
  unresolved,
  empty,
  related,
  applied,
  pastEnd,
  total,
  priceSpan,
  mixed = null
}) {
  if (empty && applied.price) {
    const budget = budgetText(applied.price);
    if (!priceSpan) {
      return `No in-stock products match these filters, even ignoring the budget: ${JSON.stringify(applied)}. Tell the shopper and suggest dropping one of them.`;
    }
    return (
      `No in-stock size is priced ${budget} for this search. Without the budget, ${priceSpan.count} match(es) cost ` +
      `${formatUsd(priceSpan.min)} to ${formatUsd(priceSpan.max)}. Tell the shopper the closest price and ask if they want to adjust the budget or see other brands.`
    );
  }
  if (pastEnd) {
    return `All ${total} matching products were already shown; there are no more. Tell the shopper that is everything for this search and offer to widen it (similar scents from other brands, or drop a filter).`;
  }
  if (requestedBrand && !brand?.value) {
    const suggestions = brand?.suggestions?.length ? ` Closest brands: ${brand.suggestions.join(", ")}.` : "";
    return `Brand "${requestedBrand}" is not in stock at Perfumania.${suggestions} Tell the shopper and offer alternatives.`;
  }
  if (empty) {
    return `No in-stock products match these filters together: ${JSON.stringify(applied)}. Tell the shopper and suggest dropping one of them.`;
  }
  const notes = [];
  if (relaxed.includes("exclude")) {
    notes.push(
      `Every match has some ${applied.exclude.join(" / ")} notes, so that exclusion was dropped. ` +
        `Tell the shopper nothing fully avoids ${applied.exclude.join(" / ")} and these are the closest.`
    );
  }
  if (relaxed.includes("query")) {
    notes.push("Nothing matched the search words with these filters; showing popular products that match the filters. Present them as alternatives.");
  } else if (relaxed.filter((key) => key !== "exclude").length) {
    notes.push(`No exact match; relaxed ${relaxed.join(", ")}. Present these as the closest matches.`);
  } else if (related) {
    notes.push("No product contains these exact words; these are the closest matches by meaning. Say so, and ask a clarifying question if they look off.");
  } else if (mixed) {
    notes.push(
      `${mixed.keywordTotal} product(s) contain "${mixed.query}"; the rest are similar by scent or style. ` +
        `On this page the first ${mixed.keywordOnPage} contain the words and the others are similar. ` +
        "Mention that in one short phrase."
    );
  }
  if (applied.exclude && !relaxed.includes("exclude")) {
    notes.push(`Products with ${applied.exclude.join(" / ")} notes were left out, as the shopper asked.`);
  }
  if (unresolved.length) notes.push(`Not a known filter value, searched as text: ${unresolved.join(", ")}.`);
  return notes.join(" ") || null;
}

/**
 * @param {object} input tool arguments
 * @param {{ shopperMessage?: string, inheritedGender?: string }} [options]
 *   shopperMessage: the shopper's current chat message; inheritedGender: gender an earlier message
 *   set for this same search (next pages)
 */
export async function searchProducts(input = {}, options = {}) {
  const args = parseSearchProductArgs(input);
  const index = getProductsIndex();
  const intent = moveIntentWordsOutOfQuery(args.query, args.sort);
  if (intent.kids) args.filters.kids = true;
  if (intent.gender && !args.filters.gender) args.filters.gender = intent.gender;
  const genderFromMessage =
    !args.filters.gender
      ? genderFromShopperMessage(options.shopperMessage) || options.inheritedGender || null
      : null;
  if (genderFromMessage) args.filters.gender = genderFromMessage;
  if (["boys", "girls", "kids"].includes(args.filters.gender)) args.filters.kids = true;
  const { clauses, applied, unresolved, brand, categoryHandles, exclusion } = await resolveFilters(index, args.filters);
  const remaining = [
    withoutExcludedWords(withoutBrandWords(intent.query, [args.filters.brand, brand?.value]), args.filters.exclude),
    ...unresolved
  ]
    .join(" ")
    .trim();
  const query = onlyStopWords(remaining) ? "" : remaining;
  const sort = intent.sort;
  const debug = {
    parsed: args,
    query,
    sort,
    genderFromMessage,
    categoryHandles,
    ...(exclusion ? { exclusion: { terms: exclusion.terms, valuesExcluded: exclusion.byField } } : {}),
    filter: clauses.map((clause) => (clause.key === "exclude" ? `${clause.expr.slice(0, 200)}…` : clause.expr)),
    attempts: []
  };

  const emptyResult = (note) => ({
    result: {
      status: "success",
      source: "search_product",
      search_stage: "empty",
      match_quality: "none",
      relaxed_filters: [],
      applied: { query, sort, filters: applied },
      note,
      products: [],
      pagination: { cursor: null, has_next_page: false, total_count: 0, limit: args.limit, offset: args.offset }
    },
    debug
  });

  if (args.filters.brand && !brand?.value) {
    debug.brand = brand;
    return emptyResult(resultNote({ relaxed: [], brand, requestedBrand: args.filters.brand, unresolved }));
  }

  const vector = query && SEARCH_TUNING.semanticRatio > 0 ? await embedQuery(query) : null;
  debug.embedding = Boolean(vector);

  let found = null;
  let attempt = null;
  let facets = null;
  for (const step of relaxationPlan(clauses, query)) {
    const options = {
      query: step.query,
      vector: step.query ? vector : null,
      clauses: step.clauses,
      sort,
      priceRange: args.filters.price,
      limit: args.limit,
      offset: args.offset,
      withFacets: args.offset === 0 && !facets
    };
    found = step.query ? await searchWithQuery(index, options) : await browse(index, options);
    if (found.facetDistribution && !facets) facets = topFacets(found.facetDistribution);
    debug.attempts.push({
      query: step.query,
      relaxed: step.relaxed,
      filter: step.clauses.map((clause) => clause.expr),
      keywordTop: found.relevance?.keywordTop ?? null,
      semanticTop: found.relevance?.semanticTop ?? null,
      threshold: found.relevance?.threshold ?? null,
      tiers: found.tiers ?? null,
      totalHits: found.total,
      ms: found.ms
    });
    attempt = step;
    if (found.total > 0) break;
  }

  const hits = found.hits;
  const total = found.total;
  const hasNext = args.offset + hits.length < total;
  const scores = new Map(hits.map((hit) => [hit.id, Number((hit._rankingScore ?? 0).toFixed(4))]));
  const matchTypes = new Map(hits.filter((hit) => hit._match).map((hit) => [hit.id, { match_type: hit._match }]));

  const missingCardHits = hits.filter((hit) => !hit.card);
  let sqlCards = [];
  if (missingCardHits.length > 0) {
    sqlCards = await loadProductCards(
      missingCardHits.map((hit) => hit.id),
      scores,
      matchTypes
    );
  }
  const sqlCardsById = new Map(missingCardHits.map((hit, i) => [hit.id, sqlCards[i]]));

  const loadedProducts = hits
    .map((hit) => {
      if (hit.card) {
        return {
          ...hit.card,
          similarity: scores.get(hit.id) ?? null,
          ...matchTypes.get(hit.id)
        };
      }
      return sqlCardsById.get(hit.id) || null;
    })
    .filter(Boolean);

  const products =
    applied.applicable_offer && applied.price
      ? loadedProducts.filter((product) =>
          (product.variants || []).some((variant) => {
            const priceInDollars = Number(variant.price?.amount ?? 0) / 100;
            const hasOffer = Boolean(variant.applicable_offer || variant.applicableOffer);
            return hasOffer && inPriceRange(priceInDollars, applied.price);
          })
        )
      : loadedProducts;
  debug.hits = hits.map((hit) => ({ id: hit.id, title: hit.title, score: scores.get(hit.id), match: hit._match }));

  const relaxed = attempt?.relaxed || [];
  const keywordCount = found.keywordCount ?? null;
  // DISABLED with the keyword tiers in queryCandidates: "related" meant no product contains the query words.
  // const related = Boolean(attempt?.query && keywordCount === 0);
  const related = Boolean(attempt?.query && found.relevance && !found.relevance.keywordConfident);
  const keywordOnPage = hits.filter((hit) => hit._match === "keyword").length;
  const mixed =
    attempt?.query && keywordCount > 0 && keywordOnPage > 0 && keywordOnPage < hits.length
      ? { query: attempt.query, keywordTotal: keywordCount, keywordOnPage }
      : null;
  const searchStage = !products.length ? "empty" : !attempt.query ? "browse" : vector ? "hybrid" : "keyword";

  const empty = !products.length && args.offset === 0;
  const priceSpan =
    empty && applied.price ? await priceSpanWithoutBudget(index, { query, vector, clauses }) : null;
  if (priceSpan) debug.priceSpanWithoutBudget = priceSpan;

  const matchQuality = !products.length ? "none" : relaxed.length ? "relaxed" : related ? "related" : "exact";
  return {
    result: {
      status: "success",
      source: "search_product",
      search_stage: searchStage,
      match_quality: matchQuality,
      relaxed_filters: relaxed,
      applied: { query: attempt?.query ?? query, sort, filters: applied },
      ...(facets ? { facets } : {}),
      note: resultNote({
        relaxed,
        brand,
        requestedBrand: null,
        unresolved,
        empty,
        related,
        applied,
        pastEnd: !products.length && args.offset > 0 && total > 0,
        total,
        priceSpan,
        mixed
      }),
      products,
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
