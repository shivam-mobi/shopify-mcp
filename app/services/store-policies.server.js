/**
 * Local store policy digest and Vector Knowledge Base search tool.
 * Searches knowledgeChunks (articles, blog posts, pages, policies, FAQs)
 * using OpenAI vector embeddings and cosine similarity.
 * Falls back to StorePolicyDigest DB table if no strong vector match.
 */
import prisma, {
  getStorePolicyDigest,
  DEFAULT_STORE_POLICY_DIGEST,
} from "../db.server.js";
import { generateEmbedding, dotProduct } from "./embeddings.server.js";

export const STORE_POLICY_TOOL_NAME = "search_articles_faqs_about_contact_and_policies";
export const STORE_POLICY_TOOL_NAME_ALT = "search_articles_faqs_about_contact_and_policie";
export const SHOPIFY_POLICY_TOOL_NAME = "search_shop_policies_and_faqs";
export const LEGACY_STORE_POLICY_TOOL_NAME = "search_store_policies";

const KNOWLEDGE_TOOL_NAMES = new Set([
  STORE_POLICY_TOOL_NAME,
  STORE_POLICY_TOOL_NAME_ALT,
  LEGACY_STORE_POLICY_TOOL_NAME,
  SHOPIFY_POLICY_TOOL_NAME,
]);

const SHOPIFY_POLICY_TOOL_NAMES = new Set([SHOPIFY_POLICY_TOOL_NAME]);

/** Drop knowledge heading/body below this score. */
const MIN_KB_SIMILARITY_FOR_LLM = 0.5;

function clampSimilarityUnit(score) {
  const n = Number(score);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(1, n);
}

const VECTOR_KB_INSTRUCTION =
  "Answer from the provided knowledge base search results above. Do NOT invent details. " +
  "Perfumania products are 100% authentic designer fragrances. " +
  "For additional support, share our Perfumania Customer Care team ([customer.service@perfumania.com](mailto:customer.service@perfumania.com) or [1 (866) 557-2368](tel:18665572368)).";

function toolResult(data) {
  return {
    content: [
      {
        type: "text",
        text: typeof data === "string" ? data : JSON.stringify(data),
      },
    ],
    structuredContent: typeof data === "object" ? data : undefined,
  };
}

function toolError(message) {
  return toolResult({
    success: false,
    error: true,
    message: String(message || "Store policy search failed."),
  });
}

/**
 * Search the vector knowledge base first, then fallback to local policy digest.
 */
