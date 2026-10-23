/**
 * Generate OpenAI embeddings for catalog products.
 *
 * Usage:
 *   node scripts/embed-products.js
 *   node scripts/embed-products.js --limit=1000
 *   node scripts/embed-products.js --handle=qaed-al-fursan-untamed-unisex-fragrance
 *   node scripts/embed-products.js --dry-run
 *   node scripts/embed-products.js --force
 *
 * Default: embed 1000 active products that are missing a vector.
 * Inactive products and products that already have embeddings are skipped.
 */
import { PrismaClient } from "@prisma/client";
import dotenv from "dotenv";

dotenv.config();

const prisma = new PrismaClient();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";
const COST_PER_TOKEN = 0.00000002;
const DEFAULT_LIMIT = 1000;

const PRODUCT_INCLUDE = {
  brand: true,
  gender: true,
  productType: true,
  fragranceFamily: true,
  scentType: true,
  applicableOffer: true,
  variants: { orderBy: { position: "asc" } },
  notes: {
    include: { note: true, type: true },
    orderBy: [{ type: { position: "asc" } }, { position: "asc" }]
  },
  categories: { include: { category: true } },
  review: true
};

function parseArgs(argv) {
  const out = { limit: DEFAULT_LIMIT, handle: null, force: false, dryRun: false };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--limit=")) {
      const n = Number(arg.slice(8));
      out.limit = Number.isFinite(n) && n > 0 ? n : DEFAULT_LIMIT;
    } else if (arg.startsWith("--handle=")) {
      out.handle = arg.slice(9).trim() || null;
    } else if (arg === "--force") {
      out.force = true;
    } else if (arg === "--dry-run") {
      out.dryRun = true;
    }
  }
  return out;
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

function variantSummary(variants = []) {
  return variants
    .map((v) => {
      const size = String(v.option1 || v.title || "").trim();
      const price = v.price != null ? `$${Number(v.price).toFixed(2)}` : "";
      if (size && price) return `${size} (${price})`;
      return size || price;
    })
    .filter(Boolean);
}

function buildEmbeddingContent(product) {
  const notes = notesByType(product.notes);
  const sizes = variantSummary(product.variants);
  const categories = (product.categories || [])
    .map((row) => row.category?.name)
    .filter(Boolean);
  const offer = product.applicableOffer?.name || product.applicableOffer?.offerText;
  const rating =
    product.review && Number(product.review.totalReviews) > 0
      ? `${Number(product.review.averageRating)}/5 from ${product.review.totalReviews} reviews`
      : "";

  const lines = [
    product.title,
    product.brand?.name ? `Brand: ${product.brand.name}` : "",
    product.gender?.name ? `Gender: ${product.gender.name}` : "",
    product.productType?.name ? `Product type: ${product.productType.name}` : "",
    product.fragranceFamily?.name ? `Fragrance family: ${product.fragranceFamily.name}` : "",
    product.scentType?.name ? `Scent type: ${product.scentType.name}` : "",
    notes.key.length ? `Key notes: ${notes.key.join(", ")}` : "",
    notes.top.length ? `Top notes: ${notes.top.join(", ")}` : "",
    notes.middle.length ? `Middle notes: ${notes.middle.join(", ")}` : "",
    notes.base.length ? `Base notes: ${notes.base.join(", ")}` : "",
    sizes.length ? `Sizes: ${sizes.join(", ")}` : "",
    offer ? `Offer: ${offer}` : "",
    categories.length ? `Collections: ${categories.join(", ")}` : "",
    rating ? `Reviews: ${rating}` : "",
    product.description ? `Description: ${product.description}` : ""
  ];
  return lines.filter(Boolean).join("\n");
}

