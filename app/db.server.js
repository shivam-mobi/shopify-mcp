import { PrismaClient } from "@prisma/client";

if (process.env.NODE_ENV !== "production") {
  if (!global.prismaGlobal) {
    global.prismaGlobal = new PrismaClient();
  }
}

const prisma = global.prismaGlobal ?? new PrismaClient();

export default prisma;

/**
 * Store a code verifier for PKCE authentication.
 * Upserts by state so retries replace the verifier that matches the latest auth URL.
 * @param {string} state - The state parameter used in OAuth flow
 * @param {string} verifier - The code verifier to store
 * @returns {Promise<Object>} - The saved code verifier object
 */
export async function storeCodeVerifier(state, verifier) {
  // Calculate expiration date (10 minutes from now)
  const expiresAt = new Date();
  expiresAt.setMinutes(expiresAt.getMinutes() + 10);

  try {
    return await prisma.codeVerifier.upsert({
      where: { state },
      create: {
        id: `cv_${Date.now()}`,
        state,
        verifier,
        expiresAt
      },
      update: {
        verifier,
        expiresAt
      }
    });
  } catch (error) {
    console.error('Error storing code verifier:', error);
    throw error;
  }
}

/**
 * Get a code verifier by state parameter
 * @param {string} state - The state parameter used in OAuth flow
 * @returns {Promise<Object|null>} - The code verifier object or null if not found
 */
export async function getCodeVerifier(state) {
  try {
    const verifier = await prisma.codeVerifier.findFirst({
      where: {
        state,
        expiresAt: {
          gt: new Date()
        }
      }
    });

    if (verifier) {
      // Delete it after retrieval to prevent reuse
      await prisma.codeVerifier.delete({
        where: {
          id: verifier.id
        }
      });
    }

    return verifier;
  } catch (error) {
    console.error('Error retrieving code verifier:', error);
    return null;
  }
}

/**
 * Store a customer access token in the database
 * @param {string} conversationId - The conversation ID to associate with the token
 * @param {string} accessToken - The access token to store
 * @param {Date} expiresAt - When the token expires
 * @returns {Promise<Object>} - The saved customer token
 */
export async function storeCustomerToken(conversationId, accessToken, expiresAt) {
  try {
    // Check if a token already exists for this conversation
    const existingToken = await prisma.customerToken.findFirst({
      where: { conversationId }
    });

    if (existingToken) {
      // Update existing token
      return await prisma.customerToken.update({
        where: { id: existingToken.id },
        data: {
          accessToken,
          expiresAt,
          updatedAt: new Date()
        }
      });
    }

    // Create a new token record
    return await prisma.customerToken.create({
      data: {
        id: `ct_${Date.now()}`,
        conversationId,
        accessToken,
        expiresAt,
        createdAt: new Date(),
        updatedAt: new Date()
      }
    });
  } catch (error) {
    console.error('Error storing customer token:', error);
    throw error;
  }
}

/**
 * Get a customer access token by conversation ID
 * @param {string} conversationId - The conversation ID
 * @returns {Promise<Object|null>} - The customer token or null if not found/expired
 */
export async function getCustomerToken(conversationId) {
  try {
    const token = await prisma.customerToken.findFirst({
      where: {
        conversationId,
        expiresAt: {
          gt: new Date() // Only return non-expired tokens
        }
      }
    });

    return token;
  } catch (error) {
    console.error('Error retrieving customer token:', error);
    return null;
  }
}

/**
 * Create or update a conversation in the database
 * @param {string} conversationId - The conversation ID
 * @returns {Promise<Object>} - The created or updated conversation
 */
export async function createOrUpdateConversation(conversationId) {
  try {
    const existingConversation = await prisma.conversation.findUnique({
      where: { id: conversationId }
    });

    if (existingConversation) {
      return await prisma.conversation.update({
        where: { id: conversationId },
        data: {
          updatedAt: new Date()
        }
      });
    }

    return await prisma.conversation.create({
      data: {
        id: conversationId
      }
    });
  } catch (error) {
    console.error('Error creating/updating conversation:', error);
    throw error;
  }
}

/**
 * Save a message to the database
 * @param {string} conversationId - The conversation ID
 * @param {string} role - The message role (user or assistant)
 * @param {string} content - The message content
 * @returns {Promise<Object>} - The saved message
 */
