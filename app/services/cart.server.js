/**
 * Cart session service
 * Keeps one Shopify cart per conversation and merges new items instead of creating new carts.
 *
 * UCP update_cart uses PUT semantics (full replace). The LLM often sends only the new
 * product or empty fulfillment — we merge with the live cart so old items/shipping stay.
 */
import {
  clearConversationCartId,
  getConversationCartId,
  setConversationCartId
} from "../db.server";

const CART_TOOLS = new Set(["create_cart", "get_cart", "update_cart", "cancel_cart"]);

export function isCartTool(toolName) {
  return CART_TOOLS.has(toolName);
}

export async function handleCartToolCall(
  mcpClient,
  conversationId,
  toolName,
  toolArgs = {},
  { userMessage = "" } = {}
) {
  const storedCartId = await getConversationCartId(conversationId);

  if (toolName === "create_cart") {
    if (storedCartId) {
      return appendToExistingCart(mcpClient, conversationId, storedCartId, toolArgs);
    }

    const response = await mcpClient.callTool("create_cart", toolArgs);
    await persistCartFromResponse(conversationId, response);
    return response;
  }

  if (toolName === "get_cart") {
    const cartId = toolArgs.id || storedCartId;
    if (!cartId) {
      return buildCartError("No active cart yet. Add a product first.");
    }

    const response = await mcpClient.callTool("get_cart", { ...toolArgs, id: cartId });
    await syncCartSession(conversationId, response);
    return response;
  }

  if (toolName === "update_cart") {
    const cartId = toolArgs.id || storedCartId;
    if (!cartId) {
      const createArgs = normalizeCreateArgsFromUpdate(toolArgs);
      return handleCartToolCall(mcpClient, conversationId, "create_cart", createArgs);
    }

    return applyUpdateToExistingCart(mcpClient, conversationId, cartId, toolArgs, userMessage);
  }

  if (toolName === "cancel_cart") {
    const cartId = toolArgs.id || storedCartId;
    if (!cartId) {
      return { content: [{ type: "text", text: "No active cart to cancel." }] };
    }

    const response = await mcpClient.callTool("cancel_cart", {
      ...toolArgs,
      id: cartId,
      meta: {
        ...(toolArgs.meta || {}),
        "idempotency-key": toolArgs.meta?.["idempotency-key"] || crypto.randomUUID()
      }
    });

    await clearConversationCartId(conversationId);
    return response;
  }

  return mcpClient.callTool(toolName, toolArgs);
}

async function appendToExistingCart(mcpClient, conversationId, cartId, createArgs) {
  const getResponse = await mcpClient.callTool("get_cart", { id: cartId });
  const existingCart = extractCartPayload(getResponse);

  if (isCartNotFound(getResponse, existingCart)) {
    console.log("[cart] stored cart expired, creating new cart", { conversationId, cartId });
    await clearConversationCartId(conversationId);
    const response = await mcpClient.callTool("create_cart", createArgs);
    await persistCartFromResponse(conversationId, response);
    return annotateCartSession(response, "created_new_after_expired");
  }

  const incomingItems = createArgs.cart?.line_items || [];
  const mergedLineItems = mergeLineItems(existingCart?.line_items || [], incomingItems);
  const updateArgs = buildPreservedCartUpdate({
    cartId,
    existingCart,
    incomingCart: createArgs.cart,
    incomingBuyer: createArgs.buyer,
    lineItems: mergedLineItems,
    meta: createArgs.meta
  });

  console.log("[cart] merging create_cart into existing cart", {
    conversationId,
    cartId,
    existingCount: existingCart?.line_items?.length || 0,
    incomingCount: incomingItems.length,
    mergedCount: mergedLineItems.length
  });

  const response = await mcpClient.callTool("update_cart", updateArgs);
  await syncCartSession(conversationId, response);
  return annotateCartSession(response, "merged_into_existing");
}

/**
 * LLM update_cart often sends only the NEW product (or empty fulfillment).
 * Fetch live cart, merge items, and preserve shipping/buyer unless meaningfully updated.
 */
