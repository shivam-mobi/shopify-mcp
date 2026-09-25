/**
 * Short, direct customer replies for vehicle cabin fitment flows.
 */

const CABIN_FITMENT_USER_PATTERN =
  /\b(cabin\s*air\s*filter|cabin\s*filter|filter\s+for\s+my\s+(car|truck|vehicle)|fits?\s+my\s+(car|truck|vehicle)|vehicle\s+filter|what\s+filter\s+fits)\b/i;

const HAS_YMM_PATTERN =
  /\b(19|20)\d{2}\b|\b(vin|year|make|model)\b/i;

const FITMENT_NEED_STATUSES = new Set([
  "need_filters",
  "need_year",
  "need_make",
  "need_model",
  "need_engine",
  "need_qualifier"
]);

const FITMENT_REPLY_RULE =
  "Reply in ONE short sentence only (about 8–18 words). No preamble, no 'I can help', no 'this will help me find'. Do not explain why you need the info — just ask.";

export function isCabinFitmentUserMessage(userMessage = "") {
  const text = String(userMessage || "").trim();
  if (!text) return false;
  if (!CABIN_FITMENT_USER_PATTERN.test(text)) return false;
  if (/\b(home|furnace|merv|\d{1,2}\s*[x×]\s*\d{1,2})\b/i.test(text)) return false;
  return true;
}

export function buildCabinFitmentHintMessage(userMessage = "") {
  if (!isCabinFitmentUserMessage(userMessage)) return null;
  if (HAS_YMM_PATTERN.test(userMessage)) return null;

  return {
    role: "system",
    content:
      "The customer wants a vehicle cabin air filter. " +
      "If SAVED SHOPPER SEARCHES includes a cabin vehicle and they did not give a new year or vehicle, " +
      "suggest continuing with that saved vehicle in one sentence. Do NOT call get_fitment_next_step and do NOT ask year, make, and model until they decline or give a different vehicle. " +
      "Only when there is no saved cabin search: call get_fitment_next_step first. " +
      FITMENT_REPLY_RULE +
      ' Then you may ask: "What year, make, and model is your vehicle?"'
  };
}

function buildShortQuestionFromAsk(ask = [], known = {}) {
  const fields = Array.isArray(ask) ? ask.filter(Boolean) : [];
  if (!fields.length) return null;

  const make = known.make ? String(known.make).trim() : "";
  const model = known.model ? String(known.model).trim() : "";

  if (fields.includes("year") && fields.includes("make") && fields.includes("model")) {
    return "What year, make, and model is your vehicle?";
  }
  if (fields.includes("year") && fields.includes("model") && make) {
    return `What year and model is your ${make}?`;
  }
  if (fields.includes("year") && fields.includes("make") && !fields.includes("model")) {
    return "What year and make is your vehicle?";
  }
  if (fields.length === 1 && fields[0] === "year") {
    if (make && model) return `What year is your ${make} ${model}?`;
    return "What year is your vehicle?";
  }
  if (fields.length === 1 && fields[0] === "make") {
    return "What make (brand) is your vehicle?";
  }
  if (fields.length === 1 && fields[0] === "model") {
    if (make) return `What model is your ${make}?`;
    return "What model is your vehicle?";
  }

  const joined = fields.join(", ");
  return `What is your vehicle ${joined}?`;
}

/**
 * Add ui_instruction to fitment tool JSON for need_* statuses.
 */
export function enrichFitmentToolPayloadForLlm(data) {
  if (!data || typeof data !== "object") return data;
  const status = String(data.status || "");
  if (!FITMENT_NEED_STATUSES.has(status)) return data;

  const ask = Array.isArray(data.ask) ? data.ask : [];
  const known = data.known && typeof data.known === "object" ? data.known : {};
  const example = buildShortQuestionFromAsk(ask, known);

  let extra = "";
  if (status === "need_engine" || status === "need_qualifier") {
    extra =
      " Engine/qualifier buttons are in the UI — one short sentence asking them to pick one; do not list options in text.";
  }

  const ui_instruction =
    FITMENT_REPLY_RULE +
    extra +
    (example ? ` Use this wording or very close: "${example}"` : "");

  return { ...data, ui_instruction, suggested_customer_question: example || undefined };
}

export function buildFitmentToolHistoryContent(toolUseResponse) {
  let data = null;
  const text = toolUseResponse?.content?.[0]?.text;
  if (toolUseResponse?.structuredContent) {
    data = toolUseResponse.structuredContent;
  } else if (typeof text === "string") {
    try {
      data = JSON.parse(text);
    } catch {
      return toolUseResponse?.content;
    }
  } else if (typeof text === "object") {
    data = text;
  }

  const enriched = enrichFitmentToolPayloadForLlm(data);
  if (!enriched || enriched === data) return toolUseResponse?.content;

  return [{ type: "text", text: JSON.stringify(enriched) }];
}

export default {
  isCabinFitmentUserMessage,
  buildCabinFitmentHintMessage,
  enrichFitmentToolPayloadForLlm,
  buildFitmentToolHistoryContent
};