export async function saveMessage(conversationId, role, content) {
  try {
    // Ensure the conversation exists
    await createOrUpdateConversation(conversationId);

    // Create the message
    return await prisma.message.create({
      data: {
        conversationId,
        role,
        content
      }
    });
  } catch (error) {
    console.error('Error saving message:', error);
    throw error;
  }
}

/**
 * Get conversation history
 * @param {string} conversationId - The conversation ID
 * @returns {Promise<Array>} - Array of messages in the conversation
 */
export async function getConversationHistory(conversationId) {
  try {
    const messages = await prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'asc' }
    });

    return messages;
  } catch (error) {
    console.error('Error retrieving conversation history:', error);
    return [];
  }
}

/**
 * Get the active Shopify cart id for a conversation, if any.
 */
export async function getConversationCartId(conversationId) {
  if (!conversationId) {
    return null;
  }

  try {
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { activeCartId: true }
    });

    return conversation?.activeCartId || null;
  } catch (error) {
    console.error("Error retrieving conversation cart id:", error);
    return null;
  }
}

/**
 * Persist the active Shopify cart id for a conversation.
 */
export async function setConversationCartId(conversationId, cartId) {
  if (!conversationId || !cartId) {
    return null;
  }

  try {
    await createOrUpdateConversation(conversationId);
    return await prisma.conversation.update({
      where: { id: conversationId },
      data: { activeCartId: String(cartId) }
    });
  } catch (error) {
    console.error("Error storing conversation cart id:", error);
    return null;
  }
}

/**
 * Clear the active cart id when a cart is cancelled or expired.
 */
export async function clearConversationCartId(conversationId) {
  if (!conversationId) {
    return null;
  }

  try {
    return await prisma.conversation.update({
      where: { id: conversationId },
      data: { activeCartId: null }
    });
  } catch (error) {
    console.error("Error clearing conversation cart id:", error);
    return null;
  }
}

/**
 * Get last saved shipping destination for this conversation (JSON object or null).
 */
export async function getConversationShippingAddress(conversationId) {
  if (!conversationId) {
    return null;
  }

  try {
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { shippingAddress: true }
    });

    if (!conversation?.shippingAddress) {
      return null;
    }

    return JSON.parse(conversation.shippingAddress);
  } catch (error) {
    console.error("Error retrieving conversation shipping address:", error);
    return null;
  }
}

/**
 * Persist shipping destination so cart changes can re-apply it on a new checkout.
 */
export async function setConversationShippingAddress(conversationId, address) {
  if (!conversationId || !address) {
    return null;
  }

  try {
    await createOrUpdateConversation(conversationId);
    const data = { shippingAddress: JSON.stringify(address) };
    const firstName = String(address.first_name || "").trim();
    const lastName = String(address.last_name || "").trim();
    if (firstName) data.customerFirstName = firstName;
    if (lastName) data.customerLastName = lastName;

    return await prisma.conversation.update({
      where: { id: conversationId },
      data
    });
  } catch (error) {
    console.error("Error storing conversation shipping address:", error);
    return null;
  }
}

/**
 * Clear saved shipping when cart is cleared.
 */
export async function clearConversationShippingAddress(conversationId) {
  if (!conversationId) {
    return null;
  }

  try {
    return await prisma.conversation.update({
      where: { id: conversationId },
      data: { shippingAddress: null }
    });
  } catch (error) {
    console.error("Error clearing conversation shipping address:", error);
    return null;
  }
}

/**
 * Get stored customer profile for LLM context (storefront login / shipping).
 */
export async function getConversationCustomerProfile(conversationId) {
  if (!conversationId) {
    return null;
  }

  try {
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: {
        customerFirstName: true,
        customerLastName: true,
        customerLoggedIn: true,
        shopifyCustomerId: true,
        shopDomain: true
      }
    });

    if (!conversation) {
      return null;
    }

    return {
      firstName: conversation.customerFirstName || null,
      lastName: conversation.customerLastName || null,
      loggedIn: Boolean(conversation.customerLoggedIn),
      shopifyCustomerId: conversation.shopifyCustomerId || null,
      shopDomain: conversation.shopDomain || null
    };
  } catch (error) {
    console.error("Error retrieving conversation customer profile:", error);
    return null;
  }
}

