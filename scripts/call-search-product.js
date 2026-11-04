/**
 * Runs search_product from the terminal (same code path as the chat).
 *
 *   npm run meili:search -- "fresh citrus"
 *   npm run meili:search -- --brand=Gucci --gender=men --sort=popular
 *   npm run meili:search -- "vanilla" --gender=women --max=50 --sort=price_asc
 *   npm run meili:search -- --kids --limit=5
 *   npm run meili:search -- '{"query":"oud","filters":{"gender":"men"}}'
 *
 * Flags: --query= --sort= --gender= --brand= --kids --notes=a,b --exclude=sweet,oud --type= --family= --scent-type=
 *        --category= (types from CATEGORY_GROUPS, comma list: bundles,gift_sets) --offer= --on-sale --min= --max= --limit= --cursor= --raw
 */
import "dotenv/config";
import fs from "node:fs";
import prisma from "../app/db.server.js";
import { searchProducts } from "../app/services/product-search/search-product.server.js";
import { printSearchProductConsole } from "../app/services/product-search/search-product-console.server.js";

function parseArgs(argv) {
  let payload = { filters: {} };
  let raw = false;
  const catalog = () => payload;
  const filters = () => (payload.filters ||= {});

  for (const arg of argv.slice(2)) {
    const [flag, ...rest] = arg.split("=");
    const value = rest.join("=");
    if (arg.trim().startsWith("{")) payload = JSON.parse(arg);
    else if (arg === "--raw") raw = true;
    else if (arg === "--kids") filters().kids = true;
    else if (arg === "--on-sale") filters().on_sale = true;
    else if (flag === "--query") catalog().query = value;
    else if (flag === "--sort") catalog().sort = value;
    else if (flag === "--gender") filters().gender = value;
    else if (flag === "--brand") filters().brand = value;
    else if (flag === "--notes") filters().notes = value.split(",").map((note) => note.trim());
    else if (flag === "--exclude") filters().exclude = value.split(",").map((word) => word.trim());
    else if (flag === "--type") filters().product_type = value;
    else if (flag === "--family") filters().fragrance_family = value;
    else if (flag === "--scent-type") filters().scent_type = value;
    else if (flag === "--category") filters().category = value;
    else if (flag === "--offer") filters().applicable_offer = value;
    else if (flag === "--min") filters().price = { ...filters().price, min: Number(value) };
    else if (flag === "--max") filters().price = { ...filters().price, max: Number(value) };
    else if (flag === "--limit") catalog().pagination = { ...catalog().pagination, limit: Number(value) };
    else if (flag === "--cursor") catalog().pagination = { ...catalog().pagination, cursor: value };
    else if (!arg.startsWith("-")) catalog().query = [catalog().query, arg].filter(Boolean).join(" ");
  }
  return { payload, raw };
}

async function main() {
  const { payload, raw } = parseArgs(process.argv);
  const started = Date.now();
  const { result, debug } = await searchProducts(payload);
  await printSearchProductConsole({
    payload,
    result,
    debug,
    elapsedMs: Date.now() - started,
    raw,
    writeJsonFile: true
  });
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error("search failed:", error.message);
    await prisma.$disconnect();
    process.exit(1);
  });
