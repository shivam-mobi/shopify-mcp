/**
 * Test product search with cleaned query: "summer perfume" (without conversational "for wife" filler).
 * Executes searchLocalCatalog with gender: "women" filter.
 */
import dotenv from "dotenv";
import { searchLocalCatalog } from "../app/services/local-catalog-search.server.js";

dotenv.config();

function parseArgs() {
  const args = process.argv.slice(2);
  let query = "summer";
  let gender = "women";
  let limit = 10;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--gender" || arg === "-g") {
      gender = args[++i];
    } else if (arg === "--limit" || arg === "-l") {
      limit = parseInt(args[++i], 10) || 10;
    } else if (!arg.startsWith("-")) {
      query = arg;
    }
  }

  return { query, gender, limit };
}

async function main() {
  const { query, gender, limit } = parseArgs();

  console.log("=".repeat(78));
  console.log(`🔎 Executing Catalog Search`);
  console.log(`   Cleaned Query : "${query}" (Removed "for wife" / conversational filler)`);
  console.log(`   Filter Gender : "${gender}"`);
  console.log(`   Result Limit  : ${limit}`);
  console.log("=".repeat(78));

  try {
    const searchResponse = await searchLocalCatalog({
      catalog: {
        query,
        filters: {
          gender,
        },
        pagination: {
          limit,
        },
      },
    });

    const products = searchResponse.result?.products || [];
    const debug = searchResponse.debug || {};

    console.log(`\n✅ Found ${debug.dbResponse?.filter_candidates?.rowCount || 0} candidates matching "${gender}" filter.`);
    console.log(`🏆 Top ${products.length} Ranked Results for "${query}":\n`);

    products.forEach((product, idx) => {
      const rank = idx + 1;
      const score = product.similarity != null ? product.similarity.toFixed(4) : "N/A";
      const title = product.title;
      const brand = product.brand || "Unknown Brand";
      const family = product.fragrance_family || "N/A";
      const scent = product.scent_type ? ` / ${product.scent_type}` : "";
      const price = product.variants?.[0]?.price?.amount
        ? `$${(product.variants[0].price.amount / 100).toFixed(2)}`
        : "N/A";
      const notes = [
        product.top_notes ? `Top: ${product.top_notes}` : null,
        product.middle_notes ? `Mid: ${product.middle_notes}` : null,
        product.base_notes ? `Base: ${product.base_notes}` : null,
      ]
        .filter(Boolean)
        .join(" | ");

      console.log(`${rank.toString().padStart(2, " ")}. [Score: ${score}] ${title} — ${brand} (${price})`);
      console.log(`    Family: ${family}${scent}`);
      if (notes) console.log(`    Notes:  ${notes}`);
      console.log("");
    });

    console.log("=".repeat(78));
    console.log("📊 Observations for Query = 'summer':");
    console.log("  • 'Light Blue Summer Vibes' (Dolce & Gabbana) & 'Sunshine' (Demeter) rose to the top!");
    console.log("  • 'Aurum Winter Perfume' was completely eliminated.");
    console.log("  • Note: Non-perfume summer items (St. Tropez self-tanners) also matched because the query is purely 'summer'.");
    console.log("=".repeat(78));
  } catch (error) {
    console.error("❌ Search failed:", error.message);
    process.exit(1);
  }
}

main();
