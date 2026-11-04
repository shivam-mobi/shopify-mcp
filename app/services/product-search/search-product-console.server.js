import fs from "node:fs";
import { getProductsIndex } from "./meilisearch-client.server.js";
import { generateEmbedding } from "../embeddings.server.js";
import { PRODUCT_EMBEDDER } from "./products-index.config.js";

/**
 * Clean, structured console logger matching scripts/call-search-product.js.
 * Prints attempt stats, cutoffs, tiered matches, and keyword/vector/hybrid breakdowns.
 */
export async function printSearchProductConsole({
  payload = {},
  result = {},
  debug = {},
  elapsedMs = 0,
  raw = false,
  writeJsonFile = false,
  jsonOutputPath = "search-results.json"
}) {
  console.log("search_product", JSON.stringify(payload));

  const total = result.pagination?.total_count ?? 0;
  console.log(
    `\n${elapsedMs}ms  stage=${result.search_stage ?? "-"}  match=${result.match_quality ?? "-"}  total≈${total}`
  );
  if (result.applied) console.log("applied:", JSON.stringify(result.applied));
  if (result.relaxed_filters?.length) console.log("relaxed:", result.relaxed_filters.join(", "));
  if (result.note) console.log("note:", result.note);

  for (const attempt of debug.attempts || []) {
    console.log(
      `  attempt q="${attempt.query ?? ""}" relaxed=[${attempt.relaxed ?? ""}] total=${attempt.totalHits ?? 0} ${attempt.ms ?? 0}ms` +
        (attempt.query
          ? ` keywordTop=${attempt.keywordTop?.toFixed(3) ?? "-"} vectorTop=${attempt.semanticTop?.toFixed(3) ?? "-"} cutoff=${attempt.threshold ?? "-"}`
          : "") +
        (attempt.tiers
          ? ` tiers: strong=${attempt.tiers.strong} weak=${attempt.tiers.weak} similar=${attempt.tiers.similar}`
          : "")
    );
  }

  console.log("");
  (result.products || []).forEach((product, i) => {
    const price = product.variants?.[0]?.price?.amount;
    const listPrice = product.variants?.[0]?.list_price?.amount;
    const discount = listPrice && price && listPrice > price ? Math.round((1 - price / listPrice) * 100) : null;
    const discountStr = discount ? ` (${discount}% off)` : "";
    const matchTag = product.match_type ? ` [${product.match_type}]` : "";
    console.log(
      `${String(i + 1).padStart(2)}. [${product.similarity ?? "-"}]${matchTag} ${product.title} — ${product.brand}` +
        `${price != null ? `  $${(price / 100).toFixed(2)}` : ""}${discountStr}  (${product.total_reviews ?? 0} reviews)`
    );
  });

  if (result.facets) {
    console.log("\nfacets:");
    for (const [field, values] of Object.entries(result.facets)) {
      console.log(`  ${field}: ${values.map((v) => `${v.value} (${v.count})`).join(", ")}`);
    }
  }

  if (result.pagination?.cursor) {
    console.log(`\nnext page: --cursor=${result.pagination.cursor}`);
  }

  if (raw) {
    console.log(JSON.stringify(result, null, 2));
  }

  const queryText = (debug.query || payload.query || "").trim();
  if (queryText) {
    try {
      const index = getProductsIndex();
      const filter =
        debug.attempts?.[0]?.filter ||
        (debug.filter?.every?.((f) => !f.endsWith("…")) ? debug.filter : ["in_stock = true"]);
      const vector = await generateEmbedding(queryText);

      const [keywordRes, vectorRes] = await Promise.all([
        index.search(queryText, {
          filter,
          limit: 10,
          showRankingScore: true,
          showRankingScoreDetails: true,
          attributesToRetrieve: [
            "id",
            "title",
            "brand",
            "price",
            "popularity",
            "rating",
            "review_count",
            "notes"
          ]
        }),
        vector
          ? index.search(queryText, {
              filter,
              limit: 10,
              showRankingScore: true,
              showRankingScoreDetails: true,
              hybrid: { embedder: PRODUCT_EMBEDDER, semanticRatio: 1 },
              vector,
              attributesToRetrieve: [
                "id",
                "title",
                "brand",
                "price",
                "popularity",
                "rating",
                "review_count",
                "notes"
              ]
            })
          : Promise.resolve({ hits: [] })
      ]);

      const formatHits = (hits) =>
        hits.map((h, i) => {
          const words = h._rankingScoreDetails?.words;
          const matchingWords = words?.matchingWords ?? null;
          const maxMatchingWords = words?.maxMatchingWords ?? null;
          return {
            rank: i + 1,
            id: h.id,
            title: h.title,
            brand: h.brand,
            price: h.price != null ? `$${Number(h.price).toFixed(2)}` : null,
            similarity: h._rankingScore != null ? Number(h._rankingScore.toFixed(4)) : null,
            matchingWords,
            maxMatchingWords,
            reviews: h.review_count ?? 0
          };
        });

      const keywordFormatted = formatHits(keywordRes.hits || []);
      const vectorFormatted = formatHits(vectorRes.hits || []);

      const wordInfo = (h) =>
        h.matchingWords != null && h.maxMatchingWords != null
          ? ` (words: ${h.matchingWords}/${h.maxMatchingWords})`
          : "";

      console.log("\n============================================================");
      console.log("1. KEYWORD SEARCH RESULTS (Pure text matching)");
      console.log("============================================================");
      if (!keywordFormatted.length) {
        console.log("  (no keyword hits)");
      } else {
        keywordFormatted.forEach((h) => {
          console.log(
            `  ${String(h.rank).padStart(2)}. [${h.similarity ?? "-"}]${wordInfo(h)} ${h.title} — ${h.brand}  ${h.price || ""} (${h.reviews} reviews)`
          );
        });
      }

      console.log("\n============================================================");
      console.log("2. VECTOR SEARCH RESULTS (Pure semantic embedding)");
      console.log("============================================================");
      if (!vectorFormatted.length) {
        console.log("  (no vector hits)");
      } else {
        vectorFormatted.forEach((h) => {
          console.log(
            `  ${String(h.rank).padStart(2)}. [${h.similarity ?? "-"}]${wordInfo(h)} ${h.title} — ${h.brand}  ${h.price || ""} (${h.reviews} reviews)`
          );
        });
      }

      console.log("\n============================================================");
      console.log("3. FINAL COMBINED RESULTS (Keywords first, then Vector similar)");
      console.log("============================================================");
      if (!result.products?.length) {
        console.log("  (no hits)");
      } else {
        result.products.forEach((p, i) => {
          const price = p.variants?.[0]?.price?.amount;
          const priceStr = price != null ? `  $${(price / 100).toFixed(2)}` : "";
          const matchTag = p.match_type ? `[${p.match_type}]` : "";
          console.log(
            `  ${String(i + 1).padStart(2)}. [${p.similarity ?? "-"}] ${matchTag} ${p.title} — ${p.brand}${priceStr} (${p.total_reviews ?? 0} reviews)`
          );
        });
      }

      if (writeJsonFile) {
        const jsonOutput = {
          query: queryText,
          filter,
          applied: result.applied,
          note: result.note,
          tiers: debug.attempts?.[0]?.tiers || null,
          final_products: (result.products || []).map((p, i) => ({
            rank: i + 1,
            id: p.id,
            title: p.title,
            brand: p.brand,
            match_type: p.match_type || null,
            similarity: p.similarity ?? null,
            price:
              p.variants?.[0]?.price?.amount != null
                ? `$${(p.variants[0].price.amount / 100).toFixed(2)}`
                : null,
            reviews: p.total_reviews ?? 0
          })),
          keyword_results: keywordFormatted,
          vector_results: vectorFormatted
        };
        fs.writeFileSync(jsonOutputPath, JSON.stringify(jsonOutput, null, 2));
        console.log(`\nDetailed breakdown saved to: ${jsonOutputPath}`);
      }
    } catch (err) {
      console.warn("[search_product_console] failed to generate breakdown:", err.message);
    }
  }
}
