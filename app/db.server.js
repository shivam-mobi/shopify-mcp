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
 * Resolve the shopper id used as ShopperCart.id (localStorage shopper id).
 * Never use conversation id — that would create one cart per chat.
 */
export function resolveShopperId({ anonymousShopperId = null } = {}) {
  const anonId = String(anonymousShopperId || "").trim();
  return anonId || null;
}

/** @deprecated use resolveShopperId — kept for older imports */
export function buildShopperKey(args = {}) {
  return resolveShopperId(args);
}

async function getConversationShopperMeta(conversationId) {
  if (!conversationId) return null;
  return prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { shopperId: true }
  });
}

async function upsertShopperCartFields(shopperId, fields = {}, meta = {}) {
  if (!shopperId) return null;

  const data = { ...fields };
  if (meta.shopifyCustomerId != null) {
    data.shopifyCustomerId = String(meta.shopifyCustomerId).trim() || null;
  }
  if (meta.customerFirstName != null) {
    data.customerFirstName = String(meta.customerFirstName).trim() || null;
  }
  if (meta.customerLastName != null) {
    data.customerLastName = String(meta.customerLastName).trim() || null;
  }
  if (meta.customerLoggedIn != null) {
    data.customerLoggedIn = Boolean(meta.customerLoggedIn);
  }

  const nowSec = Math.floor(Date.now() / 1000);
  delete data.createdAt;
  delete data.updatedAt;
  delete data.id;

  return prisma.shopperCart.upsert({
    where: { id: shopperId },
    create: {
      id: shopperId,
      shopifyCustomerId:
        data.shopifyCustomerId ??
        (meta.shopifyCustomerId ? String(meta.shopifyCustomerId).trim() : null),
      customerFirstName: data.customerFirstName ?? null,
      customerLastName: data.customerLastName ?? null,
      customerLoggedIn: Boolean(data.customerLoggedIn),
      activeConversationId: data.activeConversationId ?? null,
      activeCartId: data.activeCartId ?? null,
      activeCheckoutId: data.activeCheckoutId ?? null,
      checkoutUrl: data.checkoutUrl ?? null,
      shippingAddress: data.shippingAddress ?? null,
      createdAt: nowSec,
      updatedAt: nowSec
    },
    update: {
      ...data,
      updatedAt: nowSec
    }
  });
}

/**
 * Ensure conversation is linked to an existing ShopperCart.
 * Does not create a per-conversation shopper id.
 */
async function ensureConversationShopperKey(conversationId) {
  if (!conversationId) return null;

  await createOrUpdateConversation(conversationId);
  const existing = await getConversationShopperMeta(conversationId);
  if (existing?.shopperId) {
    await upsertShopperCartFields(existing.shopperId, {});
    return { shopperId: existing.shopperId };
  }

  console.warn(
    "[shopper-cart] conversation has no shopperId yet; bind shopper_id before cart writes",
    { conversationId }
  );
  return null;
}

async function resolveCartStateForConversation(conversationId) {
  const empty = {
    activeCartId: null,
    activeCheckoutId: null,
    checkoutUrl: null,
    shippingAddress: null,
    shopperId: null
  };

  if (!conversationId) return empty;

  const meta = await getConversationShopperMeta(conversationId);
  const shopperId = meta?.shopperId || null;
  if (!shopperId) return empty;

  const shared = await prisma.shopperCart.findUnique({
    where: { id: shopperId }
  });
  if (!shared) {
    return { ...empty, shopperId };
  }

  return {
    activeCartId: shared.activeCartId || null,
    activeCheckoutId: shared.activeCheckoutId || null,
    checkoutUrl: shared.checkoutUrl || null,
    shippingAddress: shared.shippingAddress || null,
    shopperId
  };
}

async function writeCartStateForConversation(conversationId, fields = {}) {
  if (!conversationId) return null;

  const ensured = await ensureConversationShopperKey(conversationId);
  const shopperId = ensured?.shopperId;
  if (!shopperId) return null;

  await upsertShopperCartFields(shopperId, fields);
  return shopperId;
}

/**
 * Merge cart/profile from one shopper id into another; remount conversations.
 */
