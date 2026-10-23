import prisma from "../db.server.js";

/**
 * Parse start/end date strings (YYYY-MM-DD) into Prisma Date range { gte, lte }
 */
export function parseDateRange(startDate, endDate) {
  const result = {};
  if (startDate && String(startDate).trim()) {
    const s = String(startDate).trim();
    const parts = s.split("-");
    if (parts.length === 3) {
      const y = parseInt(parts[0], 10);
      const m = parseInt(parts[1], 10) - 1;
      const d = parseInt(parts[2], 10);
      if (!isNaN(y) && !isNaN(m) && !isNaN(d)) {
        result.gte = new Date(y, m, d, 0, 0, 0, 0);
      }
    } else {
      const parsed = new Date(s);
      parsed.setHours(0, 0, 0, 0);
      if (!isNaN(parsed.getTime())) result.gte = parsed;
    }
  }
  if (endDate && String(endDate).trim()) {
    const e = String(endDate).trim();
    const parts = e.split("-");
    if (parts.length === 3) {
      const y = parseInt(parts[0], 10);
      const m = parseInt(parts[1], 10) - 1;
      const d = parseInt(parts[2], 10);
      if (!isNaN(y) && !isNaN(m) && !isNaN(d)) {
        result.lte = new Date(y, m, d, 23, 59, 59, 999);
      }
    } else {
      const parsed = new Date(e);
      parsed.setHours(23, 59, 59, 999);
      if (!isNaN(parsed.getTime())) result.lte = parsed;
    }
  }
  return Object.keys(result).length > 0 ? result : null;
}

/**
 * Parse start/end date strings (YYYY-MM-DD) into Unix epoch integer range { gte, lte }
 */
export function parseEpochRange(startDate, endDate) {
  const dr = parseDateRange(startDate, endDate);
  if (!dr) return null;
  const result = {};
  if (dr.gte) result.gte = Math.floor(dr.gte.getTime() / 1000);
  if (dr.lte) result.lte = Math.floor(dr.lte.getTime() / 1000);
  return result;
}

/**
 * Overview statistics for dashboard header
 */
export async function getAdminOverviewStats() {
  try {
    const [
      totalShoppers,
      totalCustomers,
      totalConversations,
      totalMessages,
      totalLlmLogs,
      totalMcpLogs,
      totalKnowledgeDocs,
      totalKnowledgeChunks,
      totalShopifyEvents,
    ] = await Promise.all([
      prisma.shopperCart.count(),
      prisma.storeCustomer.count(),
      prisma.conversation.count(),
      prisma.message.count(),
      prisma.llmRequestLog.count(),
      prisma.mcpCallLog.count(),
      prisma.knowledgeDocument.count(),
      prisma.knowledgeChunk.count(),
      prisma.shopifyEventLog.count(),
    ]);

    // Count guests in shopper carts (null or empty shopifyCustomerId)
    const guestShoppers = await prisma.shopperCart.count({
      where: {
        OR: [
          { shopifyCustomerId: null },
          { shopifyCustomerId: "" },
        ],
      },
    });

    return {
      totalShoppers,
      guestShoppers,
      identifiedShoppers: Math.max(0, totalShoppers - guestShoppers),
      totalCustomers,
      totalConversations,
      totalMessages,
      totalLlmLogs,
      totalMcpLogs,
      totalKnowledgeDocs,
      totalKnowledgeChunks,
      totalShopifyEvents,
    };
  } catch (error) {
    console.error("[AdminQueries] Error fetching overview stats:", error);
    return {
      totalShoppers: 0,
      guestShoppers: 0,
      identifiedShoppers: 0,
      totalCustomers: 0,
      totalConversations: 0,
      totalMessages: 0,
      totalLlmLogs: 0,
      totalMcpLogs: 0,
      totalKnowledgeDocs: 0,
      totalKnowledgeChunks: 0,
      totalShopifyEvents: 0,
    };
  }
}

/**
 * Fetch paginated shoppers (customers & guests) with their cart details, search memories, addresses, and conversations
 */