async function applyUpdateToExistingCart(mcpClient, conversationId, cartId, toolArgs, userMessage = "") {
  const getResponse = await mcpClient.callTool("get_cart", { id: cartId });
  const existingCart = extractCartPayload(getResponse);

  if (isCartNotFound(getResponse, existingCart)) {
    console.log("[cart] stored cart expired during update, creating new cart", {
      conversationId,
      cartId
    });
    await clearConversationCartId(conversationId);
    const createArgs = normalizeCreateArgsFromUpdate(toolArgs);
    const response = await mcpClient.callTool("create_cart", createArgs);
    await persistCartFromResponse(conversationId, response);
    return annotateCartSession(response, "created_new_after_expired");
  }

  const incomingCart = toolArgs.cart || {};
  const incomingItems = Array.isArray(incomingCart.line_items)
    ? incomingCart.line_items
    : [];
  const existingItems = existingCart?.line_items || [];
  const cartLineResolved = resolveCartLineReferences(incomingItems, existingItems);
  const writableIncoming = toWritableLineItems(incomingItems);
  const writableExisting = toWritableLineItems(existingItems);
  const effectiveWritable =
    cartLineResolved.length > 0 ? cartLineResolved : writableIncoming;
  const isShippingUpdate = hasFulfillmentMethods(incomingCart.fulfillment);
  const addIntent = isAddIntent(userMessage);

  const incomingCartLineCount = incomingItems.filter(isCartLineReference).length;
  const removeByMessage = isRemoveIntent(userMessage)
    ? resolveRemoveByUserMessage(existingItems, userMessage)
    : null;

  let lineItems;
  let mergeMode;

  if (removeByMessage && removeByMessage.length < existingItems.length) {
    // User asked to remove a product — match by title on live cart (ignore stale CartLine ids)
    lineItems = removeByMessage;
    mergeMode = "remove_by_user_message";
  } else if (isRemoveIntent(userMessage)) {
    return buildCartError(
      "Could not identify which product to remove. Call get_cart, then update_cart with ProductVariant ids for the products to keep."
    );
  } else if (addIntent && effectiveWritable.length > 0) {
    // "add cheapest / add this" — always merge new variants into the live cart
    lineItems = mergeLineItems(existingItems, effectiveWritable);
    mergeMode = "merge_add";
  } else if (addIntent && effectiveWritable.length === 0 && writableExisting.length > 0) {
    // LLM used malformed ids we couldn't parse — don't wipe; ask for a proper add payload
    return buildCartError(
      "Could not parse product variant ids for add. Use line_items like { quantity, item: { id: \"gid://shopify/ProductVariant/...\" } }."
    );
  } else if (cartLineResolved.length > 0) {
    if (incomingCartLineCount > 0 && cartLineResolved.length < incomingCartLineCount) {
      return buildCartError(
        "Some cart line IDs are outdated. Call get_cart first, then update_cart with ProductVariant ids for the products to keep."
      );
    }

    lineItems = cartLineResolved;
    mergeMode = "replace_line_items";
  } else if (
    incomingItems.some(isCartLineReference) &&
    incomingItems.length < existingItems.length
  ) {
    return buildCartError(
      "Cart line IDs are outdated. Call get_cart first, then update_cart with ProductVariant ids for the products to keep."
    );
  } else if (effectiveWritable.length === 0) {
    lineItems = writableExisting;
    mergeMode = isShippingUpdate ? "shipping_update" : "preserve_line_items";
  } else if (isAddOnlyUpdate(existingItems, effectiveWritable)) {
    lineItems = mergeLineItems(existingItems, effectiveWritable);
    mergeMode = "merge_add";
  } else if (isSubsetRemoveUpdate(existingItems, effectiveWritable)) {
    lineItems = effectiveWritable;
    mergeMode = "remove_items";
  } else {
    // Full list that includes existing + new, or qty changes
    lineItems = mergeLineItems(existingItems, effectiveWritable);
    mergeMode = "merge_or_replace";
  }

  if (
    lineItems.length === 0 &&
    writableExisting.length > 0 &&
    !isShippingUpdate &&
    mergeMode !== "remove_by_user_message"
  ) {
    lineItems = writableExisting;
    mergeMode = "preserve_line_items_fallback";
  }

  const updateArgs = buildPreservedCartUpdate({
    cartId,
    existingCart,
    incomingCart,
    incomingBuyer: toolArgs.buyer,
    lineItems,
    meta: toolArgs.meta
  });

  console.log("[cart] applying update_cart with preserve/merge", {
    conversationId,
    cartId,
    mergeMode,
    existingCount: existingItems.length,
    incomingCount: incomingItems.length,
    cartLineResolvedCount: cartLineResolved.length,
    writableIncomingCount: writableIncoming.length,
    finalCount: lineItems.length,
    preservingFulfillment: Boolean(updateArgs.cart?.fulfillment?.methods?.length)
  });

  let response = await mcpClient.callTool("update_cart", updateArgs);
  await syncCartSession(conversationId, response);

  if (
    mergeMode === "shipping_update" ||
    mergeMode === "preserve_line_items" ||
    mergeMode === "preserve_line_items_fallback"
  ) {
    response = await maybeAttachCheckoutUrl(mcpClient, cartId, response);
  }

  return annotateCartSession(
    response,
    mergeMode === "merge_add" ? "merged_into_existing" : "updated_existing"
  );
}

