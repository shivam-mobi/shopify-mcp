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
