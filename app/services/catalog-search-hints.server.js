/**
 * Hint the LLM to use search_store_products for home filters / fresheners
 * (not fitment, not raw search_catalog).
 */

const HOME_OR_FRESHENER_PATTERN =
  /\b(home\s*(furnace\s*)?(air\s*)?filter|furnace\s*filter|merv|\d{1,2}\s*[x×]\s*\d{1,2}(\s*[x×]\s*\d{1,2})?|air\s*freshener|fresheners?|scent|lavender|vanilla\s*orchid|new\s*car|black\s*rock|tropical\s*peach|fresh\s*linen|width|height|length|depth|thickness)\b/i;

const VEHICLE_PATTERN =
  /\b(vin|cabin\s*air|fits?\s+my\s+(car|truck|vehicle)|year\/make\/model|\b(19|20)\d{2}\b.{0,20}\b(honda|toyota|ford|chevy|chevrolet|bmw|audi|nissan|hyundai|kia|mazda|subaru|jeep|dodge|ram|gmc|volkswagen|vw|mercedes)\b)\b/i;

export function isHomeOrFreshenerBrowseQuestion(userMessage = "") {
  const text = String(userMessage || "").trim();
  if (!text) return false;
  if (VEHICLE_PATTERN.test(text) && !/\b(home|furnace|freshener|scent|merv|width|height|length|thickness|depth)\b/i.test(text)) {
    return false;
  }
  return HOME_OR_FRESHENER_PATTERN.test(text);
}

export function buildCatalogSearchHintMessage(userMessage) {
  if (!isHomeOrFreshenerBrowseQuestion(userMessage)) return null;

  const text = String(userMessage || "").toLowerCase();
  const category = /\b(freshener|fresheners|scent|lavender|vanilla|linen|peach)\b/.test(text)
    ? "freshener"
    : /\b(home|furnace|merv|width|height|length|depth|thickness|\d+\s*[x×]\s*\d+)/.test(text)
      ? "home_filter"
      : null;

  const isLengthFollowUp = /\b(length|height|width|thickness|depth)\b/.test(text);

  return {
    role: "system",
    content:
      "The customer wants home furnace filters or car air fresheners (not vehicle cabin-filter fitment). " +
      "You MUST call search_store_products " +
      (category
        ? `with category=\"${category}\"` +
          (category === "home_filter"
            ? ". BEFORE calling, build query from what the customer gave — do NOT invent a missing depth. " +
              "If they say 20x20 or 20x10, pass query exactly \"20x20\" or \"20x10\" (WidthxHeight only). " +
              "Only add a third number (Depth) when they gave thickness/depth or a full WxHxD like 20x25x1. " +
              "FORBIDDEN: defaulting depth to 1 (never turn 20x20 into 20x20x1 unless they said x1 / thickness 1). " +
              "Mapping when they use words: length→Height (2nd), thickness→Depth (3rd), width→Width (1st), height→Height (2nd). " +
              "Example: prior size 24x10x1 + \"length is 30\" → query \"24x30x1\". " +
              "If they only change one dimension, keep other known dimensions from this chat. " +
              "Pass MERV only if 8, 11, or 13."
            : " and put any scent name in query.")
        : "with category=\"home_filter\" or category=\"freshener\" (ask which if unclear).") +
      (isLengthFollowUp && category === "home_filter"
        ? " Reminder: length is NEVER the first number in the size query."
        : "") +
      " Do NOT call search_catalog. Do NOT call get_fitment_next_step unless they clearly need a cabin filter for a vehicle."
  };
}

export default {
  isHomeOrFreshenerBrowseQuestion,
  buildCatalogSearchHintMessage
};
