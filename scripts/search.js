import { PrismaClient } from "@prisma/client";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();
const prisma = new PrismaClient();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";
const COST_PER_TOKEN = 0.00000002;

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
  const queryText = process.argv.slice(2).join(" ");

  if (!queryText) {
    console.log("Please provide a question to search for.");
    console.log("Usage: node scripts/search.js <your question>");
    process.exit(1);
  }

  if (!OPENAI_API_KEY) {
    console.error("Error: OPENAI_API_KEY is not set in .env");
    process.exit(1);
  }

  console.log(`Generating embedding for: "${queryText}"`);
  const startTime = Date.now();

  const requestPayload = {
    model: OPENAI_EMBEDDING_MODEL,
    input: queryText,
  };

  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestPayload),
  });

  const statusCode = response.status;
  const headers = Object.fromEntries(response.headers.entries());
  const data = await response.json();
  const durationMs = Date.now() - startTime;

  if (!response.ok) {
    console.error("API Error:", data);

    await prisma.knowledgeProcessingLog.create({
      data: {
        knowledgeChunkId: null,
        request: JSON.stringify(requestPayload),
        response: JSON.stringify(data),
        headers: JSON.stringify(headers),
        statusCode,
        durationMs,
        llmPricingId: OPENAI_EMBEDDING_MODEL,
        errorMessage: JSON.stringify(data),
      },
    });
    process.exit(1);
  }

  const queryEmbedding = data.data?.[0]?.embedding;
  const tokensUsed = data.usage?.total_tokens || 0;
  const costUsd = tokensUsed * COST_PER_TOKEN;

  // Log search embedding call
  await prisma.knowledgeProcessingLog.create({
    data: {
      knowledgeChunkId: null,
      request: JSON.stringify(requestPayload),
      response: JSON.stringify(data),
      headers: JSON.stringify(headers),
      statusCode,
      durationMs,
      tokensUsed,
      costUsd,
      llmPricingId: OPENAI_EMBEDDING_MODEL,
    },
  });

  console.log("Searching database for similar chunks...");

  const chunks = await prisma.$queryRawUnsafe(`
    SELECT 
      c.id, 
      c.content, 
      VECTOR_TO_STRING(c.embedding) AS embeddingStr,
      d.title AS title,
      d.base_url AS baseUrl
    FROM knowledgeChunks c
    LEFT JOIN knowledgeDocuments d ON c.document_id = d.id
    WHERE c.embedding IS NOT NULL
  `);

  const scoredChunks = [];

  for (const chunk of chunks) {
    try {
      if (chunk.embeddingStr) {
        const chunkVector = JSON.parse(chunk.embeddingStr);
        if (Array.isArray(chunkVector)) {
          const score = dotProduct(queryEmbedding, chunkVector);
          scoredChunks.push({
            id: chunk.id,
            content: chunk.content,
            score,
            title: chunk.title || "Document",
            baseUrl: chunk.baseUrl,
          });
        }
      }
    } catch {
      // Ignore invalid JSON vector strings
    }
  }

  scoredChunks.sort((a, b) => b.score - a.score);
  const results = scoredChunks.slice(0, 5);

  let outputText = `Query: "${queryText}"\n`;
  outputText += `Model: ${OPENAI_EMBEDDING_MODEL}\n`;
  outputText += `Tokens Used: ${tokensUsed} | Cost: $${costUsd.toFixed(8)}\n\n`;
  outputText += `--- Top Results ---\n\n`;

  console.log("\n--- Top Results ---\n");
  if (results.length === 0) {
    console.log("No chunks with embeddings found in the database yet!");
    outputText += "No chunks with embeddings found in the database yet!\n";
  } else {
    for (let i = 0; i < results.length; i++) {
      const res = results[i];
      const resultHeader = `[Result ${i + 1}] (Similarity: ${res.score.toFixed(4)}) Chunk ID: ${res.id} | ${res.title}`;
      const resultContent = `URL: ${res.baseUrl || "N/A"}\nContent:\n${res.content}\n`;
      const separator = "-".repeat(50) + "\n";

      console.log(resultHeader);
      console.log(resultContent);
      console.log(separator);

      outputText += `${resultHeader}\n${resultContent}\n${separator}\n`;
    }
  }

  const outputPath = "search-results.txt";
  fs.writeFileSync(outputPath, outputText);
  console.log(`Results have also been saved to ${outputPath}`);
}

main()
  .catch((e) => {
    console.error("Error:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
