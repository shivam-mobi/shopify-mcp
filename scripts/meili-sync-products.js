/**
 * Pushes active products from MySQL into Meilisearch.
 *
 *   npm run meili:sync                          upsert every active product, delete stale ones
 *   npm run meili:sync -- --handle=light-blue   upsert only these handles (comma separated)
 *   npm run meili:sync -- --reset               empty the index first, then full sync
 *
 * Run after npm run sync:products and the embed:products step.
 */
import "dotenv/config";
import prisma from "../app/db.server.js";
import { getMeiliClient, getProductsIndex, waitForTask } from "../app/services/product-search/meilisearch-client.server.js";
import { productDocumentBatches } from "../app/services/product-search/product-documents.server.js";
import {
  PRODUCT_EMBEDDER,
  PRODUCTS_INDEX_UID,
  PRODUCTS_PRIMARY_KEY
} from "../app/services/product-search/products-index.config.js";

function parseArgs(argv) {
  const args = { handles: [], reset: false };
  for (const arg of argv.slice(2)) {
    if (arg === "--reset") args.reset = true;
    else if (arg.startsWith("--handle=")) {
      args.handles.push(
        ...arg
          .slice("--handle=".length)
          .split(",")
          .map((handle) => handle.trim())
          .filter(Boolean)
      );
    }
  }
  return args;
}

async function assertIndexConfigured(client) {
  let settings;
  try {
    settings = await client.index(PRODUCTS_INDEX_UID).getSettings();
  } catch (error) {
    if (error?.cause?.code === "index_not_found") {
      throw new Error(`Index "${PRODUCTS_INDEX_UID}" does not exist. Run: npm run meili:config`);
    }
    throw error;
  }
  if (!settings.embedders?.[PRODUCT_EMBEDDER]) {
    throw new Error(`Embedder "${PRODUCT_EMBEDDER}" is not configured. Run: npm run meili:config`);
  }
}

async function indexedIds(index) {
  const ids = new Set();
  const limit = 1000;
  for (let offset = 0; ; offset += limit) {
    const page = await index.getDocuments({ fields: ["id"], limit, offset });
    for (const doc of page.results) ids.add(doc.id);
    if (page.results.length < limit) return ids;
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const client = getMeiliClient();
  await client.health();
  await assertIndexConfigured(client);
  const index = getProductsIndex();
  const started = Date.now();

  if (args.reset && !args.handles.length) {
    console.log("Removing all documents...");
    await waitForTask(index.deleteAllDocuments());
  }

  const synced = new Set();
  let withoutVector = 0;
  let outOfStock = 0;
  for await (const batch of productDocumentBatches({ handles: args.handles })) {
    await waitForTask(index.addDocuments(batch, { primaryKey: PRODUCTS_PRIMARY_KEY }));
    for (const doc of batch) {
      synced.add(doc.id);
      if (!doc._vectors[PRODUCT_EMBEDDER]) withoutVector += 1;
      if (!doc.in_stock) outOfStock += 1;
    }
    console.log(`  upserted ${synced.size} products`);
  }

  let removed = 0;
  if (!args.handles.length) {
    const stale = [...(await indexedIds(index))].filter((id) => !synced.has(id));
    if (stale.length) {
      await waitForTask(index.deleteDocuments(stale));
      removed = stale.length;
    }
  } else {
    const missing = args.handles.length - synced.size;
    if (missing > 0) console.log(`  ${missing} handle(s) not found or not active in MySQL`);
  }

  const stats = await index.getStats();
  console.log("Done", {
    upserted: synced.size,
    removedStale: removed,
    outOfStock,
    withoutEmbedding: withoutVector,
    documentsInIndex: stats.numberOfDocuments,
    seconds: Math.round((Date.now() - started) / 1000)
  });
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error("meili:sync failed:", error.message);
    if (/ECONNREFUSED|fetch failed/i.test(String(error.message) + String(error.cause))) {
      console.error("Is Meilisearch running? Start it with: npm run meili:up");
    }
    await prisma.$disconnect();
    process.exit(1);
  });