/**
 * Persist customer profile fields for a conversation.
 */
export async function setConversationCustomerProfile(
  conversationId,
  {
    firstName = null,
    lastName = null,
    loggedIn = false,
    shopifyCustomerId = null,
    shopDomain = null
  } = {}
) {
  if (!conversationId) {
    return null;
  }

  try {
    await createOrUpdateConversation(conversationId);
    const data = {};
    const normalizedFirst = String(firstName || "").trim();
    const normalizedLast = String(lastName || "").trim();
    const normalizedCustomerId = String(shopifyCustomerId || "").trim();
    const normalizedShop = String(shopDomain || "").trim().toLowerCase();

    if (normalizedFirst) data.customerFirstName = normalizedFirst;
    if (normalizedLast) data.customerLastName = normalizedLast;
    if (loggedIn) data.customerLoggedIn = true;
    if (normalizedCustomerId) data.shopifyCustomerId = normalizedCustomerId;
    if (normalizedShop) data.shopDomain = normalizedShop;

    if (Object.keys(data).length === 0) {
      return null;
    }

    return await prisma.conversation.update({
      where: { id: conversationId },
      data
    });
  } catch (error) {
    console.error("Error storing conversation customer profile:", error);
    return null;
  }
}

function truncateSessionText(text, maxLen) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value) return "";
  if (value.length <= maxLen) return value;
  return `${value.slice(0, maxLen - 1)}…`;
}

function extractPlainUserText(content) {
  if (content == null) return "";
  if (typeof content === "string") {
    const trimmed = content.trim();
    if (!trimmed) return "";
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          return parsed
            .filter((block) => block?.type === "text" && block.text)
            .map((block) => block.text)
            .join(" ")
            .trim();
        }
        if (parsed?.type === "text" && parsed.text) {
          return String(parsed.text).trim();
        }
      } catch {
        // use raw string
      }
    }
    return trimmed;
  }
  return "";
}

/**
 * Attach a guest (or same-customer) conversation to a logged-in Shopify customer.
 * Refuses to steal a conversation already owned by a different customer.
 * Does not bump activity time when only linking ownership.
 */
export async function claimConversationForCustomer(
  conversationId,
  { shopifyCustomerId, shopDomain = null, firstName = null, lastName = null } = {}
) {
  const id = String(conversationId || "").trim();
  const customerId = String(shopifyCustomerId || "").trim();
  if (!id || !customerId) {
    return { ok: false, reason: "missing_ids" };
  }

  try {
    const existing = await prisma.conversation.findUnique({
      where: { id },
      select: {
        shopifyCustomerId: true,
        shopDomain: true,
        customerFirstName: true,
        customerLastName: true,
        customerLoggedIn: true
      }
    });

    const ownedBy = existing?.shopifyCustomerId
      ? String(existing.shopifyCustomerId).trim()
      : "";

    if (ownedBy && ownedBy !== customerId) {
      return { ok: false, reason: "owned_by_other" };
    }

    const normalizedShop = String(shopDomain || "").trim().toLowerCase() || null;
    const normalizedFirst = String(firstName || "").trim() || null;
    const normalizedLast = String(lastName || "").trim() || null;

    // Already linked to this customer — skip write so @updatedAt stays unchanged
    if (
      ownedBy === customerId &&
      existing?.customerLoggedIn === true &&
      (!normalizedShop || existing.shopDomain === normalizedShop) &&
      (!normalizedFirst || existing.customerFirstName === normalizedFirst) &&
      (!normalizedLast || existing.customerLastName === normalizedLast)
    ) {
      return { ok: true, conversationId: id, claimed: false };
    }

    const data = {
      shopifyCustomerId: customerId,
      customerLoggedIn: true
    };
    if (normalizedShop) data.shopDomain = normalizedShop;
    if (normalizedFirst) data.customerFirstName = normalizedFirst;
    if (normalizedLast) data.customerLastName = normalizedLast;

    if (!existing) {
      await prisma.conversation.create({
        data: { id, ...data }
      });
      return { ok: true, conversationId: id, claimed: true };
    }

    await prisma.conversation.update({
      where: { id },
      data
    });

    return { ok: true, conversationId: id, claimed: !ownedBy };
  } catch (error) {
    console.error("Error claiming conversation for customer:", error);
    return { ok: false, reason: "error" };
  }
}

