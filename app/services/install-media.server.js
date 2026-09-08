/**
 * When the customer asks how to install a product, prefer that product's
 * PDF / YouTube metafields over generic policy FAQ answers.
 */

const INSTALL_HELP_PATTERN =
  /\b(install(?:ation)?|how\s+(?:do|can|to)\s+(?:i\s+)?(?:install|fit)|instruction(?:s)?(?:\s+(?:manual|guide))?|install(?:ation)?\s+(?:video|pdf|guide|manual)|how\s+to\s+(?:put|place)\s+(?:it|this|the\s+filter)\s+in|assembly\s+guide)\b/i;

export function isInstallHelpQuestion(userMessage = "") {
  return INSTALL_HELP_PATTERN.test(String(userMessage || "").trim());
}

function parseMessageContent(raw) {
  if (raw == null) return "";
  if (typeof raw !== "string") return raw;
  const trimmed = raw.trim();
  if (!trimmed) return raw;
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return raw;
  try {
    return JSON.parse(trimmed);
  } catch {
    return raw;
  }
}

function normalizeInstallProduct(product = {}) {
  const pdfUrl = String(product.pdfUrl || product.pdf_url || "").trim() || null;
  const youtubeUrl = String(product.youtubeUrl || product.youtube_url || "").trim() || null;
  if (!pdfUrl && !youtubeUrl) return null;

  return {
    id: product.id || product.variantId || product.variant_id || null,
    title: String(product.title || "Product").trim() || "Product",
    pdfTitle: String(product.pdfTitle || product.pdf_title || "").trim() || "Installation Guide (PDF)",
    pdfUrl,
    youtubeUrl,
    isBest: product.isBest === true
  };
}

/**
 * Prefer the most recent product carousel that includes install media.
 */
export function extractInstallMediaFromMessages(messages = []) {
  if (!Array.isArray(messages) || messages.length === 0) return [];

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const content = parseMessageContent(messages[i]?.content);
    if (!Array.isArray(content)) continue;

    const products = [];
    for (const block of content) {
      if (block?.type !== "product_results" || !Array.isArray(block.products)) continue;
      for (const product of block.products) {
        const normalized = normalizeInstallProduct(product);
        if (normalized) products.push(normalized);
      }
    }

    if (products.length > 0) {
      // Best pick first, then keep carousel order
      return products.sort((a, b) => Number(b.isBest) - Number(a.isBest));
    }
  }

  return [];
}

export function buildInstallMediaHintMessage(userMessage, installProducts = []) {
  if (!isInstallHelpQuestion(userMessage)) return null;

  const products = Array.isArray(installProducts) ? installProducts : [];
  if (products.length === 0) {
    return {
      role: "system",
      content:
        "The customer asked about product installation. " +
        "No installation PDF or video is on file for the recent products in this chat. " +
        "You may call search_shop_policies_and_faqs for general install guidance, " +
        "and share support@pureflowair.com / 866-206-4492 if needed. " +
        "Do not invent PDF or video links."
    };
  }

  const lines = products.map((product, index) => {
    const bits = [`${index + 1}. ${product.title}`];
    if (product.pdfUrl) bits.push(`PDF (${product.pdfTitle}): ${product.pdfUrl}`);
    if (product.youtubeUrl) bits.push(`Video: ${product.youtubeUrl}`);
    return bits.join(" — ");
  });

  return {
    role: "system",
    content:
      "The customer asked how to install a product. " +
      "Installation resources already exist for recent products in this chat. " +
      "CRITICAL: Share these install links in your reply as markdown " +
      "([Installation Guide (PDF)](url) / [Installation Video](url)). " +
      "Prefer the Best pick / the product they mean by \"this\". " +
      "Do NOT call search_shop_policies_and_faqs for generic packaging advice when these links exist. " +
      "Do NOT say only \"check the packaging\" when a PDF or video URL is listed below.\n" +
      lines.join("\n")
  };
}

export default {
  isInstallHelpQuestion,
  extractInstallMediaFromMessages,
  buildInstallMediaHintMessage
};
