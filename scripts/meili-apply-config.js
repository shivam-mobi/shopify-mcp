/**
 * Creates the products index if needed and applies PRODUCTS_INDEX_SETTINGS from
 * app/services/product-search/products-index.config.js.
 *
 *   npm run meili:config
 */
import "dotenv/config";
import { getMeiliClient, getProductsIndex, waitForTask } from "../app/services/product-search/meilisearch-client.server.js";
import {
  PRODUCTS_INDEX_SETTINGS,
  PRODUCTS_INDEX_UID,
  PRODUCTS_PRIMARY_KEY
} from "../app/services/product-search/products-index.config.js";

async function ensureIndex(client) {
  try {
    await client.getIndex(PRODUCTS_INDEX_UID);
  } catch (error) {
    if (error?.cause?.code !== "index_not_found") throw error;
    console.log(`Creating index "${PRODUCTS_INDEX_UID}"`);
    await waitForTask(client.createIndex(PRODUCTS_INDEX_UID, { primaryKey: PRODUCTS_PRIMARY_KEY }));
  }
}

async function main() {
  const client = getMeiliClient();
  await client.health();
  await ensureIndex(client);

  const started = Date.now();
  console.log(`Applying settings to "${PRODUCTS_INDEX_UID}" (re-indexing can take a minute)...`);
  const task = await waitForTask(getProductsIndex().updateSettings(PRODUCTS_INDEX_SETTINGS));
  console.log(`Settings applied (task ${task.uid}, ${Math.round((Date.now() - started) / 1000)}s)`);
}

main().catch((error) => {
  console.error("meili:config failed:", error.message);
  if (/ECONNREFUSED|fetch failed/i.test(String(error.message) + String(error.cause))) {
    console.error("Is Meilisearch running? Start it with: npm run meili:up");
  }
  process.exit(1);
});