/**
 * List chat sessions for a storefront customer (cross-device).
 * updatedAt is last message time (not claim/sync time) for correct sorting/display.
 * Pass limit to cap results; omit / null / 0 = all sessions for this customer.
 */
export async function listConversationsForCustomer(
  shopifyCustomerId,
  { shopDomain = null, limit = null } = {}
) {
  const customerId = String(shopifyCustomerId || "").trim();
  if (!customerId) return [];

  const parsedLimit = limit == null || limit === "" ? null : Number(limit);
  const take =
    parsedLimit == null || !Number.isFinite(parsedLimit) || parsedLimit <= 0
      ? null
      : Math.floor(parsedLimit);
  const shop = String(shopDomain || "").trim().toLowerCase();

  try {
    const conversations = await prisma.conversation.findMany({
      where: {
        shopifyCustomerId: customerId,
        ...(shop ? { shopDomain: shop } : {})
      },
      orderBy: { updatedAt: "desc" },
      ...(take ? { take } : {}),
      select: { id: true, updatedAt: true, createdAt: true }
    });

    if (!conversations.length) return [];

    const ids = conversations.map((row) => row.id);
    const messages = await prisma.message.findMany({
      where: { conversationId: { in: ids } },
      orderBy: { createdAt: "asc" },
      select: {
        conversationId: true,
        role: true,
        content: true,
        createdAt: true
      }
    });

    const byConversation = new Map();
    for (const message of messages) {
      const bucket = byConversation.get(message.conversationId) || {
        firstUser: null,
        lastUser: null,
        lastActivityAt: null
      };

      const activityMs = message.createdAt?.getTime?.() || 0;
      if (!bucket.lastActivityAt || activityMs > bucket.lastActivityAt) {
        bucket.lastActivityAt = activityMs;
      }

      if (message.role === "user") {
        const text = extractPlainUserText(message.content);
        if (text) {
          if (!bucket.firstUser) bucket.firstUser = text;
          bucket.lastUser = text;
        }
      }

      byConversation.set(message.conversationId, bucket);
    }

    const sessions = conversations.map((row) => {
      const meta = byConversation.get(row.id);
      const titleSource = meta?.firstUser || "Chat";
      const previewSource = meta?.lastUser || meta?.firstUser || "";
      const updatedAt =
        meta?.lastActivityAt ||
        row.updatedAt?.getTime?.() ||
        row.createdAt?.getTime?.() ||
        Date.now();

      return {
        id: row.id,
        title: truncateSessionText(titleSource, 48) || "Chat",
        preview: truncateSessionText(previewSource, 80),
        updatedAt
      };
    });

    return sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  } catch (error) {
    console.error("Error listing conversations for customer:", error);
    return [];
  }
}

/**
 * Get the active Shopify checkout id for a conversation, if any.
 */
export async function getConversationCheckoutId(conversationId) {
  if (!conversationId) {
    return null;
  }

  try {
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { activeCheckoutId: true }
    });

    return conversation?.activeCheckoutId || null;
  } catch (error) {
    console.error("Error retrieving conversation checkout id:", error);
    return null;
  }
}

/**
 * Latest checkout continue_url stored for this conversation (may change if checkout is recreated).
 */
export async function getConversationCheckoutUrl(conversationId) {
  if (!conversationId) {
    return null;
  }

  try {
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { checkoutUrl: true }
    });

    return conversation?.checkoutUrl || null;
  } catch (error) {
    console.error("Error retrieving conversation checkout url:", error);
    return null;
  }
}

/**
 * Persist the active Shopify checkout id for a conversation.
 */
export async function setConversationCheckoutId(conversationId, checkoutId) {
  if (!conversationId || !checkoutId) {
    return null;
  }

  try {
    await createOrUpdateConversation(conversationId);
    return await prisma.conversation.update({
      where: { id: conversationId },
      data: { activeCheckoutId: String(checkoutId) }
    });
  } catch (error) {
    console.error("Error storing conversation checkout id:", error);
    return null;
  }
}

/**
 * Persist the latest checkout URL. Returns whether the URL changed vs what was stored.
 */
