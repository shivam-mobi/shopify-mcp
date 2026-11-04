/**
 * Shows Meilisearch health, products index stats, and the main settings.
 *
 *   npm run meili:status
 */
import "dotenv/config";
import { getMeiliClient } from "../app/services/product-search/meilisearch-client.server.js";
import { PRODUCTS_INDEX_UID } from "../app/services/product-search/products-index.config.js";

async function main() {
  const client = getMeiliClient();
  const health = await client.health();
  const version = await client.getVersion();
  console.log(`Meilisearch ${version.pkgVersion} at ${process.env.MEILI_HOST} — ${health.status}`);

  const index = client.index(PRODUCTS_INDEX_UID);
  const [stats, settings] = await Promise.all([index.getStats(), index.getSettings()]);
  console.log(`Index "${PRODUCTS_INDEX_UID}":`, {
    documents: stats.numberOfDocuments,
    embeddedDocuments: stats.numberOfEmbeddedDocuments,
    isIndexing: stats.isIndexing
  });
  console.log("Settings:", {
    searchableAttributes: settings.searchableAttributes,
    filterableAttributes: settings.filterableAttributes,
    sortableAttributes: settings.sortableAttributes,
    rankingRules: settings.rankingRules,
    embedders: Object.keys(settings.embedders || {}),
    synonyms: Object.keys(settings.synonyms || {}).length,
    stopWords: (settings.stopWords || []).length
  });
}

main().catch((error) => {
  console.error("meili:status failed:", error.message);
  console.error("Is Meilisearch running? Start it with: npm run meili:up");
  process.exit(1);
});
