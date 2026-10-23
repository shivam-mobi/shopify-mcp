import prisma from "../db.server.js";
import { chunkText, generateEmbeddingsForChunks } from "../services/knowledge-sync.server.js";

/**
 * Re-chunk a single Knowledge Document
 * @param {string} documentId
 * @param {Object} options
 * @param {number} [options.chunkSize=2000]
 * @param {number} [options.overlap=500]
 * @param {boolean} [options.generateEmbeddings=true]
 */
export async function rechunkSingleDocument(
  documentId,
  { chunkSize = 2000, overlap = 500, generateEmbeddings = true } = {}
) {
  if (!documentId) {
    return { success: false, error: "Missing documentId parameter." };
  }

  try {
    const document = await prisma.knowledgeDocument.findUnique({
      where: { id: documentId },
      include: { source: true },
    });

    if (!document) {
      return { success: false, error: `Document with ID ${documentId} not found.` };
    }

    const rawContent = (document.content || "").trim();
    if (!rawContent) {
      return {
        success: false,
        error: `Document "${document.title}" has no text content to chunk.`,
      };
    }

    const chunks = chunkText(rawContent, Number(chunkSize) || 2000, Number(overlap) || 500);

    if (chunks.length === 0) {
      return {
        success: false,
        error: `No chunks could be produced from "${document.title}".`,
      };
    }

    // Delete existing chunks for this document
    await prisma.knowledgeChunk.deleteMany({
      where: { documentId: document.id },
    });

    // Create new chunks
    const createdChunks = [];
    for (let index = 0; index < chunks.length; index++) {
      const chunkContent = chunks[index];
      const approxTokens = Math.ceil(chunkContent.length / 4);

      const chunk = await prisma.knowledgeChunk.create({
        data: {
          documentId: document.id,
          chunkIndex: index + 1,
          content: chunkContent,
          tokenCount: approxTokens,
          metadata: JSON.stringify({
            chunk_index: index + 1,
            total_chunks: chunks.length,
            document_title: document.title,
            source: document.source?.code || document.source?.name || "document",
            shopify_id: document.shopifyGraphqlId || null,
          }),
        },
      });
      createdChunks.push(chunk);
    }

    const totalTokens = createdChunks.reduce((acc, c) => acc + (c.tokenCount || 0), 0);

    // Update document chunk count and timestamp
    await prisma.knowledgeDocument.update({
      where: { id: document.id },
      data: {
        chunkCount: createdChunks.length,
        tokenCount: totalTokens,
        updatedAt: new Date(),
      },
    });

    // Trigger OpenAI embeddings generation in the background if enabled
    if (generateEmbeddings) {
      generateEmbeddingsForChunks(createdChunks).catch((err) => {
        console.error(`[AdminChunker] Error generating embeddings for doc ${document.id}:`, err);
      });
    }

    return {
      success: true,
      documentId: document.id,
      title: document.title,
      chunkCount: createdChunks.length,
      totalTokens,
    };
  } catch (error) {
    console.error(`[AdminChunker] Error rechunking document ${documentId}:`, error);
    return {
      success: false,
      error: error?.message || "Failed to re-chunk document.",
    };
  }
}

/**
 * Re-chunk ALL Knowledge Documents or all documents within a source
 * @param {Object} options
 * @param {string} [options.sourceId]
 * @param {number} [options.chunkSize=2000]
 * @param {number} [options.overlap=500]
 * @param {boolean} [options.generateEmbeddings=true]
 */
export async function rechunkAllDocuments({
  sourceId = "",
  chunkSize = 2000,
  overlap = 500,
  generateEmbeddings = true,
} = {}) {
  try {
    const where = {
      content: { not: "" },
    };
    if (sourceId) {
      where.sourceId = sourceId;
    }

    const documents = await prisma.knowledgeDocument.findMany({
      where,
      include: { source: true },
    });

    if (documents.length === 0) {
      return {
        success: false,
        error: "No eligible knowledge documents found to chunk.",
      };
    }

    let processedCount = 0;
    let totalChunksCreated = 0;
    const errors = [];

    for (const doc of documents) {
      const res = await rechunkSingleDocument(doc.id, {
        chunkSize,
        overlap,
        generateEmbeddings,
      });

      if (res.success) {
        processedCount++;
        totalChunksCreated += res.chunkCount;
      } else {
        errors.push(`${doc.title}: ${res.error}`);
      }
    }

    return {
      success: true,
      totalDocuments: documents.length,
      processedDocuments: processedCount,
      totalChunksCreated,
      errors: errors.length > 0 ? errors.slice(0, 5) : [],
    };
  } catch (error) {
    console.error("[AdminChunker] Error in rechunkAllDocuments:", error);
    return {
      success: false,
      error: error?.message || "Failed to re-chunk all documents.",
    };
  }
}