export async function setConversationCheckoutUrl(conversationId, checkoutUrl) {
  if (!conversationId) {
    return { ok: false, changed: false, checkoutUrl: null };
  }

  const nextUrl = checkoutUrl ? String(checkoutUrl).trim() : null;
  if (!nextUrl) {
    return { ok: false, changed: false, checkoutUrl: null };
  }

  try {
    await createOrUpdateConversation(conversationId);
    const existing = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { checkoutUrl: true }
    });
    const previous = existing?.checkoutUrl || null;
    const changed = Boolean(previous && previous !== nextUrl);

    await prisma.conversation.update({
      where: { id: conversationId },
      data: { checkoutUrl: nextUrl }
    });

    return { ok: true, changed, checkoutUrl: nextUrl, previousUrl: previous };
  } catch (error) {
    console.error("Error storing conversation checkout url:", error);
    return { ok: false, changed: false, checkoutUrl: null };
  }
}

/**
 * Clear the active checkout id (stale/expired recreate path).
 * Keeps checkoutUrl until a new URL is persisted so we can detect URL changes.
 */
export async function clearConversationCheckoutId(conversationId) {
  if (!conversationId) {
    return null;
  }

  try {
    return await prisma.conversation.update({
      where: { id: conversationId },
      data: { activeCheckoutId: null }
    });
  } catch (error) {
    console.error("Error clearing conversation checkout id:", error);
    return null;
  }
}

/**
 * Clear checkout id + stored checkout URL (cart cleared / checkout cancelled).
 */
export async function clearConversationCheckout(conversationId) {
  if (!conversationId) {
    return null;
  }

  try {
    return await prisma.conversation.update({
      where: { id: conversationId },
      data: { activeCheckoutId: null, checkoutUrl: null }
    });
  } catch (error) {
    console.error("Error clearing conversation checkout:", error);
    return null;
  }
}

/**
 * Store customer account URLs for a conversation
 * @param {string} conversationId - The conversation ID
 * @param {string} mcpApiUrl - The customer account MCP URL
 * @param {string} authorizationUrl - The customer account authorization URL
 * @param {string} tokenUrl - The customer account token URL
 * @returns {Promise<Object>} - The saved urls object
 */
export async function storeCustomerAccountUrls({conversationId, mcpApiUrl, authorizationUrl, tokenUrl}) {
  try {
    return await prisma.customerAccountUrls.upsert({
      where: { conversationId },
      create: {
        conversationId,
        mcpApiUrl,
        authorizationUrl,
        tokenUrl,
        updatedAt: new Date(),
      },
      update: {
        mcpApiUrl,
        authorizationUrl,
        tokenUrl,
        updatedAt: new Date(),
      },
    });
  } catch (error) {
    console.error('Error storing customer account URLs:', error);
    throw error;
  }
}

/**
 * Get customer account URLs for a conversation
 * @param {string} conversationId - The conversation ID
 * @returns {Promise<Object|null>} - The customer account URLs or null if not found
 */
export async function getCustomerAccountUrls(conversationId) {
  try {
    return await prisma.customerAccountUrls.findUnique({
      where: { conversationId }
    });
  } catch (error) {
    console.error('Error retrieving customer account URLs:', error);
    return null;
  }
}

/**
 * Persist the exact payload sent to an LLM and the exact payload returned.
 * Logging failures must not break the chat.
 */
export async function storeLlmRequestLog({ request, response, statusCode, provider }) {
  try {
    return await prisma.llmRequestLog.create({
      data: {
        request: stringifyLlmPayload(request),
        response: stringifyLlmPayload(response),
        statusCode: Number.isInteger(statusCode) ? statusCode : 0,
        provider: String(provider || "unknown")
      }
    });
  } catch (error) {
    console.error("Error storing LLM request log:", error);
    return null;
  }
}

/**
 * Persist Shopify MCP JSON-RPC and Admin GraphQL calls.
 * server: storefront | ucp | customer | admin
 * Sensitive fields (tokens, auth headers) are redacted before storage.
 */