async function embeddingIds(ids) {
  if (!ids.length) return new Set();
  const placeholders = ids.map(() => "?").join(", ");
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id FROM products WHERE embedding IS NOT NULL AND id IN (${placeholders})`,
    ...ids
  );
  return new Set(rows.map((row) => row.id));
}

async function loadProducts({ limit, handle, force }) {
  if (handle) {
    const product = await prisma.product.findUnique({
      where: { handle },
      include: PRODUCT_INCLUDE
    });
    if (!product) return [];
    if (String(product.status || "").toLowerCase() !== "active") {
      console.log(`[embed-products] Skipped ${handle}: not active (${product.status})`);
      return [];
    }
    if (!force) {
      const existing = await embeddingIds([product.id]);
      if (existing.has(product.id)) {
        console.log(`[embed-products] Skipped ${handle}: embedding already exists`);
        return [];
      }
    }
    return [product];
  }

  const where = force
    ? `status = 'active'`
    : `status = 'active' AND embedding IS NULL`;
  const ids = await prisma.$queryRawUnsafe(
    `SELECT id FROM products WHERE ${where} ORDER BY last_synced_at DESC LIMIT ${Number(limit)}`
  );

  if (!ids.length) return [];
  const idList = ids.map((row) => row.id);
  const products = await prisma.product.findMany({
    where: { id: { in: idList } },
    include: PRODUCT_INCLUDE
  });
  const order = new Map(idList.map((id, i) => [id, i]));
  products.sort((a, b) => order.get(a.id) - order.get(b.id));
  return products;
}

async function embedText(text) {
  const requestPayload = {
    model: OPENAI_EMBEDDING_MODEL,
    input: text
  };
  const started = Date.now();
  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(requestPayload)
  });
  const data = await response.json();
  const durationMs = Date.now() - started;
  if (!response.ok) {
    const err = new Error(JSON.stringify(data));
    err.statusCode = response.status;
    throw err;
  }
  return {
    vector: data.data?.[0]?.embedding,
    tokensUsed: data.usage?.total_tokens || 0,
    durationMs
  };
}

async function saveEmbedding(productId, text, vector, { tokensUsed, costUsd }) {
  await prisma.$executeRawUnsafe(
    `UPDATE products
     SET embedding = STRING_TO_VECTOR(?),
         embedding_content = ?,
         token_count = ?,
         llm_cost = ?,
         updated_at = CURRENT_TIMESTAMP(3)
     WHERE id = ?`,
    JSON.stringify(vector),
    text,
    tokensUsed,
    costUsd,
    productId
  );
}

async function main() {
  const args = parseArgs(process.argv);
  console.log("Starting product embedding...");
  console.log(`Model: ${OPENAI_EMBEDDING_MODEL}`);
  console.log("Scope: active products only; skip products that already have embeddings");
  console.log(`Limit: ${args.handle ? 1 : args.limit}`);
  if (args.handle) console.log(`Handle: ${args.handle}`);
  if (args.force) console.log("Force: re-embed even if a vector already exists");
  if (args.dryRun) console.log("Dry run: print embedding text only, no API calls");

  if (!args.dryRun && !OPENAI_API_KEY) {
    console.error("Error: OPENAI_API_KEY is not set in .env");
    process.exit(1);
  }

  const products = await loadProducts(args);
  if (!products.length) {
    console.log("No products to embed.");
    return;
  }

  let synced = 0;
  let skipped = 0;
  let failed = 0;
  let tokens = 0;
  let cost = 0;

  for (const product of products) {
    const text = buildEmbeddingContent(product);
    console.log("\n---");
    console.log(`${product.title} (${product.handle})`);
    console.log(text);

    if (!text.trim()) {
      skipped += 1;
      console.log("Skipped: empty embedding text");
      continue;
    }

    if (args.dryRun) {
      skipped += 1;
      continue;
    }

    try {
      const result = await embedText(text);
      if (!result.vector?.length) {
        throw new Error("OpenAI returned an empty embedding");
      }
      const itemCost = result.tokensUsed * COST_PER_TOKEN;
      await saveEmbedding(product.id, text, result.vector, {
        tokensUsed: result.tokensUsed,
        costUsd: itemCost
      });
      tokens += result.tokensUsed;
      cost += itemCost;
      synced += 1;
      console.log(
        `Saved (${result.tokensUsed} tokens, $${itemCost.toFixed(8)}, ${result.durationMs}ms)`
      );
    } catch (err) {
      failed += 1;
      console.error(`Failed: ${err.message.slice(0, 400)}`);
    }
  }

  console.log("\n[embed-products] Done.");
  console.log(`  products selected: ${products.length}`);
  console.log(`  embeddings saved:  ${synced}`);
  console.log(`  skipped:           ${skipped}`);
  console.log(`  failed:            ${failed}`);
  console.log(`  tokens:            ${tokens}`);
  console.log(`  cost:              $${cost.toFixed(6)}`);
}

main()
  .catch((err) => {
    console.error("[embed-products] Fatal:", err.message);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