export async function searchStorePolicies(
  { query = "", topic = null } = {},
  conversationIdOrOptions = null,
  optionalMessageId = null
) {
  let conversationId = null;
  let messageId = null;
  let userMessage = null;
  if (typeof conversationIdOrOptions === "object" && conversationIdOrOptions !== null) {
    conversationId = conversationIdOrOptions.conversationId || null;
    messageId = conversationIdOrOptions.messageId || null;
    userMessage = conversationIdOrOptions.userMessage || null;
  } else {
    conversationId = conversationIdOrOptions;
    messageId = optionalMessageId;
  }

  let matchedChunks = [];

  const effectiveQuery = String(
    userMessage && query && !userMessage.toLowerCase().includes(query.toLowerCase())
      ? `${query} ${userMessage}`
      : query || userMessage || ""
  ).trim();

  if (effectiveQuery) {
    try {
      const queryEmbedding = await generateEmbedding(effectiveQuery);

      if (queryEmbedding) {
        const chunks = await prisma.$queryRawUnsafe(`
          SELECT c.id, c.content, VECTOR_TO_STRING(c.embedding) AS embeddingStr, d.title
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
                scoredChunks.push({ id: chunk.id, content: chunk.content, score });
              }
            }
          } catch {
            // Ignore parse errors on malformed embeddings
          }
        }

        scoredChunks.sort((a, b) => b.score - a.score);

        if (scoredChunks.length > 0) {
          const topScore = scoredChunks[0].score;
          const seen = new Set();
          matchedChunks = [];

          // Collect top 2 to 3 chunks:
          // Always take the top chunk if it meets minimum threshold. Include 2nd and 3rd if close.
          for (const c of scoredChunks) {
            if (matchedChunks.length >= 3) break;
            const text = (c.content || "").trim();
            if (seen.has(text)) continue;
            seen.add(text);

            if (matchedChunks.length === 0) {
              matchedChunks.push(c);
            } else if (c.score >= MIN_KB_SIMILARITY_FOR_LLM && c.score >= topScore - 0.15) {
              matchedChunks.push(c);
            } else {
              break;
            }
          }

          if (conversationId && matchedChunks.length > 0) {
            await Promise.all(
              matchedChunks.map((chunk) =>
                prisma.knowledgeSearchResult
                  .create({
                    data: {
                      conversationId,
                      messageId: messageId || null,
                      chunkId: chunk.id,
                      similarity: clampSimilarityUnit(chunk.score),
                      queryText: effectiveQuery,
                    },
                  })
                  .catch((err) => console.error("Error logging knowledgeSearchResult:", err))
              )
            );
          }
        }
      }
    } catch (err) {
      console.error("Vector search failed in policy fallback:", err);
    }
  }

  if (matchedChunks.length > 0) {
    const strongChunks = matchedChunks.filter(
      (chunk) => Number(chunk.score) >= MIN_KB_SIMILARITY_FOR_LLM
    );

    if (strongChunks.length > 0) {
      return {
        success: true,
        found: true,
        source: "vector_knowledge_base",
        query: String(query || "").trim(),
        topic: topic || null,
        results: strongChunks.map((chunk, index) => ({
          topic: "Search Result",
          heading:
            index === 0
              ? "Most Relevant Knowledge Base Info"
              : `Related Knowledge Base Info (Part ${index + 1})`,
          body: chunk.content,
          similarity: clampSimilarityUnit(chunk.score),
        })),
        instruction: VECTOR_KB_INSTRUCTION,
      };
    }
  }

  // Fallback: Local policy digest from DB / in-code default
  const row = await getStorePolicyDigest("default");
  const digest = row?.digest || DEFAULT_STORE_POLICY_DIGEST.digest;

  return {
    success: true,
    found: true,
    source: "store_policy_digest_db",
    query: String(query || "").trim(),
    topic: topic || null,
    content_date: row?.contentDate || DEFAULT_STORE_POLICY_DIGEST.contentDate,
    title: row?.title || DEFAULT_STORE_POLICY_DIGEST.title,
    note: row?.note || DEFAULT_STORE_POLICY_DIGEST.note,
    policy_digest: digest,
    results: [
      {
        topic: "digest",
        title: row?.title || DEFAULT_STORE_POLICY_DIGEST.title,
        heading: "Perfumania store policy digest",
        body: digest,
        content_date: row?.contentDate || DEFAULT_STORE_POLICY_DIGEST.contentDate,
      },
    ],
    contact: {
      store_url: "https://perfumania.com/",
      email: "customer.service@perfumania.com",
      phone: "1 (866) 557-2368",
    },
    instruction:
      "Shopify policy search returned no useful results (or this tool was called directly). " +
      "Answer ONLY from policy_digest. Do NOT invent policy details, shipping countries, return windows, or contact info. " +
      "This store is Perfumania (https://perfumania.com/). " +
      "Use only the published contact details in the digest. " +
      "U.S. shipping only; no international shipping per shipping-and-returns.",
  };
}

export function getStorePolicyTools() {
  return [
    {
      name: STORE_POLICY_TOOL_NAME,
      description:
        "Searches store knowledge base, articles, blog posts, fragrance guides, authenticity guarantees, FAQs, About Us / company info, Contact info, and store policies (shipping, returns, warranty, terms). Call this for ANY informational question, perfume guide, fragrance care advice, or store information.",
      input_schema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Customer question, keywords, or search topic using their full phrasing (e.g., 'are your fragrances authentic', 'how to choose perfume', 'shipping policy', 'return policy', 'contact'). Do NOT shorten to a single word.",
          },
          topic: {
            type: "string",
            description: "Optional topic hint",
          },
        },
        required: ["query"],
      },
    },
  ];
}

export function isStorePolicyTool(toolName) {
  return KNOWLEDGE_TOOL_NAMES.has(toolName);
}

export function isShopifyPolicyTool(toolName) {
  return SHOPIFY_POLICY_TOOL_NAMES.has(toolName);
}

function extractPolicyResponseText(response) {
  if (!response) return "";
  if (response.error) return "";

  if (response.structuredContent != null) {
    try {
      return typeof response.structuredContent === "string"
        ? response.structuredContent
        : JSON.stringify(response.structuredContent);
    } catch {
      return "";
    }
  }

  const parts = Array.isArray(response.content) ? response.content : [];
  return parts
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .join("\n")
    .trim();
}

/** True when Shopify policy MCP returned nothing useful. */
export function isEmptyShopifyPolicyResult(response) {
  if (!response || response.error) return true;

  const text = extractPolicyResponseText(response);
  if (!text) return true;

  try {
    const data = JSON.parse(text);
    if (Array.isArray(data) && data.length === 0) return true;
    if (data && typeof data === "object") {
      if (data.found === false) return true;
      for (const key of ["faqs", "results", "policies", "items", "answers", "documents"]) {
        if (Array.isArray(data[key]) && data[key].length === 0) return true;
      }
      const values = Object.values(data);
      if (
        values.length > 0 &&
        values.every((v) => v == null || v === "" || (Array.isArray(v) && v.length === 0))
      ) {
        return true;
      }
    }
  } catch {
    // plain text
  }

  const lower = text.toLowerCase();
  if (
    /no (relevant |matching )?(results?|faqs?|policies|information|matches)|not found|couldn'?t find|unable to find|i (don'?t|do not) have/.test(
      lower
    )
  ) {
    return true;
  }

  if (text.replace(/\s+/g, " ").trim().length < 40) return true;

  return false;
}

function policyQueryFromArgs(toolArgs = {}, fallbackQuery = "") {
  return String(
    toolArgs.query ||
      toolArgs.search ||
      toolArgs.question ||
      toolArgs.q ||
      fallbackQuery ||
      "store policies"
  ).trim();
}

/**
 * If Shopify policy search is empty/failed, return local DB digest / vector knowledge search.
 */
export async function withLocalPolicyFallback(
  shopifyResponse,
  toolArgs = {},
  fallbackQuery = "",
  conversationIdOrOptions = null,
  optionalMessageId = null
) {
  const query = policyQueryFromArgs(toolArgs, fallbackQuery);
  console.log("[store-policies] Shopify empty/error — DB digest/vector fallback", { query });

  const local = await callStorePolicyTool(
    STORE_POLICY_TOOL_NAME,
    {
      query,
      topic: toolArgs.topic || null,
    },
    conversationIdOrOptions,
    optionalMessageId
  );

  try {
    const data = JSON.parse(local.content?.[0]?.text || "{}");
    data.source = "local_fallback";
    data.shopify_empty = true;
    data.instruction =
      (data.instruction ? `${data.instruction} ` : "") +
      "Answer from this local policy digest/knowledge search. If the answer is not in the text, provide the support contact info instead of failing.";
    local.content = [{ type: "text", text: JSON.stringify(data) }];
    local.structuredContent = data;
  } catch {
    // keep raw local response
  }

  return local;
}

/** Filter raw Shopify policy tool from LLM so only the unified knowledge tool is visible. */
export function filterShopifyPolicyToolsForLlm(tools = []) {
  return tools.filter((tool) => tool?.name !== SHOPIFY_POLICY_TOOL_NAME);
}

export async function callStorePolicyTool(
  toolName,
  toolArgs = {},
  conversationIdOrOptions = null,
  optionalMessageId = null
) {
  if (!isStorePolicyTool(toolName)) {
    return toolError(`Unknown store policy tool: ${toolName}`);
  }

  let conversationId = null;
  let messageId = null;
  let userMessage = null;
  if (typeof conversationIdOrOptions === "object" && conversationIdOrOptions !== null) {
    conversationId = conversationIdOrOptions.conversationId || null;
    messageId = conversationIdOrOptions.messageId || null;
    userMessage = conversationIdOrOptions.userMessage || null;
  } else {
    conversationId = conversationIdOrOptions;
    messageId = optionalMessageId;
  }

  try {
    return toolResult(
      await searchStorePolicies(toolArgs, { conversationId, messageId, userMessage })
    );
  } catch (error) {
    console.error("[store-policies] digest load failed", error);
    // Last resort: in-code default digest JSON
    return toolResult({
      success: true,
      found: true,
      source: "in_code_default",
      query: String(toolArgs.query || "").trim(),
      content_date: DEFAULT_STORE_POLICY_DIGEST.contentDate,
      title: DEFAULT_STORE_POLICY_DIGEST.title,
      note: DEFAULT_STORE_POLICY_DIGEST.note,
      policy_digest: DEFAULT_STORE_POLICY_DIGEST.digest,
      results: [
        {
          topic: "digest",
          title: DEFAULT_STORE_POLICY_DIGEST.title,
          heading: "Perfumania store policy digest",
          body: DEFAULT_STORE_POLICY_DIGEST.digest,
          content_date: DEFAULT_STORE_POLICY_DIGEST.contentDate,
        },
      ],
      contact: {
        store_url: "https://perfumania.com/",
        email: "customer.service@perfumania.com",
        phone: "1 (866) 557-2368",
      },
      instruction:
        "Answer ONLY from policy_digest. Do NOT invent policy details. " +
        "This store is Perfumania (https://perfumania.com/).",
    });
  }
}

export default {
  getStorePolicyTools,
  isStorePolicyTool,
  isShopifyPolicyTool,
  isEmptyShopifyPolicyResult,
  withLocalPolicyFallback,
  callStorePolicyTool,
  filterShopifyPolicyToolsForLlm,
  searchStorePolicies,
};