export async function getShoppersPaginated({ search = "", filter = "all", sortOrder = "desc", page = 1, limit = 20, startDate = "", endDate = "" } = {}) {
  try {
    const andClauses = [];

    const epochRange = parseEpochRange(startDate, endDate);
    if (epochRange) {
      andClauses.push({
        updatedAt: epochRange,
      });
    }

    if (filter === "guest") {
      andClauses.push({
        OR: [{ shopifyCustomerId: null }, { shopifyCustomerId: "" }],
      });
    } else if (filter === "customer") {
      andClauses.push({
        shopifyCustomerId: { not: null },
      });
      andClauses.push({
        shopifyCustomerId: { not: "" },
      });
    } else if (filter === "cart") {
      andClauses.push({
        activeCartId: { not: null },
      });
    }

    if (search && search.trim()) {
      const q = search.trim();
      const qClean = q.replace(/^#/, "").trim();
      const terms = q.split(/\s+/).filter(Boolean);

      // 1. Search StoreCustomer table strictly for matching name, email, or shopifyCustomerId
      const storeCustomerOr = [
        { email: { contains: q } },
        { firstName: { contains: q } },
        { lastName: { contains: q } },
        { shopifyCustomerId: { contains: q } },
      ];

      if (qClean !== q) {
        storeCustomerOr.push(
          { email: { contains: qClean } },
          { firstName: { contains: qClean } },
          { lastName: { contains: qClean } },
          { shopifyCustomerId: { contains: qClean } }
        );
      }

      // If multi-word search (e.g. "Shivam Sahu")
      if (terms.length > 1) {
        storeCustomerOr.push(
          {
            AND: [
              { firstName: { contains: terms[0] } },
              { lastName: { contains: terms[terms.length - 1] } },
            ],
          },
          {
            AND: [
              { firstName: { contains: terms[terms.length - 1] } },
              { lastName: { contains: terms[0] } },
            ],
          }
        );
      }

      // Collect customer IDs from StoreCustomer
      let matchedCustomerIds = [];
      try {
        const matchedCustomers = await prisma.storeCustomer.findMany({
          where: { OR: storeCustomerOr },
          select: { shopifyCustomerId: true },
          take: 300,
        });
        matchedCustomerIds = matchedCustomers
          .map((c) => c.shopifyCustomerId)
          .filter((id) => Boolean(id && String(id).trim()));
      } catch (err) {
        console.error("[AdminQueries] Error searching StoreCustomer:", err);
      }

      // 2. Build search conditions for ShopperCart (only Name, Shopper ID, and matched Customer ID)
      const searchConditions = [
        { id: { contains: q } },
        { customerFirstName: { contains: q } },
        { customerLastName: { contains: q } },
        { shopifyCustomerId: { contains: q } },
      ];

      if (qClean !== q) {
        searchConditions.push(
          { id: { contains: qClean } },
          { customerFirstName: { contains: qClean } },
          { customerLastName: { contains: qClean } },
          { shopifyCustomerId: { contains: qClean } }
        );
      }

      // 1. Search at SQL query level using CONCAT('Guest-', id) LIKE ?
      // This allows matching ANY substring: "Guest-44f09a50", "t-44f09a50", "est-44f", etc.
      if (q.length >= 2) {
        try {
          const guestRows = await prisma.$queryRawUnsafe(
            "SELECT id FROM ShopperCart WHERE ('Guest-' || id) LIKE ? LIMIT 100",
            `%${q}%`
          );
          if (Array.isArray(guestRows) && guestRows.length > 0) {
            const guestIds = guestRows.map((r) => r.id).filter(Boolean);
            if (guestIds.length > 0) {
              searchConditions.push({ id: { in: guestIds } });
            }
          }
        } catch (err) {
          console.error("[AdminQueries] Error searching CONCAT('Guest-', id):", err);
        }
      }

      // 2. Also strip any partial "guest-" prefix e.g. "Guest-44f09a50", "t-44f09a50", "st-44f09a50"
      const strippedGuestId = q
        .replace(/^(?:guest|uest|est|st|t)[-_\s(]*/i, "")
        .replace(/[)]+$/, "")
        .trim();
      if (strippedGuestId && strippedGuestId !== q) {
        searchConditions.push({ id: { contains: strippedGuestId } });
      }

      // 3. Support generic "guest" search
      if (q.toLowerCase() === "guest" || q.toLowerCase() === "guest-") {
        searchConditions.push(
          { shopifyCustomerId: null },
          { shopifyCustomerId: "" }
        );
      }

      // If matching customers were found in StoreCustomer, include their carts
      if (matchedCustomerIds.length > 0) {
        searchConditions.push({
          shopifyCustomerId: { in: matchedCustomerIds },
        });
      }

      // If multi-word search (e.g. "Shivam Sahu")
      if (terms.length > 1) {
        searchConditions.push(
          {
            AND: [
              { customerFirstName: { contains: terms[0] } },
              { customerLastName: { contains: terms[terms.length - 1] } },
            ],
          },
          {
            AND: [
              { customerFirstName: { contains: terms[terms.length - 1] } },
              { customerLastName: { contains: terms[0] } },
            ],
          }
        );
      }

      andClauses.push({ OR: searchConditions });
    }

    const where = andClauses.length > 0 ? { AND: andClauses } : {};

    const normalizedSort = String(sortOrder).toLowerCase() === "asc" ? "asc" : "desc";

    const [total, carts] = await Promise.all([
      prisma.shopperCart.count({ where }),
      prisma.shopperCart.findMany({
        where,
        orderBy: { updatedAt: normalizedSort },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    if (carts.length === 0) {
      return {
        shoppers: [],
        total,
        page,
        limit,
        sortOrder: normalizedSort,
        totalPages: Math.ceil(total / limit) || 1,
      };
    }

    const shopperIds = carts.map((c) => c.id);
    const customerIds = carts
      .map((c) => c.shopifyCustomerId)
      .filter((id) => Boolean(id && String(id).trim()));

    // Fast lightweight parallel fetch: only get basic customer info and counts
    const [customers, memCounts, convCounts] = await Promise.all([
      customerIds.length > 0
        ? prisma.storeCustomer.findMany({
            where: { shopifyCustomerId: { in: customerIds } },
            select: { id: true, shopifyCustomerId: true, firstName: true, lastName: true, email: true },
          })
        : [],
      prisma.shopperSearchMemory.groupBy({
        by: ["shopperId"],
        where: { shopperId: { in: shopperIds } },
        _count: { shopperId: true },
      }),
      prisma.conversation.groupBy({
        by: ["shopperId"],
        where: { shopperId: { in: shopperIds } },
        _count: { shopperId: true },
      }),
    ]);

    const customerMap = new Map();
    for (const c of customers) customerMap.set(c.shopifyCustomerId, c);

    const memCountMap = new Map();
    for (const m of memCounts) memCountMap.set(m.shopperId, m._count.shopperId);

    const convCountMap = new Map();
    for (const cv of convCounts) convCountMap.set(cv.shopperId, cv._count.shopperId);

    const shoppers = carts.map((cart) => {
      const isGuest = !cart.shopifyCustomerId || String(cart.shopifyCustomerId).trim() === "";
      const customer = !isGuest ? customerMap.get(cart.shopifyCustomerId) : null;

      let parsedShipping = null;
      if (cart.shippingAddress) {
        try {
          parsedShipping = JSON.parse(cart.shippingAddress);
        } catch {
          try {
            parsedShipping = JSON.parse(cart.shippingAddress + "}");
          } catch {
            parsedShipping = null;
          }
        }
      }

      let displayName = "Guest";
      if (customer?.firstName || customer?.lastName) {
        displayName = `${customer.firstName || ""} ${customer.lastName || ""}`.trim();
      } else if (cart.customerFirstName || cart.customerLastName) {
        displayName = `${cart.customerFirstName || ""} ${cart.customerLastName || ""}`.trim();
      } else if (parsedShipping?.name || parsedShipping?.firstName || parsedShipping?.first_name) {
        const guestName = (parsedShipping.name || `${parsedShipping.firstName || parsedShipping.first_name || ""} ${parsedShipping.lastName || parsedShipping.last_name || ""}`).trim();
        displayName = guestName || `Guest-${cart.id.slice(0, 8)}`;
      } else if (isGuest) {
        displayName = `Guest-${cart.id.slice(0, 8)}`;
      }

      const email = customer?.email || parsedShipping?.email || null;

      return {
        id: cart.id,
        isGuest,
        displayName,
        email,
        shopifyCustomerId: cart.shopifyCustomerId,
        customerLoggedIn: cart.customerLoggedIn,
        activeCartId: cart.activeCartId,
        activeCheckoutId: cart.activeCheckoutId,
        checkoutUrl: cart.checkoutUrl,
        shippingAddress: parsedShipping,
        searchMemoryCount: memCountMap.get(cart.id) || 0,
        conversationCount: convCountMap.get(cart.id) || 0,
        createdAtDate: new Date(cart.createdAt * 1000),
        updatedAtDate: new Date(cart.updatedAt * 1000),
      };
    });

    return {
      shoppers,
      total,
      page,
      limit,
      sortOrder: normalizedSort,
      totalPages: Math.ceil(total / limit) || 1,
    };
  } catch (error) {
    console.error("[AdminQueries] Error fetching paginated shoppers list:", error);
    return { shoppers: [], total: 0, page: 1, limit, sortOrder: "desc", totalPages: 1 };
  }
}

/**
 * Fetch full shopper details on-demand when inspect is clicked
 */
export async function getShopperDetails(shopperId) {
  if (!shopperId) return null;

  try {
    const cart = await prisma.shopperCart.findUnique({
      where: { id: shopperId },
    });
    if (!cart) return null;

    const isGuest = !cart.shopifyCustomerId || String(cart.shopifyCustomerId).trim() === "";

    const [customer, searchMemories, conversations] = await Promise.all([
      !isGuest
        ? prisma.storeCustomer.findFirst({
            where: { shopifyCustomerId: cart.shopifyCustomerId },
            include: { addresses: true },
          })
        : null,
      prisma.shopperSearchMemory.findMany({
        where: { shopperId },
        orderBy: { lastUsedAt: "desc" },
      }),
      prisma.conversation.findMany({
        where: { shopperId },
        include: {
          _count: { select: { messages: true } },
          messages: {
            take: 6,
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            select: { id: true, content: true, role: true, createdAt: true },
          },
        },
        orderBy: { updatedAt: "desc" },
      }),
    ]);

    let parsedShipping = null;
    if (cart.shippingAddress) {
      try {
        parsedShipping = JSON.parse(cart.shippingAddress);
      } catch {
        try {
          parsedShipping = JSON.parse(cart.shippingAddress + "}");
        } catch {
          parsedShipping = cart.shippingAddress;
        }
      }
    }

    let displayName = "Guest";
    if (customer?.firstName || customer?.lastName) {
      displayName = `${customer.firstName || ""} ${customer.lastName || ""}`.trim();
    } else if (cart.customerFirstName || cart.customerLastName) {
      displayName = `${cart.customerFirstName || ""} ${cart.customerLastName || ""}`.trim();
    } else if (parsedShipping?.name || parsedShipping?.firstName || parsedShipping?.first_name) {
      const guestName = (parsedShipping.name || `${parsedShipping.firstName || parsedShipping.first_name || ""} ${parsedShipping.lastName || parsedShipping.last_name || ""}`).trim();
      displayName = guestName || `Guest-${cart.id.slice(0, 8)}`;
    } else if (isGuest) {
      displayName = `Guest-${cart.id.slice(0, 8)}`;
    }

    const email = customer?.email || parsedShipping?.email || null;

    const formattedConversations = conversations.map((conv) => {
      let firstMessage = "";
      let firstMessageRole = "";
      if (conv.messages && conv.messages.length > 0) {
        const userMsg = conv.messages.find((m) => m.role === "user");
        const msgToUse = userMsg || conv.messages[0];
        firstMessageRole = msgToUse.role;
        const rawText = stripVariantIdForDisplay(extractTextFromMessage(msgToUse.content));
        firstMessage = rawText ? rawText.slice(0, 240) : "";
      }
      return {
        id: conv.id,
        createdAt: conv.createdAt,
        updatedAt: conv.updatedAt,
        _count: conv._count,
        messageCount: conv._count?.messages || 0,
        isActive: conv.id === cart.activeConversationId,
        firstMessage,
        firstMessageRole,
        snippet: firstMessage,
        snippetRole: firstMessageRole,
      };
    });

    return {
      id: cart.id,
      isGuest,
      displayName,
      email,
      shopifyCustomerId: cart.shopifyCustomerId,
      customerLoggedIn: cart.customerLoggedIn,
      activeConversationId: cart.activeConversationId,
      activeCartId: cart.activeCartId,
      activeCheckoutId: cart.activeCheckoutId,
      checkoutUrl: cart.checkoutUrl,
      shippingAddress: parsedShipping,
      cart,
      addresses: customer?.addresses || [],
      searchMemories,
      conversations: formattedConversations,
      conversationCount: formattedConversations.length,
      createdAtDate: new Date(cart.createdAt * 1000),
      updatedAtDate: new Date(cart.updatedAt * 1000),
    };
  } catch (error) {
    console.error(`[AdminQueries] Error fetching details for shopper ${shopperId}:`, error);
    return null;
  }
}

/**
 * Backward compatible helper for shoppers list
 */
export async function getShoppersList({ search = "", filter = "all", limit = 20, page = 1 } = {}) {
  const res = await getShoppersPaginated({ search, filter, page, limit });
  return res.shoppers;
}

function stripVariantIdForDisplay(text) {
  return String(text || "")
    .replace(/\s*using\s+variant_id:\s*gid:\/\/shopify\/ProductVariant\/\d+/gi, "")
    .replace(/\s*variant_id:\s*gid:\/\/shopify\/ProductVariant\/\d+/gi, "")
    .replace(/\s*gid:\/\/shopify\/ProductVariant\/\d+/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function extractTextFromMessage(content) {
  if (!content) return "";
  if (typeof content !== "string") return String(content);
  const trimmed = content.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      const textItem = items.find((it) => it && it.type === "text" && it.text && it.text.trim());
      if (textItem) return textItem.text.trim();
      const hasOnlyInternal = items.every((it) =>
        it?.type === "product_results" ||
        it?.type === "tool_use" ||
        it?.type === "tool_result" ||
        it?.type === "fitment_options" ||
        it?.type === "customer_addresses" ||
        it?.type === "install_resources"
      );
      if (hasOnlyInternal) return "";
    } catch {}
  }
  return trimmed;
}

/**
 * Fetch paginated list of conversations with shopper/customer preview and message counts
 */
export async function getConversationsPaginated({ search = "", user = "", page = 1, limit = 20, startDate = "", endDate = "" } = {}) {
  try {
    const andConditions = [];

    const dateRange = parseDateRange(startDate, endDate);
    if (dateRange) {
      andConditions.push({
        OR: [
          { updatedAt: dateRange },
          { createdAt: dateRange },
        ],
      });
    }

    // 1. User Filter
    if (user && user.trim()) {
      const u = user.trim();
      if (u === "guest") {
        // Find named or customer carts to exclude
        const namedCarts = await prisma.shopperCart.findMany({
          where: {
            OR: [
              { shopifyCustomerId: { not: null } },
              { customerFirstName: { not: null } },
              { customerLastName: { not: null } },
            ],
          },
          select: { id: true },
        });
        const namedIds = namedCarts.map((c) => c.id);
        andConditions.push({
          OR: [
            { shopperId: { notIn: namedIds } },
            { shopperId: null },
          ],
        });
      } else if (u.startsWith("customer:")) {
        const custId = u.replace("customer:", "").trim();
        const storeCust = await prisma.storeCustomer.findFirst({
          where: { shopifyCustomerId: custId },
          select: { firstName: true, lastName: true },
        });
        const cartOr = [
          { shopifyCustomerId: custId },
          { shopifyCustomerId: { contains: custId } },
        ];
        if (storeCust?.firstName) {
          cartOr.push({ customerFirstName: { contains: storeCust.firstName } });
        }
        const matchingCarts = await prisma.shopperCart.findMany({
          where: { OR: cartOr },
          select: { id: true },
        });
        const shopperIds = matchingCarts.map((c) => c.id);
        andConditions.push({ shopperId: { in: shopperIds } });
      } else if (u.startsWith("name:")) {
        const name = u.replace("name:", "").trim();
        const words = name.split(/\s+/).filter(Boolean);
        const nameConditions = [
          { customerFirstName: { contains: name } },
          { customerLastName: { contains: name } },
        ];
        if (words.length > 1) {
          nameConditions.push({
            AND: [
              { customerFirstName: { contains: words[0] } },
              { customerLastName: { contains: words.slice(1).join(" ") } },
            ],
          });
          nameConditions.push({
            AND: [
              { customerFirstName: { contains: words.slice(1).join(" ") } },
              { customerLastName: { contains: words[0] } },
            ],
          });
        }
        const matchingCarts = await prisma.shopperCart.findMany({
          where: { OR: nameConditions },
          select: { id: true },
        });
        const shopperIds = matchingCarts.map((c) => c.id);
        andConditions.push({ shopperId: { in: shopperIds } });
      } else if (u.startsWith("shopper:") || u.startsWith("guest:")) {
        const sId = u.replace(/^(?:shopper|guest):/, "").trim();
        andConditions.push({
          OR: [
            { shopperId: sId },
            { shopperId: { contains: sId } },
          ],
        });
      } else if (u.toLowerCase().startsWith("guest-")) {
        const sId = u.slice(6).trim();
        andConditions.push({
          OR: [
            { shopperId: sId },
            { shopperId: { contains: sId } },
          ],
        });
      } else {
        andConditions.push({
          OR: [
            { shopperId: u },
            { shopperId: { contains: u } },
          ],
        });
      }
    }

    // 2. Search Text Filter
    if (search && search.trim()) {
      const q = search.trim();
      const qClean = q.replace(/^#/, "").trim();
      const words = q.split(/\s+/).filter(Boolean);

      // Search matching ShopperCart records by customer name
      const shopperOr = [
        { customerFirstName: { contains: q } },
        { customerLastName: { contains: q } },
        { customerFirstName: { contains: qClean } },
        { customerLastName: { contains: qClean } },
        { id: { contains: q } },
        { id: { contains: qClean } },
      ];

      // Strip any partial "guest-" prefix e.g. "t-44f09a50", "Guest-44f09a50"
      const strippedConvId = q
        .replace(/^(?:guest|uest|est|st|t)[-_\s(]*/i, "")
        .replace(/[)]+$/, "")
        .trim();
      if (strippedConvId && strippedConvId !== q) {
        shopperOr.push({ id: { contains: strippedConvId } });
      }

      if (q.length >= 2) {
        try {
          const guestConvRows = await prisma.$queryRawUnsafe(
            "SELECT id FROM ShopperCart WHERE ('Guest-' || id) LIKE ? LIMIT 100",
            `%${q}%`
          );
          if (Array.isArray(guestConvRows) && guestConvRows.length > 0) {
            const guestIds = guestConvRows.map((r) => r.id).filter(Boolean);
            if (guestIds.length > 0) {
              shopperOr.push({ id: { in: guestIds } });
            }
          }
        } catch (err) {}
      }

      if (words.length > 1) {
        shopperOr.push({
          AND: [
            { customerFirstName: { contains: words[0] } },
            { customerLastName: { contains: words.slice(1).join(" ") } },
          ],
        });
        shopperOr.push({
          AND: [
            { customerFirstName: { contains: words.slice(1).join(" ") } },
            { customerLastName: { contains: words[0] } },
          ],
        });
      }

      // Also search StoreCustomer for first/last name/email
      const storeCustOr = [
        { firstName: { contains: q } },
        { lastName: { contains: q } },
        { email: { contains: q } },
      ];
      if (words.length > 1) {
        storeCustOr.push({
          AND: [
            { firstName: { contains: words[0] } },
            { lastName: { contains: words.slice(1).join(" ") } },
          ],
        });
      }

      const [matchingShoppers, matchingStoreCustomers] = await Promise.all([
        prisma.shopperCart.findMany({
          where: { OR: shopperOr },
          select: { id: true },
        }),
        prisma.storeCustomer.findMany({
          where: { OR: storeCustOr },
          select: { shopifyCustomerId: true },
        }),
      ]);

      const shopperIdsFromCarts = matchingShoppers.map((s) => s.id);
      const customerIdsFromStore = matchingStoreCustomers
        .map((sc) => sc.shopifyCustomerId)
        .filter(Boolean);

      let extraShopperIds = [];
      if (customerIdsFromStore.length > 0) {
        const extraCarts = await prisma.shopperCart.findMany({
          where: { shopifyCustomerId: { in: customerIdsFromStore } },
          select: { id: true },
        });
        extraShopperIds = extraCarts.map((c) => c.id);
      }

      const allMatchingShopperIds = Array.from(
        new Set([...shopperIdsFromCarts, ...extraShopperIds])
      );

      const conversationOr = [
        { id: { contains: q } },
        { id: { contains: qClean } },
        { shopperId: { contains: q } },
        { shopperId: { contains: qClean } },
        { messages: { some: { content: { contains: q } } } },
      ];

      if (strippedConvId && strippedConvId !== q) {
        conversationOr.push(
          { shopperId: { contains: strippedConvId } },
          { id: { contains: strippedConvId } }
        );
      }

      if (q.length >= 2) {
        try {
          const guestMatches = await prisma.$queryRawUnsafe(
            "SELECT DISTINCT shopperId FROM Conversation WHERE shopperId IS NOT NULL AND (('Guest-' || SUBSTR(shopperId, 1, 8)) LIKE ? OR ('Guest-' || shopperId) LIKE ?) LIMIT 100",
            `%${q}%`,
            `%${q}%`
          );
          if (Array.isArray(guestMatches) && guestMatches.length > 0) {
            const guestIds = guestMatches.map((r) => r.shopperId).filter(Boolean);
            if (guestIds.length > 0) {
              conversationOr.push({ shopperId: { in: guestIds } });
            }
          }
        } catch (err) {}
      }

      if (allMatchingShopperIds.length > 0) {
        conversationOr.push({ shopperId: { in: allMatchingShopperIds } });
      }

      if (q.toLowerCase().includes("guest")) {
        const guestCarts = await prisma.shopperCart.findMany({
          where: {
            OR: [{ shopifyCustomerId: null }, { shopifyCustomerId: "" }],
          },
          select: { id: true },
        });
        const guestIds = guestCarts.map((c) => c.id);
        if (guestIds.length > 0) {
          conversationOr.push({ shopperId: { in: guestIds } });
        }
      }

      andConditions.push({ OR: conversationOr });
    }

    const where = andConditions.length > 0 ? { AND: andConditions } : {};

    const [total, conversations] = await Promise.all([
      prisma.conversation.count({ where }),
      prisma.conversation.findMany({
        where,
        include: {
          _count: { select: { messages: true } },
          messages: {
            take: 10,
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            select: { id: true, content: true, role: true, createdAt: true },
          },
        },
        orderBy: { updatedAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    const shopperIds = conversations.map((c) => c.shopperId).filter(Boolean);
    const shopperCarts = shopperIds.length > 0
      ? await prisma.shopperCart.findMany({
          where: { id: { in: shopperIds } },
          select: {
            id: true,
            shopifyCustomerId: true,
            customerFirstName: true,
            customerLastName: true,
            activeCartId: true,
          },
        })
      : [];

    const shopperMap = new Map();
    for (const sc of shopperCarts) shopperMap.set(sc.id, sc);

    const formattedConversations = conversations.map((c) => {
      const sc = c.shopperId ? shopperMap.get(c.shopperId) : null;
      const isGuest = !sc || !sc.shopifyCustomerId;
      const customerName = sc
        ? `${sc.customerFirstName || ""} ${sc.customerLastName || ""}`.trim()
        : null;

      // Extract the first customer message for clean thread preview
      let firstMessageText = "";
      if (Array.isArray(c.messages) && c.messages.length > 0) {
        for (const m of c.messages) {
          if (m.role === "user") {
            const text = extractTextFromMessage(m.content);
            if (text) {
              firstMessageText = text;
              break;
            }
          }
        }
        if (!firstMessageText) {
          for (const m of c.messages) {
            const text = extractTextFromMessage(m.content);
            if (text) {
              firstMessageText = text;
              break;
            }
          }
        }
      }

      return {
        id: c.id,
        shopperId: c.shopperId,
        isGuest,
        displayName: customerName || (isGuest ? `Guest-${(c.shopperId || "unknown").slice(0, 8)}` : "Customer"),
        messageCount: c._count.messages,
        firstMessage: firstMessageText || "New Conversation",
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      };
    });

    return {
      conversations: formattedConversations,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
    };
  } catch (error) {
    console.error("[AdminQueries] Error fetching paginated conversations list:", error);
    return { conversations: [], total: 0, page: 1, limit, totalPages: 1 };
  }
}

/**
 * Get aggregated users/customers with active conversation counts for the user filter dropdown
 * Supports lazy loading (page, limit) and searching (search) for handling 100k+ (1 lakh+) users efficiently!
 */
export async function getConversationUserFilters({ search = "", page = 1, limit = 25, selectedUser = "" } = {}) {
  try {
    // 1. Total and guest conversation counts directly via pure SQL
    const countsSql = `
      SELECT 
        COUNT(*) as totalConversations,
        SUM(
          CASE 
            WHEN COALESCE(sc.shopifyCustomerId, cust.shopifyCustomerId) IS NOT NULL THEN 0
            ELSE 1
          END
        ) as guestConversations
      FROM Conversation c
      LEFT JOIN ShopperCart sc ON c.shopperId = sc.id
      LEFT JOIN StoreCustomer cust ON sc.shopifyCustomerId = cust.shopifyCustomerId
    `;
    const countsRes = await prisma.$queryRawUnsafe(countsSql);
    const totalCount = Number(countsRes?.[0]?.totalConversations) || 0;
    const guestCount = Number(countsRes?.[0]?.guestConversations) || 0;

    // 2. Query users, grouped, ranked and filtered 100% in MySQL
    const params = [];
    let havingClause = "";

    if (search && search.trim()) {
      const qClean = search.trim().replace(/^#/, "").trim();
      const pattern = `%${qClean}%`;
      const words = qClean.split(/\s+/).filter(Boolean);

      const conditions = [
        "displayLabel LIKE ?",
        "email LIKE ?",
        "shopperId LIKE ?",
        "customerId LIKE ?",
        "userKey LIKE ?",
      ];
      params.push(pattern, pattern, pattern, pattern, pattern);

      if (words.length > 1) {
        const wordClauses = words.map(() => "(displayLabel LIKE ? OR email LIKE ?)").join(" AND ");
        conditions.push(`(${wordClauses})`);
        for (const w of words) {
          params.push(`%${w}%`, `%${w}%`);
        }
      }

      havingClause = "HAVING " + conditions.join(" OR ");
    }

    const offset = Math.max(0, (page - 1) * limit);
    const fetchLimit = limit + 1; // 1 extra to accurately determine hasMore

    const sql = `
      SELECT
        CASE 
          WHEN COALESCE(sc.shopifyCustomerId, cust.shopifyCustomerId) IS NOT NULL 
            THEN 'customer:' || COALESCE(sc.shopifyCustomerId, cust.shopifyCustomerId)
          ELSE 'shopper:' || c.shopperId
        END AS userKey,

        MAX(
          CASE 
            WHEN COALESCE(sc.shopifyCustomerId, cust.shopifyCustomerId) IS NOT NULL 
              THEN COALESCE(
                NULLIF(TRIM(COALESCE(cust.firstName, sc.customerFirstName, '') || ' ' || COALESCE(cust.lastName, sc.customerLastName, '')), ''),
                cust.email,
                'Customer #' || SUBSTR(COALESCE(sc.shopifyCustomerId, cust.shopifyCustomerId), -6)
              )
            WHEN (NULLIF(sc.customerFirstName, '') IS NOT NULL OR NULLIF(sc.customerLastName, '') IS NOT NULL)
              THEN TRIM(COALESCE(sc.customerFirstName, '') || ' ' || COALESCE(sc.customerLastName, ''))
            ELSE 'Guest-' || SUBSTR(c.shopperId, 1, 8)
          END
        ) AS displayLabel,

        CASE 
          WHEN COALESCE(sc.shopifyCustomerId, cust.shopifyCustomerId) IS NOT NULL 
            THEN 0
          ELSE 1
        END AS isGuest,

        MAX(COALESCE(sc.shopifyCustomerId, cust.shopifyCustomerId)) AS customerId,
        MAX(cust.email) AS email,
        MAX(c.shopperId) AS shopperId,
        COUNT(c.id) AS convCount
      FROM Conversation c
      LEFT JOIN ShopperCart sc ON c.shopperId = sc.id
      LEFT JOIN StoreCustomer cust ON sc.shopifyCustomerId = cust.shopifyCustomerId
      WHERE c.shopperId IS NOT NULL
      GROUP BY userKey, isGuest
      ${havingClause}
      ORDER BY convCount DESC
      LIMIT ? OFFSET ?;
    `;
    params.push(fetchLimit, offset);

    const rows = await prisma.$queryRawUnsafe(sql, ...params);
    const hasMore = rows.length > limit;
    const currentRows = hasMore ? rows.slice(0, limit) : rows;

    const users = currentRows.map((r) => {
      const isGuest = Boolean(Number(r.isGuest));
      const customerId = r.customerId || undefined;
      const hasNamedLabel = r.displayLabel && !r.displayLabel.toLowerCase().startsWith("guest-") && !r.displayLabel.toLowerCase().startsWith("customer #");
      const name = hasNamedLabel ? r.displayLabel : undefined;

      return {
        key: r.userKey,
        label: r.displayLabel,
        count: Number(r.convCount) || 1,
        isGuest,
        customerId,
        name,
        email: r.email || undefined,
        shopperId: r.shopperId,
      };
    });

    // 3. If selectedUser is specified and not in the current page, fetch directly via SQL and prepend
    if (selectedUser && selectedUser !== "all" && !users.some((u) => u.key === selectedUser)) {
      try {
        const cleanSelected = selectedUser.replace(/^(?:customer|shopper|guest|name)[:\s-]*/i, "").trim();
        const selectedSql = `
          SELECT
            CASE 
              WHEN COALESCE(sc.shopifyCustomerId, cust.shopifyCustomerId) IS NOT NULL 
                THEN 'customer:' || COALESCE(sc.shopifyCustomerId, cust.shopifyCustomerId)
              ELSE 'shopper:' || c.shopperId
            END AS userKey,

            MAX(
              CASE 
                WHEN COALESCE(sc.shopifyCustomerId, cust.shopifyCustomerId) IS NOT NULL 
                  THEN COALESCE(
                    NULLIF(TRIM(COALESCE(cust.firstName, sc.customerFirstName, '') || ' ' || COALESCE(cust.lastName, sc.customerLastName, '')), ''),
                    cust.email,
                    'Customer #' || SUBSTR(COALESCE(sc.shopifyCustomerId, cust.shopifyCustomerId), -6)
                  )
                WHEN (NULLIF(sc.customerFirstName, '') IS NOT NULL OR NULLIF(sc.customerLastName, '') IS NOT NULL)
                  THEN TRIM(COALESCE(sc.customerFirstName, '') || ' ' || COALESCE(sc.customerLastName, ''))
                ELSE 'Guest-' || SUBSTR(c.shopperId, 1, 8)
              END
            ) AS displayLabel,

            CASE 
              WHEN COALESCE(sc.shopifyCustomerId, cust.shopifyCustomerId) IS NOT NULL 
                THEN 0
              ELSE 1
            END AS isGuest,

            MAX(COALESCE(sc.shopifyCustomerId, cust.shopifyCustomerId)) AS customerId,
            MAX(cust.email) AS email,
            MAX(c.shopperId) AS shopperId,
            COUNT(c.id) AS convCount
          FROM Conversation c
          LEFT JOIN ShopperCart sc ON c.shopperId = sc.id
          LEFT JOIN StoreCustomer cust ON sc.shopifyCustomerId = cust.shopifyCustomerId
          WHERE c.shopperId IS NOT NULL
          GROUP BY userKey, isGuest
          HAVING userKey = ? OR shopperId = ? OR displayLabel = ? OR shopperId LIKE ?
          LIMIT 1;
        `;
        const selRows = await prisma.$queryRawUnsafe(
          selectedSql,
          selectedUser,
          cleanSelected,
          cleanSelected,
          `%${cleanSelected}%`
        );
        if (Array.isArray(selRows) && selRows.length > 0) {
          const r = selRows[0];
          const isGuest = Boolean(Number(r.isGuest));
          const hasNamedLabel = r.displayLabel && !r.displayLabel.toLowerCase().startsWith("guest-") && !r.displayLabel.toLowerCase().startsWith("customer #");
          users.unshift({
            key: r.userKey,
            label: r.displayLabel,
            count: Number(r.convCount) || 1,
            isGuest,
            customerId: r.customerId || undefined,
            name: hasNamedLabel ? r.displayLabel : undefined,
            email: r.email || undefined,
            shopperId: r.shopperId,
          });
        }
      } catch (err) {
        console.error("[AdminQueries] Error fetching selected user:", err);
      }
    }

    return {
      users,
      hasMore,
      page,
      totalCount,
      guestCount,
    };
  } catch (error) {
    console.error("[AdminQueries] Error fetching conversation user filters:", error);
    return { users: [], hasMore: false, page: 1, guestCount: 0, totalCount: 0 };
  }
}

/**
 * Backward compatible helper for conversations list
 */
export async function getConversationsList({ search = "", user = "", limit = 20, page = 1 } = {}) {
  const res = await getConversationsPaginated({ search, user, page, limit });
  return res.conversations;
}

/**
 * Get detailed conversation thread, messages with knowledge search results, MCP logs, and LLM logs
 */
export async function getConversationDetails(conversationId) {
  if (!conversationId) return null;

  try {
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      include: {
        messages: {
          orderBy: { createdAt: "asc" },
          include: {
            searchResults: {
              include: {
                chunk: {
                  include: {
                    document: {
                      select: { id: true, title: true, baseUrl: true, shopifyGraphqlId: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!conversation) return null;

    // Fetch MCP Call Logs for this conversation
    const mcpLogs = await prisma.mcpCallLog.findMany({
      where: { conversationId },
      orderBy: { createdAt: "desc" },
      take: 100,
    });

    // Fetch LLM Request Logs for this conversation
    const llmLogs = await prisma.llmRequestLog.findMany({
      where: { conversationId },
      orderBy: { createdAt: "desc" },
      take: 100,
    });

    // Fetch ShopperCart info if attached
    let shopperCart = null;
    let storeCustomer = null;
    if (conversation.shopperId) {
      shopperCart = await prisma.shopperCart.findUnique({
        where: { id: conversation.shopperId },
      });
      if (shopperCart?.shopifyCustomerId) {
        storeCustomer = await prisma.storeCustomer.findFirst({
          where: { shopifyCustomerId: shopperCart.shopifyCustomerId },
          include: { addresses: true },
        });
      }
    }

    const isGuest = !shopperCart || !shopperCart.shopifyCustomerId;

    // Associate knowledge search results with the corresponding Assistant messages
    // in the conversational turn so both tool call and user-facing assistant response
    // have access to the matched knowledge document and similarity scores.
    const messages = (conversation.messages || []).map((m) => ({
      ...m,
      searchResults: Array.isArray(m.searchResults) ? [...m.searchResults] : [],
    }));

    for (let i = 0; i < messages.length; i++) {
      const currentMsg = messages[i];
      if (currentMsg.role === "user" && currentMsg.searchResults.length > 0) {
        const turnAssistantMsgs = [];
        for (let j = i + 1; j < messages.length; j++) {
          if (messages[j].role === "assistant") {
            turnAssistantMsgs.push(messages[j]);
          } else if (
            messages[j].role === "user" &&
            !messages[j].content?.includes("tool_result")
          ) {
            break;
          }
        }

        if (turnAssistantMsgs.length > 0) {
          for (const asstMsg of turnAssistantMsgs) {
            asstMsg.searchResults = [
              ...(asstMsg.searchResults || []),
              ...currentMsg.searchResults,
            ];
          }
          currentMsg.searchResults = [];
        }
      }
    }

    return {
      conversation,
      messages,
      mcpLogs,
      llmLogs,
      shopperCart,
      storeCustomer,
      isGuest,
    };
  } catch (error) {
    console.error(`[AdminQueries] Error fetching details for conversation ${conversationId}:`, error);
    return null;
  }
}

/**
 * Fetch knowledge documents with source info, chunk count, file type filtering, and pagination
 */
export async function getKnowledgeDocumentsList({
  search = "",
  sourceId = "",
  fileType = "",
  page = 1,
  limit = 20,
  startDate = "",
  endDate = "",
} = {}) {
  try {
    const andConditions = [];

    const dateRange = parseDateRange(startDate, endDate);
    if (dateRange) {
      andConditions.push({
        OR: [
          { createdAt: dateRange },
          { updatedAt: dateRange },
        ],
      });
    }

    if (sourceId) {
      andConditions.push({ sourceId });
    }

    if (fileType === "pdf") {
      andConditions.push({
        OR: [
          { baseUrl: { startsWith: "file:pdf:" } },
          { shopifyGraphqlId: { startsWith: "file:pdf:" } },
        ],
      });
    } else if (fileType === "word" || fileType === "doc") {
      andConditions.push({
        OR: [
          { baseUrl: { startsWith: "file:doc:" } },
          { baseUrl: { startsWith: "file:docx:" } },
          { shopifyGraphqlId: { startsWith: "file:doc:" } },
          { shopifyGraphqlId: { startsWith: "file:docx:" } },
          { filePath: { endsWith: ".docx" } },
          { filePath: { endsWith: ".doc" } },
        ],
      });
    } else if (fileType === "excel") {
      andConditions.push({
        OR: [
          { baseUrl: { startsWith: "file:excel:" } },
          { shopifyGraphqlId: { startsWith: "file:excel:" } },
        ],
      });
    } else if (fileType === "file_upload") {
      andConditions.push({
        OR: [
          { baseUrl: { startsWith: "file:" } },
          { shopifyGraphqlId: { startsWith: "file:" } },
          { filePath: { not: null } },
        ],
      });
    } else if (fileType === "shopify") {
      andConditions.push({
        NOT: [
          { baseUrl: { startsWith: "file:" } },
          { shopifyGraphqlId: { startsWith: "file:" } },
        ],
      });
    }

    if (search && search.trim()) {
      const q = search.trim();
      andConditions.push({
        OR: [
          { title: { contains: q } },
          { shopifyGraphqlId: { contains: q } },
          { baseUrl: { contains: q } },
          { filePath: { contains: q } },
          { content: { contains: q } },
        ],
      });
    }

    const where = andConditions.length > 0 ? { AND: andConditions } : {};

    const [total, documents, sources] = await Promise.all([
      prisma.knowledgeDocument.count({ where }),
      prisma.knowledgeDocument.findMany({
        where,
        select: {
          id: true,
          shopifyGraphqlId: true,
          sourceId: true,
          title: true,
          baseUrl: true,
          filePath: true,
          version: true,
          chunkCount: true,
          tokenCount: true,
          embeddingTokens: true,
          embeddingCostUsd: true,
          processingMs: true,
          errorMessage: true,
          createdAt: true,
          updatedAt: true,
          source: true,
          _count: { select: { chunks: true } },
        },
        orderBy: { updatedAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.knowledgeSource.findMany({
        orderBy: { name: "asc" },
      }),
    ]);

    return {
      documents,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
      sources,
    };
  } catch (error) {
    console.error("[AdminQueries] Error fetching knowledge documents list:", error);
    return { documents: [], total: 0, page: 1, limit, totalPages: 1, sources: [] };
  }
}

/**
 * Delete a knowledge document and its associated chunks
 */
export async function deleteKnowledgeDocument(documentId) {
  try {
    const doc = await prisma.knowledgeDocument.findUnique({
      where: { id: documentId },
    });
    if (!doc) {
      return { success: false, error: "Document not found." };
    }
    await prisma.knowledgeChunk.deleteMany({
      where: { documentId },
    });
    await prisma.knowledgeDocument.delete({
      where: { id: documentId },
    });

    if (doc.filePath) {
      try {
        const remaining = await prisma.knowledgeDocument.count({
          where: { filePath: doc.filePath },
        });
        if (remaining === 0) {
          const fs = await import("fs");
          const path = await import("path");
          const fullPath = path.isAbsolute(doc.filePath)
            ? doc.filePath
            : path.join(process.cwd(), doc.filePath);
          if (fs.existsSync(fullPath)) {
            await fs.promises.unlink(fullPath).catch(() => {});
          }
        }
      } catch (_) {}
    }

    return { success: true, title: doc.title, documentId };
  } catch (err) {
    console.error(`[AdminQueries] Error deleting document ${documentId}:`, err);
    return { success: false, error: err.message || "Failed to delete document.", documentId };
  }
}

/**
 * Fetch full knowledge document details with all ordered chunks
 */
export async function getKnowledgeDocumentDetails(documentId) {
  try {
    const document = await prisma.knowledgeDocument.findUnique({
      where: { id: documentId },
      include: {
        source: true,
        chunks: {
          select: {
            id: true,
            documentId: true,
            chunkIndex: true,
            content: true,
            embeddingContent: true,
            tokenCount: true,
            metadata: true,
            llmCost: true,
            createdAt: true,
            updatedAt: true,
          },
          orderBy: { chunkIndex: "asc" },
        },
      },
    });
    return document;
  } catch (error) {
    console.error(`[AdminQueries] Error fetching details for doc ${documentId}:`, error);
    return null;
  }
}

/**
 * Fetch Shopify event logs with status, topic, and parsed entity info
 */
export async function getShopifyEventsList({ search = "", topic = "", status = "", page = 1, limit = 20, startDate = "", endDate = "" } = {}) {
  try {
    const where = {};
    if (topic) {
      where.topic = topic;
    }
    if (status) {
      where.status = status;
    }
    const dateRange = parseDateRange(startDate, endDate);
    if (dateRange) {
      where.createdAt = dateRange;
    }
    if (search && search.trim()) {
      const q = search.trim();
      where.OR = [
        { payload: { contains: q } },
        { eventId: { contains: q } },
        { errorMessage: { contains: q } },
      ];
    }

    const [total, events, topicsRaw] = await Promise.all([
      prisma.shopifyEventLog.count({ where }),
      prisma.shopifyEventLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.shopifyEventLog.findMany({
        select: { topic: true },
        distinct: ["topic"],
      }),
    ]);

    const formattedEvents = events.map((ev) => {
      let parsed = null;
      let entityId = null;
      let actionType = null;
      try {
        parsed = typeof ev.payload === "string" ? JSON.parse(ev.payload) : ev.payload;
        actionType = parsed?.action || parsed?.event_type || null;
        entityId =
          parsed?.data?.article?.id ||
          parsed?.article?.id ||
          parsed?.data?.page?.id ||
          parsed?.page?.id ||
          parsed?.data?.product?.id ||
          parsed?.product?.id ||
          parsed?.id ||
          null;
      } catch {}

      return {
        id: ev.id,
        topic: ev.topic,
        eventId: ev.eventId,
        apiVersion: ev.apiVersion,
        status: ev.status,
        errorMessage: ev.errorMessage,
        actionType,
        entityId: entityId ? String(entityId) : null,
        createdAt: ev.createdAt,
      };
    });

    return {
      events: formattedEvents,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
      topics: topicsRaw.map((t) => t.topic).filter(Boolean),
    };
  } catch (error) {
    console.error("[AdminQueries] Error fetching shopify event logs list:", error);
    return { events: [], total: 0, page: 1, limit, totalPages: 1, topics: [] };
  }
}

/**
 * Fetch full Shopify event log details including parsed payload and linked knowledge document & event chunks
 */
export async function getShopifyEventDetails(eventId) {
  try {
    const event = await prisma.shopifyEventLog.findUnique({
      where: { id: eventId },
    });
    if (!event) return null;

    let parsedPayload = null;
    let entityId = null;
    try {
      parsedPayload = typeof event.payload === "string" ? JSON.parse(event.payload) : event.payload;
      entityId =
        parsedPayload?.data?.article?.id ||
        parsedPayload?.article?.id ||
        parsedPayload?.data?.page?.id ||
        parsedPayload?.page?.id ||
        parsedPayload?.data?.product?.id ||
        parsedPayload?.product?.id ||
        parsedPayload?.id ||
        null;
    } catch {
      parsedPayload = event.payload;
    }

    // Try to find the matching KnowledgeDocument and its event chunks
    let linkedDocument = null;
    let eventChunks = [];

    if (entityId) {
      const entityStr = String(entityId);
      const numericId = entityStr.split("/").pop();

      linkedDocument = await prisma.knowledgeDocument.findFirst({
        where: {
          OR: [
            { shopifyGraphqlId: entityStr },
            { shopifyGraphqlId: { contains: numericId } },
          ],
        },
        include: {
          source: true,
          chunks: {
            select: {
              id: true,
              documentId: true,
              chunkIndex: true,
              content: true,
              embeddingContent: true,
              tokenCount: true,
              metadata: true,
              createdAt: true,
              updatedAt: true,
            },
            orderBy: { chunkIndex: "asc" },
          },
        },
      });

      if (linkedDocument) {
        eventChunks = linkedDocument.chunks || [];
      }
    }

    return {
      event,
      parsedPayload,
      entityId: entityId ? String(entityId) : null,
      linkedDocument,
      eventChunks,
    };
  } catch (error) {
    console.error(`[AdminQueries] Error fetching details for event ${eventId}:`, error);
    return null;
  }
}