export async function storeMcpCallLog({
  conversationId,
  server,
  method,
  toolName,
  endpoint,
  request,
  response,
  statusCode,
  durationMs
}) {
  try {
    return await prisma.mcpCallLog.create({
      data: {
        conversationId: conversationId || null,
        server: String(server || "unknown"),
        method: String(method || "unknown"),
        toolName: toolName ? String(toolName) : null,
        endpoint: String(endpoint || ""),
        request: stringifyMcpPayload(sanitizeMcpPayload(request)),
        response: stringifyMcpPayload(sanitizeMcpPayload(response)),
        statusCode: Number.isInteger(statusCode) ? statusCode : 0,
        durationMs: Number.isInteger(durationMs) ? durationMs : null
      }
    });
  } catch (error) {
    console.error("Error storing MCP call log:", error);
    return null;
  }
}

const MCP_REDACTED_KEYS = new Set([
  "authorization",
  "accesstoken",
  "access_token",
  "refreshtoken",
  "refresh_token",
  "token",
  "password",
  "secret",
  "api_key",
  "apikey"
]);

function sanitizeMcpPayload(value, key = "") {
  if (value == null) {
    return value;
  }

  if (typeof key === "string" && MCP_REDACTED_KEYS.has(key.toLowerCase())) {
    return "[REDACTED]";
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeMcpPayload(item));
  }

  if (typeof value === "object") {
    const sanitized = {};

    for (const [entryKey, entryValue] of Object.entries(value)) {
      sanitized[entryKey] = sanitizeMcpPayload(entryValue, entryKey);
    }

    return sanitized;
  }

  return value;
}

function stringifyMcpPayload(value) {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value, llmJsonReplacer);
  } catch (error) {
    return JSON.stringify({
      unserializable: true,
      error: error.message,
      fallback: String(value)
    });
  }
}

function stringifyLlmPayload(value) {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value, llmJsonReplacer);
  } catch (error) {
    return JSON.stringify({
      unserializable: true,
      error: error.message,
      fallback: String(value)
    });
  }
}

function llmJsonReplacer(_key, value) {
  if (typeof value === "bigint") {
    return value.toString();
  }

  if (typeof value === "function") {
    return undefined;
  }

  return value;
}

/** Default PUREFLOW digest used if DB row is missing. */
export const DEFAULT_STORE_POLICY_DIGEST = {
  id: "default",
  title: "PUREFLOW store policy cheat sheet",
  note:
    "Returned when Shopify search_shop_policies_and_faqs is empty. Prefer these quick facts; do not invent policy details.",
  contentDate: "2026-09-04",
  digest: `PUREFLOW quick facts — use these before inventing anything.

CONTACT: Email support@pureflowair.com or call 866-206-4492 (typically 9am–5pm CST). Contact page: https://pureflowair.com/pages/contact-us

CANCEL ORDER: You may cancel any time BEFORE the order is dispatched/shipped. Email support@pureflowair.com or call 866-206-4492. Orders placed before noon often ship the same day — next-day cancel only works if it has not shipped yet. After dispatch, use returns (not cancel). Do NOT treat “sales final after 30 days” as the cancel rule.

SHIPPING / WHERE WE DELIVER: Ships domestically AND internationally. No fixed public country list — availability and cost are calculated at checkout by destination. Domestic transit usually 2–7 days; international usually 4–22 days. Orders usually dispatch within 2 business days of payment. Shipping price at checkout is final. P.O. Boxes: postal only. Military: USPS only. International import duties/taxes may be due on arrival. Tracking emailed after dispatch. Shipping policy: https://pureflowair.com/pages/shippings-policy

RETURNS / REFUNDS (US & Canada): Return or exchange within 30 days of purchase if unused and in original packaging. Email support@pureflowair.com — PUREFLOW emails a prepaid return label. Damaged or wrong item: contact support for replacement. Refunds: after return received and checked, credit original payment in 3–5 business days; original outbound shipping (if charged) is not refunded. Canada: same return window; duties/taxes not refunded. Returns page: https://pureflowair.com/pages/return-refund-policy

WARRANTY: 1-year limited warranty on PUREFLOW cabin and home filters for defects in workmanship/materials under normal use. Excludes misuse, abuse, neglect, alteration, improper install, acts of nature. Proof of purchase required; call 866-206-4492 if bought from PUREFLOW. Also a 30-day money-back guarantee if not satisfied with filter quality. Warranty page: https://pureflowair.com/pages/warranty

PRODUCTS / WHY PUREFLOW: Sells cabin air filters, home furnace filters, and cabin-filter air fresheners. Multi-stage filtration (particles + charcoal/baking soda + antimicrobial). Febreze cabin filters (P&G license) are unscented odor-control. Fresheners: ~90 days, 6 scents, attach to filter pleats. Why PUREFLOW: https://pureflowair.com/pages/why-pureflow

COMMON FAQs: Cabin filter replace about every 12,000–15,000 miles or at least yearly. Standard vs carbon vs HEPA: particulate vs odor/gases vs HEPA ~99.97% plus charcoal/antibacterial. Payments: major cards, Amazon Pay, Google Pay, Facebook Pay. Home furnace filters: change at least twice a year; arrows toward furnace. FAQs: https://pureflowair.com/pages/faqs

PRIVACY: Site collects contact/account info as needed; uses cookies; CCPA/GDPR-style rights may apply — contact support. Privacy: https://pureflowair.com/pages/privacy-policies

TERMS: Operated by Premium Guard Inc. (PGI). Subscriptions: cancel with at least 30 days notice via account page. “Sales final 30 days after order” in Terms is about purchase finality/returns timing — NOT a substitute for the cancel-before-dispatch rule. Terms: https://pureflowair.com/pages/term-of-service`
};

