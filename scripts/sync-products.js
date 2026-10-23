/**
 * Shopify Admin GraphQL → MySQL product catalog sync (upsert, no embeddings).
 *
 * Usage:
 *   node scripts/sync-products.js
 *   node scripts/sync-products.js --limit=10
 *   node scripts/sync-products.js --handle=chill-perfume
 *
 * Requires prisma migrate for the product tables before the first run.
 */
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { PrismaClient } from "@prisma/client";
import dotenv from "dotenv";

dotenv.config();

const prisma = new PrismaClient();

const SHOPIFY_ADMIN_ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
const STOREFRONT_URL = (process.env.STOREFRONT_URL || "https://perfumania.com").replace(
  /\/+$/,
  ""
);
const SHOPIFY_STORE_DOMAIN =
  process.env.SHOPIFY_STORE_DOMAIN ||
  (STOREFRONT_URL.includes("://") ? new URL(STOREFRONT_URL).hostname : STOREFRONT_URL) ||
  "perfumania-tfo.myshopify.com";
const API_VERSION = process.env.SHOPIFY_ADMIN_API_VERSION || "2025-07";
const GRAPHQL_URL = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${API_VERSION}/graphql.json`;
// 25 products with nested collections/images/variants/metaobjects scored 1184 (Shopify max 1000).
const PRODUCT_PAGE_SIZE = 20;

const CATEGORIES = [
  { handle: "womens-perfume-new-arrivals", name: "New Arrivals - Women's Perfume" },
  { handle: "bundle-deals-for-women", name: "Bundle Deals for Women" },
  { handle: "best-selling-perfumes-for-women", name: "Best Selling Perfumes for Women" },
  { handle: "only-at-perfumania", name: "Only at Perfumania" },
  { handle: "clearance-for-women-perfume", name: "Women's Perfume Sale" },
  { handle: "womens-perfume", name: "Women's Perfume" },
  { handle: "mens-cologne-new-arrivals", name: "New Arrivals - Men's Cologne" },
  { handle: "bundle-deals-for-men", name: "Bundle Deals for Men" },
  { handle: "best-selling-colognes-for-men", name: "Best Selling Colognes for Men" },
  { handle: "clearance-for-mens-cologne", name: "Men's Cologne on Sale" },
  { handle: "beauty", name: "Beauty" },
  { handle: "gift-set", name: "Gift Sets" }
];

const CATEGORY_HANDLES = new Set(CATEGORIES.map((c) => c.handle));

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

const METAFIELD_KEYS = [
  "top_notes",
  "middle_notes",
  "base_notes",
  "key_notes",
  "applicable_offer",
  "fragrance_family",
  "fragrance_family_new",
  "scent_type",
  "scent_type_new",
  "product_faqs",
  "product_review_summary"
];

const METAOBJECT_FIELDS = `
  id
  handle
  type
  fields { key value }
