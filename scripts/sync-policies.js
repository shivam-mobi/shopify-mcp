import { PrismaClient } from "@prisma/client";
import dotenv from "dotenv";

const prisma = new PrismaClient();
dotenv.config();

const SHOPIFY_ADMIN_ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
const STOREFRONT_PRIVATE_ACCESS_TOKEN = process.env.STOREFRONT_PRIVATE_ACCESS_TOKEN;
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
 * Fetch Shop Policies via Shopify GraphQL
 * Uses Admin GraphQL, with automatic fallback to Storefront GraphQL
 */
async function fetchPolicies() {
  // 1. Try Admin GraphQL API first
  if (SHOPIFY_ADMIN_ACCESS_TOKEN) {
    try {
      const query = `query { 
        shop { 
          shopPolicies { 
            id 
            type 
            title 
            body 
            url 
            createdAt 
            updatedAt 
          } 
        } 
      }`;

      const response = await fetch(`https://${SHOPIFY_STORE_DOMAIN}/admin/api/2024-10/graphql.json`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": SHOPIFY_ADMIN_ACCESS_TOKEN,
        },
        body: JSON.stringify({ query }),
      });

      const json = await response.json();
      if (!json.errors && json.data?.shop?.shopPolicies) {
        console.log("Successfully fetched policies via Shopify Admin API.");
        return json.data.shop.shopPolicies;
      }
      console.warn("Shopify Admin API policy query notice:", json.errors?.[0]?.message || "No policies");
    } catch (adminErr) {
      console.warn("Shopify Admin API query failed:", adminErr.message);
    }
  }

  // 2. Resilient fallback: Fetch live policies via Storefront GraphQL API
  if (STOREFRONT_PRIVATE_ACCESS_TOKEN) {
    console.log("Fetching policies via Storefront GraphQL API (Shopify-Storefront-Private-Token)...");
    const storefrontQuery = `query {
      shop {
        privacyPolicy { id title body url }
        refundPolicy { id title body url }
        termsOfService { id title body url }
        shippingPolicy { id title body url }
        subscriptionPolicy { id title body url }
      }
    }`;

    const sfResponse = await fetch(`https://${SHOPIFY_STORE_DOMAIN}/api/2024-10/graphql.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Shopify-Storefront-Private-Token": STOREFRONT_PRIVATE_ACCESS_TOKEN,
      },
      body: JSON.stringify({ query: storefrontQuery }),
    });

    const sfJson = await sfResponse.json();
    if (sfJson.errors) {
      throw new Error(`Storefront API error: ${JSON.stringify(sfJson.errors)}`);
    }

    const shop = sfJson.data?.shop || {};
    const policies = [];

    const policyMap = [
      { key: "privacyPolicy", type: "PRIVACY_POLICY" },
      { key: "refundPolicy", type: "REFUND_POLICY" },
      { key: "termsOfService", type: "TERMS_OF_SERVICE" },
      { key: "shippingPolicy", type: "SHIPPING_POLICY" },
      { key: "subscriptionPolicy", type: "SUBSCRIPTION_POLICY" },
    ];

    for (const { key, type } of policyMap) {
      const p = shop[key];
      if (p && p.body) {
        policies.push({
          id: p.id || `policy_${type.toLowerCase()}`,
          type,
          title: p.title || type.replace(/_/g, " "),
          body: p.body,
          url: p.url,
        });
      }
    }

    console.log(`Fetched ${policies.length} live policies via Storefront GraphQL API.`);
    return policies;
  }

  throw new Error("Neither SHOPIFY_ADMIN_ACCESS_TOKEN nor STOREFRONT_PRIVATE_ACCESS_TOKEN was able to fetch policies.");
}

async function main() {
  console.log("Starting Shopify Policies Sync for Perfumania...");
  console.log(`Store Domain: ${SHOPIFY_STORE_DOMAIN}`);
  console.log(`Storefront URL: ${STOREFRONT_URL}`);

  if (!SHOPIFY_ADMIN_ACCESS_TOKEN && !STOREFRONT_PRIVATE_ACCESS_TOKEN) {
    console.error("Error: Neither SHOPIFY_ADMIN_ACCESS_TOKEN nor STOREFRONT_PRIVATE_ACCESS_TOKEN is set in .env");
    process.exit(1);
  }

  // 1. Ensure Policy Knowledge Source exists
  const source = await prisma.knowledgeSource.upsert({
    where: { code: "policy" },
    update: {
      name: "Store Policies",
      sourceType: "policy",
      baseUrl: `${STOREFRONT_URL}/policies`,
    },
    create: {
      code: "policy",
      name: "Store Policies",
      sourceType: "policy",
      baseUrl: `${STOREFRONT_URL}/policies`,
    },
  });

  let totalProcessed = 0;
  let totalSkipped = 0;

  const policies = await fetchPolicies();

  for (const policy of policies) {
    // Ignore policies that have an empty body
    if (!policy.body || policy.body.trim() === "") {
      console.log(`Skipping (Empty Body): ${policy.title || policy.type}`);
      totalSkipped++;
      continue;
    }

    console.log(`Processing: ${policy.title || policy.type}`);

    const cleanContent = stripHtml(policy.body);

    // Check if empty after cleaning
    if (cleanContent.trim() === "") {
      console.log(`Skipping (No real text after cleaning HTML): ${policy.title || policy.type}`);
      totalSkipped++;
      continue;
    }

    const pageUrl = policy.url || `${STOREFRONT_URL}/policies/${String(policy.type || "").toLowerCase()}`;
    const chunks = chunkText(cleanContent, 2000, 500);
    const initialTokenEstimate = chunks.reduce((acc, c) => acc + Math.ceil(c.length / 4), 0);

    // 2. Upsert Document using the unique shopifyGraphqlId
    const doc = await prisma.knowledgeDocument.upsert({
      where: { shopifyGraphqlId: policy.id },
      update: {
        title: policy.title || policy.type || "Store Policy",
        baseUrl: pageUrl,
        content: cleanContent,
        chunkCount: chunks.length,
        tokenCount: initialTokenEstimate,
        updatedAt: new Date(),
      },
      create: {
        shopifyGraphqlId: policy.id,
        sourceId: source.id,
        title: policy.title || policy.type || "Store Policy",
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
          title: policy.title,
          type: policy.type,
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

  console.log(`✅ Policies sync complete! Processed ${totalProcessed} policies (Skipped ${totalSkipped} empty policies).`);
}

/**
 * Generate and store embeddings, tokens, llmPricingId, and llmCost for chunks
 */
async function embedChunksForDocument(docId) {
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  const OPENAI_EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";
  const COST_PER_TOKEN = 0.00000002;

  if (!OPENAI_API_KEY) {
    console.log("  Notice: OPENAI_API_KEY not found in .env — skipping embeddings generation.");
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
    console.error("Error during policies sync:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