function buildPreservedCartUpdate({
  cartId,
  existingCart,
  incomingCart = {},
  incomingBuyer,
  lineItems,
  meta
}) {
  const cart = {
    line_items: lineItems
  };

  const context = pickNonEmptyObject(incomingCart.context, existingCart?.context);
  if (context) {
    cart.context = context;
  }

  const attribution = pickNonEmptyObject(incomingCart.attribution, existingCart?.attribution);
  if (attribution) {
    cart.attribution = attribution;
  }

  const buyer = pickNonEmptyObject(
    incomingBuyer,
    pickNonEmptyObject(incomingCart.buyer, existingCart?.buyer)
  );
  if (buyer) {
    cart.buyer = buyer;
  }

  const fulfillment = normalizeFulfillment(
    incomingCart.fulfillment,
    existingCart?.fulfillment,
    filterCartLinesForVariants(existingCart?.line_items, lineItems)
  );
  if (fulfillment) {
    cart.fulfillment = fulfillment;
  }

  const discounts = pickNonEmptyObject(incomingCart.discounts, existingCart?.discounts);
  if (discounts) {
    cart.discounts = discounts;
  }

  return {
    id: cartId,
    cart,
    meta
  };
}

/**
 * True when every incoming variant is NEW to the cart (typical "add second product").
 * False when incoming touches existing variants (qty change / remove / full list).
 */
function isAddOnlyUpdate(existingItems = [], writableIncoming = []) {
  const existingIds = new Set(
    existingItems.map((item) => item?.item?.id).filter(Boolean)
  );

  if (existingIds.size === 0 || writableIncoming.length === 0) {
    return false;
  }

  return writableIncoming.every((item) => !existingIds.has(item.item.id));
}

function isSubsetRemoveUpdate(existingItems = [], writableIncoming = []) {
  if (writableIncoming.length === 0) {
    return false;
  }

  const existingVariantIds = new Set(
    existingItems.map((item) => item?.item?.id).filter(Boolean)
  );

  if (writableIncoming.length >= existingVariantIds.size) {
    return false;
  }

  return writableIncoming.every((item) => existingVariantIds.has(item.item.id));
}

function isCartLineReference(item) {
  const lineId = item?.id;
  return (
    typeof lineId === "string" &&
    lineId.includes("CartLine") &&
    !item?.item?.id
  );
}

function normalizeCartLineId(id) {
  return String(id || "").split("?")[0];
}

function buildExistingCartLineMap(existingItems = []) {
  const map = new Map();

  for (const item of existingItems) {
    if (!item?.id) {
      continue;
    }

    map.set(normalizeCartLineId(item.id), item);
    map.set(item.id, item);
  }

  return map;
}

function resolveCartLineReferences(incomingItems = [], existingItems = []) {
  if (!incomingItems.some(isCartLineReference)) {
    return [];
  }

  const lineMap = buildExistingCartLineMap(existingItems);

  return incomingItems
    .filter(isCartLineReference)
    .map((incoming) => {
      const existing = lineMap.get(normalizeCartLineId(incoming.id));
      const variantId = existing?.item?.id;

      if (!variantId) {
        return null;
      }

      return {
        quantity: incoming.quantity || existing.quantity || 1,
        item: { id: variantId }
      };
    })
    .filter(Boolean);
}

function filterCartLinesForVariants(existingLineItems = [], writableLineItems = []) {
  const variantIds = new Set(writableLineItems.map((item) => item.item.id));

  return existingLineItems.filter((line) => variantIds.has(line?.item?.id));
}

function isRemoveIntent(userMessage) {
  return Boolean(userMessage && /\b(remove|delete|take out|drop)\b/i.test(userMessage));
}

function isAddIntent(userMessage) {
  if (!userMessage || isRemoveIntent(userMessage)) {
    return false;
  }

  return /\b(add|cheapest|cheap|put|include)\b/i.test(userMessage);
}

