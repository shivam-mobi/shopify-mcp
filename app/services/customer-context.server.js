/**
 * Customer name context for LLM welcome + ongoing session hints.
 */

import {
  getConversationCustomerProfile,
  setConversationCustomerProfile,
  claimConversationForCustomer,
  bindConversationShopper
} from "../db.server";
import {
  STANDARD_STORE_HELP_LINE,
  formatCompactGreeting
} from "./shopper-search-memory.server.js";

export function normalizeCustomerName(value) {
  const trimmed = String(value || "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function parseCustomerContextFromBody(body = {}) {
  const firstName = normalizeCustomerName(body.customer_first_name);
  const lastName = normalizeCustomerName(body.customer_last_name);
  const loggedIn = body.customer_logged_in === true;
  const shopifyCustomerId = String(
    body.customer_id || body.shopify_customer_id || ""
  ).trim();
  const shopDomain = String(body.shop || body.shop_domain || "")
    .trim()
    .toLowerCase();
  const anonymousShopperId = String(
    body.shopper_id || body.anonymous_shopper_id || ""
  ).trim();

  return {
    firstName,
    lastName,
    loggedIn: loggedIn || Boolean(shopifyCustomerId),
    hasName: Boolean(firstName || lastName),
    shopifyCustomerId: shopifyCustomerId || null,
    shopDomain: shopDomain || null,
    anonymousShopperId: anonymousShopperId || null
  };
}

export async function syncCustomerContextFromRequest(conversationId, body = {}) {
  const incoming = parseCustomerContextFromBody(body);
  if (!conversationId) {
    return incoming;
  }

  const existing = await getConversationCustomerProfile(conversationId);
  const merged = {
    firstName: incoming.firstName || existing?.firstName || null,
    lastName: incoming.lastName || existing?.lastName || null,
    loggedIn: incoming.loggedIn || existing?.loggedIn || false,
    shopifyCustomerId:
      incoming.shopifyCustomerId || existing?.shopifyCustomerId || null,
    shopDomain: incoming.shopDomain || existing?.shopDomain || null
  };

  const shouldPersist =
    incoming.loggedIn ||
    incoming.hasName ||
    Boolean(incoming.shopifyCustomerId) ||
    (existing &&
      (merged.firstName !== existing.firstName ||
        merged.lastName !== existing.lastName ||
        merged.loggedIn !== existing.loggedIn ||
        merged.shopifyCustomerId !== existing.shopifyCustomerId ||
        merged.shopDomain !== existing.shopDomain));

  if (
    shouldPersist &&
    (merged.firstName ||
      merged.lastName ||
      merged.loggedIn ||
      merged.shopifyCustomerId)
  ) {
    await setConversationCustomerProfile(conversationId, {
      ...merged,
      anonymousShopperId: incoming.anonymousShopperId
    });
  }

  // Guest session → login: attach this conversation to the customer
  if (incoming.shopifyCustomerId) {
    await claimConversationForCustomer(conversationId, {
      shopifyCustomerId: incoming.shopifyCustomerId,
      shopDomain: incoming.shopDomain,
      firstName: merged.firstName,
      lastName: merged.lastName
    });
  }

  // Shared cart/checkout/address across conversations for this shopper.
  // Failures are non-fatal — conversation-local cart still works.
  try {
    await bindConversationShopper(conversationId, {
      shopifyCustomerId: merged.shopifyCustomerId || incoming.shopifyCustomerId,
      anonymousShopperId: incoming.anonymousShopperId,
      firstName: merged.firstName,
      lastName: merged.lastName,
      loggedIn: merged.loggedIn
    });
  } catch (error) {
    console.warn(
      "[shopper-cart] bind from request failed:",
      error?.message || error
    );
  }

  return merged;
}

export function buildCustomerDisplayName({ firstName, lastName } = {}) {
  const first = normalizeCustomerName(firstName);
  const last = normalizeCustomerName(lastName);

  if (first && last) return `${first} ${last}`;
  return first || last || null;
}

export function buildCustomerContextHintMessage(
  profile = {},
  { hasPastSearches = false } = {}
) {
  const firstName = normalizeCustomerName(profile.firstName);
  const lastName = normalizeCustomerName(profile.lastName);
  const loggedIn = Boolean(profile.loggedIn);

  const parts = [];
  if (loggedIn) {
    parts.push("The customer is logged into their Shopify account.");
  } else {
    parts.push("The customer is a guest (not logged into Shopify).");
  }
  if (firstName) {
    parts.push(`Customer first name: ${firstName}.`);
  }
  if (lastName) {
    parts.push(`Customer last name: ${lastName}.`);
  }
  if (!firstName && !lastName && loggedIn) {
    parts.push("Their profile has no first or last name on file.");
  }

  const greetingScope =
    `For hi/hello greetings, reply in exactly ONE short sentence covering: ${STANDARD_STORE_HELP_LINE} ` +
    `Example with name: "${formatCompactGreeting("Alex")}". Example without name: "${formatCompactGreeting()}". ` +
    "No second sentence. No questions like \"How can I help/assist you?\". " +
    "Do NOT mention past searches on a plain greeting. ";

  parts.push(
    "Use their first name naturally when you know it — briefly, not as the whole greeting. " +
      "If only last name is known, you may use it politely. " +
      "If no name is known, skip the name. " +
      greetingScope +
      "Do NOT say \"AI-powered shopping assistant\" — the chat UI already shows that. " +
      "Never say \"vehicle parts\" or long generic lines like \"How can I assist you today\". " +
      "Do not ask for their name at welcome unless needed for shipping or orders."
  );

  if (loggedIn) {
    parts.push(
      "Saved shipping addresses: available via get_customer_addresses. " +
        "Call that tool ONLY when they clearly ask about addresses (saved/shipping/my/default address, use my address for checkout). " +
        "NEVER call it for \"show the products\", filters, fresheners, cart, or other product lists — those are not address requests. " +
        "If unclear (e.g. just \"show\"), ask what they want; do not guess addresses. " +
        "A select dropdown appears in the UI after a valid address call — reply in one short sentence only. Do not invent addresses."
    );
  } else {
    parts.push(
      "Cart and checkout work for guests — login is NOT required. " +
        "When they ask to show cart / cart products / what's in my cart / checkout, ALWAYS call get_my_cart (or the matching cart tool) and answer from that result. " +
        "NEVER say you cannot show the cart because they are not logged in. " +
        "Saved shipping addresses: NOT available for guests (get_customer_addresses is not in your tools). " +
        "If they ask to show or use saved addresses, reply in 1-2 short friendly sentences: " +
        "saved addresses are available after they sign in; they can type a new shipping address here in chat, or sign in to their account to use saved ones. " +
        "Do NOT say only \"I'm unable to show stored addresses\". Do NOT invent a select UI or fake addresses. " +
        "Do NOT mix up cart requests with saved-address requests."
    );
  }

  return {
    role: "system",
    content: parts.join(" ")
  };
}

export function buildWelcomePromptMessages(
  profile = {},
  { welcomeTemplate, searchMemoryLines = [] } = {}
) {
  const firstName = normalizeCustomerName(profile.firstName);
  const lastName = normalizeCustomerName(profile.lastName);
  const loggedIn = Boolean(profile.loggedIn);
  const template = String(welcomeTemplate || "").trim();

  const customerLines = [];
  if (loggedIn) {
    customerLines.push("The customer is logged into their Shopify account.");
  }
  if (firstName) {
    customerLines.push(`First name: ${firstName}`);
  }
  if (lastName) {
    customerLines.push(`Last name: ${lastName}`);
  }
  if (loggedIn && !firstName && !lastName) {
    customerLines.push("No first or last name is on their profile.");
  }
  if (!loggedIn && !firstName && !lastName) {
    customerLines.push("Guest customer — no name is known.");
  }

  const instruction =
    "Generate the opening welcome message for a NEW chat session. " +
    "Reply with exactly ONE short sentence (no second sentence). " +
    `Must include all of: ${STANDARD_STORE_HELP_LINE} ` +
    `With first name: "${formatCompactGreeting("Alex")}". Without name: "${formatCompactGreeting()}". ` +
    "Do NOT mention past searches. " +
    "Do NOT say \"AI-powered shopping assistant\" — the chat UI already shows that. " +
    "Never output 'Hi !'. " +
    "Forbidden: \"How can I help/assist you\", \"What can I do for you\", \"vehicle parts\", or extra filler. " +
    "Do not call any tools." +
    (template
      ? ` Merchant welcome style hint (adapt, do not copy verbatim): ${template}`
      : "");

  return [
    {
      role: "system",
      content: instruction
    },
    {
      role: "system",
      content: customerLines.join(" ")
    },
    {
      role: "user",
      content: "Start the chat with your welcome message."
    }
  ];
}

export function getFallbackWelcomeMessage(profile = {}) {
  const firstName = normalizeCustomerName(profile.firstName);
  return formatCompactGreeting(firstName);
}

const GREETING_PATTERN = /^(hi|hello|hey|howdy|good\s+(morning|afternoon|evening)|what'?s\s+up|yo)[!.?\s]*$/i;

export function isSimpleGreeting(userMessage = "") {
  return GREETING_PATTERN.test(String(userMessage || "").trim());
}

export function buildGreetingHintMessage(
  userMessage,
  profile = {},
  { pastSearchOffers = null, recentSearchSnippet = null } = {}
) {
  if (!isSimpleGreeting(userMessage)) {
    return null;
  }

  const firstName = normalizeCustomerName(profile.firstName);
  const example = formatCompactGreeting(firstName);

  return {
    role: "system",
    content:
      "The customer sent a simple greeting. " +
      "Reply with exactly ONE short sentence — no second sentence, no closing question. " +
      (firstName
        ? `Use their first name. Match this shape: "${example}". `
        : `No name — match this shape: "${example}". `) +
      `Must include: ${STANDARD_STORE_HELP_LINE} ` +
      "Do NOT mention past searches. " +
      "Do NOT say \"AI-powered shopping assistant\". " +
      "Forbidden: \"How can I help/assist you\", \"What can I do for you\", \"vehicle parts\". " +
      "Do not call tools."
  };
}

export function extractAssistantText(message) {
  if (!message?.content) return "";
  if (typeof message.content === "string") {
    return message.content.trim();
  }
  if (Array.isArray(message.content)) {
    return message.content
      .filter((block) => block?.type === "text" && block.text)
      .map((block) => block.text)
      .join("")
      .trim();
  }
  return "";
}

export default {
  normalizeCustomerName,
  parseCustomerContextFromBody,
  syncCustomerContextFromRequest,
  buildCustomerDisplayName,
  buildCustomerContextHintMessage,
  buildWelcomePromptMessages,
  getFallbackWelcomeMessage,
  isSimpleGreeting,
  buildGreetingHintMessage,
  extractAssistantText
};