async function mergeShopperCartIds(fromId, toId) {
  if (!fromId || !toId || fromId === toId) return;

  const from = await prisma.shopperCart.findUnique({ where: { id: fromId } });
  if (!from) {
    await prisma.conversation.updateMany({
      where: { shopperId: fromId },
      data: { shopperId: toId }
    });
    return;
  }

  const to = await prisma.shopperCart.findUnique({ where: { id: toId } });
  const merged = {
    activeCartId: to?.activeCartId || from.activeCartId || null,
    activeCheckoutId: to?.activeCheckoutId || from.activeCheckoutId || null,
    checkoutUrl: to?.checkoutUrl || from.checkoutUrl || null,
    shippingAddress: to?.shippingAddress || from.shippingAddress || null,
    shopifyCustomerId: to?.shopifyCustomerId || from.shopifyCustomerId || null,
    customerFirstName: to?.customerFirstName || from.customerFirstName || null,
    customerLastName: to?.customerLastName || from.customerLastName || null,
    customerLoggedIn: Boolean(to?.customerLoggedIn || from.customerLoggedIn),
    activeConversationId:
      to?.activeConversationId || from.activeConversationId || null
  };

  await upsertShopperCartFields(toId, merged);
  await prisma.conversation.updateMany({
    where: { shopperId: fromId },
    data: { shopperId: toId }
  });

  try {
    await prisma.shopperCart.delete({ where: { id: fromId } });
  } catch {
    // ignore
  }
}

/**
 * Link a conversation to a shopper id (ShopperCart.id).
 */
export async function bindConversationShopper(
  conversationId,
  {
    shopifyCustomerId = null,
    anonymousShopperId = null,
    firstName = null,
    lastName = null,
    loggedIn = null
  } = {}
) {
  if (!conversationId) return null;

  try {
    await createOrUpdateConversation(conversationId);
    const existing = await getConversationShopperMeta(conversationId);
    const previousId = existing?.shopperId || null;
    let previousProfile = null;
    if (previousId) {
      previousProfile = await prisma.shopperCart.findUnique({
        where: { id: previousId }
      });
    }

    // Prefer localStorage shopper_id. Never keep shopperId === conversationId.
    let targetId = resolveShopperId({ anonymousShopperId });
    if (!targetId && previousId && previousId !== conversationId) {
      targetId = previousId;
    }
    if (!targetId || targetId === conversationId) {
      console.warn("[shopper-cart] bind skipped: missing shopper_id", {
        conversationId,
        previousId
      });
      return null;
    }

    if (previousId && previousId !== targetId) {
      await mergeShopperCartIds(previousId, targetId);
    }

    const profilePatch = {
      activeConversationId: conversationId
    };
    const customerId = String(
      shopifyCustomerId || previousProfile?.shopifyCustomerId || ""
    ).trim();
    if (customerId) profilePatch.shopifyCustomerId = customerId;
    if (firstName != null && String(firstName).trim()) {
      profilePatch.customerFirstName = String(firstName).trim();
    }
    if (lastName != null && String(lastName).trim()) {
      profilePatch.customerLastName = String(lastName).trim();
    }
    if (loggedIn === true || customerId) {
      profilePatch.customerLoggedIn = true;
    }

    await upsertShopperCartFields(targetId, profilePatch);
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { shopperId: targetId }
    });

    return targetId;
  } catch (error) {
    console.error("[shopper-cart] bind failed:", error?.message || error);
    return null;
  }
}

/**
 * Resolve or create the active conversation for a shopper (localStorage shopper id).
 */
