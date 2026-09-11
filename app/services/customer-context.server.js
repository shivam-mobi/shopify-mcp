/**
 * Customer name context for LLM welcome + ongoing session hints.
 */

import {
  getConversationCustomerProfile,
  setConversationCustomerProfile,
  claimConversationForCustomer,
  bindConversationShopper
} from "../db.server";

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

export function buildCustomerContextHintMessage(profile = {}) {
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

  parts.push(
    "Use their first name naturally when you know it — briefly, not as the whole greeting. " +
      "If only last name is known, you may use it politely. " +
      "If no name is known, skip the name. " +
      "For hi/hello greetings, briefly offer help finding products, checking the cart, and answering store questions. " +
      "Do NOT say \"AI-powered shopping assistant\" — the chat UI already shows that. " +
      "Never use long generic lines like \"How can I assist you today\". " +
      "Do not ask for their name at welcome unless needed for shipping or orders."
  );

  if (loggedIn) {
    parts.push(
      "Saved shipping addresses: available via get_customer_addresses. " +
        "Call that tool ONLY when they clearly ask about addresses (saved/shipping/my/default address, use my address for checkout). " +
        "NEVER call it for \"show the products\" or other product lists — those are not address requests. " +
        "If unclear (e.g. just \"show\"), ask what they want; do not guess addresses. " +
        "A select dropdown appears in the UI after a valid address call — reply in one short sentence only. Do not invent addresses."
    );
  } else {
    parts.push(
      "Cart and checkout: available for guests — no sign-in required. " +
        "When they ask what is in the cart / show cart / checkout, ALWAYS call get_my_cart. " +
        "NEVER say the cart requires login or that they must sign in to view cart. " +
        "Saved shipping addresses: NOT available for guests (get_customer_addresses is not in your tools). " +
        "If they ask to show or use saved addresses, reply in 1-2 short friendly sentences: " +
        "saved addresses are available after they sign in; they can type a new shipping address here in chat, or sign in to their account to use saved ones. " +
        "Do NOT confuse cart with saved addresses. Do NOT say only \"I'm unable to show stored addresses\". Do NOT invent a select UI or fake addresses."
    );
  }

  return {
    role: "system",
    content: parts.join(" ")
  };
}

export function buildWelcomePromptMessages(profile = {}, { welcomeTemplate } = {}) {
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
    "Reply with 1-2 short sentences only. " +
    "Say you can help find products, add them to the cart, and answer store questions. " +
    "Do NOT say \"AI-powered shopping assistant\" or \"I'm your AI-powered shopping assistant\" — the chat UI already shows that. " +
    "If first name is known, you may start with a brief Hi {firstName}! — then the help line. " +
    "If no name is known, skip the name — never output 'Hi !'. " +
    "Do NOT use phrases like 'How can I assist you today' or long generic offers. " +
    "Do not call any tools. Do not ask a long list of questions." +
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

  if (firstName) {
    return `Hi ${firstName}! I can help you find products, add them to your cart, and answer store questions.`;
  }
  return "I can help you find products, add them to your cart, and answer store questions. What are you looking for?";
}

const GREETING_PATTERN = /^(hi|hello|hey|howdy|good\s+(morning|afternoon|evening)|what'?s\s+up|yo)[!.?\s]*$/i;

export function isSimpleGreeting(userMessage = "") {
  return GREETING_PATTERN.test(String(userMessage || "").trim());
}

export function buildGreetingHintMessage(userMessage, profile = {}) {
  if (!isSimpleGreeting(userMessage)) {
    return null;
  }

  const firstName = normalizeCustomerName(profile.firstName);
  const nameHint = firstName
    ? `You may start with "Hi ${firstName}!" then the assistant line. `
    : "Do not invent or ask for a name. ";

  return {
    role: "system",
    content:
      "The customer sent a simple greeting. Reply in 1-2 short sentences only. " +
      nameHint +
      "Mention you help find products, manage the cart, and answer store questions. " +
      "Do NOT say \"AI-powered shopping assistant\" or \"I'm your AI-powered shopping assistant\" — the chat UI already shows that. " +
      "Do NOT say 'How can I assist you today' or other long generic support lines. " +
      "Do not call tools for a plain greeting."
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
