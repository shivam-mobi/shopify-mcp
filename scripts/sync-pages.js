import { PrismaClient } from "@prisma/client";
import dotenv from "dotenv";

const prisma = new PrismaClient();
dotenv.config();

const SHOPIFY_ADMIN_ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
const STOREFRONT_URL = process.env.STOREFRONT_URL || "https://perfumania.com";
const SHOPIFY_STORE_DOMAIN =
  process.env.SHOPIFY_STORE_DOMAIN ||
  (STOREFRONT_URL.includes("://") ? new URL(STOREFRONT_URL).hostname : STOREFRONT_URL) ||
  "perfumania-tfo.myshopify.com";

/**
 * Clean and Normalize HTML Content
 */
function stripHtml(html) {
  if (!html) return "";
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "") // Remove styles
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "") // Remove scripts
    .replace(/<\/?[^>]+(>|$)/g, " ") // Remove HTML tags
    .replace(/&[a-z]+;/gi, " ") // Basic entity removal
    .replace(/\s+/g, " ") // Normalize spaces
    .trim();
}

/**
 * Split Content into Overlapping Chunks
 */
function chunkText(text, chunkSize = 2000, overlap = 500) {
  if (!text) return [];
  const chunks = [];
  let startIndex = 0;

  while (startIndex < text.length) {
    let endIndex = startIndex + chunkSize;

    // Attempt to break cleanly at sentence or word boundary
    if (endIndex < text.length) {
      const lastPeriod = text.lastIndexOf(". ", endIndex);
      if (lastPeriod > startIndex + overlap) {
        endIndex = lastPeriod + 1;
      } else {
        const lastSpace = text.lastIndexOf(" ", endIndex);
        if (lastSpace > startIndex + overlap) {
          endIndex = lastSpace;
        }
      }
    }

    chunks.push(text.slice(startIndex, endIndex).trim());

    if (endIndex >= text.length) break;
    startIndex = endIndex - overlap;
  }

  return chunks;
}

/**
 * Fetch Pages via Shopify GraphQL
 */
