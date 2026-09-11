/**
 * Inject LLM hints for store FAQ / product-care questions so the model
 * calls Shopify search_shop_policies_and_faqs first (local search_store_policies is server fallback).
 */

const STORE_HELP_PATTERN =
  /\b(return|refund|exchange|warranty|shipping|ship(?:s|ping)?\s+to|deliver(?:y|ies|ing)?|countries?|country|international|domestic|privacy|policy|policies|terms of service|faq|faqs|contact|phone number|support email|accessibility|cancel(?:lation)?|payment method|install(?:ation)?|instruction(?:s)?)\b/i;

export function isStoreHelpQuestion(userMessage = "") {
  return STORE_HELP_PATTERN.test(String(userMessage || "").trim());
}

export function buildStoreHelpHintMessage(userMessage) {
  if (!isStoreHelpQuestion(userMessage)) {
    return null;
  }

  return {
    role: "system",
    content:
      "The customer's message is a store FAQ or product-care question " +
      "(including shipping destinations, deliver-to country, returns, privacy, warranty, etc.). " +
      "You MUST call search_shop_policies_and_faqs NOW with their current question as the query " +
      "(example queries: shipping countries, deliver to India, shipping policy). " +
      "CRITICAL: Call the tool on EVERY such question — including follow-ups like " +
      "\"do you deliver to India?\" or \"what about Canada?\". " +
      "Do NOT answer from memory, prior chat turns, or earlier tool results without calling the tool again. " +
      "If that tool returns nothing useful, call search_store_policies with the same question " +
      "(the server may also auto-fill local policy content when Shopify is empty). " +
      "Do NOT invent countries, shipping rules, or policy details."
  };
}

export default {
  isStoreHelpQuestion,
  buildStoreHelpHintMessage
};
