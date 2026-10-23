import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    inputFile: path.join(PROJECT_ROOT, "search-product-log.json"),
    outputFile: path.join(PROJECT_ROOT, "search-queries.sql"),
    writeOutput: true,
    showHelp: false,
    runQueries: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      options.showHelp = true;
    } else if (arg === "--file" || arg === "-f") {
      options.inputFile = path.resolve(process.cwd(), args[++i]);
    } else if (arg === "--output" || arg === "-o") {
      options.outputFile = path.resolve(process.cwd(), args[++i]);
    } else if (arg === "--no-write") {
      options.writeOutput = false;
    } else if (arg === "--run" || arg === "-r") {
      options.runQueries = true;
    } else if (!arg.startsWith("-")) {
      options.inputFile = path.resolve(process.cwd(), arg);
    }
  }

  return options;
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

function formatSql(sql) {
  return String(sql || "").trim();
}

function dotProduct(vecA, vecB) {
  if (!Array.isArray(vecA) || !Array.isArray(vecB) || vecA.length !== vecB.length) {
    return 0;
  }
  let sum = 0;
  for (let i = 0; i < vecA.length; i++) {
    sum += vecA[i] * vecB[i];
  }
  return sum;
}

async function main() {
  const options = parseArgs();

  if (options.showHelp) {
    console.log(`
Usage: node scripts/generate-queries-from-log.js [options] [log-file-path]

Options:
  -f, --file <path>    Path to search log JSON file (default: ./search-product-log.json)
  -o, --output <path>  Path to output .sql file (default: ./search-queries.sql)
  -r, --run            Execute the queries directly against the database and display ranked products
  --no-write           Only print to stdout, do not write .sql file
  -h, --help           Show help
`);
    process.exit(0);
  }

  if (!fs.existsSync(options.inputFile)) {
    console.error(`Error: File not found at: ${options.inputFile}`);
    process.exit(1);
  }

  let logData;
  try {
    const fileContent = fs.readFileSync(options.inputFile, "utf-8");
    logData = JSON.parse(fileContent);
  } catch (err) {
    console.error(`Error parsing JSON from ${options.inputFile}:`, err.message);
    process.exit(1);
  }

  const queries = [];
  const logSql = Array.isArray(logData.sql) ? logData.sql : [];

  // 1. Candidate Filter Query (Works in MySQL 9 & TiDB)
  const filterEntry = logSql.find((item) => item.name === "filter_candidates");
  let filterSql = "";
  if (filterEntry) {
    filterSql =
      filterEntry.interpolatedSql ||
      interpolateSql(filterEntry.sql, filterEntry.params);
    queries.push({
      name: "1. Candidate Filter Query (filter_candidates) [Runs on MySQL 9 & TiDB]",
      description:
        "Extracts candidate products and embeddings string matching catalog filters. (Standard MySQL query executed by the app)",
      sql: formatSql(filterSql) + ";",
    });
  }

  // 2. Product Hydration Query (Works in MySQL 9 & TiDB)
  const hydrateEntry = logSql.find((item) => item.name === "hydrate_products");
  let hydrateSql = "";
  if (hydrateEntry) {
    hydrateSql =
      hydrateEntry.interpolatedSql ||
      interpolateSql(hydrateEntry.sql, hydrateEntry.params);
    queries.push({
      name: "2. Hydrate Ranked Products Query (hydrate_products) [Runs on MySQL 9 & TiDB]",
      description:
        "Fetches the top-10 products after vector similarity ranking in Node.js",
      sql: formatSql(hydrateSql) + ";",
    });
  }

  // 3. Optional TiDB Only Vector Query
  const queryVector =
    logData.queryVector || logData.ranking?.queryVector || null;
  const actualQuery = logData.actualQuery || logData.passed?.parsed?.query || "";
  const limit = logData.passed?.parsed?.limit || 10;

  if (filterSql && Array.isArray(queryVector) && queryVector.length > 0) {
    const vectorJson = JSON.stringify(queryVector);
    const fromIndex = filterSql.search(/\bFROM\b/i);
    const fromAndWhereClause =
      fromIndex !== -1 ? filterSql.slice(fromIndex) : "";

    const directVectorSql = `SELECT 
  p.id,
  p.shopify_product_id,
  p.title,
  p.handle,
  b.name AS brand,
  g.name AS gender,
  pt.name AS product_type,
  1 - VEC_COSINE_DISTANCE(p.embedding, '${vectorJson}') AS similarity
${fromAndWhereClause}
ORDER BY similarity DESC
LIMIT ${limit};`;

    queries.push({
      name: "3. Direct TiDB Vector Search Query [TiDB Cloud ONLY - Not Standard MySQL]",
      description: `Note: Standard MySQL 9 does not have VEC_COSINE_DISTANCE(). Run this ONLY if connected to TiDB Cloud. On standard MySQL, use Query 1 + 2 or run "npm run query:log -- --run" to rank directly.`,
      sql: directVectorSql,
    });
  }

  // Build the complete .sql file content
  const timestamp = logData.at || new Date().toISOString();
  let sqlFileContent = `-- =============================================================================
-- SQL Queries Generated from: ${path.basename(options.inputFile)}
-- Generated at: ${new Date().toISOString()}
-- Search Query: ${JSON.stringify(actualQuery)}
--
-- IMPORTANT NOTE ON DATABASE COMPATIBILITY:
-- Your database is MySQL 9. Standard MySQL Community Edition supports
-- VECTOR(1536) and VECTOR_TO_STRING(p.embedding), but does NOT support VEC_COSINE_DISTANCE().
--
-- -> Query 1 & Query 2 are the EXACT queries that run in MySQL.
-- -> Similarity scoring is performed in Node.js using dotProduct() on the returned vectors.
-- -> Query 3 is only for TiDB Cloud deployments with native VEC_COSINE_DISTANCE().
-- =============================================================================\n\n`;

  queries.forEach((q) => {
    sqlFileContent += `-- -----------------------------------------------------------------------------\n`;
    sqlFileContent += `-- ${q.name}\n`;
    sqlFileContent += `-- Description: ${q.description}\n`;
    sqlFileContent += `-- -----------------------------------------------------------------------------\n`;
    sqlFileContent += `${q.sql}\n\n`;
  });

  if (options.writeOutput) {
    fs.writeFileSync(options.outputFile, sqlFileContent, "utf-8");
    console.log(`\n✅ Generated SQL file saved to: ${options.outputFile}\n`);
  }

  console.log("=".repeat(78));
  console.log(`🔍 Search Query: "${actualQuery.replace(/\n/g, " ")}"`);
  console.log(`📅 Log Timestamp: ${timestamp}`);
  if (queryVector) {
    console.log(
      `🧠 Query Vector: ${queryVector.length} dimensions (${logData.embeddingModel || "text-embedding-3-small"})`
    );
  }
  console.log("=".repeat(78));

  queries.forEach((q) => {
    console.log(`\n### ${q.name}`);
    console.log(`-- ${q.description}\n`);

    if (q.sql.length > 2000) {
      const preview = q.sql.replace(
        /VEC_COSINE_DISTANCE\(p\.embedding, '\[.*?\]'\)/s,
        `VEC_COSINE_DISTANCE(p.embedding, '[${queryVector.slice(0, 5).join(", ")}, ... ${queryVector.length} dimensions]')`
      );
      console.log(preview);
      console.log(
        `\nℹ️  (Vector literal truncated in console output for readability. Full vector is in ${options.outputFile})`
      );
    } else {
      console.log(q.sql);
    }
  });

  console.log("\n" + "=".repeat(78));

  // If --run option is passed, execute Candidate query + rank in Node.js + hydrate
  if (options.runQueries) {
    console.log("\n🚀 Executing queries on database and ranking candidates...\n");
    try {
      const { PrismaClient } = await import("@prisma/client");
      const prisma = new PrismaClient();

      const candidateRows = await prisma.$queryRawUnsafe(filterSql);
      console.log(`📦 Filtered Candidates Found: ${candidateRows.length}`);

      if (!queryVector || !queryVector.length) {
        console.log("No query vector found in log to calculate similarity.");
      } else {
        const scored = [];
        for (const row of candidateRows) {
          if (!row.embeddingStr) continue;
          try {
            const vector = JSON.parse(row.embeddingStr);
            if (Array.isArray(vector)) {
              scored.push({
                id: row.id,
                similarity: dotProduct(queryVector, vector),
              });
            }
          } catch {
            // skip malformed
          }
        }

        scored.sort((a, b) => b.similarity - a.similarity);
        const top10 = scored.slice(0, limit);
        const topIds = top10.map((s) => s.id);

        if (topIds.length) {
          const products = await prisma.product.findMany({
            where: { id: { in: topIds } },
            include: {
              brand: true,
              gender: true,
              productType: true,
              variants: {
                take: 1,
              },
            },
          });

          const productMap = new Map(products.map((p) => [p.id, p]));

          console.log(`\n🏆 Top ${top10.length} Ranked Results (exact match to app logic):`);
          top10.forEach((item, index) => {
            const prod = productMap.get(item.id);
            const price = prod?.variants?.[0]?.price ? `$${prod.variants[0].price}` : "N/A";
            console.log(
              `  ${index + 1}. [Score: ${item.similarity.toFixed(4)}] ${prod?.title || item.id} | ${prod?.brand?.name || "Unknown Brand"} (${price})`
            );
          });
        }
      }

      await prisma.$disconnect();
    } catch (err) {
      console.error("Database Execution Error:", err.message);
    }
  }
}

main();
