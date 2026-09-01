/**
 * Home furnace filter size helpers for browse_products_by_type Admin API search.
 */

const HOME_FILTER_SIZE_PATTERN =
  /\b(\d{1,2})\s*x\s*(\d{1,2})(?:\s*x\s*(\d{1,2}))?\b/i;

const HOME_FILTER_INTENT_PATTERN =
  /\b(home|furnace|hvac|merv)\b.*\bfilter\b|\bhome filter\b|\bfurnace filter\b/i;

const HOME_FILTER_CONFIRMATION_PATTERN =
  /\b(yes|yeah|yep|sure|ok|okay|proceed|correct|home filter|furnace filter)\b/i;

const HOME_FURNACE_PRODUCT_TYPE = "Home Furnace Air Filter";

/**
 * Parse filter dimensions like 10x10 or 16x25x1 from text.
 */
export function parseHomeFilterSize(text = "") {
  const match = String(text || "").match(HOME_FILTER_SIZE_PATTERN);
  if (!match) {
    return null;
  }

  return [match[1], match[2], match[3]].filter(Boolean).join("x");
}

function extractTextFromMessageContent(content) {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join(" ");
}

/**
 * Collect recent user message text (newest first).
 */
export function collectRecentUserTexts(messages = [], { maxMessages = 8 } = {}) {
  const texts = [];

  for (let index = messages.length - 1; index >= 0 && texts.length < maxMessages; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") {
      continue;
    }

    const text = extractTextFromMessageContent(message.content).trim();
    if (text) {
      texts.push(text);
    }
  }

  return texts;
}

/**
 * Find the most recent home filter size in conversation history + current message.
 */
export function extractHomeFilterSizeFromConversation(
  messages = [],
  { currentUserMessage = "" } = {}
) {
  const texts = [
    String(currentUserMessage || "").trim(),
    ...collectRecentUserTexts(messages)
  ].filter(Boolean);

  for (const text of texts) {
    const size = parseHomeFilterSize(text);
    if (size) {
      return size;
    }
  }

  return null;
}

export function isHomeFilterIntent(text = "") {
  return HOME_FILTER_INTENT_PATTERN.test(String(text || ""));
}

export function isHomeFurnaceProductType(productType = "") {
  return /home furnace air filter/i.test(String(productType || ""));
}

/**
 * Whether the conversation includes a sized home filter request.
 */
export function isSizedHomeFilterSearchRequest(
  messages = [],
  { currentUserMessage = "" } = {}
) {
  const size = extractHomeFilterSizeFromConversation(messages, { currentUserMessage });
  if (!size) {
    return false;
  }

  const combinedText = [
    currentUserMessage,
    ...collectRecentUserTexts(messages)
  ].join(" ");

  if (parseHomeFilterSize(currentUserMessage)) {
    return true;
  }

  if (isHomeFilterIntent(combinedText)) {
    return true;
  }

  if (HOME_FILTER_CONFIRMATION_PATTERN.test(String(currentUserMessage || ""))) {
    return true;
  }

  return false;
}

function resolveBrowseSearchTerm(toolArgs = {}) {
  const explicit = String(toolArgs.search || toolArgs.size || "").trim();
  return explicit || null;
}

/**
 * Inject search/size from conversation when browse_products_by_type omits it.
 */
export function enrichBrowseArgsWithHomeFilterSize(
  toolArgs = {},
  messages = [],
  { currentUserMessage = "" } = {}
) {
  const nextArgs = { ...toolArgs };
  const existingSearch = resolveBrowseSearchTerm(nextArgs);

  if (existingSearch) {
    nextArgs.search = existingSearch;
    return nextArgs;
  }

  const productType = String(nextArgs.product_type || "").trim();
  const category = String(nextArgs.category || "").trim();
  const targetsHomeFilter =
    isHomeFurnaceProductType(productType) ||
    isHomeFilterIntent(category) ||
    isHomeFilterIntent(currentUserMessage) ||
    isSizedHomeFilterSearchRequest(messages, { currentUserMessage });

  if (!targetsHomeFilter) {
    return nextArgs;
  }

  const size = extractHomeFilterSizeFromConversation(messages, { currentUserMessage });
  if (!size) {
    return nextArgs;
  }

  if (!nextArgs.product_type && targetsHomeFilter) {
    nextArgs.product_type = HOME_FURNACE_PRODUCT_TYPE;
  }

  nextArgs.search = size;
  return nextArgs;
}

/**
 * Filter Admin API results to products whose title/SKU contains the size term.
 */
export function filterProductsBySearchTerm(products = [], search = "") {
  const searchTerm = String(search || "").trim();
  if (!searchTerm || !Array.isArray(products) || products.length === 0) {
    return products;
  }

  const normalizedSearch = searchTerm.toLowerCase().replace(/\s+/g, "");
  const filtered = products.filter((product) => {
    const haystack = `${product.title || ""} ${product.sku || ""}`
      .toLowerCase()
      .replace(/\s+/g, "");
    return haystack.includes(normalizedSearch);
  });

  return filtered.length > 0 ? filtered : products;
}

export function buildSizedHomeFilterBrowseHintMessage(
  messages = [],
  { currentUserMessage = "" } = {}
) {
  if (!isSizedHomeFilterSearchRequest(messages, { currentUserMessage })) {
    return null;
  }

  const size = extractHomeFilterSizeFromConversation(messages, { currentUserMessage });
  if (!size) {
    return null;
  }

  return {
    role: "system",
    content:
      `The customer wants a home furnace filter in size ${size}. ` +
      `Call browse_products_by_type with product_type: "${HOME_FURNACE_PRODUCT_TYPE}" ` +
      `and search: "${size}". Do NOT call search_catalog for this request.`
  };
}

export default {
  parseHomeFilterSize,
  collectRecentUserTexts,
  extractHomeFilterSizeFromConversation,
  isHomeFilterIntent,
  isHomeFurnaceProductType,
  isSizedHomeFilterSearchRequest,
  enrichBrowseArgsWithHomeFilterSize,
  filterProductsBySearchTerm,
  buildSizedHomeFilterBrowseHintMessage
};
