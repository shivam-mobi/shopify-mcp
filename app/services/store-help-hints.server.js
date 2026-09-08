/**
 * Inject LLM hints for store FAQ / product-care questions so the model
 * calls Shopify search_shop_policies_and_faqs first (local search_store_policies is server fallback).
 */

const STORE_HELP_PATTERN =
  /\b(return|refund|exchange|warranty|shipping|delivery|privacy|policy|policies|terms of service|faq|faqs|merv|hepa|sds|safety data|cabin air filter|furnace filter|home filter|how often|replace my|replacement interval|difference between|standard filter|charcoal filter|activated carbon|air freshener|contact|phone number|support email|accessibility|cancel(?:lation)?|payment method|why pureflow)\b/i;

const INSTALL_ONLY_PATTERN =
  /\b(install(?:ation)?|how\s+(?:do|can|to)\s+(?:i\s+)?(?:install|fit)|instruction(?:s)?(?:\s+(?:manual|guide))?|install(?:ation)?\s+(?:video|pdf|guide|manual))\b/i;

export function isStoreHelpQuestion(userMessage = "") {
  const text = String(userMessage || "").trim();
  // Install questions are handled by install-media hints (product PDF/video first).
  if (INSTALL_ONLY_PATTERN.test(text) && !STORE_HELP_PATTERN.test(text)) {
    return false;
  }
  return STORE_HELP_PATTERN.test(text);
}

export function buildStoreHelpHintMessage(userMessage) {
  if (!isStoreHelpQuestion(userMessage)) {
    return null;
  }

  return {
    role: "system",
    content:
      "The customer's message is a store FAQ or product-care question. " +
      "You MUST call search_shop_policies_and_faqs FIRST with their question as the query. " +
      "If that tool returns nothing useful, call search_store_policies with the same question " +
      "(the server may also auto-fill local policy content when Shopify is empty). " +
      "Do NOT answer from general knowledge without calling a policy tool. " +
      "If they also ask about installing a product and install PDF/video URLs were provided in another system message, share those links too."
  };
}

export default {
  isStoreHelpQuestion,
  buildStoreHelpHintMessage
};