function extractRemoveTarget(userMessage) {
  const match = userMessage.match(/\b(?:remove|delete|take out|drop)\b(?:\s+the)?\s+(.+)/i);
  return (match?.[1] || userMessage).trim();
}

function resolveRemoveByUserMessage(existingItems = [], userMessage = "") {
  if (!isRemoveIntent(userMessage)) {
    return null;
  }

  const msg = extractRemoveTarget(userMessage).toLowerCase();
  const scored = existingItems
    .map((line) => {
      const title = (line.item?.title || "").toLowerCase();
      if (!title) {
        return { line, score: 0 };
      }

      const titleTokens = title.split(/[^a-z0-9]+/).filter((token) => token.length > 2);
      let score = titleTokens.filter((token) => msg.includes(token)).length;

      const yearMatch = title.match(/\b(19|20)\d{2}\b/);
      if (yearMatch && msg.includes(yearMatch[0])) {
        score += 3;
      }

      return { line, score };
    })
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  const second = scored[1];

  if (!best || best.score < 3) {
    return null;
  }

  if (second && second.score >= best.score - 1 && second.score >= 3) {
    return null;
  }

  const removeVariantId = best.line.item?.id;
  if (!removeVariantId) {
    return null;
  }

  return existingItems
    .filter((line) => line.item?.id !== removeVariantId)
    .map((line) => ({
      quantity: line.quantity || 1,
      item: { id: line.item.id }
    }));
}

function mergeLineItems(existingItems = [], newItems = []) {
  const byVariantId = new Map();

  for (const item of toWritableLineItems(existingItems)) {
    byVariantId.set(item.item.id, item);
  }

  for (const item of toWritableLineItems(newItems)) {
    const variantId = item.item.id;
    const existing = byVariantId.get(variantId);
    if (existing) {
      existing.quantity += item.quantity || 1;
    } else {
      byVariantId.set(variantId, item);
    }
  }

  return Array.from(byVariantId.values());
}

function toWritableLineItems(items = []) {
  return items
    .map((entry) => {
      // Correct UCP shape: { quantity, item: { id: ProductVariant } }
      let variantId = entry?.item?.id;

      // LLM often sends malformed: { id: ProductVariant, quantity }
      if (!variantId && isProductVariantId(entry?.id)) {
        variantId = entry.id;
      }

      if (!variantId || !isProductVariantId(variantId)) {
        return null;
      }

      return {
        quantity: entry.quantity || 1,
        item: { id: variantId }
      };
    })
    .filter(Boolean);
}

function isProductVariantId(id) {
  return typeof id === "string" && id.includes("ProductVariant");
}

function pickNonEmptyObject(preferred, fallback) {
  if (isNonEmptyObject(preferred)) {
    return preferred;
  }

  if (isNonEmptyObject(fallback)) {
    return fallback;
  }

  return null;
}

function pickMeaningfulFulfillment(preferred, fallback) {
  if (hasFulfillmentMethods(preferred)) {
    return preferred;
  }

  if (hasFulfillmentMethods(fallback)) {
    return fallback;
  }

  return null;
}

function normalizeFulfillment(preferred, fallback, cartLineItems = []) {
  const fulfillment = pickMeaningfulFulfillment(preferred, fallback);
  if (!fulfillment) {
    return null;
  }

  const cartLineIds = (cartLineItems || []).map((item) => item?.id).filter(Boolean);
  if (cartLineIds.length === 0) {
    return fulfillment;
  }

  return {
    ...fulfillment,
    methods: fulfillment.methods.map((method) => ({
      ...method,
      destinations: normalizeDestinations(method.destinations),
      line_item_ids: cartLineIds
    }))
  };
}

function normalizeDestinations(destinations = []) {
  return destinations;
}