`;

const lookups = {
  brand: new Map(),
  gender: new Map(),
  productType: new Map(),
  offer: new Map(),
  family: new Map(),
  scent: new Map(),
  note: new Map(),
  noteType: new Map(),
  category: new Map(),
  faq: new Map()
};

const GRAPHQL_LOG_DIR = join(
  process.cwd(),
  "uploads",
  "shopify-graphql",
  new Date().toISOString().replace(/[:.]/g, "-")
);
let graphqlLogIndex = 0;

const stats = {
  products: 0,
  variants: 0,
  images: 0,
  notes: 0,
  faqs: 0,
  reviews: 0,
  categoryLinks: 0,
  errors: 0
};

function parseArgs(argv) {
  const out = { limit: null, handle: null, query: null };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--limit=")) {
      const n = Number(arg.slice(8));
      out.limit = Number.isFinite(n) && n > 0 ? n : null;
    } else if (arg.startsWith("--handle=")) {
      out.handle = arg.slice(9).trim() || null;
    } else if (arg.startsWith("--query=")) {
      out.query = arg.slice(8).trim() || null;
    }
  }
  return out;
}

function operationName(query) {
  const match = String(query || "").match(/\bquery\s+(\w+)/);
  return match ? match[1] : "anonymous";
}

async function logGraphqlCall({
  baseUrl,
  operation,
  request,
  responseBody,
  statusCode,
  durationMs,
  errorMessage
}) {
  mkdirSync(GRAPHQL_LOG_DIR, { recursive: true });
  graphqlLogIndex += 1;
  const fileName = `${String(graphqlLogIndex).padStart(4, "0")}-${operation || "graphql"}.json`;
  const filePath = join(GRAPHQL_LOG_DIR, fileName);
  const payload = {
    baseUrl,
    operation,
    statusCode,
    durationMs,
    errorMessage: errorMessage || null,
    request,
    response: responseBody
  };
  try {
    writeFileSync(filePath, JSON.stringify(payload, null, 2));
  } catch (err) {
    console.warn(`[sync-products] Could not write GraphQL file ${filePath}: ${err.message}`);
  }

  try {
    await prisma.shopifyGraphqlLog.create({
      data: {
        baseUrl,
        operation,
        request: JSON.stringify(request),
        response: JSON.stringify(responseBody ?? {}),
        statusCode,
        durationMs,
        errorMessage: errorMessage || null,
        filePath
      }
    });
  } catch (err) {
    console.warn(`[sync-products] Could not save GraphQL log: ${err.message}`);
  }
}

function numericId(gidOrId) {
  const raw = String(gidOrId || "").trim();
  const match = raw.match(/(\d+)\s*$/);
  return match ? match[1] : raw;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripHtml(html) {
  if (!html) return "";
  return String(html)
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<\/?[^>]+(>|$)/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitNotes(raw) {
  if (!raw) return [];
  return String(raw)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
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
  if (!Number.isFinite(averageRating) && !Number.isFinite(totalReviews)) return null;
  return {
    averageRating: Number.isFinite(averageRating) ? averageRating : 0,
    totalReviews: Number.isFinite(totalReviews) ? totalReviews : 0,
    oneStar: Number(parts["1star"]) || 0,
    twoStar: Number(parts["2star"]) || 0,
    threeStar: Number(parts["3star"]) || 0,
    fourStar: Number(parts["4star"]) || 0,
    fiveStar: Number(parts["5star"]) || 0
  };
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

function metaobjectLabel(obj) {
  if (!obj) return null;
  const fields = Object.fromEntries(
    (obj.fields || []).map((f) => [String(f.key || "").toLowerCase(), String(f.value || "").trim()])
  );
  return (
    fields.label ||
    fields.name ||
    fields.title ||
    fields.value ||
    fields.display_name ||
    (obj.handle
      ? obj.handle.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
      : null) ||
    null
  );
}

function faqFields(obj) {
  const fields = {};
  for (const field of obj?.fields || []) {
    fields[String(field.key || "").toLowerCase()] = String(field.value || "").trim();
  }
  return fields;
}

function faqsFromMetaobject(obj) {
  if (!obj?.id) return [];
  const fields = faqFields(obj);
  const metaId = numericId(obj.id);
  const faqs = [];
  const blockNums = new Set();
  for (const key of Object.keys(fields)) {
    const match = key.match(/^block_(\d+)_(question|answer)$/);
    if (match) blockNums.add(Number(match[1]));
  }
  for (const n of [...blockNums].sort((a, b) => a - b)) {
    const question = fields[`block_${n}_question`] || "";
    const answer = fields[`block_${n}_answer`] || "";
    if (!question || !answer) continue;
    faqs.push({
      shopifyMetaobjectId: metaId,
      question,
      answer,
      position: n,
      embeddingContent: `${question}\n${answer}`
    });
  }
  if (faqs.length) return faqs;

  const question =
    fields.question || fields.title || fields.q || fields.name || fields.heading || "";
  const answer =
    fields.answer ||
    fields.body ||
    fields.a ||
    fields.content ||
    fields.description ||
    fields.text ||
    "";
  if (!question || !answer) return [];
  return [
    {
      shopifyMetaobjectId: metaId,
      question,
      answer,
      position: 0,
      embeddingContent: `${question}\n${answer}`
    }
  ];
}

function metafieldsByKey(product = {}) {
  const map = {};
  for (const key of METAFIELD_KEYS) {
    const mf = product[key];
    if (mf && (mf.value != null || mf.reference || mf.references)) {
      map[key] = mf;
    }
  }
  return map;
}

function genderFromTagsAndType(tags = [], productTypeMetafield = "") {
  const normalized = (tags || []).map((t) => String(t).toLowerCase().trim());
  const typeText = String(productTypeMetafield || "").toLowerCase();

  const hasWomen =
    normalized.some(
      (t) =>
        t === "gender_women" ||
        t.startsWith("gender_women") ||
        t === "women" ||
        t === "womens" ||
        t === "women's"
    ) || /\bfor women\b/.test(typeText);
  const hasMen =
    normalized.some(
      (t) =>
        t === "gender_men" ||
        t.startsWith("gender_men") ||
        t === "men" ||
        t === "mens" ||
        t === "men's"
    ) || /\bfor men\b/.test(typeText);
  const hasUnisex =
    normalized.some((t) => t.includes("unisex") || t === "gender_unisex") ||
    /\bunisex\b/.test(typeText);

  if (hasUnisex || (hasWomen && hasMen)) return "Unisex";
  if (hasWomen) return "Women";
  if (hasMen) return "Men";
  return null;
}

function firstLabelFromMetafield(mf, gidMap = {}) {
  if (!mf) return null;
  const refs = [];
  if (mf.reference) refs.push(mf.reference);
  for (const node of mf.references?.nodes || []) refs.push(node);
  for (const ref of refs) {
    const label = metaobjectLabel(ref);
    if (label) return label;
  }
  const plain = String(mf.value || "").trim();
  if (plain && !plain.includes("gid://")) return plain;
  const gids = parseMetaobjectGids(mf.value);
  for (const gid of gids) {
    if (gidMap[gid]) return gidMap[gid];
  }
  if (refs[0]?.handle) return metaobjectLabel(refs[0]);
  return null;
}

function buildEmbeddingContent(product, extras) {
  const lines = [
    product.title,
    extras.brandName,
    extras.productTypeName,
    extras.genderName,
    extras.familyName ? `Fragrance family: ${extras.familyName}` : "",
    extras.scentName ? `Scent type: ${extras.scentName}` : "",
    extras.offerName ? `Offer: ${extras.offerName}` : "",
    extras.keyNotes.length ? `Key notes: ${extras.keyNotes.join(", ")}` : "",
    extras.topNotes.length ? `Top notes: ${extras.topNotes.join(", ")}` : "",
    extras.middleNotes.length ? `Middle notes: ${extras.middleNotes.join(", ")}` : "",
    extras.baseNotes.length ? `Base notes: ${extras.baseNotes.join(", ")}` : "",
    extras.description || ""
  ];
  return lines.filter(Boolean).join("\n");
}

function scopeHint(errors = []) {
  const text = JSON.stringify(errors);
  const hints = [];
  if (/metaobject/i.test(text) || /reference/i.test(text)) {
    hints.push("read_metaobjects  (fragrance family, scent type, product FAQs)");
  }
  if (/inventory/i.test(text)) {
    hints.push("read_inventory  (variant stock quantities)");
  }
  if (/collection/i.test(text) || /publication/i.test(text)) {
    hints.push("read_products  (already in shopify.app.toml; re-auth the app if token is old)");
  }
  if (!hints.length) {
    hints.push("read_products, read_metaobjects, read_inventory");
  }
  return hints;
}

function productsQuery(includeMetaobjectRefs) {
  const refBlock = includeMetaobjectRefs
    ? `
      reference {
        ... on Metaobject { ${METAOBJECT_FIELDS} }
      }
      references(first: 10) {
        nodes {
          ... on Metaobject { ${METAOBJECT_FIELDS} }
        }
      }`
    : "";

  const metafieldBlock = METAFIELD_KEYS.map(
    (key) => `
          ${key}: metafield(namespace: "custom", key: "${key}") {
            namespace
            key
            type
            value
            ${refBlock}
          }`
  ).join("\n");

  return `
    query GetProducts($first: Int!, $after: String, $query: String) {
      products(first: $first, after: $after, query: $query) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          handle
          title
          description
          descriptionHtml
          vendor
          productType
          status
          tags
          updatedAt
          collections(first: 50) {
            nodes { handle title }
          }
          images(first: 30) {
            nodes { id url altText }
          }
          variants(first: 50) {
            nodes {
              id
              title
              sku
              barcode
              price
              compareAtPrice
              availableForSale
              inventoryQuantity
              position
              selectedOptions { name value }
              image { id url altText }
            }
          }
          ${metafieldBlock}
        }
      }
    }
  `;
}

const COLLECTION_PRODUCTS_QUERY = `
  query GetCollectionProducts($handle: String!, $after: String) {
    collectionByHandle(handle: $handle) {
      id
      handle
      title
      products(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { id }
      }
    }
  }