/**
 * Load local store policy digest from DB (fallback content when Shopify is empty).
 * Seeds the default row if missing.
 */
export async function getStorePolicyDigest(id = "default") {
  try {
    let row = await prisma.storePolicyDigest.findUnique({ where: { id } });

    if (!row) {
      row = await prisma.storePolicyDigest.create({
        data: {
          id: DEFAULT_STORE_POLICY_DIGEST.id,
          title: DEFAULT_STORE_POLICY_DIGEST.title,
          note: DEFAULT_STORE_POLICY_DIGEST.note,
          digest: DEFAULT_STORE_POLICY_DIGEST.digest,
          contentDate: DEFAULT_STORE_POLICY_DIGEST.contentDate
        }
      });
    }

    return {
      id: row.id,
      title: row.title,
      note: row.note,
      digest: row.digest,
      contentDate: row.contentDate,
      updatedAt: row.updatedAt
    };
  } catch (error) {
    console.error("[db] getStorePolicyDigest failed — using in-code default", error.message);
    return { ...DEFAULT_STORE_POLICY_DIGEST, updatedAt: null };
  }
}

function stringifyLogPayload(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch (error) {
    return JSON.stringify({ unserializable: true, error: error.message });
  }
}

/**
 * Record when a tool was called but returned no useful data.
 * Use this to find which tools miss user queries.
 */
export async function storeToolEmptyResultLog({
  conversationId = null,
  shop = null,
  userQuery = "",
  toolName,
  toolArgs = null,
  response = null,
  reason = "empty"
} = {}) {
  try {
    return await prisma.toolEmptyResultLog.create({
      data: {
        conversationId: conversationId || null,
        shop: shop || null,
        userQuery: String(userQuery || "").slice(0, 4000),
        toolName: String(toolName || "unknown"),
        toolArgs: toolArgs == null ? null : stringifyLogPayload(toolArgs).slice(0, 8000),
        response: stringifyLogPayload(response ?? {}).slice(0, 20000),
        reason: String(reason || "empty").slice(0, 64)
      }
    });
  } catch (error) {
    console.error("[db] storeToolEmptyResultLog failed", error.message);
    return null;
  }
}

function normalizeAddressField(value, max = 500) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  return text.slice(0, max);
}

/**
 * Upsert storefront customer + replace their saved addresses from Liquid sync.
 */