async function maybeAttachCheckoutUrl(mcpClient, cartId, cartResponse) {
  const cart = extractCartPayload(cartResponse);
  if (!cart?.line_items?.length) {
    return cartResponse;
  }

  try {
    const lineItems = toWritableLineItems(cart.line_items || []);
    const checkout = {
      currency: cart.currency || "USD",
      line_items: lineItems
    };

    if (cart.buyer && (cart.buyer.phone_number || cart.buyer.email)) {
      checkout.buyer = cart.buyer;
    }

    if (cart.context) {
      checkout.context = cart.context;
    }

    if (cart.fulfillment) {
      checkout.fulfillment = cart.fulfillment;
    }

    const checkoutResponse = await mcpClient.callTool("create_checkout", {
      cart_id: cartId,
      checkout
    });
    const checkoutUrl = extractContinueUrl(checkoutResponse);

    if (!checkoutUrl) {
      return cartResponse;
    }

    console.log("[cart] attached checkout URL after shipping update");

    if (cartResponse.structuredContent && typeof cartResponse.structuredContent === "object") {
      return {
        ...cartResponse,
        structuredContent: {
          ...cartResponse.structuredContent,
          checkout_url: checkoutUrl,
          checkout_note:
            "Use checkout_url (not cart continue_url) for the customer to pay after shipping is set."
        }
      };
    }

    return {
      ...cartResponse,
      checkout_url: checkoutUrl,
      checkout_note:
        "Use checkout_url (not cart continue_url) for the customer to pay after shipping is set."
    };
  } catch (error) {
    console.warn("[cart] create_checkout failed:", error.message);
    return cartResponse;
  }
}

function extractContinueUrl(toolResponse) {
  const structured = toolResponse?.structuredContent;
  if (structured?.continue_url) {
    return structured.continue_url;
  }

  const parsed = parseToolTextContent(toolResponse);
  return parsed?.continue_url || parsed?.checkout?.continue_url || null;
}

export function extractCheckoutPayload(toolResponse) {
  if (!toolResponse) {
    return null;
  }

  // MCP often sets isError=true for requires_escalation — still a valid checkout payload.
  const structured = toolResponse.structuredContent;
  if (structured?.id && (Array.isArray(structured.line_items) || structured.status || structured.continue_url)) {
    return structured;
  }

  const parsed = parseToolTextContent(toolResponse);
  if (parsed?.id && (Array.isArray(parsed.line_items) || parsed.status || parsed.continue_url)) {
    return parsed;
  }

  return null;
}

/**
 * Buyer-fixable checkout validation errors (phone/address/etc).
 * Ignores expected escalation noise like payment extension prompts.
 * Returns { code, content, readable } objects for LLM/customer messaging.
 */
export function extractCheckoutValidationErrors(checkoutOrResponse) {
  const checkout = checkoutOrResponse?.id
    ? checkoutOrResponse
    : extractCheckoutPayload(checkoutOrResponse) || checkoutOrResponse?.structuredContent;

  const messages = Array.isArray(checkout?.messages) ? checkout.messages : [];
  if (!messages.length) {
    return [];
  }

  const ignoredCodes = new Set([
    "extension_interaction_required"
  ]);

  // Any address/buyer field Shopify may reject when adding/updating shipping
  const fieldHints =
    /phone|address|postal|zip|delivery|shipping|fulfillment|buyer|destination|region|state|locality|city|country|name|street|email|province|first_name|last_name/i;

  return messages
    .filter((message) => message && message.type === "error")
    .filter((message) => !ignoredCodes.has(String(message.code || "")))
    .filter((message) => {
      // During address add/update, surface all recoverable errors to the customer
      if (message.severity === "recoverable") return true;
      if (message.severity === "requires_buyer_input" && fieldHints.test(String(message.code || "") + String(message.content || ""))) {
        return true;
      }
      return fieldHints.test(String(message.code || "")) || fieldHints.test(String(message.content || ""));
    })
    .map((message) => {
      const content = String(message.content || message.message || "").trim();
      const code = String(message.code || "").trim();
      return {
        code,
        content,
        readable: humanizeCheckoutValidationError(code, content)
      };
    })
    .filter((item) => item.readable);
}