async function fetchPages(after = null) {
  const query = `query GetPages($after: String, $filter: String) { 
    pages(first: 50, after: $after, query: $filter) { 
      nodes { 
        id 
        title 
        handle 
        body 
        bodySummary 
        isPublished 
        publishedAt 
        updatedAt 
      } 
      pageInfo { hasNextPage endCursor } 
    } 
  }`;

  const response = await fetch(`https://${SHOPIFY_STORE_DOMAIN}/admin/api/2024-10/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": SHOPIFY_ADMIN_ACCESS_TOKEN,
    },
    body: JSON.stringify({
      query,
      variables: { after, filter: "published_status:published" },
    }),
  });

  const json = await response.json();
  if (json.errors) {
    throw new Error(JSON.stringify(json.errors));
  }
  return json.data.pages;
}

async function main() {
  console.log("Starting Shopify Pages Sync for Perfumania...");
  console.log(`Store Domain: ${SHOPIFY_STORE_DOMAIN}`);
  console.log(`Storefront URL: ${STOREFRONT_URL}`);

  if (!SHOPIFY_ADMIN_ACCESS_TOKEN) {
    console.error("Error: SHOPIFY_ADMIN_ACCESS_TOKEN is not set in .env");
    process.exit(1);
  }

  // 1. Ensure Page Knowledge Source exists
  const source = await prisma.knowledgeSource.upsert({
    where: { code: "page" },
    update: {
      name: "Shopify Pages",
      sourceType: "page",
      baseUrl: `${STOREFRONT_URL}/pages`,
    },
    create: {
      code: "page",
      name: "Shopify Pages",
      sourceType: "page",
      baseUrl: `${STOREFRONT_URL}/pages`,
    },
  });

  let hasNextPage = true;
  let cursor = null;
  let totalProcessed = 0;
  let totalSkipped = 0;

  while (hasNextPage) {
    console.log(`Fetching pages (cursor: ${cursor || "start"})...`);
    const pagesData = await fetchPages(cursor);

    if (!pagesData || !pagesData.nodes) {
      console.log("No pages returned.");
      break;
    }

    const pages = pagesData.nodes;
    for (const page of pages) {
      if (!page.body || page.body.trim() === "") {
        console.log(`Skipping (Empty Body): "${page.title}"`);
        totalSkipped++;
        continue;
      }

      const cleanContent = stripHtml(page.body);
      if (!cleanContent || cleanContent.trim() === "") {
        console.log(`Skipping (No real text after HTML strip): "${page.title}"`);
        totalSkipped++;
        continue;
      }

      console.log(`Processing: "${page.title}"`);

      const pageUrl = `${STOREFRONT_URL}/pages/${page.handle}`;
      const chunks = chunkText(cleanContent, 2000, 500);
      const initialTokenEstimate = chunks.reduce((acc, c) => acc + Math.ceil(c.length / 4), 0);

      // 2. Upsert Document using unique shopifyGraphqlId
      const doc = await prisma.knowledgeDocument.upsert({
        where: { shopifyGraphqlId: page.id },
        update: {
          title: page.title,
          baseUrl: pageUrl,
          content: cleanContent,
          chunkCount: chunks.length,
          tokenCount: initialTokenEstimate,
          updatedAt: new Date(),
        },
        create: {
          shopifyGraphqlId: page.id,
          sourceId: source.id,
          title: page.title,
          baseUrl: pageUrl,
          content: cleanContent,
          chunkCount: chunks.length,
          tokenCount: initialTokenEstimate,
        },
      });

      // 3. Delete old chunks if they exist
      await prisma.knowledgeChunk.deleteMany({
        where: { documentId: doc.id },
      });

      // 4. Create new chunks with metadata
      if (chunks.length > 0) {
        const chunkRecords = chunks.map((chunkTextContent, index) => ({
          documentId: doc.id,
          chunkIndex: index + 1,
          content: chunkTextContent,
          tokenCount: Math.ceil(chunkTextContent.length / 4),
          metadata: JSON.stringify({
            title: page.title,
            handle: page.handle,
            url: pageUrl,
            chunk_index: index + 1,
            total_chunks: chunks.length,
          }),
        }));

        await prisma.knowledgeChunk.createMany({
          data: chunkRecords,
        });

        // 5. Generate and store embeddings, pricing ID, and LLM cost
        await embedChunksForDocument(doc.id);
      }

      totalProcessed++;
    }

    hasNextPage = Boolean(pagesData.pageInfo?.hasNextPage);
    cursor = pagesData.pageInfo?.endCursor || null;
  }

  console.log(`✅ Pages sync complete! Processed ${totalProcessed} pages (Skipped ${totalSkipped} empty pages).`);
}

/**
 * Generate and store embeddings, tokens, llmPricingId, and llmCost for chunks
 */
async function embedChunksForDocument(docId) {
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  const OPENAI_EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";
  const COST_PER_TOKEN = 0.00000002;

  if (!OPENAI_API_KEY) {
    return;
  }

  const chunks = await prisma.knowledgeChunk.findMany({
    where: { documentId: docId },
    select: { id: true, content: true },
    orderBy: { chunkIndex: "asc" },
  });

  if (chunks.length === 0) return;
  console.log(`  Generating embeddings for ${chunks.length} chunks via ${OPENAI_EMBEDDING_MODEL}...`);

  let totalTokens = 0;
  let totalCost = 0;

  for (const chunk of chunks) {
    try {
      const startTime = Date.now();
      const res = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: OPENAI_EMBEDDING_MODEL,
          input: chunk.content,
        }),
      });

      const data = await res.json();
      if (res.ok && data.data?.[0]?.embedding) {
        const embeddingVector = data.data[0].embedding;
        const tokensUsed = data.usage?.total_tokens || 0;
        const costUsd = tokensUsed * COST_PER_TOKEN;
        totalTokens += tokensUsed;
        totalCost += costUsd;

        // Store vector, tokens, pricing ID, and LLM cost directly in knowledgeChunks table
        await prisma.$executeRawUnsafe(
          `UPDATE knowledgeChunks 
           SET embedding = STRING_TO_VECTOR(?),
               token_count = ?,
               llm_pricing_id = ?,
               llm_cost = ?
           WHERE id = ?`,
          JSON.stringify(embeddingVector),
          tokensUsed,
          OPENAI_EMBEDDING_MODEL,
          costUsd,
          chunk.id
        );

        // Log to processing log
        await prisma.knowledgeProcessingLog.create({
          data: {
            knowledgeChunkId: chunk.id,
            request: JSON.stringify({ model: OPENAI_EMBEDDING_MODEL, input: chunk.content }),
            response: JSON.stringify(data),
            statusCode: res.status,
            durationMs: Date.now() - startTime,
            tokensUsed,
            costUsd,
            llmPricingId: OPENAI_EMBEDDING_MODEL,
          },
        }).catch(() => {});
      }
    } catch (err) {
      console.warn(`  [Embeddings] Error on chunk ${chunk.id}:`, err.message);
    }
  }

  // Update parent document with rolled-up tokens and cost
  await prisma.knowledgeDocument.update({
    where: { id: docId },
    data: {
      tokenCount: totalTokens,
      embeddingTokens: totalTokens,
      embeddingCostUsd: totalCost,
      updatedAt: new Date(),
    },
  });
  console.log(`  ✅ Stored embeddings & costs for doc (Tokens: ${totalTokens}, Cost: $${totalCost.toFixed(6)})`);
}

main()
  .catch((e) => {
    console.error("Error during pages sync:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