`;

async function shopifyGraphql(query, variables = {}, { retries = 5 } = {}) {
  const operation = operationName(query);
  const request = { query, variables };

  for (let attempt = 1; attempt <= retries; attempt++) {
    const started = Date.now();
    let statusCode = 0;
    let json = {};
    try {
      const response = await fetch(GRAPHQL_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": SHOPIFY_ADMIN_ACCESS_TOKEN
        },
        body: JSON.stringify(request)
      });
      statusCode = response.status;
      json = await response.json().catch(() => ({}));
      const durationMs = Date.now() - started;
      const throttle = json?.extensions?.cost?.throttleStatus;
      const throttled =
        response.status === 429 ||
        (Array.isArray(json.errors) &&
          json.errors.some((e) => String(e.extensions?.code || "").includes("THROTTLE")));

      const graphqlError =
        Array.isArray(json.errors) && json.errors.length
          ? JSON.stringify(json.errors)
          : !response.ok
            ? `Shopify HTTP ${response.status}`
            : null;

      await logGraphqlCall({
        baseUrl: GRAPHQL_URL,
        operation,
        request,
        responseBody: json,
        statusCode,
        durationMs,
        errorMessage: graphqlError
      });

      if (throttled && attempt < retries) {
        const waitMs = Math.max(1500, Number(throttle?.restoreRate ? 1000 : 2000) * attempt);
        console.warn(`[sync-products] Throttled, retrying in ${waitMs}ms (attempt ${attempt})`);
        await sleep(waitMs);
        continue;
      }

      if (!response.ok) {
        throw new Error(`Shopify HTTP ${response.status}: ${JSON.stringify(json).slice(0, 600)}`);
      }

      if (graphqlError) {
        const err = new Error(graphqlError);
        err.graphqlErrors = json.errors;
        throw err;
      }

      if (throttle && Number(throttle.currentlyAvailable) < 100) {
        await sleep(400);
      }

      return json.data;
    } catch (err) {
      if (err.graphqlErrors || String(err.message || "").startsWith("Shopify HTTP")) {
        throw err;
      }
      await logGraphqlCall({
        baseUrl: GRAPHQL_URL,
        operation,
        request,
        responseBody: json,
        statusCode,
        durationMs: Date.now() - started,
        errorMessage: err.message
      });
      throw err;
    }
  }
  throw new Error("Shopify GraphQL retries exhausted");
}

async function upsertNamed(cacheKey, delegate, name) {
  const trimmed = String(name || "").trim();
  if (!trimmed) return null;
  const key = trimmed.toLowerCase();
  if (lookups[cacheKey].has(key)) return lookups[cacheKey].get(key);
  const row = await delegate.upsert({
    where: { name: trimmed },
    update: {},
    create: { name: trimmed }
  });
  lookups[cacheKey].set(key, row);
  return row;
}

async function seedNoteTypes() {
  const types = [
    { code: "key", name: "Key", position: 0 },
    { code: "top", name: "Top", position: 1 },
    { code: "middle", name: "Middle", position: 2 },
    { code: "base", name: "Base", position: 3 }
  ];
  for (const type of types) {
    const row = await prisma.noteType.upsert({
      where: { code: type.code },
      update: { name: type.name, position: type.position },
      create: type
    });
    lookups.noteType.set(type.code, row);
  }
}

async function seedCategories() {
  for (const cat of CATEGORIES) {
    const url = `${STOREFRONT_URL}/collections/${cat.handle}`;
    const row = await prisma.productCategory.upsert({
      where: { handle: cat.handle },
      update: { name: cat.name, url },
      create: { name: cat.name, handle: cat.handle, url }
    });
    lookups.category.set(cat.handle, row);
  }
  console.log(`[sync-products] Seeded ${CATEGORIES.length} categories`);
}

async function fetchAllProducts({ limit, handle, query, includeMetaobjectRefs }) {
  const products = [];
  let after = null;
  const pageSize = limit ? Math.min(PRODUCT_PAGE_SIZE, limit) : PRODUCT_PAGE_SIZE;
  let searchQuery = query || null;
  if (handle) searchQuery = `handle:${handle}`;

  while (true) {
    const remaining = limit ? limit - products.length : null;
    const first = remaining ? Math.min(pageSize, remaining) : pageSize;
    const data = await shopifyGraphql(productsQuery(includeMetaobjectRefs), {
      first,
      after,
      query: searchQuery
    });
    const conn = data?.products;
    const nodes = conn?.nodes || [];
    products.push(...nodes);
    console.log(`[sync-products] Fetched ${products.length} products...`);
    if (limit && products.length >= limit) break;
    if (!conn?.pageInfo?.hasNextPage) break;
    after = conn.pageInfo.endCursor;
    await sleep(150);
  }
  return products;
}

async function fetchCollectionMembership(limitMode) {
  const membership = new Map();
  if (limitMode) return membership;

  for (const cat of CATEGORIES) {
    let after = null;
    let found = 0;
    while (true) {
      let data;
      try {
        data = await shopifyGraphql(COLLECTION_PRODUCTS_QUERY, {
          handle: cat.handle,
          after
        });
      } catch (err) {
        console.warn(
          `[sync-products] Could not load collection ${cat.handle}: ${err.message.slice(0, 300)}`
        );
        break;
      }
      const collection = data?.collectionByHandle;
      if (!collection) {
        console.warn(`[sync-products] Collection not found: ${cat.handle}`);
        break;
      }
      if (collection.title) {
        await prisma.productCategory.update({
          where: { handle: cat.handle },
          data: { name: collection.title }
        });
      }
      for (const node of collection.products?.nodes || []) {
        const id = numericId(node.id);
        if (!membership.has(id)) membership.set(id, new Set());
        membership.get(id).add(cat.handle);
        found += 1;
      }
      if (!collection.products?.pageInfo?.hasNextPage) break;
      after = collection.products.pageInfo.endCursor;
      await sleep(120);
    }
    console.log(`[sync-products] Collection ${cat.handle}: ${found} products`);
  }
  return membership;
}

function handlesFromProduct(product) {
  const handles = new Set();
  for (const col of product.collections?.nodes || []) {
    if (col?.handle && CATEGORY_HANDLES.has(col.handle)) handles.add(col.handle);
  }
  return handles;
}

async function syncNotes(productId, groups) {
  await prisma.productNote.deleteMany({ where: { productId } });
  let count = 0;
  for (const [typeCode, names] of Object.entries(groups)) {
    const noteType = lookups.noteType.get(typeCode);
    if (!noteType) {
      console.warn(`[sync-products] Unknown note type "${typeCode}", skipping`);
      continue;
    }
    const seen = new Set();
    for (let i = 0; i < names.length; i += 1) {
      const key = names[i].toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const note = await upsertNamed("note", prisma.note, names[i]);
      if (!note) continue;
      await prisma.productNote.create({
        data: {
          productId,
          noteId: note.id,
          typeId: noteType.id,
          position: i
        }
      });
      count += 1;
    }
  }
  return count;
}

async function syncVariants(shopifyProductId, variants) {
  const keepIds = [];
  const imageToVariant = new Map();

  for (const variant of variants || []) {
    const shopifyVariantId = numericId(variant.id);
    const option1 =
      (variant.selectedOptions || []).find((o) => /size/i.test(o.name || ""))?.value ||
      variant.selectedOptions?.[0]?.value ||
      variant.title ||
      null;
    const row = await prisma.productVariant.upsert({
      where: { shopifyVariantId },
      update: {
        shopifyProductId,
        title: variant.title || null,
        option1,
        sku: variant.sku || null,
        barcode: variant.barcode || null,
        price: variant.price || "0.00",
        compareAtPrice: variant.compareAtPrice || null,
        availableForSale: variant.availableForSale === true,
        inventoryQuantity: Number.isFinite(Number(variant.inventoryQuantity))
          ? Number(variant.inventoryQuantity)
          : 0,
        position: Number(variant.position) || 1
      },
      create: {
        shopifyVariantId,
        shopifyProductId,
        title: variant.title || null,
        option1,
        sku: variant.sku || null,
        barcode: variant.barcode || null,
        price: variant.price || "0.00",
        compareAtPrice: variant.compareAtPrice || null,
        availableForSale: variant.availableForSale === true,
        inventoryQuantity: Number.isFinite(Number(variant.inventoryQuantity))
          ? Number(variant.inventoryQuantity)
          : 0,
        position: Number(variant.position) || 1
      }
    });
    keepIds.push(row.shopifyVariantId);
    if (variant.image?.id) imageToVariant.set(String(variant.image.id), row.id);
    stats.variants += 1;
  }

  await prisma.productVariant.deleteMany({
    where: {
      shopifyProductId,
      shopifyVariantId: { notIn: keepIds }
    }
  });

  return imageToVariant;
}

async function syncImages(productId, images, imageToVariant) {
  const keepIds = [];
  for (let i = 0; i < (images || []).length; i += 1) {
    const image = images[i];
    if (!image?.id || !image.url) continue;
    const shopifyImageId = String(image.id);
    const variantId = imageToVariant.get(shopifyImageId) || null;
    await prisma.productImage.upsert({
      where: { shopifyImageId },
      update: {
        productId,
        variantId,
        url: image.url,
        alt: image.altText || null,
        position: i + 1
      },
      create: {
        productId,
        variantId,
        shopifyImageId,
        url: image.url,
        alt: image.altText || null,
        position: i + 1
      }
    });
    keepIds.push(shopifyImageId);
    stats.images += 1;
  }

  await prisma.productImage.deleteMany({
    where: {
      productId,
      shopifyImageId: { notIn: keepIds }
    }
  });
}

function faqCacheKey(question, answer) {
  return `${question}\n${answer}`;
}

async function upsertFaq(faq) {
  const key = faqCacheKey(faq.question, faq.answer);
  if (lookups.faq.has(key)) return lookups.faq.get(key);
  let row = await prisma.productFaq.findFirst({
    where: { question: faq.question, answer: faq.answer }
  });
  if (!row) {
    row = await prisma.productFaq.create({
      data: {
        shopifyMetaobjectId: faq.shopifyMetaobjectId,
        question: faq.question,
        answer: faq.answer,
        embeddingContent: faq.embeddingContent
      }
    });
  }
  lookups.faq.set(key, row);
  return row;
}

async function syncFaqs(productId, shopifyProductId, metafield) {
  const faqs = [];
  if (metafield?.reference) {
    faqs.push(...faqsFromMetaobject(metafield.reference));
  }
  for (const node of metafield?.references?.nodes || []) {
    faqs.push(...faqsFromMetaobject(node));
  }
  if (!faqs.length && metafield?.value?.includes("gid://shopify/Metaobject")) {
    if (!metafield.reference && !(metafield.references?.nodes || []).length) {
      console.warn(
        `[sync-products] FAQ metaobject GID present on product ${shopifyProductId} but was not resolved. Add read_metaobjects.`
      );
    } else {
      console.warn(
        `[sync-products] FAQ metaobject on product ${shopifyProductId} had no question/answer pairs.`
      );
    }
  }

  await prisma.productFaqProduct.deleteMany({ where: { productId } });
  const linked = new Set();
  for (const faq of faqs) {
    const row = await upsertFaq(faq);
    if (linked.has(row.id)) continue;
    linked.add(row.id);
    await prisma.productFaqProduct.create({
      data: {
        productId,
        faqId: row.id,
        position: faq.position
      }
    });
    stats.faqs += 1;
  }
}

async function syncReview(productId, summary) {
  if (!summary) {
    await prisma.productReview.deleteMany({ where: { productId } });
    return;
  }
  await prisma.productReview.upsert({
    where: { productId },
    update: summary,
    create: { productId, ...summary }
  });
  stats.reviews += 1;
}

async function syncCategories(productId, handles) {
  const categoryIds = [...handles]
    .map((handle) => lookups.category.get(handle)?.id)
    .filter(Boolean);
  await prisma.productCategoryProduct.deleteMany({
    where: {
      productId,
      categoryId: { notIn: categoryIds }
    }
  });
  for (const categoryId of categoryIds) {
    await prisma.productCategoryProduct.upsert({
      where: {
        productId_categoryId: { productId, categoryId }
      },
      update: {},
      create: { productId, categoryId }
    });
    stats.categoryLinks += 1;
  }
}

async function upsertProduct(product, membership) {
  const shopifyProductId = numericId(product.id);
  const mf = metafieldsByKey(product);
  const productTypeName = String(product.productType || "").trim() || null;
  const genderName = genderFromTagsAndType(product.tags || [], productTypeName);
  const offerName = String(mf.applicable_offer?.value || "").trim() || null;
  const familyName = firstLabelFromMetafield(mf.fragrance_family_new, FRAGRANCE_FAMILY_GID_LABELS);
  const familyFallback =
    familyName || firstLabelFromMetafield(mf.fragrance_family, FRAGRANCE_FAMILY_GID_LABELS);
  const scentName = firstLabelFromMetafield(mf.scent_type_new, SCENT_TYPE_GID_LABELS);
  const scentFallback = scentName || firstLabelFromMetafield(mf.scent_type, SCENT_TYPE_GID_LABELS);
  const keyNotes = splitNotes(mf.key_notes?.value);
  const topNotes = splitNotes(mf.top_notes?.value);
  const middleNotes = splitNotes(mf.middle_notes?.value);
  const baseNotes = splitNotes(mf.base_notes?.value);
  const description =
    String(product.description || "").trim() || stripHtml(product.descriptionHtml) || null;

  const brand = product.vendor
    ? await upsertNamed("brand", prisma.brand, product.vendor)
    : null;
  const gender = genderName
    ? await upsertNamed("gender", prisma.productGender, genderName)
    : null;
  const productType = productTypeName
    ? await upsertNamed("productType", prisma.productType, productTypeName)
    : null;
  let offer = null;
  if (offerName) {
    const offerKey = offerName.toLowerCase();
    offer = lookups.offer.get(offerKey);
    if (!offer) {
      offer = await prisma.applicableOffer.upsert({
        where: { name: offerName },
        update: { offerText: offerName },
        create: { name: offerName, offerText: offerName }
      });
      lookups.offer.set(offerKey, offer);
    }
  }
  const family = familyFallback
    ? await upsertNamed("family", prisma.fragranceFamily, familyFallback)
    : null;
  const scent = scentFallback
    ? await upsertNamed("scent", prisma.scentType, scentFallback)
    : null;

  const extra = {
    brandName: product.vendor || "",
    productTypeName: productTypeName || "",
    genderName: genderName || "",
    familyName: familyFallback || "",
    scentName: scentFallback || "",
    offerName: offerName || "",
    keyNotes,
    topNotes,
    middleNotes,
    baseNotes,
    description: description || ""
  };

  const data = {
    handle: product.handle,
    title: product.title,
    description,
    brandId: brand?.id || null,
    genderId: gender?.id || null,
    productTypeId: productType?.id || null,
    applicableOfferId: offer?.id || null,
    fragranceFamilyId: family?.id || null,
    scentTypeId: scent?.id || null,
    status: String(product.status || "ACTIVE").toLowerCase(),
    embeddingContent: buildEmbeddingContent(product, extra),
    shopifyUpdatedAt: product.updatedAt ? new Date(product.updatedAt) : null,
    lastSyncedAt: new Date()
  };

  const saved = await prisma.product.upsert({
    where: { shopifyProductId },
    update: data,
    create: { shopifyProductId, ...data }
  });

  const imageToVariant = await syncVariants(shopifyProductId, product.variants?.nodes || []);
  await syncImages(saved.id, product.images?.nodes || [], imageToVariant);
  stats.notes += await syncNotes(saved.id, {
    key: keyNotes,
    top: topNotes,
    middle: middleNotes,
    base: baseNotes
  });
  await syncFaqs(saved.id, shopifyProductId, mf.product_faqs);
  await syncReview(saved.id, parseReviewSummary(mf.product_review_summary?.value));

  const handles = handlesFromProduct(product);
  for (const handle of membership.get(shopifyProductId) || []) handles.add(handle);
  await syncCategories(saved.id, handles);

  stats.products += 1;
  return saved;
}

async function databaseTotals() {
  const [products, variants, images, notes, faqs, faqLinks, reviews, categoryLinks] =
    await Promise.all([
      prisma.product.count(),
      prisma.productVariant.count(),
      prisma.productImage.count(),
      prisma.productNote.count(),
      prisma.productFaq.count(),
      prisma.productFaqProduct.count(),
      prisma.productReview.count(),
      prisma.productCategoryProduct.count()
    ]);
  return { products, variants, images, notes, faqs, faqLinks, reviews, categoryLinks };
}

async function main() {
  const args = parseArgs(process.argv);
  console.log("Starting Shopify product sync (no embeddings)...");
  console.log(`Store: ${SHOPIFY_STORE_DOMAIN}`);
  console.log(`API: ${API_VERSION}`);
  console.log(`GraphQL logs: ${GRAPHQL_LOG_DIR}`);
  if (args.limit) console.log(`Limit: ${args.limit}`);
  if (args.handle) console.log(`Handle: ${args.handle}`);

  if (!SHOPIFY_ADMIN_ACCESS_TOKEN) {
    console.error("Error: SHOPIFY_ADMIN_ACCESS_TOKEN is not set in .env");
    process.exit(1);
  }

  try {
    await seedNoteTypes();
    await seedCategories();
  } catch (err) {
    if (String(err.message || "").includes("does not exist") || err.code === "P2021") {
      console.error(
        "Product tables are missing. Run prisma migrate first, then re-run this script."
      );
    }
    throw err;
  }

  let includeMetaobjectRefs = true;
  let products;
  try {
    products = await fetchAllProducts({ ...args, includeMetaobjectRefs });
  } catch (err) {
    const hints = scopeHint(err.graphqlErrors || [{ message: err.message }]);
    if (/ACCESS_DENIED|ACCESS_DENIED_MISSING_SCOPE|metaobject/i.test(err.message)) {
      console.warn("[sync-products] Metaobject fields were denied. Retrying without references.");
      console.warn("Add this scope, then reinstall/re-auth the app:");
      for (const hint of hints) console.warn(`  - ${hint}`);
      includeMetaobjectRefs = false;
      products = await fetchAllProducts({ ...args, includeMetaobjectRefs });
    } else {
      throw err;
    }
  }

  const membership = await fetchCollectionMembership(Boolean(args.limit || args.handle));
  const fetched = products.length;
  console.log(`[sync-products] Total products fetched from Shopify: ${fetched}`);
  console.log(`[sync-products] Upserting ${fetched} products...`);

  for (const product of products) {
    try {
      await upsertProduct(product, membership);
      if (stats.products % PRODUCT_PAGE_SIZE === 0 || stats.products === fetched) {
        console.log(`[sync-products] Synced ${stats.products}/${fetched} products`);
      }
    } catch (err) {
      stats.errors += 1;
      console.error(
        `[sync-products] Failed ${product.handle || product.id}: ${err.message.slice(0, 400)}`
      );
    }
  }

  const totals = await databaseTotals();
  console.log("[sync-products] Done.");
  console.log("[sync-products] This run:");
  console.log(`  products fetched: ${fetched}`);
  console.log(`  products synced:  ${stats.products}`);
  console.log(`  products failed:  ${stats.errors}`);
  console.log(`  variants:         ${stats.variants}`);
  console.log(`  images:           ${stats.images}`);
  console.log(`  notes:            ${stats.notes}`);
  console.log(`  faq links:        ${stats.faqs}`);
  console.log(`  reviews:          ${stats.reviews}`);
  console.log(`  category links:   ${stats.categoryLinks}`);
  console.log("[sync-products] Database totals:");
  console.log(`  products:         ${totals.products}`);
  console.log(`  variants:         ${totals.variants}`);
  console.log(`  images:           ${totals.images}`);
  console.log(`  notes:            ${totals.notes}`);
  console.log(`  faqs:             ${totals.faqs}`);
  console.log(`  faq links:        ${totals.faqLinks}`);
  console.log(`  reviews:          ${totals.reviews}`);
  console.log(`  category links:   ${totals.categoryLinks}`);
}

main()
  .catch((err) => {
    console.error("[sync-products] Fatal:", err.message);
    if (err.graphqlErrors) {
      console.error("GraphQL errors:", JSON.stringify(err.graphqlErrors, null, 2));
      console.error("Add/confirm Shopify Admin API scopes, then re-auth the app:");
      for (const hint of scopeHint(err.graphqlErrors)) console.error(`  - ${hint}`);
    }
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
