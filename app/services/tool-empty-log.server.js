/**
 * Detect empty / failed tool results and persist ToolEmptyResultLog rows.
 */
import { storeToolEmptyResultLog } from "../db.server.js";
import { isEmptyShopifyPolicyResult, isShopifyPolicyTool } from "./store-policies.server.js";

function extractText(response) {
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

/**
 * @returns {"error"|"empty"|"no_results"|null} null = has useful data
 */
export function classifyEmptyToolResult(toolName, response) {
  if (!response) return "empty";

  if (response.error === true || (response.error && typeof response.error === "object")) {
    return "error";
  }

  if (isShopifyPolicyTool(toolName) && isEmptyShopifyPolicyResult(response)) {
    return "empty";
  }

  const text = extractText(response);
  if (!text) return "empty";

  try {
    const data = JSON.parse(text);
    if (Array.isArray(data) && data.length === 0) return "empty";
    if (data && typeof data === "object") {
      if (data.found === false) return "no_results";
      if (data.success === false && (data.error || data.message)) return "error";
      if (data.status === "not_found") return "no_results";
      for (const key of ["faqs", "results", "policies", "items", "products", "answers", "documents"]) {
        if (Array.isArray(data[key]) && data[key].length === 0) return "empty";
      }
    }
  } catch {
    // plain text
  }

  const lower = text.toLowerCase();
  if (
    /no (relevant |matching )?(results?|faqs?|policies|information|matches)|not found|couldn'?t find|unable to find/.test(
      lower
    )
  ) {
    return "no_results";
  }

  return null;
}

/**
 * Fire-and-forget log when a tool returned no useful data.
 * Skips local_fallback / digest responses (those are successful fills).
 */
export async function logEmptyToolResultIfNeeded({
  conversationId = null,
  shop = null,
  userQuery = "",
  toolName,
  toolArgs = null,
  response = null
} = {}) {
  // Don't treat successful local digest fallback as a miss for search_store_policies
  const text = extractText(response);
  if (
    text.includes('"source":"local_fallback"') ||
    text.includes('"source":"store_policy_digest_db"') ||
    text.includes('"source":"in_code_default"')
  ) {
    return null;
  }

  const reason = classifyEmptyToolResult(toolName, response);
  if (!reason) return null;

  return storeToolEmptyResultLog({
    conversationId,
    shop,
    userQuery,
    toolName,
    toolArgs,
    response,
    reason
  });
}

export default {
  classifyEmptyToolResult,
  logEmptyToolResultIfNeeded
};
