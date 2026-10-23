import prisma from "../db.server.js";
import {
  callOpenAIEmbeddingsApi,
  getEmbeddingModel,
  generateEmbedding,
  updateChunkEmbedding,
} from "./embeddings.server.js";

/**
 * Clean and Normalize HTML Content
 */
export function stripHtml(html) {
  if (!html) return "";
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<\/?[^>]+(>|$)/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Split Content into Overlapping Chunks
 */
export function chunkText(text, chunkSize = 2000, overlap = 500) {
  if (!text) return [];
  const chunks = [];
  let startIndex = 0;

  while (startIndex < text.length) {
    let endIndex = startIndex + chunkSize;

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
 * Generate OpenAI Embeddings for newly created chunks with pricing and cost tracking
 */
export async function generateEmbeddingsForChunks(chunks) {
  if (!Array.isArray(chunks) || chunks.length === 0) return;
  const COST_PER_TOKEN = 0.00000002;
  const model = getEmbeddingModel();

  for (const chunk of chunks) {
    try {
      const res = await callOpenAIEmbeddingsApi(chunk.content);
      if (res.ok && res.data?.data?.[0]?.embedding) {
        const embeddingVector = res.data.data[0].embedding;
        const tokensUsed = res.data.usage?.total_tokens || 0;
        const costUsd = tokensUsed * COST_PER_TOKEN;

        await updateChunkEmbedding(chunk.id, embeddingVector, {
          tokenCount: tokensUsed,
          llmPricingId: model,
          llmCost: costUsd,
          documentId: chunk.documentId,
        });

        await prisma.knowledgeProcessingLog.create({
          data: {
            knowledgeChunkId: chunk.id,
            request: JSON.stringify({ model, input: chunk.content }),
            response: JSON.stringify(res.data),
            statusCode: res.status || 200,
            tokensUsed,
            costUsd,
            llmPricingId: model,
          },
        }).catch(() => {});

        console.log(`[KnowledgeSync] Saved vector embedding, pricing ID (${model}), and cost ($${costUsd.toFixed(8)}) for chunk ${chunk.id}`);
      }
    } catch (err) {
      console.error(`[KnowledgeSync] Error generating embedding for chunk ${chunk.id}:`, err);
    }
  }
}

/**
 * Handle Article create and update events
 */
export async function syncArticleFromEvent(payload) {
  if (!payload || !payload.id) {
    console.warn("[KnowledgeSync] Missing article payload or ID");
    return;
  }

  const shopifyStoreDomain = process.env.SHOPIFY_STORE_DOMAIN || "perfumania-tfo.myshopify.com";
  const storefrontUrl = process.env.STOREFRONT_URL || `https://${shopifyStoreDomain}`;
  const articleId = payload.id;
  const graphqlId = payload.admin_graphql_api_id || `gid://shopify/Article/${articleId}`;

  // Find KnowledgeSource with code 'blog'
  let source = await prisma.knowledgeSource.findUnique({
    where: { code: "blog" },
  });

  if (!source) {
    source = await prisma.knowledgeSource.create({
      data: {
        code: "blog",
        name: "Blog Articles",
        sourceType: "blog",
        baseUrl: `${storefrontUrl}/blogs/post`,
      },
    });
  }

  // 1. Check for empty body (reference: sync-pages.js)
  const rawBody = payload.body_html || payload.summary_html || payload.body || "";
  if (!rawBody || rawBody.trim() === "") {
    // If the event payload only sent { id, title, handle }, fetch full details from Admin API
    if (payload.id && !payload._hasFetchedBody) {
      console.log(`[KnowledgeSync] Article "${payload.title || articleId}" missing body in event payload; fetching full article via Admin API...`);
      return await fetchAndSyncArticleById(payload.id);
    }
    console.log(`[KnowledgeSync] Skipping Article (Empty Body): "${payload.title || articleId}". Removing from knowledge if exists.`);
    await deleteArticleFromEvent(payload);
    return;
  }

  // 2. Clean HTML content
  const cleanContent = stripHtml(rawBody);

  // 3. Ignore if no real text after cleaning HTML (reference: sync-pages.js)
  if (!cleanContent || cleanContent.trim() === "") {
    console.log(`[KnowledgeSync] Skipping Article (No real text after cleaning HTML): "${payload.title || articleId}". Removing from knowledge if exists.`);
    await deleteArticleFromEvent(payload);
    return;
  }

  const blogHandle = payload.blog?.handle || "post";
  const articleUrl = payload.handle ? `${storefrontUrl}/blogs/${blogHandle}/${payload.handle}` : null;
  const chunks = chunkText(cleanContent, 2000, 500);

  if (chunks.length === 0) {
    console.log(`[KnowledgeSync] Skipping Article (No chunks generated): "${payload.title || articleId}". Removing from knowledge if exists.`);
    await deleteArticleFromEvent(payload);
    return;
  }

  console.log(`[KnowledgeSync] Upserting Article "${payload.title}" (${graphqlId}) with ${chunks.length} chunks`);

  const doc = await prisma.knowledgeDocument.upsert({
    where: { shopifyGraphqlId: graphqlId },
    update: {
      title: payload.title || "Untitled Article",
      baseUrl: articleUrl,
      content: cleanContent,
      chunkCount: chunks.length,
      updatedAt: new Date(),
    },
    create: {
      shopifyGraphqlId: graphqlId,
      sourceId: source.id,
      title: payload.title || "Untitled Article",
      baseUrl: articleUrl,
      content: cleanContent,
      chunkCount: chunks.length,
    },
  });

  // Remove stale chunks
  await prisma.knowledgeChunk.deleteMany({
    where: { documentId: doc.id },
  });

  if (chunks.length > 0) {
    const createdChunks = [];
    for (let index = 0; index < chunks.length; index++) {
      const chunkTextContent = chunks[index];
      const chunk = await prisma.knowledgeChunk.create({
        data: {
          documentId: doc.id,
          chunkIndex: index + 1,
          content: chunkTextContent,
          metadata: {
            title: payload.title,
            handle: payload.handle,
            url: articleUrl,
            chunk_index: index + 1,
          },
        },
      });
      createdChunks.push(chunk);
    }

    // Generate embeddings asynchronously without blocking event delivery response
    generateEmbeddingsForChunks(createdChunks).catch((err) => {
      console.error("[KnowledgeSync] Async embedding generation error for article:", err);
    });
  }
}

/**
 * Handle Article delete events
 */
export async function deleteArticleFromEvent(payload) {
  if (!payload || !payload.id) return;
  const graphqlId = payload.admin_graphql_api_id || `gid://shopify/Article/${payload.id}`;
  console.log(`[KnowledgeSync] Deleting Article ${graphqlId}`);
  await prisma.knowledgeDocument.deleteMany({
    where: { shopifyGraphqlId: graphqlId },
  });
}

export const syncArticleFromWebhook = syncArticleFromEvent;
export const deleteArticleFromWebhook = deleteArticleFromEvent;

/**
 * Handle Page create and update events
 */
export async function syncPageFromEvent(payload) {
  if (!payload || !payload.id) {
    console.warn("[KnowledgeSync] Missing page payload or ID");
    return;
  }

  const shopifyStoreDomain = process.env.SHOPIFY_STORE_DOMAIN || "perfumania-tfo.myshopify.com";
  const storefrontUrl = process.env.STOREFRONT_URL || `https://${shopifyStoreDomain}`;
  const pageId = payload.id;
  const graphqlId = payload.admin_graphql_api_id || `gid://shopify/Page/${pageId}`;

  // Find KnowledgeSource with code 'page'
  let source = await prisma.knowledgeSource.findUnique({
    where: { code: "page" },
  });

  if (!source) {
    source = await prisma.knowledgeSource.create({
      data: {
        code: "page",
        name: "Shopify Pages",
        sourceType: "page",
        baseUrl: `${storefrontUrl}/pages`,
      },
    });
  }

  // 1. Check for empty body (reference: sync-pages.js)
  const rawBody = payload.body_html || payload.body || "";
  if (!rawBody || rawBody.trim() === "") {
    // If the event payload only sent { id, title, handle }, fetch full page details from Admin API
    if (payload.id && !payload._hasFetchedBody) {
      console.log(`[KnowledgeSync] Page "${payload.title || pageId}" missing body in event payload; fetching full page via Admin API...`);
      return await fetchAndSyncPageById(payload.id);
    }
    console.log(`[KnowledgeSync] Skipping Page (Empty Body): "${payload.title || pageId}". Removing from knowledge if exists.`);
    await deletePageFromEvent(payload);
    return;
  }

  // 2. Clean HTML content
  const cleanContent = stripHtml(rawBody);

  // 3. Ignore if no real text after cleaning HTML (reference: sync-pages.js)
  if (!cleanContent || cleanContent.trim() === "") {
    console.log(`[KnowledgeSync] Skipping Page (No real text after cleaning HTML): "${payload.title || pageId}". Removing from knowledge if exists.`);
    await deletePageFromEvent(payload);
    return;
  }

  const pageUrl = payload.handle ? `${storefrontUrl}/pages/${payload.handle}` : null;
  const chunks = chunkText(cleanContent, 2000, 500);

  if (chunks.length === 0) {
    console.log(`[KnowledgeSync] Skipping Page (No chunks generated): "${payload.title || pageId}". Removing from knowledge if exists.`);
    await deletePageFromEvent(payload);
    return;
  }

  console.log(`[KnowledgeSync] Upserting Page "${payload.title}" (${graphqlId}) with ${chunks.length} chunks`);

  const doc = await prisma.knowledgeDocument.upsert({
    where: { shopifyGraphqlId: graphqlId },
    update: {
      title: payload.title || "Untitled Page",
      baseUrl: pageUrl,
      content: cleanContent,
      chunkCount: chunks.length,
      updatedAt: new Date(),
    },
    create: {
      shopifyGraphqlId: graphqlId,
      sourceId: source.id,
      title: payload.title || "Untitled Page",
      baseUrl: pageUrl,
      content: cleanContent,
      chunkCount: chunks.length,
    },
  });

  // Remove stale chunks
  await prisma.knowledgeChunk.deleteMany({
    where: { documentId: doc.id },
  });

  if (chunks.length > 0) {
    const createdChunks = [];
    for (let index = 0; index < chunks.length; index++) {
      const chunkTextContent = chunks[index];
      const chunk = await prisma.knowledgeChunk.create({
        data: {
          documentId: doc.id,
          chunkIndex: index + 1,
          content: chunkTextContent,
          metadata: {
            title: payload.title,
            handle: payload.handle,
            url: pageUrl,
            chunk_index: index + 1,
          },
        },
      });
      createdChunks.push(chunk);
    }

    // Generate embeddings asynchronously without blocking event delivery response
    generateEmbeddingsForChunks(createdChunks).catch((err) => {
      console.error("[KnowledgeSync] Async embedding generation error for page:", err);
    });
  }
}

/**
 * Handle Page delete events
 */
export async function deletePageFromEvent(payload) {
  if (!payload || !payload.id) return;
  const graphqlId = payload.admin_graphql_api_id || `gid://shopify/Page/${payload.id}`;
  console.log(`[KnowledgeSync] Deleting Page ${graphqlId}`);
  await prisma.knowledgeDocument.deleteMany({
    where: { shopifyGraphqlId: graphqlId },
  });
}

export const syncPageFromWebhook = syncPageFromEvent;
export const deletePageFromWebhook = deletePageFromEvent;

/**
 * Fetch full article from Admin API by ID and sync (handles Event Subscriptions)
 */
export async function fetchAndSyncArticleById(articleId) {
  if (!articleId) return;
  const normalizedId = String(articleId).startsWith("gid://shopify/Article/")
    ? String(articleId)
    : `gid://shopify/Article/${articleId}`;

  const shopifyStoreDomain = process.env.SHOPIFY_STORE_DOMAIN;
  const adminToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
  if (!shopifyStoreDomain || !adminToken) {
    console.error("[KnowledgeSync] Missing SHOPIFY_STORE_DOMAIN or SHOPIFY_ADMIN_ACCESS_TOKEN");
    return;
  }

  try {
    const response = await fetch(`https://${shopifyStoreDomain}/admin/api/2024-10/graphql.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": adminToken,
      },
      body: JSON.stringify({
        query: `query GetArticle($id: ID!) {
          article(id: $id) {
            id
            title
            handle
            body
            summary
            blog { handle }
          }
        }`,
        variables: { id: normalizedId },
      }),
    });

    const json = await response.json();
    const article = json?.data?.article;
    if (article) {
      // 1. Ignore articles with empty body (reference: sync-pages.js)
      if (!article.body || article.body.trim() === "") {
        console.log(`[KnowledgeSync] Skipping Article (Empty Body): "${article.title || normalizedId}". Removing from knowledge if exists.`);
        await deleteArticleFromEvent({ id: article.id, admin_graphql_api_id: article.id });
        return;
      }

      // 2. Ignore articles with no real text after cleaning HTML (reference: sync-pages.js)
      const cleanContent = stripHtml(article.body);
      if (!cleanContent || cleanContent.trim() === "") {
        console.log(`[KnowledgeSync] Skipping Article (No real text after cleaning HTML): "${article.title || normalizedId}". Removing from knowledge if exists.`);
        await deleteArticleFromEvent({ id: article.id, admin_graphql_api_id: article.id });
        return;
      }

      await syncArticleFromEvent({
        id: article.id,
        admin_graphql_api_id: article.id,
        title: article.title,
        handle: article.handle,
        body: article.body,
        summary: article.summary,
        blog: article.blog,
        _hasFetchedBody: true,
      });
    } else {
      console.warn(`[KnowledgeSync] Article not found in Shopify Admin: ${normalizedId}`);
    }
  } catch (error) {
    console.error(`[KnowledgeSync] Error fetching article by ID ${normalizedId}:`, error);
  }
}

/**
 * Fetch full page from Admin API by ID and sync (handles Event Subscriptions)
 */
export async function fetchAndSyncPageById(pageId) {
  if (!pageId) return;
  const normalizedId = String(pageId).startsWith("gid://shopify/Page/")
    ? String(pageId)
    : `gid://shopify/Page/${pageId}`;

  const shopifyStoreDomain = process.env.SHOPIFY_STORE_DOMAIN;
  const adminToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
  if (!shopifyStoreDomain || !adminToken) {
    console.error("[KnowledgeSync] Missing SHOPIFY_STORE_DOMAIN or SHOPIFY_ADMIN_ACCESS_TOKEN");
    return;
  }

  try {
    const response = await fetch(`https://${shopifyStoreDomain}/admin/api/2024-10/graphql.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": adminToken,
      },
      body: JSON.stringify({
        query: `query GetPage($id: ID!) {
          page(id: $id) {
            id
            title
            handle
            body
          }
        }`,
        variables: { id: normalizedId },
      }),
    });

    const json = await response.json();
    const page = json?.data?.page;
    if (page) {
      // 1. Ignore pages with empty body (reference: sync-pages.js)
      if (!page.body || page.body.trim() === "") {
        console.log(`[KnowledgeSync] Skipping Page (Empty Body): "${page.title || normalizedId}". Removing from knowledge if exists.`);
        await deletePageFromEvent({ id: page.id, admin_graphql_api_id: page.id });
        return;
      }

      // 2. Ignore pages with no real text after cleaning HTML (reference: sync-pages.js)
      const cleanContent = stripHtml(page.body);
      if (!cleanContent || cleanContent.trim() === "") {
        console.log(`[KnowledgeSync] Skipping Page (No real text after cleaning HTML): "${page.title || normalizedId}". Removing from knowledge if exists.`);
        await deletePageFromEvent({ id: page.id, admin_graphql_api_id: page.id });
        return;
      }

      await syncPageFromEvent({
        id: page.id,
        admin_graphql_api_id: page.id,
        title: page.title,
        handle: page.handle,
        body: page.body,
        _hasFetchedBody: true,
      });
    } else {
      console.warn(`[KnowledgeSync] Page not found in Shopify Admin: ${normalizedId}`);
    }
  } catch (error) {
    console.error(`[KnowledgeSync] Error fetching page by ID ${normalizedId}:`, error);
  }
}

