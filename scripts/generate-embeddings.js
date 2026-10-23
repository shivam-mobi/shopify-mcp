import { PrismaClient, Prisma } from "@prisma/client";
import dotenv from "dotenv";

dotenv.config();
const prisma = new PrismaClient();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";
// text-embedding-3-small is priced at $0.020 / 1M tokens ($0.00000002 per token)
const COST_PER_TOKEN = 0.00000002;

async function main() {
  console.log(`Starting embedding generation using model: ${OPENAI_EMBEDDING_MODEL}`);

  if (!OPENAI_API_KEY) {
    console.error("Error: OPENAI_API_KEY is not configured in .env");
    process.exit(1);
  }

  // Find chunks that do not have embeddings yet
  const chunksToProcess = await prisma.knowledgeChunk.findMany({
    where: {
      OR: [
        { embedding: null },
        { embedding: "" },
      ],
    },
    take: 50,
    select: {
      id: true,
      content: true,
      documentId: true,
    },
  });

  if (chunksToProcess.length === 0) {
    console.log("No chunks with missing embeddings found.");
    return;
  }

  console.log(`Found ${chunksToProcess.length} chunks to process.`);

  for (const chunk of chunksToProcess) {
    console.log(`Processing chunk ID: ${chunk.id}`);
    const textToEmbed = chunk.content;

    if (!textToEmbed || textToEmbed.trim() === "") {
      console.log(`Chunk ${chunk.id} is empty, skipping.`);
      continue;
    }

    const startTime = Date.now();
    let statusCode = 200;
    let apiResponse = null;
    let errorMessage = null;
    let tokensUsed = 0;
    let costUsd = 0;

    const requestPayload = {
      model: OPENAI_EMBEDDING_MODEL,
      input: textToEmbed,
    };

    try {
      const response = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestPayload),
      });

      statusCode = response.status;
      const headers = Object.fromEntries(response.headers.entries());
      const data = await response.json();
      apiResponse = data;

      const durationMs = Date.now() - startTime;

      if (!response.ok) {
        errorMessage = JSON.stringify(data);
        console.error(`API Error for chunk ${chunk.id}:`, data);
      } else {
        const embeddingVector = data.data?.[0]?.embedding;
        tokensUsed = data.usage?.total_tokens || 0;
        costUsd = tokensUsed * COST_PER_TOKEN;

        // Store embedding VECTOR(1536), pricing ID, and LLM cost in knowledgeChunks
        const vectorString = JSON.stringify(embeddingVector);
        await prisma.$executeRawUnsafe(
          `UPDATE knowledgeChunks 
           SET embedding = STRING_TO_VECTOR(?),
               token_count = ?,
               llm_pricing_id = ?,
               llm_cost = ?
           WHERE id = ?`,
          vectorString,
          tokensUsed,
          OPENAI_EMBEDDING_MODEL,
          costUsd,
          chunk.id
        );

        // Update document aggregate embedding cost and tokens
        if (chunk.documentId) {
          const stats = await prisma.knowledgeChunk.aggregate({
            where: { documentId: chunk.documentId },
            _sum: {
              tokenCount: true,
              llmCost: true,
            },
          });

          await prisma.knowledgeDocument.update({
            where: { id: chunk.documentId },
            data: {
              tokenCount: stats._sum.tokenCount || 0,
              embeddingTokens: stats._sum.tokenCount || 0,
              embeddingCostUsd: stats._sum.llmCost || 0,
              updatedAt: new Date(),
            },
          });
        }

        console.log(`Successfully generated and saved embedding for chunk ${chunk.id} (Tokens: ${tokensUsed}, Cost: $${costUsd.toFixed(8)})`);
      }

      // Log to KnowledgeProcessingLog
      await prisma.knowledgeProcessingLog.create({
        data: {
          knowledgeChunkId: chunk.id,
          request: JSON.stringify(requestPayload),
          response: JSON.stringify(apiResponse),
          headers: JSON.stringify(headers),
          statusCode,
          durationMs,
          tokensUsed,
          costUsd,
          llmPricingId: OPENAI_EMBEDDING_MODEL,
          errorMessage,
        },
      });
    } catch (error) {
      console.error(`Request failed for chunk ${chunk.id}:`, error);
      const durationMs = Date.now() - startTime;

      await prisma.knowledgeProcessingLog.create({
        data: {
          knowledgeChunkId: chunk.id,
          request: JSON.stringify(requestPayload),
          response: "",
          statusCode: 500,
          durationMs,
          tokensUsed: 0,
          costUsd: 0,
          llmPricingId: OPENAI_EMBEDDING_MODEL,
          errorMessage: error.message || String(error),
        },
      });
    }
  }

  console.log("Finished embedding generation batch.");
}

main()
  .catch((e) => {
    console.error("Error in generate-embeddings:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
