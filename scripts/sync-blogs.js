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
 * Fetch Articles via Shopify GraphQL
 */
async function fetchArticles(after = null) {
  const query = `query GetArticles($after: String, $filter: String) { 
    articles(first: 50, after: $after, query: $filter) { 
      nodes { 
        id 
        title 
        handle 
        body 
        summary 
        publishedAt 
        tags 
        isPublished 
        blog { id title handle } 
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
  return json.data.articles;
}

/**
 * Resilient fallback: Fetch live articles directly from Perfumania sitemap
 */
async function fetchArticlesFromStorefront(maxArticles = 25) {
  console.log("Fetching article URLs from Perfumania sitemap (https://perfumania.com/sitemap_articles_1.xml)...");
  const sitemapRes = await fetch("https://perfumania.com/sitemap_articles_1.xml");
  if (!sitemapRes.ok) {
    throw new Error(`Failed to fetch sitemap: HTTP ${sitemapRes.status}`);
  }
  const sitemapXml = await sitemapRes.text();
  const urls = [...sitemapXml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  console.log(`Found ${urls.length} articles in sitemap. Syncing first ${maxArticles}...`);

  const articles = [];
  const targetUrls = urls.slice(0, maxArticles);

  for (let i = 0; i < targetUrls.length; i++) {
    const url = targetUrls[i];
    const handle = url.split("/").pop();
    try {
      const pageRes = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; PerfumaniaBot/1.0)" } });
      if (!pageRes.ok) {
        console.warn(`  Failed to fetch ${url} (HTTP ${pageRes.status})`);
        continue;
      }
      const html = await pageRes.text();
      const titleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || html.match(/<meta property="og:title" content="([^"]+)"/i);
      const title = titleMatch ? titleMatch[1].replace(/<\/?[^>]+>/g, "").trim() : handle.replace(/-/g, " ");

      const mainMatch = html.match(/<main[\s\S]*?<\/main>/i);
      let body = "";
      if (mainMatch) {
        body = mainMatch[0]
          .replace(/<script[\s\S]*?<\/script>/gi, "")
          .replace(/<style[\s\S]*?<\/style>/gi, "")
          .replace(/<\/?[^>]+(>|$)/g, " ")
          .replace(/&[a-z]+;/gi, " ")
          .replace(/\s+/g, " ")
          .trim();
      }

      if (body) {
        articles.push({
          id: `article_${handle}`,
          title,
          handle,
          body,
          url,
          blog: { handle: "articles", title: "Articles" },
        });
        console.log(`  [${i + 1}/${targetUrls.length}] Loaded "${title}" (${body.length} chars)`);
      }
    } catch (fetchErr) {
      console.warn(`  Error fetching ${url}:`, fetchErr.message);
    }
  }

  return articles;
}

async function main() {
  console.log("Starting Shopify Blog Sync for Perfumania...");
  console.log(`Store Domain: ${SHOPIFY_STORE_DOMAIN}`);
  console.log(`Storefront URL: ${STOREFRONT_URL}`);

  // 1. Ensure Blog Knowledge Source exists
  const source = await prisma.knowledgeSource.upsert({
    where: { code: "blog" },
    update: {
      name: "Blog Articles",
      sourceType: "blog",
      baseUrl: `${STOREFRONT_URL}/blogs`,
    },
    create: {
      code: "blog",
      name: "Blog Articles",
      sourceType: "blog",
      baseUrl: `${STOREFRONT_URL}/blogs`,
    },
  });

  let totalProcessed = 0;
  let totalSkipped = 0;
  let articles = [];

  // Try Admin API first
  let useAdmin = Boolean(SHOPIFY_ADMIN_ACCESS_TOKEN);
  if (useAdmin) {
    try {
      console.log("Attempting to fetch articles via Shopify Admin API...");
      const page = await fetchArticles(null);
      if (page && page.nodes && page.nodes.length > 0) {
        articles = page.nodes;
      } else {
        useAdmin = false;
      }
    } catch (err) {
      console.warn("Shopify Admin API articles query notice:", err.message);
      console.log("Falling back to live Perfumania storefront sitemap sync...");
      useAdmin = false;
    }
  }

  if (!useAdmin || articles.length === 0) {
    articles = await fetchArticlesFromStorefront(20);
  }

  for (const article of articles) {
      const rawContent = article.body || article.summary || "";
      if (!rawContent || rawContent.trim() === "") {
        console.log(`Skipping (Empty Body): "${article.title}"`);
        totalSkipped++;
        continue;
      }

      const cleanContent = stripHtml(rawContent);
      if (!cleanContent || cleanContent.trim() === "") {
        console.log(`Skipping (No real text after HTML strip): "${article.title}"`);
        totalSkipped++;
        continue;
      }

      console.log(`Processing: "${article.title}"`);

      const blogHandle = article.blog?.handle || "news";
      const articleUrl = `${STOREFRONT_URL}/blogs/${blogHandle}/${article.handle}`;
      const chunks = chunkText(cleanContent, 2000, 500);
      const initialTokenEstimate = chunks.reduce((acc, c) => acc + Math.ceil(c.length / 4), 0);

      // 2. Upsert Document using unique shopifyGraphqlId
      const doc = await prisma.knowledgeDocument.upsert({
        where: { shopifyGraphqlId: article.id },
        update: {
          title: article.title,
          baseUrl: articleUrl,
          content: cleanContent,
          chunkCount: chunks.length,
          tokenCount: initialTokenEstimate,
          updatedAt: new Date(),
        },
        create: {
          shopifyGraphqlId: article.id,
          sourceId: source.id,
          title: article.title,
          baseUrl: articleUrl,
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
            title: article.title,
            handle: article.handle,
            url: articleUrl,
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

    console.log(`✅ Blog sync complete! Processed ${totalProcessed} articles (Skipped ${totalSkipped} empty articles).`);
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
    console.error("Error during blog sync:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