export async function resolveShopperSession({
  anonymousShopperId = null,
  shopifyCustomerId = null,
  firstName = null,
  lastName = null,
  action = "get",
  conversationId = null
} = {}) {
  const shopperId = resolveShopperId({ anonymousShopperId });
  if (!shopperId) {
    return { ok: false, error: "shopper_id_required" };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  let shopper = await prisma.shopperCart.findUnique({ where: { id: shopperId } });

  if (!shopper) {
    shopper = await prisma.shopperCart.create({
      data: {
        id: shopperId,
        shopifyCustomerId: shopifyCustomerId ? String(shopifyCustomerId).trim() : null,
        customerFirstName: firstName ? String(firstName).trim() : null,
        customerLastName: lastName ? String(lastName).trim() : null,
        customerLoggedIn: Boolean(shopifyCustomerId),
        createdAt: nowSec,
        updatedAt: nowSec
      }
    });
  } else if (shopifyCustomerId) {
    shopper = await prisma.shopperCart.update({
      where: { id: shopperId },
      data: {
        shopifyCustomerId: String(shopifyCustomerId).trim(),
        customerLoggedIn: true,
        ...(firstName ? { customerFirstName: String(firstName).trim() } : {}),
        ...(lastName ? { customerLastName: String(lastName).trim() } : {}),
        updatedAt: nowSec
      }
    });

    // Same logged-in customer may have older browser shopper rows — merge them.
    const otherShoppers = await prisma.shopperCart.findMany({
      where: {
        shopifyCustomerId: String(shopifyCustomerId).trim(),
        NOT: { id: shopperId }
      },
      select: { id: true }
    });
    for (const other of otherShoppers) {
      await mergeShopperCartIds(other.id, shopperId);
    }
    shopper = await prisma.shopperCart.findUnique({ where: { id: shopperId } });
  }

  const normalizedAction = String(action || "get").toLowerCase();

  if (normalizedAction === "new") {
    const newId = String(Date.now());
    await createOrUpdateConversation(newId);
    await prisma.conversation.update({
      where: { id: newId },
      data: { shopperId }
    });
    shopper = await prisma.shopperCart.update({
      where: { id: shopperId },
      data: {
        activeConversationId: newId,
        updatedAt: nowSec
      }
    });
  } else if (normalizedAction === "activate" && conversationId) {
    const targetId = String(conversationId).trim();
    const owned = await prisma.conversation.findFirst({
      where: { id: targetId, shopperId },
      select: { id: true }
    });
    if (!owned) {
      return { ok: false, error: "conversation_not_found" };
    }
    shopper = await prisma.shopperCart.update({
      where: { id: shopperId },
      data: { activeConversationId: targetId, updatedAt: nowSec }
    });
  } else {
    let activeId = shopper.activeConversationId
      ? String(shopper.activeConversationId)
      : null;

    if (activeId) {
      const exists = await prisma.conversation.findFirst({
        where: { id: activeId, shopperId },
        select: { id: true }
      });
      const msgCount = exists
        ? await prisma.message.count({ where: { conversationId: activeId } })
        : 0;
      if (!exists || msgCount === 0) activeId = null;
    }

    // Do not invent empty conversations on get — only reuse chats that have messages.
    if (!activeId) {
      const linked = await prisma.conversation.findMany({
        where: { shopperId },
        orderBy: { updatedAt: "desc" },
        select: { id: true }
      });
      for (const row of linked) {
        const count = await prisma.message.count({
          where: { conversationId: row.id }
        });
        if (count > 0) {
          activeId = row.id;
          break;
        }
      }
    }

    shopper = await prisma.shopperCart.update({
      where: { id: shopperId },
      data: {
        activeConversationId: activeId || null,
        updatedAt: nowSec
      }
    });
  }

  const sessions = await listConversationsForShopperId(shopperId);

  return {
    ok: true,
    shopper_id: shopperId,
    conversation_id: shopper.activeConversationId || null,
    sessions
  };
}

/**
 * List chat sessions linked to a shopper id.
 */
export async function listConversationsForShopperId(shopperId, { limit = null } = {}) {
  const id = String(shopperId || "").trim();
  if (!id) return [];

  const parsedLimit = limit == null || limit === "" ? null : Number(limit);
  const take =
    parsedLimit == null || !Number.isFinite(parsedLimit) || parsedLimit <= 0
      ? null
      : Math.floor(parsedLimit);

  try {
    const conversations = await prisma.conversation.findMany({
      where: { shopperId: id },
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

    const sessions = conversations
      .map((row) => {
        const meta = byConversation.get(row.id);
        // Hide empty threads (created on open / abandoned new chat).
        if (!meta?.lastActivityAt && !meta?.firstUser && !meta?.lastUser) {
          return null;
        }
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
      })
      .filter(Boolean);

    return sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  } catch (error) {
    console.error("Error listing conversations for shopper:", error);
    return [];
  }
}

/** @deprecated alias */
export async function listConversationsForShopperKey(shopperKey, opts) {
  return listConversationsForShopperId(shopperKey, opts);
}

/**
 * Get the active Shopify cart id for a conversation, if any.
 */
export async function getConversationCartId(conversationId) {
  if (!conversationId) {
    return null;
  }

  try {
    const state = await resolveCartStateForConversation(conversationId);
    return state.activeCartId || null;
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
    await writeCartStateForConversation(conversationId, {
      activeCartId: String(cartId)
    });
    return { id: conversationId, activeCartId: String(cartId) };
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
    await writeCartStateForConversation(conversationId, { activeCartId: null });
    return { id: conversationId, activeCartId: null };
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
    const state = await resolveCartStateForConversation(conversationId);
    if (!state.shippingAddress) {
      return null;
    }

    return typeof state.shippingAddress === "string"
      ? JSON.parse(state.shippingAddress)
      : state.shippingAddress;
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
    const shippingAddress = JSON.stringify(address);
    await writeCartStateForConversation(conversationId, { shippingAddress });

    const firstName = String(address.first_name || "").trim();
    const lastName = String(address.last_name || "").trim();
    if (firstName || lastName) {
      const ensured = await ensureConversationShopperKey(conversationId);
      if (ensured?.shopperId) {
        await upsertShopperCartFields(ensured.shopperId, {
          ...(firstName ? { customerFirstName: firstName } : {}),
          ...(lastName ? { customerLastName: lastName } : {})
        });
      }
    }

    return { id: conversationId, shippingAddress };
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
    await writeCartStateForConversation(conversationId, {
      shippingAddress: null
    });
    return { id: conversationId, shippingAddress: null };
  } catch (error) {
    console.error("Error clearing conversation shipping address:", error);
    return null;
  }
}

/**
 * Get stored shopper profile for LLM context (shared across conversations).
 */
export async function getConversationCustomerProfile(conversationId) {
  if (!conversationId) {
    return null;
  }

  try {
    const meta = await getConversationShopperMeta(conversationId);
    if (!meta?.shopperId) {
      return {
        firstName: null,
        lastName: null,
        loggedIn: false,
        shopifyCustomerId: null,
        shopDomain: null
      };
    }

    const shopper = await prisma.shopperCart.findUnique({
      where: { id: meta.shopperId }
    });

    if (!shopper) {
      return {
        firstName: null,
        lastName: null,
        loggedIn: false,
        shopifyCustomerId: null,
        shopDomain: null
      };
    }

    return {
      firstName: shopper.customerFirstName || null,
      lastName: shopper.customerLastName || null,
      loggedIn: Boolean(shopper.customerLoggedIn),
      shopifyCustomerId: shopper.shopifyCustomerId || null,
      shopDomain: null
    };
  } catch (error) {
    console.error("Error retrieving conversation customer profile:", error);
    return null;
  }
}

/**
 * Persist shopper profile fields (shared across conversations via ShopperCart).
 */
export async function setConversationCustomerProfile(
  conversationId,
  {
    firstName = null,
    lastName = null,
    loggedIn = false,
    shopifyCustomerId = null,
    shopDomain = null,
    anonymousShopperId = null
  } = {}
) {
  if (!conversationId) {
    return null;
  }

  try {
    const normalizedFirst = String(firstName || "").trim();
    const normalizedLast = String(lastName || "").trim();
    const normalizedCustomerId = String(shopifyCustomerId || "").trim();
    const anonId = String(anonymousShopperId || "").trim();

    void shopDomain; // single-shop; kept for caller compatibility

    // Only re-key when we have a real shopper identity (customer or anon).
    // Never force a conversation-only re-key here when identity is missing —
    // that would break shared carts. Pass anonymousShopperId/customer id to re-key.
    if (normalizedCustomerId || anonId) {
      await bindConversationShopper(conversationId, {
        shopifyCustomerId: normalizedCustomerId || null,
        anonymousShopperId: anonId || null,
        firstName: normalizedFirst || null,
        lastName: normalizedLast || null,
        loggedIn: loggedIn || Boolean(normalizedCustomerId)
      });
    }

    const ensured = await ensureConversationShopperKey(conversationId);
    if (!ensured?.shopperId) return null;

    const data = {};
    if (normalizedFirst) data.customerFirstName = normalizedFirst;
    if (normalizedLast) data.customerLastName = normalizedLast;
    if (loggedIn || normalizedCustomerId) data.customerLoggedIn = true;
    if (normalizedCustomerId) data.shopifyCustomerId = normalizedCustomerId;

    if (Object.keys(data).length === 0) {
      return null;
    }

    return await upsertShopperCartFields(ensured.shopperId, data);
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
 * Profile is stored on ShopperCart (shared), not on Conversation.
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
    void shopDomain; // single-shop; kept for caller compatibility
    await createOrUpdateConversation(id);

    const profile = await getConversationCustomerProfile(id);
    const ownedBy = profile?.shopifyCustomerId
      ? String(profile.shopifyCustomerId).trim()
      : "";

    if (ownedBy && ownedBy !== customerId) {
      return { ok: false, reason: "owned_by_other" };
    }

    const normalizedFirst = String(firstName || "").trim() || null;
    const normalizedLast = String(lastName || "").trim() || null;

    const alreadyLinked =
      ownedBy === customerId &&
      profile?.loggedIn === true &&
      (!normalizedFirst || profile.firstName === normalizedFirst) &&
      (!normalizedLast || profile.lastName === normalizedLast);

    await bindConversationShopper(id, {
      shopifyCustomerId: customerId,
      firstName: normalizedFirst,
      lastName: normalizedLast,
      loggedIn: true
    });

    return { ok: true, conversationId: id, claimed: !alreadyLinked && !ownedBy };
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

  void shopDomain; // single-shop

  const parsedLimit = limit == null || limit === "" ? null : Number(limit);
  const take =
    parsedLimit == null || !Number.isFinite(parsedLimit) || parsedLimit <= 0
      ? null
      : Math.floor(parsedLimit);

  try {
    const shoppers = await prisma.shopperCart.findMany({
      where: { shopifyCustomerId: customerId },
      select: { id: true }
    });
    const shopperIds = shoppers.map((row) => row.id).filter(Boolean);

    if (!shopperIds.length) return [];

    const conversations = await prisma.conversation.findMany({
      where: { shopperId: { in: shopperIds } },
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
    const state = await resolveCartStateForConversation(conversationId);
    return state.activeCheckoutId || null;
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
    const state = await resolveCartStateForConversation(conversationId);
    return state.checkoutUrl || null;
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
    await writeCartStateForConversation(conversationId, {
      activeCheckoutId: String(checkoutId)
    });
    return { id: conversationId, activeCheckoutId: String(checkoutId) };
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
    const previousState = await resolveCartStateForConversation(conversationId);
    const previous = previousState.checkoutUrl || null;
    const changed = Boolean(previous && previous !== nextUrl);

    await writeCartStateForConversation(conversationId, {
      checkoutUrl: nextUrl
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
    await writeCartStateForConversation(conversationId, {
      activeCheckoutId: null
    });
    return { id: conversationId, activeCheckoutId: null };
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
    await writeCartStateForConversation(conversationId, {
      activeCheckoutId: null,
      checkoutUrl: null
    });
    return { id: conversationId, activeCheckoutId: null, checkoutUrl: null };
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
export async function storeLlmRequestLog({
  request,
  response,
  statusCode,
  provider,
  conversationId = null
}) {
  try {
    return await prisma.llmRequestLog.create({
      data: {
        conversationId: conversationId ? String(conversationId) : null,
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

/** Default manishclothes digest used if DB row is missing. */
export const DEFAULT_STORE_POLICY_DIGEST = {
  id: "default",
  title: "manishclothes store policy cheat sheet",
  note:
    "Returned when Shopify search_shop_policies_and_faqs is empty. Prefer these quick facts; do not invent policy details.",
  contentDate: "2026-09-11",
  digest: `manishclothes quick facts — use these before inventing anything. Store: https://manishclothes.myshopify.com/

CONTACT: No public support email or phone is published on the storefront. Direct customers to https://manishclothes.myshopify.com/ or their Shopify account. Do not invent an email or phone number.

PRODUCTS: Online shop named manishclothes. Navigation: Home, Catalog, Search By Make. Published products include clothing (e.g. tshirt for men with color/size variants) and gift cards. Search the live catalog for what is in stock — do not invent product names, prices, or categories.

CURRENCY: Storefront shows INR (₹) as the selected currency, with GBP and USD also available in the currency selector.

PAYMENTS: Footer lists Visa, Mastercard, American Express, PayPal, Diners Club, and Discover.

SHIPPING / WHERE WE DELIVER: No shipping policy page is published. Do NOT invent countries, transit times, P.O. Box rules, or exclusions. Do NOT say the store does not ship to India or Asia. If asked where you ship, say availability and cost are shown at checkout, and you do not have a published country list.

CANCEL ORDER: No cancel policy is published. Do not invent a before-dispatch rule. If asked, say they should check their order status in their account or contact the store through the website.

RETURNS / REFUNDS: A Return Order page exists at https://manishclothes.myshopify.com/pages/return-order but it has no published policy text. Do NOT invent a 30-day window, prepaid labels, or country-specific refund rules.

WARRANTY: No warranty page is published. Do not invent product warranties.

PRIVACY: No privacy policy page is published. Do not invent privacy/legal details.

TERMS: No terms of service page is published. Do not invent terms, company legal names, or subscription-cancel rules.`
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
