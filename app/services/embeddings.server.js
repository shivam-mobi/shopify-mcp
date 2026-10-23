import prisma from "../db.server.js";

export const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";

export function getEmbeddingModel() {
  return process.env.OPENAI_EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL;
}

export function getOpenAIApiKey() {
  return process.env.OPENAI_API_KEY || "";
}

/**
 * Common low-level function to call the OpenAI Embeddings API.
 * Accepts a single string OR an array of strings.
 *
 * @param {string | string[]} input - The string or array of strings to embed.
 * @param {Object} [options]
 * @param {string} [options.model] - Optional override for embedding model.
 * @param {string} [options.apiKey] - Optional override for OpenAI API key.
 * @returns {Promise<{ ok: boolean, data?: any, error?: string, status?: number }>}
 */
export async function callOpenAIEmbeddingsApi(input, options = {}) {
  const apiKey = options.apiKey || getOpenAIApiKey();
  if (!apiKey) {
    const errorMsg = "[Embeddings] OPENAI_API_KEY is not configured.";
    console.warn(errorMsg);
    return { ok: false, error: errorMsg, status: 401 };
  }

  const model = options.model || getEmbeddingModel();

  try {
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        input,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[Embeddings] OpenAI API error (${response.status}):`, errorText);
      return { ok: false, error: errorText, status: response.status };
    }

    const data = await response.json();
    return { ok: true, data, status: response.status };
  } catch (error) {
    console.error("[Embeddings] Error calling OpenAI Embeddings API:", error);
    return { ok: false, error: error.message || String(error), status: 500 };
  }
}

/**
 * Generate embedding vector for a single text string using OpenAI.
 *
 * @param {string} text - The input text to embed.
 * @param {Object} [options]
 * @param {string} [options.model] - Optional override for embedding model.
 * @param {string} [options.apiKey] - Optional override for OpenAI API key.
 * @returns {Promise<number[] | null>} The 1536-dimensional vector array or null if failed.
 */
export async function generateEmbedding(text, options = {}) {
  if (!text || typeof text !== "string" || text.trim() === "") {
    return null;
  }

  const result = await callOpenAIEmbeddingsApi(text.trim(), options);
  if (!result.ok || !result.data) {
    return null;
  }

  return result.data.data?.[0]?.embedding || null;
}

/**
 * Generate embeddings for an array of texts in batch.
 *
 * @param {string[]} texts - Array of text strings to embed.
 * @param {Object} [options]
 * @returns {Promise<Array<number[] | null>>}
 */
export async function generateBatchEmbeddings(texts, options = {}) {
  if (!Array.isArray(texts) || texts.length === 0) {
    return [];
  }

  const sanitizedTexts = texts.map((t) => (typeof t === "string" ? t.trim() : String(t || "")));
  const result = await callOpenAIEmbeddingsApi(sanitizedTexts, options);
  if (!result.ok || !result.data) {
    return texts.map(() => null);
  }

  const results = new Array(texts.length).fill(null);
  for (const item of result.data.data || []) {
    if (typeof item.index === "number" && item.embedding) {
      results[item.index] = item.embedding;
    }
  }
  return results;
}

/**
 * Save an embedding vector to a knowledge chunk along with cost and pricing info.
 * Serialized as JSON string in SQLite / Prisma.
 *
 * @param {string} chunkId - The knowledgeChunk ID.
 * @param {number[]} embeddingVector - Array of floating point numbers.
 * @param {Object} [options]
 * @param {string} [options.llmPricingId] - Model ID used for embeddings
 * @param {number} [options.llmCost] - Cost in USD for generating this chunk's embedding
 * @param {number} [options.tokenCount] - Exact tokens consumed by this chunk
 * @param {string} [options.documentId] - Optional document ID to update aggregate cost
 * @returns {Promise<boolean>}
 */
export async function updateChunkEmbedding(chunkId, embeddingVector, options = {}) {
  if (!chunkId || !Array.isArray(embeddingVector) || embeddingVector.length === 0) {
    return false;
  }

  try {
    const vectorString = JSON.stringify(embeddingVector);
    await prisma.$executeRawUnsafe(
      `UPDATE knowledgeChunks 
       SET embedding = STRING_TO_VECTOR(?),
           llm_pricing_id = COALESCE(?, llm_pricing_id),
           llm_cost = COALESCE(?, llm_cost),
           token_count = COALESCE(?, token_count)
       WHERE id = ?`,
      vectorString,
      options.llmPricingId || null,
      options.llmCost != null ? Number(options.llmCost) : null,
      options.tokenCount != null ? Number(options.tokenCount) : null,
      chunkId
    );

    let docId = options.documentId;
    if (!docId) {
      const chunk = await prisma.knowledgeChunk.findUnique({
        where: { id: chunkId },
        select: { documentId: true },
      });
      docId = chunk?.documentId;
    }

    if (docId) {
      const chunkStats = await prisma.knowledgeChunk.aggregate({
        where: { documentId: docId },
        _sum: {
          tokenCount: true,
          llmCost: true,
        },
      });

      await prisma.knowledgeDocument.update({
        where: { id: docId },
        data: {
          tokenCount: chunkStats._sum.tokenCount || 0,
          embeddingTokens: chunkStats._sum.tokenCount || 0,
          embeddingCostUsd: chunkStats._sum.llmCost || 0,
          updatedAt: new Date(),
        },
      });
    }

    return true;
  } catch (error) {
    console.error(`[Embeddings] Failed to save embedding for chunk ${chunkId}:`, error);
    return false;
  }
}

/**
 * Calculate dot product between two equal-length vectors.
 */
export function dotProduct(vecA, vecB) {
  if (!Array.isArray(vecA) || !Array.isArray(vecB) || vecA.length !== vecB.length) {
    return 0;
  }
  let sum = 0;
  for (let i = 0; i < vecA.length; i++) {
    sum += vecA[i] * vecB[i];
  }
  return sum;
}