export function humanizeCheckoutValidationError(code, content = "") {
  const normalizedCode = String(code || "").toLowerCase();
  const raw = String(content || "").trim().replace(/\s+/g, " ");
  const blob = `${normalizedCode} ${raw.toLowerCase()}`;

  if (blob.includes("phone")) {
    return (
      "The phone number is invalid. Please provide a real mobile/phone number " +
      "(for example 305-555-1234), not a placeholder like 9999999999."
    );
  }

  if (blob.includes("postal") || blob.includes("zip")) {
    return raw && !/^enter a valid/i.test(raw)
      ? `The postal/ZIP code looks invalid (${raw}). Please provide a valid ZIP for that city and state.`
      : "The postal/ZIP code is invalid. Please provide a valid ZIP code for that city and state.";
  }

  if (blob.includes("first_name") || (blob.includes("first") && blob.includes("name"))) {
    return "The first name looks invalid. Please provide a valid first name.";
  }

  if (blob.includes("last_name") || (blob.includes("last") && blob.includes("name"))) {
    return "The last name looks invalid. Please provide a valid last name.";
  }

  if (blob.includes("street") || blob.includes("address_line") || normalizedCode.includes("street_address")) {
    return raw && !/^enter a valid/i.test(raw)
      ? `The street address looks invalid (${raw}). Please provide a full street address.`
      : "The street address looks invalid. Please provide a full street address.";
  }

  if (blob.includes("locality") || blob.includes("city")) {
    return "The city looks invalid. Please provide a valid city name.";
  }

  if (blob.includes("region") || blob.includes("province") || blob.includes("state")) {
    return "The state/region looks invalid. For US addresses use a 2-letter code (for example FL, NY, CA).";
  }

  if (blob.includes("country")) {
    return "The country looks invalid. For US addresses use US.";
  }

  if (blob.includes("email")) {
    return "The email address looks invalid. Please provide a valid email.";
  }

  if (
    blob.includes("address") ||
    blob.includes("delivery") ||
    blob.includes("shipping") ||
    blob.includes("destination") ||
    blob.includes("fulfillment") ||
    blob.includes("buyer")
  ) {
    return raw
      ? `This shipping detail could not be accepted: ${raw}`
      : "One or more shipping address fields look invalid. Please check name, phone, street, city, state, ZIP, and country.";
  }

  if (raw) {
    return raw.endsWith(".") ? raw : `${raw}.`;
  }

  return "Some shipping details look invalid. Please double-check every address field and try again.";
}

function hasFulfillmentMethods(fulfillment) {
  return Boolean(
    fulfillment &&
      typeof fulfillment === "object" &&
      Array.isArray(fulfillment.methods) &&
      fulfillment.methods.length > 0
  );
}

function isNonEmptyObject(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length > 0
  );
}

function normalizeCreateArgsFromUpdate(toolArgs) {
  if (toolArgs.cart) {
    return {
      cart: toolArgs.cart,
      buyer: toolArgs.buyer || toolArgs.cart.buyer || {},
      meta: toolArgs.meta
    };
  }

  return toolArgs;
}

function extractCartPayload(toolResponse) {
  if (!toolResponse || toolResponse.error) {
    return null;
  }

  const structured = toolResponse.structuredContent;
  if (structured?.id && Array.isArray(structured.line_items)) {
    return structured;
  }

  if (structured?.cart?.id) {
    return structured.cart;
  }

  const parsed = parseToolTextContent(toolResponse);
  if (parsed?.id && Array.isArray(parsed.line_items)) {
    return parsed;
  }

  if (parsed?.cart?.id) {
    return parsed.cart;
  }

  return null;
}

