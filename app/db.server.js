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
    return await prisma.conversation.update({
      where: { id: conversationId },
      data: { shippingAddress: JSON.stringify(address) }
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
 * Clear the active checkout id (cancel / expired / cart cleared).
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
 * Persist Shopify MCP JSON-RPC calls (storefront, UCP, customer).
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

/**
 * Persist Shopify Admin API GraphQL calls (fitment product enrichment, etc.).
 * Tokens and secrets are redacted before storage.
 */
export async function storeShopifyAdminApiLog({
  shop,
  operation,
  authMode,
  endpoint,
  request,
  response,
  statusCode,
  durationMs,
  error
}) {
  try {
    return await prisma.shopifyAdminApiLog.create({
      data: {
        shop: String(shop || "unknown"),
        operation: String(operation || "unknown"),
        authMode: String(authMode || "unknown"),
        endpoint: String(endpoint || ""),
        request: stringifyMcpPayload(sanitizeMcpPayload(request)),
        response: stringifyMcpPayload(sanitizeMcpPayload(response)),
        statusCode: Number.isInteger(statusCode) ? statusCode : 0,
        durationMs: Number.isInteger(durationMs) ? durationMs : null,
        error: error ? String(error) : null
      }
    });
  } catch (logError) {
    console.error("Error storing Shopify Admin API log:", logError);
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
