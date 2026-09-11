/**
 * Local store policy digest tool.
 * Loaded from StorePolicyDigest DB table; used when Shopify
 * search_shop_policies_and_faqs returns empty / fails.
 */
import {
  getStorePolicyDigest,
  DEFAULT_STORE_POLICY_DIGEST
} from "../db.server.js";

export const STORE_POLICY_TOOL_NAME = "search_store_policies";
export const SHOPIFY_POLICY_TOOL_NAME = "search_shop_policies_and_faqs";

const SHOPIFY_POLICY_TOOL_NAMES = new Set([SHOPIFY_POLICY_TOOL_NAME]);

function toolResult(data) {
  return {
    content: [
      {
        type: "text",
        text: typeof data === "string" ? data : JSON.stringify(data)
      }
    ],
    structuredContent: typeof data === "object" ? data : undefined
  };
}

function toolError(message) {
  return toolResult({
    success: false,
    error: true,
    message: String(message || "Store policy search failed.")
  });
}

/**
 * Return the local policy digest from DB (or in-code default).
 */
export async function searchStorePolicies({ query = "", topic = null } = {}) {
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
        heading: "manishclothes store policy digest",
        body: digest,
        content_date: row?.contentDate || DEFAULT_STORE_POLICY_DIGEST.contentDate
      }
    ],
    contact: {
      store_url: "https://manishclothes.myshopify.com/",
      email: null,
      phone: null
    },
    instruction:
      "Shopify policy search returned no useful results (or this tool was called directly). " +
      "Answer ONLY from policy_digest. Do NOT invent policy details, shipping countries, return windows, or contact info. " +
      "This store is manishclothes (https://manishclothes.myshopify.com/). " +
      "No public email/phone is published — do not invent contact details. " +
      "If asked about shipping destinations, say cost and availability are shown at checkout."
  };
}

export function getStorePolicyTools() {
  return [
    {
      name: STORE_POLICY_TOOL_NAME,
      description:
        "Local manishclothes store policy digest from the database. " +
        "Prefer search_shop_policies_and_faqs first. Use this if Shopify returned nothing useful " +
        "(the server also auto-falls back here when Shopify is empty).",
      input_schema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Customer question or keywords"
          },
          topic: {
            type: "string",
            description: "Optional topic hint (ignored; full digest is returned)"
          }
        },
        required: ["query"]
      }
    }
  ];
}

export function isStorePolicyTool(toolName) {
  return toolName === STORE_POLICY_TOOL_NAME;
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
 * If Shopify policy search is empty/failed, return local DB digest.
 */
export async function withLocalPolicyFallback(shopifyResponse, toolArgs = {}, fallbackQuery = "") {
  if (!isEmptyShopifyPolicyResult(shopifyResponse)) {
    return shopifyResponse;
  }

  const query = policyQueryFromArgs(toolArgs, fallbackQuery);
  console.log("[store-policies] Shopify empty/error — DB digest fallback", { query });

  const local = await callStorePolicyTool(STORE_POLICY_TOOL_NAME, {
    query,
    topic: toolArgs.topic || null
  });

  try {
    const data = JSON.parse(local.content?.[0]?.text || "{}");
    data.source = "local_fallback";
    data.shopify_empty = true;
    data.instruction =
      (data.instruction ? `${data.instruction} ` : "") +
      "Shopify search_shop_policies_and_faqs returned no useful results; answer from this local policy digest.";
    local.content = [{ type: "text", text: JSON.stringify(data) }];
    local.structuredContent = data;
  } catch {
    // keep raw local response
  }

  return local;
}

/** @deprecated Pass-through — Shopify policy tool stays visible to the LLM. */
export function filterShopifyPolicyToolsForLlm(tools = []) {
  return tools;
}

export async function callStorePolicyTool(toolName, toolArgs = {}) {
  if (toolName !== STORE_POLICY_TOOL_NAME) {
    return toolError(`Unknown store policy tool: ${toolName}`);
  }

  try {
    return toolResult(await searchStorePolicies(toolArgs));
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
          heading: "manishclothes store policy digest",
          body: DEFAULT_STORE_POLICY_DIGEST.digest,
          content_date: DEFAULT_STORE_POLICY_DIGEST.contentDate
        }
      ],
      contact: {
        store_url: "https://manishclothes.myshopify.com/",
        email: null,
        phone: null
      },
      instruction:
        "Answer ONLY from policy_digest. Do NOT invent policy details. " +
        "This store is manishclothes. No public email/phone is published."
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
  searchStorePolicies
};