function parseToolTextContent(toolResponse) {
  const content = toolResponse?.content;
  if (!Array.isArray(content) || content.length === 0) {
    return null;
  }

  const text = content[0]?.text;
  if (!text) {
    return null;
  }

  if (typeof text === "object") {
    return text;
  }

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isCartNotFound(toolResponse, cartPayload) {
  if (cartPayload?.id) {
    return false;
  }

  const messages = cartPayload?.messages || toolResponse?.structuredContent?.messages || [];
  if (Array.isArray(messages)) {
    return messages.some((message) =>
      message?.code === "not_found" ||
      message?.severity === "unrecoverable" ||
      /not found/i.test(String(message?.content || message?.message || ""))
    );
  }

  return !cartPayload?.id;
}

async function persistCartFromResponse(conversationId, response) {
  const cartId = extractCartPayload(response)?.id;
  if (cartId) {
    await setConversationCartId(conversationId, cartId);
  }
}

async function syncCartSession(conversationId, response) {
  if (isCartNotFound(response, extractCartPayload(response))) {
    await clearConversationCartId(conversationId);
    return;
  }

  await persistCartFromResponse(conversationId, response);
}

function annotateCartSession(response, sessionAction) {
  if (!response || response.error) {
    return response;
  }

  const notes = {
    merged_into_existing:
      "Added to the existing cart for this conversation (kept previous products and shipping).",
    updated_existing: "Updated the existing cart for this conversation.",
    created_new_after_expired: "Created a new cart because the previous cart expired."
  };

  const note = notes[sessionAction] || notes.updated_existing;

  if (response.structuredContent && typeof response.structuredContent === "object") {
    return {
      ...response,
      structuredContent: {
        ...response.structuredContent,
        cart_session: sessionAction,
        cart_session_note: note
      }
    };
  }

  return {
    ...response,
    cart_session: sessionAction,
    cart_session_note: note
  };
}

function buildCartError(message) {
  return {
    error: {
      type: "internal_error",
      data: message
    }
  };
}

export function toolResult(data) {
  return {
    content: [{
      type: "text",
      text: typeof data === "string" ? data : JSON.stringify(data)
    }],
    structuredContent: typeof data === "object" ? data : undefined
  };
}

export function toolError(message) {
  return buildCartError(message);
}

export async function fetchLiveCart(mcpClient, conversationId) {
  const cartId = await getConversationCartId(conversationId);
  if (!cartId) {
    return null;
  }

  const getResponse = await mcpClient.callTool("get_cart", { id: cartId });
  const cart = extractCartPayload(getResponse);

  if (isCartNotFound(getResponse, cart)) {
    await clearConversationCartId(conversationId);
    return null;
  }

  await syncCartSession(conversationId, getResponse);
  return { cartId, cart, raw: getResponse };
}

export async function updateCartLineItems(
  mcpClient,
  conversationId,
  cartId,
  existingCart,
  lineItems,
  { incomingCart = {}, incomingBuyer, meta } = {}
) {
  const updateArgs = buildPreservedCartUpdate({
    cartId,
    existingCart,
    incomingCart,
    incomingBuyer,
    lineItems,
    meta
  });

  const response = await mcpClient.callTool("update_cart", updateArgs);
  await syncCartSession(conversationId, response);
  return response;
}

export function formatCartSummary(
  cart,
  rawResponse = null,
  { checkoutUrl = null, shippingAddress = null } = {}
) {
  if (!cart) {
    return { success: false, empty: true, message: "Cart is empty." };
  }

  const items = (cart.line_items || []).map((line) => ({
    title: line.item?.title || "Product",
    quantity: line.quantity || 1,
    variant_id: line.item?.id,
    price: formatLinePrice(line)
  }));

  const totalEntry = cart.totals?.find((t) => t.type === "total");
  const subtotalEntry = cart.totals?.find((t) => t.type === "subtotal");

  const summary = {
    success: true,
    cart_id: cart.id,
    item_count: items.length,
    items,
    currency: cart.currency || "USD",
    subtotal: formatMoney(subtotalEntry?.amount, cart.currency),
    total: formatMoney(totalEntry?.amount, cart.currency),
    continue_url: cart.continue_url || null,
    checkout_url:
      checkoutUrl ||
      rawResponse?.structuredContent?.checkout_url ||
      rawResponse?.checkout_url ||
      null,
    instruction:
      "Base your reply ONLY on this summary. Do not claim items were added/removed unless they appear here."
  };

  if (shippingAddress) {
    summary.shipping_saved = true;
    summary.shipping_address = shippingAddress;
    summary.instruction =
      "Shipping was saved successfully ONLY because shipping_saved is true. Confirm shipping_address and share checkout_url. Do not say there was an error.";
  }

  return summary;
}

function formatLinePrice(line) {
  const subtotal = line.totals?.find((t) => t.type === "subtotal");
  if (subtotal?.amount != null) {
    return formatMoney(subtotal.amount, "USD");
  }

  if (line.item?.price != null) {
    return formatMoney(line.item.price, "USD");
  }

  return null;
}

function formatMoney(amountMinor, currency = "USD") {
  if (amountMinor == null) {
    return null;
  }

  const major = Number(amountMinor) / 100;
  return `${currency} ${major.toFixed(2)}`;
}

export {
  buildPreservedCartUpdate,
  extractCartPayload,
  extractContinueUrl,
  mergeLineItems,
  toWritableLineItems,
  persistCartFromResponse,
  syncCartSession,
  maybeAttachCheckoutUrl
};

export function buildActiveCartContextMessage(cartId) {
  if (!cartId) {
    return null;
  }

  return {
    role: "system",
    content:
      "This conversation has an active cart. Use add_to_cart, remove_from_cart, get_my_cart, " +
      "set_cart_shipping, and clear_my_cart — NOT create_cart, update_cart, or get_cart."
  };
}

export default {
  isCartTool,
  handleCartToolCall,
  buildActiveCartContextMessage
};