export async function upsertStoreCustomerAddresses({
  shopifyCustomerId,
  shopDomain,
  email = null,
  firstName = null,
  lastName = null,
  addresses = []
} = {}) {
  const customerKey = String(shopifyCustomerId || "").trim();
  const shop = String(shopDomain || "").trim().toLowerCase();
  if (!customerKey || !shop) {
    return { ok: false, error: "Missing shopifyCustomerId or shopDomain" };
  }

  try {
    const list = Array.isArray(addresses) ? addresses : [];
    const normalized = list
      .map((raw) => {
        const streetAddress = normalizeAddressField(
          raw?.street_address || raw?.address1 || raw?.streetAddress,
          500
        );
        if (!streetAddress) return null;
        return {
          shopifyAddressId: normalizeAddressField(raw?.id ?? raw?.shopifyAddressId, 64),
          firstName: normalizeAddressField(raw?.first_name || raw?.firstName, 120),
          lastName: normalizeAddressField(raw?.last_name || raw?.lastName, 120),
          company: normalizeAddressField(raw?.company, 200),
          streetAddress,
          extendedAddress: normalizeAddressField(
            raw?.extended_address || raw?.address2 || raw?.extendedAddress,
            500
          ),
          addressLocality: normalizeAddressField(
            raw?.address_locality || raw?.city || raw?.addressLocality,
            200
          ),
          addressRegion: normalizeAddressField(
            raw?.address_region || raw?.province_code || raw?.province || raw?.addressRegion,
            120
          ),
          postalCode: normalizeAddressField(
            raw?.postal_code || raw?.zip || raw?.postalCode,
            40
          ),
          addressCountry: normalizeAddressField(
            raw?.address_country || raw?.country_code || raw?.country || raw?.addressCountry,
            80
          ),
          phoneNumber: normalizeAddressField(
            raw?.phone_number || raw?.phone || raw?.phoneNumber,
            80
          ),
          isDefault: Boolean(raw?.is_default || raw?.isDefault || raw?.default)
        };
      })
      .filter(Boolean)
      .slice(0, 20);

    const customer = await prisma.storeCustomer.upsert({
      where: {
        shopifyCustomerId_shopDomain: {
          shopifyCustomerId: customerKey,
          shopDomain: shop
        }
      },
      create: {
        shopifyCustomerId: customerKey,
        shopDomain: shop,
        email: normalizeAddressField(email, 320),
        firstName: normalizeAddressField(firstName, 120),
        lastName: normalizeAddressField(lastName, 120)
      },
      update: {
        email: normalizeAddressField(email, 320),
        firstName: normalizeAddressField(firstName, 120),
        lastName: normalizeAddressField(lastName, 120)
      }
    });

    await prisma.$transaction([
      prisma.storeCustomerAddress.deleteMany({ where: { customerId: customer.id } }),
      ...(normalized.length
        ? [
            prisma.storeCustomerAddress.createMany({
              data: normalized.map((row) => ({
                ...row,
                customerId: customer.id
              }))
            })
          ]
        : [])
    ]);

    return {
      ok: true,
      customerId: customer.id,
      shopifyCustomerId: customerKey,
      shopDomain: shop,
      addressCount: normalized.length
    };
  } catch (error) {
    console.error("[db] upsertStoreCustomerAddresses failed", error.message);
    return { ok: false, error: error.message || "Sync failed" };
  }
}

/**
 * List saved addresses for a storefront customer (Liquid-synced).
 */
export async function listStoreCustomerAddresses(shopifyCustomerId, { shopDomain = null } = {}) {
  const customerKey = String(shopifyCustomerId || "").trim();
  if (!customerKey) return [];

  try {
    const shop = String(shopDomain || "").trim().toLowerCase();
    const customer = shop
      ? await prisma.storeCustomer.findUnique({
          where: {
            shopifyCustomerId_shopDomain: {
              shopifyCustomerId: customerKey,
              shopDomain: shop
            }
          },
          include: {
            addresses: { orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }] }
          }
        })
      : await prisma.storeCustomer.findFirst({
          where: { shopifyCustomerId: customerKey },
          orderBy: { updatedAt: "desc" },
          include: {
            addresses: { orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }] }
          }
        });

    if (!customer) return [];

    return customer.addresses.map((row) => ({
      id: row.shopifyAddressId || row.id,
      first_name: row.firstName,
      last_name: row.lastName,
      company: row.company,
      street_address: row.streetAddress,
      extended_address: row.extendedAddress,
      address_locality: row.addressLocality,
      address_region: row.addressRegion,
      postal_code: row.postalCode,
      address_country: row.addressCountry,
      phone_number: row.phoneNumber,
      is_default: row.isDefault
    }));
  } catch (error) {
    console.error("[db] listStoreCustomerAddresses failed", error.message);
    return [];
  }
}
