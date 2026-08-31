/**
 * Cart wrapper tools for the LLM.
 * The model calls simple intents; this module builds correct Shopify UCP payloads.
 */
import {
  clearConversationCartId,
  clearConversationCheckoutId,
  clearConversationShippingAddress,
  getConversationCartId,
  getConversationCheckoutId,
  getConversationShippingAddress,
  setConversationCheckoutId,
  setConversationShippingAddress
} from "../db.server";
import {
  buildPreservedCartUpdate,
  extractCartPayload,
  extractCheckoutPayload,
  extractCheckoutValidationErrors,
  extractContinueUrl,
  fetchLiveCart,
  formatCartSummary,
  mergeLineItems,
  persistCartFromResponse,
  toWritableLineItems,
  toolResult,
  toolError,
  updateCartLineItems
} from "./cart.server";

const RAW_CART_TOOL_NAMES = new Set([
  "create_cart",
  "get_cart",
  "update_cart",
  "cancel_cart",
  "create_checkout",
  "get_checkout",
  "update_checkout",
  "complete_checkout",
  "cancel_checkout"
]);

export const CART_WRAPPER_TOOL_NAMES = [
  "add_to_cart",
  "remove_from_cart",
  "get_my_cart",
  "set_cart_shipping",
  "clear_my_cart"
];

export function getCartWrapperTools() {
  return [
    {
      name: "add_to_cart",
      description:
        "Add one product to the customer's cart. Always keeps existing cart items. Pass variant_id from fitment/catalog (gid://shopify/ProductVariant/...). Server handles merge — never call create_cart or update_cart directly.",
      input_schema: {
        type: "object",
        properties: {
          variant_id: {
            type: "string",
            description: "Shopify ProductVariant GID from fitment/catalog results"
          },
          quantity: {
            type: "integer",
            description: "Quantity to add (default 1)"
          }
        },
        required: ["variant_id"]
      }
    },
    {
      name: "remove_from_cart",
      description:
        "Reduce quantity or fully remove a cart product. DEFAULT reduces quantity by 1 (does NOT remove the whole line). " +
        "For 'reduce 1 qty' / 'remove one' / 'decrease quantity': pass quantity:1 (or omit quantity — default is 1). " +
        "ONLY to delete the product entirely (customer says remove this product / delete from cart), pass remove_all:true. " +
        "Use variant_id if known, otherwise product_title.",
      input_schema: {
        type: "object",
        properties: {
          variant_id: {
            type: "string",
            description: "ProductVariant GID to remove or reduce"
          },
          product_title: {
            type: "string",
            description: "Product title or distinctive words (year/make/model) if variant_id unknown"
          },
          quantity: {
            type: "integer",
            description:
              "How many units to subtract. Default 1. Example: cart qty 2 + quantity:1 → leaves qty 1."
          },
          remove_all: {
            type: "boolean",
            description:
              "Set true ONLY to remove the entire product line from the cart. Do not set this for quantity reduce requests."
          }
        }
      }
    },
    {
      name: "get_my_cart",
      description:
        "Show the current cart contents, totals, and checkout link for this conversation. " +
        "Call this when the customer wants to checkout / proceed / pay / get the checkout link. " +
        "If shipping is already on file, the server creates/refreshes checkout and returns checkout_url when Shopify allows it.",
      input_schema: {
        type: "object",
        properties: {}
      }
    },
    {
      name: "set_cart_shipping",
      description:
        "Set or update shipping address on checkout (replaces any previous address). Keeps all cart products. " +
        "YOU must convert the customer's free-text address into Shopify fields before calling: " +
        "split first/last name; use 2-letter state (New York/new yark → NY); use ISO country (USA → US). " +
        "Phone: keep E.164 with + when the customer gives it (e.g. +13454656723). Do NOT strip the +. " +
        "10-digit US numbers are also fine — the server will add +1. " +
        "Prefer structured fields over address_text. Do NOT ask the customer to reformat — convert yourself. " +
        "On success:false / shipping_saved:false: tell the customer the exact issues[] / shopify_errors content " +
        "(e.g. \"Phone is invalid\"). Ask ONLY for the failed field(s). Never invent formatting rules like \"remove the +\". " +
        "Never re-ask the full address list. Never claim it was saved.",
      input_schema: {
        type: "object",
        properties: {
          address_text: {
            type: "string",
            description:
              "Optional raw customer message. Prefer structured fields when you can convert the address yourself."
          },
          first_name: { type: "string" },
          last_name: { type: "string" },
          phone_number: {
            type: "string",
            description:
              "Buyer phone. Prefer E.164 with country code when provided (e.g. +13454656723). " +
              "Keep the leading +. Also accept 10-digit US numbers (3454656723). Never strip +."
          },
          street_address: { type: "string" },
          extended_address: { type: "string" },
          address_locality: { type: "string", description: "City" },
          address_region: {
            type: "string",
            description: "State/region. For US use 2-letter code (NY, CA). Convert full names yourself (New York → NY)."
          },
          postal_code: { type: "string" },
          address_country: {
            type: "string",
            description: "ISO country code Shopify expects (US not USA). Convert yourself."
          }
        }
      }
    },
    {
      name: "clear_my_cart",
      description: "Empty/cancel the current cart so the customer can start over.",
      input_schema: {
        type: "object",
        properties: {}
      }
    }
  ];
}

export function isCartWrapperTool(toolName) {
  return CART_WRAPPER_TOOL_NAMES.includes(toolName);
}

/** Hide raw UCP cart/checkout tools from the LLM — wrappers handle cart logic. */
export function filterCartToolsForLlm(tools = []) {
  return tools.filter((tool) => !RAW_CART_TOOL_NAMES.has(tool.name));
}

export async function callCartWrapperTool(
  mcpClient,
  conversationId,
  toolName,
  toolArgs = {},
  context = {}
) {
  switch (toolName) {
    case "add_to_cart":
      return addToCart(mcpClient, conversationId, toolArgs);
    case "remove_from_cart":
      return removeFromCart(mcpClient, conversationId, toolArgs, context);
    case "get_my_cart":
      return getMyCart(mcpClient, conversationId);
    case "set_cart_shipping":
      return setCartShipping(mcpClient, conversationId, toolArgs, context);
    case "clear_my_cart":
      return clearMyCart(mcpClient, conversationId);
    default:
      return toolError(`Unknown cart wrapper tool: ${toolName}`);
  }
}

/** Inject when the user's message looks like a shipping address. */
export function buildShippingAddressHintMessage(userMessage) {
  const parsed = parseAddressText(userMessage);
  if (!parsed) {
    return null;
  }

  return {
    role: "system",
    content:
      "The customer's latest message contains a shipping address. " +
      "Call set_cart_shipping NOW with structured fields YOU convert for Shopify: " +
      "first_name, last_name, phone_number, street_address, address_locality (city), " +
      "address_region (2-letter US state — infer from city when clear, e.g. New York/new yark → NY), " +
      "postal_code, address_country (US not USA). " +
      "For phone_number: if the customer wrote +13454656723 (or any +country… number), pass it WITH the +. " +
      "Do NOT strip +, and do NOT tell them to remove + or reformat the phone. " +
      "Do NOT ask the customer to reformat or re-provide state/country when you can convert from their message."
  };
}

export function buildActiveCartWrapperContextMessage(cartId) {
  if (!cartId) {
    return null;
  }

  return {
    role: "system",
    content:
      "This conversation has an active cart. Use add_to_cart to add products or increase qty, " +
      "remove_from_cart to reduce qty by 1 by default (pass remove_all:true only to delete the product), " +
      "get_my_cart to show contents, set_cart_shipping for address, " +
      "clear_my_cart to start over. Do NOT call create_cart, update_cart, or get_cart directly."
  };
}

async function addToCart(mcpClient, conversationId, { variant_id, quantity = 1 }) {
  const variantId = normalizeVariantId(variant_id);
  if (!variantId) {
    return toolError("variant_id is required (gid://shopify/ProductVariant/...)");
  }

  const qty = Math.max(1, Number(quantity) || 1);
  const newItem = { quantity: qty, item: { id: variantId } };
  const live = await fetchLiveCart(mcpClient, conversationId);

  if (!live) {
    const response = await mcpClient.callTool("create_cart", {
      cart: { line_items: [newItem] }
    });
    await persistCartFromResponse(conversationId, response);
    return toolResult(
      await summarizeCartWithShipping(
        mcpClient,
        conversationId,
        extractCartPayload(response),
        response
      )
    );
  }

  const merged = mergeLineItems(live.cart.line_items || [], [newItem]);
  const response = await updateCartLineItems(
    mcpClient,
    conversationId,
    live.cartId,
    live.cart,
    merged
  );

  // Trust live cart after update — response / stale fulfillment can omit new variants.
  const verified = await fetchLiveCart(mcpClient, conversationId);
  const verifiedCart = verified?.cart || extractCartPayload(response);
  const added = (verifiedCart?.line_items || []).some(
    (line) => line?.item?.id === variantId
  );

  console.log("[cart-wrapper] add_to_cart", {
    conversationId,
    variantId,
    before: live.cart.line_items?.length || 0,
    merged: merged.length,
    after: verifiedCart?.line_items?.length || 0,
    added
  });

  if (!added) {
    return toolResult({
      success: false,
      shipping_saved: false,
      variant_id: variantId,
      items: (verifiedCart?.line_items || []).map((line) => ({
        title: line.item?.title || "Product",
        quantity: line.quantity || 1,
        variant_id: line.item?.id
      })),
      issues: [
        "Shopify did not add that product to the cart. It may be unavailable for purchase right now."
      ],
      instruction:
        "The requested product was NOT added. Tell the customer clearly using issues[]. " +
        "Do NOT claim it is in the cart. Base any cart list ONLY on items[]."
    });
  }

  return toolResult(
    await summarizeCartWithShipping(
      mcpClient,
      conversationId,
      verifiedCart,
      verified?.raw || response
    )
  );
}

async function removeFromCart(
  mcpClient,
  conversationId,
  { variant_id, product_title, quantity, remove_all },
  context = {}
) {
  const live = await fetchLiveCart(mcpClient, conversationId);
  if (!live?.cart?.line_items?.length) {
    return toolError("Cart is empty.");
  }

  const removeVariantId = resolveRemoveVariantId(live.cart.line_items, {
    variant_id,
    product_title
  });

  if (!removeVariantId) {
    return toolError(
      "Could not find that product in the cart. Call get_my_cart to list items, then retry with variant_id or a clearer product_title."
    );
  }

  const targetLine = live.cart.line_items.find(
    (line) => line?.item?.id === removeVariantId
  );
  const currentQty = Math.max(1, Number(targetLine?.quantity) || 1);
  const userMessage = String(context.userMessage || "");

  // Default: reduce by 1. Full delete only with remove_all:true (or clear intent in user text).
  const wantsFullRemove =
    remove_all === true ||
    (
      quantity == null &&
      /\b(remove|delete|take)\b/i.test(userMessage) &&
      !/\b(reduce|decrease|qty|quantity|one less|minus)\b/i.test(userMessage) &&
      /\b(product|item|from\s+(the\s+)?cart|entirely|completely|all)\b/i.test(userMessage)
    );

  const reduceBy = wantsFullRemove
    ? currentQty
    : Math.max(1, Number(quantity) || 1);
  const nextQty = currentQty - reduceBy;

  let lineItems;
  if (nextQty <= 0) {
    lineItems = toWritableLineItems(
      live.cart.line_items.filter((line) => line?.item?.id !== removeVariantId)
    );
  } else {
    lineItems = toWritableLineItems(
      live.cart.line_items.map((line) => {
        if (line?.item?.id !== removeVariantId) return line;
        return {
          ...line,
          quantity: nextQty
        };
      })
    );
  }

  const response = await updateCartLineItems(
    mcpClient,
    conversationId,
    live.cartId,
    live.cart,
    lineItems
  );

  console.log("[cart-wrapper] remove_from_cart", {
    conversationId,
    variantId: removeVariantId,
    currentQty,
    reduceBy,
    nextQty: Math.max(0, nextQty),
    wantsFullRemove,
    remainingLines: lineItems.length,
    userMessagePreview: userMessage.slice(0, 80)
  });

  const summary = await summarizeCartWithShipping(
    mcpClient,
    conversationId,
    extractCartPayload(response),
    response
  );

  const qtyInstruction =
    nextQty <= 0
      ? "Product was fully removed from the cart. Base your reply ONLY on the items list."
      : `Quantity was reduced from ${currentQty} to ${nextQty}. Do NOT say the product was removed. Base your reply ONLY on the items list.`;

  return toolResult({
    ...summary,
    action: nextQty <= 0 ? "removed_product" : "reduced_quantity",
    variant_id: removeVariantId,
    previous_quantity: currentQty,
    removed_quantity: Math.min(reduceBy, currentQty),
    new_quantity: Math.max(0, nextQty),
    instruction: [qtyInstruction, summary.instruction].filter(Boolean).join(" ")
  });
}

async function getMyCart(mcpClient, conversationId) {
  const live = await fetchLiveCart(mcpClient, conversationId);
  if (!live?.cart) {
    return toolResult({
      success: true,
      empty: true,
      message: "Cart is empty. Use add_to_cart when the customer chooses a product."
    });
  }

  return toolResult(
    await summarizeCartWithShipping(mcpClient, conversationId, live.cart, live.raw)
  );
}

async function setCartShipping(mcpClient, conversationId, address, context = {}) {
  const live = await fetchLiveCart(mcpClient, conversationId);
  if (!live?.cart?.line_items?.length) {
    return toolError("Add products to the cart before setting a shipping address.");
  }

  const normalized = normalizeShippingAddress(address, {
    userMessage: context.userMessage,
    existingCart: live.cart
  });

  if (normalized.missing.length > 0) {
    const fieldLabels = {
      first_name: "First Name",
      last_name: "Last Name",
      phone_number: "Phone Number",
      street_address: "Street Address",
      address_locality: "City",
      address_region: "State/Region",
      postal_code: "Postal Code",
      address_country: "Country"
    };
    const missingLabels = normalized.missing.map((field) => fieldLabels[field] || field);
    return toolResult({
      success: false,
      shipping_saved: false,
      issues: missingLabels.map((label) => `${label} is required.`),
      customer_message:
        `I couldn't save your shipping address yet because some required details are missing: ${missingLabels.join(", ")}. ` +
        "Please send those details and I'll update the address.",
      instruction:
        "The shipping address was NOT saved. Ask only for the missing fields listed in issues/customer_message. Never say the address was saved."
    });
  }

  const resolved = normalized.address;

  if (isUsLikeCountry(resolved.address_country) && !resolved.address_region) {
    return toolResult({
      success: false,
      shipping_saved: false,
      issues: ["State/Region is required."],
      customer_message:
        "I couldn't save your shipping address yet because the state is missing. " +
        "Please tell me the state (for example FL or Florida) and I'll update it.",
      instruction:
        "The shipping address was NOT saved. Ask for state only. Never say the address was saved."
    });
  }

  resolved.phone_number = normalizePhoneNumber(
    resolved.phone_number,
    resolved.address_country
  );

  const destination = buildShippingDestination(resolved);
  const cartLineItems = toWritableLineItems(live.cart.line_items);

  await mcpClient.callTool("update_cart", buildPreservedCartUpdate({
    cartId: live.cartId,
    existingCart: live.cart,
    incomingCart: {
      context: {
        address_country: resolved.address_country,
        address_region: resolved.address_region,
        postal_code: resolved.postal_code
      },
      buyer: { phone_number: resolved.phone_number }
    },
    incomingBuyer: { phone_number: resolved.phone_number },
    lineItems: cartLineItems
  }));

  const synced = await syncCheckoutWithCart(mcpClient, conversationId, live.cart, {
    shipping: destination,
    force: true,
    allowCreate: true
  });

  if (synced?.rate_limited || /rate limit|too many requests/i.test(String(synced?.error || ""))) {
    const transport = parseShopifyTransportError(synced.error || synced.shopify_error || "");
    const issues = [
      synced.shopify_error ||
        transport.shopify_error ||
        synced.error ||
        "Rate limit exceeded"
    ].filter(Boolean);

    return toolResult({
      success: false,
      shipping_saved: false,
      rate_limited: true,
      retry_after_seconds:
        synced.retry_after_seconds ?? transport.retry_after_seconds ?? null,
      shopify_errors: issues.map((content) => ({ content })),
      issues,
      instruction:
        "Shipping was NOT saved because Shopify rate-limited checkout. " +
        "Tell the customer the exact issues[] message (Rate limit exceeded / retry_after_seconds). " +
        "Do NOT claim the address was saved. Do NOT share a checkout link."
    });
  }

  const verification = synced?.checkoutId
    ? await fetchVerifiedCheckoutShipping(mcpClient, synced.checkoutId)
    : null;

  const verifiedAddress = verification?.shippingAddress
    ? {
        ...verification.shippingAddress,
        phone_number:
          verification.shippingAddress.phone_number ||
          verification.buyerPhone ||
          null
      }
    : null;
  const validationErrors = [
    ...(synced?.validationErrors || []),
    ...(verification?.validationErrors || []),
    ...extractCheckoutValidationErrors(synced?.checkout),
    ...extractCheckoutValidationErrors(verification?.checkout),
    ...extractCheckoutValidationErrors(synced?.error)
  ].filter(Boolean);

  // Only keep address/buyer related failures here; item/stock issues are separate.
  const shippingValidationErrors = validationErrors.filter((item) => {
    const code = String(item?.code || item || "");
    const content = String(item?.content || item?.readable || item || "");
    return /phone|address|postal|zip|delivery|shipping|fulfillment|buyer|destination|region|state|locality|city|country|name|street|first_name|last_name/i.test(
      `${code} ${content}`
    );
  });

  if (shippingValidationErrors.length > 0) {
    const shopifyErrors = shippingValidationErrors.map((item) => {
      if (typeof item === "string") {
        return { code: "", content: item, readable: item };
      }
      const content = String(item.content || item.readable || "").trim();
      const code = String(item.code || "").trim();
      return {
        code,
        content,
        path: item.path || null,
        // Prefer Shopify's own wording (e.g. "Phone is invalid").
        readable: content || item.readable || code
      };
    });
    const issues = [
      ...new Set(shopifyErrors.map((item) => item.readable).filter(Boolean))
    ];

    console.warn("[cart-wrapper] set_cart_shipping validation failed", {
      conversationId,
      errors: shopifyErrors,
      verifiedStreet: verifiedAddress?.street_address || null
    });

    return toolResult({
      success: false,
      shipping_saved: false,
      shopify_errors: shopifyErrors,
      issues,
      instruction:
        "Shipping was NOT saved. Tell the customer the exact problem from issues/shopify_errors " +
        "(example: if issues says \"Phone is invalid\", say the phone number is invalid and ask only for a valid phone). " +
        "Do NOT invent phone formatting advice (never say remove +, never require only 10 digits). " +
        "+E.164 numbers like +13454656723 are valid to send as-is. " +
        "Do NOT re-ask the full address form. Do NOT say a vague \"there was an issue, provide your address again\". " +
        "Never claim the address was saved."
    });
  }

  if (!verifiedAddress?.street_address || !shippingAddressMatchesExpected(verifiedAddress, destination)) {
    console.warn("[cart-wrapper] set_cart_shipping not verified on checkout", {
      conversationId,
      checkoutId: synced?.checkoutId || null,
      expected: destination,
      verified: verifiedAddress,
      buyerPhone: verification?.buyerPhone || null,
      syncedError: synced?.error || null
    });

    return toolResult({
      success: false,
      shipping_saved: false,
      issues: synced?.error
        ? [String(synced.error)]
        : ["Shipping address was not accepted by checkout."],
      instruction:
        "Shipping was NOT saved. Tell the customer clearly using issues if present. " +
        "Ask only for what failed — do not re-list the full address form. Never claim it was saved."
    });
  }

  await setConversationShippingAddress(conversationId, writableShippingAddress(verifiedAddress));

  console.log("[cart-wrapper] set_cart_shipping verified", {
    conversationId,
    itemCount: cartLineItems.length,
    checkoutId: synced.checkoutId,
    savedStreet: verifiedAddress.street_address,
    savedPhone: verifiedAddress.phone_number || verification?.buyerPhone || null,
    checkoutUrl: verification?.checkoutUrl || synced.checkoutUrl || null
  });

  return toolResult(
    formatCartSummary(live.cart, live.raw, {
      checkoutUrl: verification?.checkoutUrl || synced.checkoutUrl,
      shippingAddress: {
        ...verifiedAddress,
        phone_number:
          verifiedAddress.phone_number ||
          verification?.buyerPhone ||
          destination.phone_number
      }
    })
  );
}

/** Shopify MCP marks checkout as required even when cart_id is provided. */
function buildCreateCheckoutArgs(cartId, cart, overrides = {}) {
  const lineItems = toWritableLineItems(cart?.line_items || []);
  const currency = cart?.currency || "USD";
  const buyer = overrides.buyer || cart?.buyer || null;

  const checkout = {
    currency,
    line_items: lineItems
  };

  if (buyer && (buyer.phone_number || buyer.email)) {
    checkout.buyer = buyer;
  }

  if (overrides.context || cart?.context) {
    checkout.context = overrides.context || cart.context;
  }

  if (overrides.fulfillment) {
    checkout.fulfillment = overrides.fulfillment;
  }

  return {
    cart_id: cartId,
    checkout
  };
}

function extractToolErrorText(toolResponse) {
  if (!toolResponse) {
    return "";
  }

  if (typeof toolResponse.error === "string") {
    return toolResponse.error;
  }

  if (toolResponse.error?.data) {
    return String(toolResponse.error.data);
  }

  const text = toolResponse.content?.[0]?.text;
  if (text) {
    return String(text);
  }

  return JSON.stringify(toolResponse.structuredContent || toolResponse);
}

function buildShippingDestination(resolved) {
  const phone = normalizePhoneNumber(resolved.phone_number, resolved.address_country);
  return {
    first_name: resolved.first_name,
    last_name: resolved.last_name,
    phone_number: phone,
    street_address: resolved.street_address,
    extended_address: resolved.extended_address || undefined,
    address_locality: resolved.address_locality,
    address_region: resolved.address_region || undefined,
    postal_code: resolved.postal_code,
    address_country: resolved.address_country
  };
}

function normalizePhoneNumber(phone, country) {
  const raw = String(phone || "").trim();
  if (!raw) return raw;

  const digits = raw.replace(/\D/g, "");
  if (!digits) return raw;

  if (isUsLikeCountry(country)) {
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  }

  if (raw.startsWith("+")) return `+${digits}`;
  return digits.length >= 10 ? `+${digits}` : raw;
}

function buildCheckoutLineItems(lineItems = []) {
  return lineItems
    .map((line) => {
      const variantId = line?.item?.id;
      if (!variantId || !line?.id) {
        return null;
      }

      return {
        id: line.id,
        quantity: line.quantity || 1,
        item: { id: variantId }
      };
    })
    .filter(Boolean);
}

function extractShippingDestination(checkout) {
  const methods = checkout?.fulfillment?.methods || [];
  for (const method of methods) {
    for (const destination of method.destinations || []) {
      if (destination?.street_address) {
        return destination;
      }
    }
  }

  return null;
}

function normalizeComparable(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function normalizePhoneDigits(phone) {
  return String(phone || "").replace(/\D/g, "");
}

/**
 * Confirm Shopify actually stored the destination we sent (not just echo / local fallback).
 */
function shippingAddressMatchesExpected(actual, expected) {
  if (!actual?.street_address || !expected?.street_address) return false;

  const streetOk =
    normalizeComparable(actual.street_address) === normalizeComparable(expected.street_address);
  const cityOk =
    !expected.address_locality ||
    normalizeComparable(actual.address_locality) === normalizeComparable(expected.address_locality);
  const zipOk =
    !expected.postal_code ||
    normalizeComparable(actual.postal_code) === normalizeComparable(expected.postal_code);
  const regionOk =
    !expected.address_region ||
    normalizeComparable(actual.address_region) === normalizeComparable(expected.address_region);

  const expectedPhone = normalizePhoneDigits(expected.phone_number);
  const actualPhone = normalizePhoneDigits(actual.phone_number || actual.buyer?.phone_number);
  const phoneOk =
    !expectedPhone ||
    (Boolean(actualPhone) &&
      (actualPhone === expectedPhone ||
        actualPhone.endsWith(expectedPhone) ||
        expectedPhone.endsWith(actualPhone)));

  return streetOk && cityOk && zipOk && regionOk && phoneOk;
}

async function fetchVerifiedCheckoutShipping(mcpClient, checkoutId) {
  if (!checkoutId) return null;

  try {
    const response = await mcpClient.callTool("get_checkout", { id: checkoutId });
    const checkout = extractCheckoutPayload(response);
    if (!checkout?.id) return null;

    return {
      checkout,
      checkoutUrl: extractContinueUrl(response) || checkout.continue_url || null,
      shippingAddress: extractShippingDestination(checkout),
      validationErrors: extractCheckoutValidationErrors(checkout),
      buyerPhone: checkout?.buyer?.phone_number || null
    };
  } catch (error) {
    console.warn("[cart-wrapper] get_checkout verify failed", { checkoutId, message: error.message });
    return null;
  }
}

function isUsLikeCountry(country) {
  const value = String(country || "").trim().toUpperCase();
  return value === "US" || value === "USA" || value === "UNITED STATES";
}

function writableShippingAddress(destination = {}) {
  return {
    first_name: destination.first_name,
    last_name: destination.last_name,
    phone_number: destination.phone_number,
    street_address: destination.street_address,
    extended_address: destination.extended_address || undefined,
    address_locality: destination.address_locality,
    address_region: destination.address_region || undefined,
    postal_code: destination.postal_code,
    address_country: destination.address_country
  };
}

/**
 * Keep one checkout per conversation.
 * - If activeCheckoutId exists → update_checkout (items + shipping)
 * - Else if shipping (or force) and allowCreate → create_checkout once and store id
 */
async function syncCheckoutWithCart(
  mcpClient,
  conversationId,
  cart,
  { shipping = null, force = false, allowCreate = true } = {}
) {
  const savedShipping =
    shipping || (await getConversationShippingAddress(conversationId));
  const hasShipping = Boolean(savedShipping?.street_address);

  if (!cart?.id || !cart?.line_items?.length) {
    return null;
  }

  // No shipping and not forced → nothing to sync (cart-only browsing).
  if (!hasShipping && !force) {
    return null;
  }

  const destination = hasShipping ? writableShippingAddress(savedShipping) : null;
  let checkoutId = await getConversationCheckoutId(conversationId);

  if (checkoutId) {
    const updated = await updateExistingCheckout(
      mcpClient,
      checkoutId,
      cart,
      destination
    );

    if (updated?.checkout?.id) {
      await setConversationCheckoutId(conversationId, updated.checkout.id);
      const validationErrors = [
        ...(updated.validationErrors || []),
        ...extractCheckoutValidationErrors(updated.checkout)
      ];
      if (validationErrors.length === 0 && updated.shippingAddress) {
        await setConversationShippingAddress(
          conversationId,
          writableShippingAddress(updated.shippingAddress)
        );
      }

      console.log("[cart-wrapper] updated existing checkout", {
        conversationId,
        checkoutId: updated.checkout.id,
        hasShipping: Boolean(updated.shippingAddress?.street_address),
        validationErrors
      });

      return {
        checkoutId: updated.checkout.id,
        checkoutUrl: updated.checkoutUrl,
        shippingAddress: updated.shippingAddress || null,
        checkout: updated.checkout,
        validationErrors,
        error: updated.error || null,
        rate_limited: updated.rate_limited || false,
        retry_after_seconds: updated.retry_after_seconds || null
      };
    }

    // Field validation failure without a usable checkout payload — do not recreate.
    if ((updated?.validationErrors || []).length > 0 || updated?.rate_limited) {
      return {
        checkoutId,
        checkoutUrl: updated.checkoutUrl || null,
        shippingAddress: null,
        checkout: updated.checkout || null,
        validationErrors: updated.validationErrors || [],
        error: updated.error || null,
        rate_limited: updated.rate_limited || false,
        retry_after_seconds: updated.retry_after_seconds || null
      };
    }

    // Stale/expired checkout — create a new one only when allowed.
    console.warn("[cart-wrapper] checkout update failed, creating new checkout", {
      conversationId,
      checkoutId,
      error: updated?.error,
      allowCreate
    });
    await clearConversationCheckoutId(conversationId);
    checkoutId = null;
  }

  if (!allowCreate) {
    return {
      skipped_create: true,
      shippingAddress: destination,
      error: null
    };
  }

  const created = await createCheckoutFromCart(mcpClient, cart, destination);
  if (!created?.checkout?.id) {
    return {
      error: created?.error || "create_checkout failed",
      validationErrors: created?.validationErrors || [],
      rate_limited: created?.rate_limited || false,
      retry_after_seconds: created?.retry_after_seconds || null
    };
  }

  await setConversationCheckoutId(conversationId, created.checkout.id);
  const validationErrors = [
    ...(created.validationErrors || []),
    ...extractCheckoutValidationErrors(created.checkout)
  ];

  if (validationErrors.length === 0 && created.shippingAddress) {
    await setConversationShippingAddress(
      conversationId,
      writableShippingAddress(created.shippingAddress)
    );
  }

  console.log("[cart-wrapper] created checkout", {
    conversationId,
    checkoutId: created.checkout.id,
    hasShipping: Boolean(created.shippingAddress?.street_address),
    validationErrors
  });

  return {
    checkoutId: created.checkout.id,
    checkoutUrl: created.checkoutUrl,
    shippingAddress: created.shippingAddress || null,
    checkout: created.checkout,
    validationErrors,
    rate_limited: created.rate_limited || false,
    retry_after_seconds: created.retry_after_seconds || null
  };
}

async function updateExistingCheckout(mcpClient, checkoutId, cart, destination) {
  try {
    const getResponse = await mcpClient.callTool("get_checkout", { id: checkoutId });
    const existing = extractCheckoutPayload(getResponse);

    if (!existing?.id) {
      return { error: "checkout not found" };
    }

    const lineItems = buildUpdateCheckoutLineItems(cart.line_items, existing.line_items);
    console.log("[cart-wrapper] update_checkout line_items", {
      cartCount: cart.line_items?.length || 0,
      checkoutCount: existing.line_items?.length || 0,
      sending: lineItems.map((line) => ({
        variantId: line?.item?.id,
        quantity: line?.quantity,
        hasCheckoutLineId: Boolean(line?.id)
      }))
    });
    const checkoutBody = {
      line_items: lineItems,
      buyer: destination?.phone_number
        ? { phone_number: destination.phone_number }
        : existing.buyer || undefined
    };

    if (destination) {
      const lineItemIds = lineItems.map((line) => line.id).filter(Boolean);
      checkoutBody.fulfillment = {
        methods: [
          {
            type: "shipping",
            ...(lineItemIds.length ? { line_item_ids: lineItemIds } : {}),
            destinations: [destination]
          }
        ]
      };
    } else if (existing.fulfillment) {
      // Preserve existing fulfillment when only items change.
      checkoutBody.fulfillment = existing.fulfillment;
    }

    const updateResponse = await mcpClient.callTool("update_checkout", {
      id: checkoutId,
      checkout: checkoutBody
    });

    const responseErrors = extractCheckoutValidationErrors(updateResponse);
    const checkoutFromUpdate = extractCheckoutPayload(updateResponse);

    // Shopify often returns isError + messages without a checkout id (e.g. invalid phone).
    if (!checkoutFromUpdate?.id && responseErrors.length > 0) {
      return {
        checkout: existing,
        checkoutUrl: extractContinueUrl(getResponse) || existing.continue_url || null,
        shippingAddress: null,
        validationErrors: responseErrors,
        error: responseErrors[0]?.readable || extractToolErrorText(updateResponse)
      };
    }

    const checkout = checkoutFromUpdate || existing;
    if (!checkout?.id) {
      return {
        error: extractToolErrorText(updateResponse) || "update_checkout failed",
        validationErrors: responseErrors
      };
    }

    // If we sent destination but response omitted it, run a second update with fresh line ids.
    let shippingAddress = extractShippingDestination(checkout);
    let validationErrors = [
      ...responseErrors,
      ...extractCheckoutValidationErrors(checkout)
    ];

    if (destination && !shippingAddress?.street_address && responseErrors.length === 0) {
      const lineItemIds = (checkout.line_items || [])
        .map((line) => line.id)
        .filter(Boolean);
      const retryResponse = await mcpClient.callTool("update_checkout", {
        id: checkout.id,
        checkout: {
          line_items: buildCheckoutLineItems(checkout.line_items),
          buyer: { phone_number: destination.phone_number },
          fulfillment: {
            methods: [
              {
                type: "shipping",
                line_item_ids: lineItemIds,
                destinations: [destination]
              }
            ]
          }
        }
      });
      const retryErrors = extractCheckoutValidationErrors(retryResponse);
      const retried = extractCheckoutPayload(retryResponse) || checkout;
      shippingAddress = extractShippingDestination(retried);
      validationErrors = [
        ...validationErrors,
        ...retryErrors,
        ...extractCheckoutValidationErrors(retried)
      ];
      return {
        checkout: retried,
        checkoutUrl: extractContinueUrl(retryResponse) || retried.continue_url,
        shippingAddress: shippingAddress || null,
        validationErrors,
        error: retryErrors[0]?.readable || null
      };
    }

    return {
      checkout,
      checkoutUrl: extractContinueUrl(updateResponse) || checkout.continue_url,
      shippingAddress: shippingAddress || null,
      validationErrors
    };
  } catch (error) {
    return { error: error.message, ...parseShopifyTransportError(error) };
  }
}

async function createCheckoutFromCart(mcpClient, cart, destination) {
  try {
    const overrides = {};
    if (destination?.phone_number) {
      overrides.buyer = { phone_number: destination.phone_number };
    }
    // Do not attach fulfillment on create_checkout — destinations stick reliably
    // only after update_checkout with checkout line_item_ids.

    const response = await mcpClient.callTool(
      "create_checkout",
      buildCreateCheckoutArgs(cart.id, cart, overrides)
    );
    let checkout = extractCheckoutPayload(response);
    const createErrors = extractCheckoutValidationErrors(response);

    if (!checkout?.id) {
      return {
        error: createErrors[0]?.readable || extractToolErrorText(response) || "create_checkout failed",
        validationErrors: createErrors
      };
    }

    let shippingAddress = extractShippingDestination(checkout);
    let checkoutUrl = extractContinueUrl(response) || checkout.continue_url;
    let validationErrors = [
      ...createErrors,
      ...extractCheckoutValidationErrors(checkout)
    ];

    if (destination?.street_address) {
      const lineItems = buildCheckoutLineItems(checkout.line_items || cart.line_items);
      const lineItemIds = lineItems.map((line) => line.id).filter(Boolean);
      const updateResponse = await mcpClient.callTool("update_checkout", {
        id: checkout.id,
        checkout: {
          line_items: lineItems,
          buyer: destination.phone_number
            ? { phone_number: destination.phone_number }
            : undefined,
          fulfillment: {
            methods: [
              {
                type: "shipping",
                ...(lineItemIds.length ? { line_item_ids: lineItemIds } : {}),
                destinations: [destination]
              }
            ]
          }
        }
      });
      const updateErrors = extractCheckoutValidationErrors(updateResponse);
      const updatedCheckout = extractCheckoutPayload(updateResponse);
      if (updatedCheckout?.id) {
        checkout = updatedCheckout;
        shippingAddress = extractShippingDestination(checkout);
        checkoutUrl = extractContinueUrl(updateResponse) || checkout.continue_url || checkoutUrl;
      } else {
        shippingAddress = null;
      }
      validationErrors = [
        ...validationErrors,
        ...updateErrors,
        ...extractCheckoutValidationErrors(checkout)
      ];
    }

    return {
      checkout,
      checkoutUrl,
      shippingAddress,
      validationErrors,
      error: validationErrors[0]?.readable || null
    };
  } catch (error) {
    return { error: error.message, ...parseShopifyTransportError(error) };
  }
}

/** Parse Shopify MCP transport failures (429 rate limit, etc.) for the LLM. */
function parseShopifyTransportError(error) {
  const message = String(error?.message || error || "");
  const status = Number(error?.status) || (/Request failed:\s*(\d+)/i.exec(message)?.[1]
    ? Number(/Request failed:\s*(\d+)/i.exec(message)[1])
    : 0);

  const retryMatch =
    /retry after\s+(\d+)\s*seconds/i.exec(message) ||
    /retry-after["\s:]+(\d+)/i.exec(message);
  const retryAfterSeconds = retryMatch ? Number(retryMatch[1]) : null;

  const rateLimited =
    status === 429 ||
    /rate limit exceeded/i.test(message) ||
    /too many requests/i.test(message);

  let shopifyMessage = message;
  try {
    const jsonMatch = message.match(/\{[\s\S]*\}$/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const rpcError = parsed?.error;
      if (rpcError?.message || rpcError?.data) {
        shopifyMessage = [rpcError.message, rpcError.data].filter(Boolean).join(" — ");
      }
    }
  } catch {
    // keep raw message
  }

  return {
    status: status || null,
    rate_limited: rateLimited,
    retry_after_seconds: retryAfterSeconds,
    shopify_error: shopifyMessage
  };
}

function buildCartSummaryWithCheckoutIssue(cart, rawResponse, synced, savedShipping) {
  const transport = parseShopifyTransportError(synced?.error || synced?.shopify_error || "");
  const rateLimited = Boolean(synced?.rate_limited || transport.rate_limited);
  const retryAfter =
    synced?.retry_after_seconds ?? transport.retry_after_seconds ?? null;
  const shopifyError =
    synced?.shopify_error ||
    transport.shopify_error ||
    synced?.error ||
    "Checkout sync failed";

  const issues = [
    ...new Set(
      [
        ...(synced?.validationErrors || []).map((item) =>
          typeof item === "string" ? item : item.content || item.readable
        ),
        shopifyError
      ].filter(Boolean)
    )
  ];

  // If Shopify still gave a checkout URL, keep it — do not hide the link.
  const checkoutUrl = synced?.checkoutUrl || null;
  const summary = formatCartSummary(cart, rawResponse, {
    checkoutUrl,
    shippingAddress: checkoutUrl ? synced?.shippingAddress || savedShipping : null
  });

  if (checkoutUrl && !rateLimited) {
    return {
      ...summary,
      success: true,
      cart_updated: true,
      checkout_url: checkoutUrl,
      issues,
      instruction:
        "Cart updated. checkout_url is available — share it as: You can [click here to proceed to checkout](URL). " +
        "Ignore escalation noise; the customer completes payment on that Shopify page."
    };
  }

  return {
    ...summary,
    success: true,
    cart_updated: true,
    checkout_sync_failed: true,
    rate_limited: rateLimited,
    retry_after_seconds: retryAfter,
    shipping_address_on_file: savedShipping || null,
    shopify_errors: issues.map((content) => ({ content })),
    issues,
    checkout_url: null,
    instruction:
      "The cart items/totals above DID update successfully. " +
      "Checkout sync FAILED — read issues[] / shopify_errors and tell the customer that exact problem " +
      "(e.g. Rate limit exceeded / Too many requests, and retry_after_seconds if present). " +
      "Do NOT share a checkout link. Do NOT claim checkout is ready. Do NOT invent a success-only reply."
  };
}

function buildUpdateCheckoutLineItems(cartLines = [], checkoutLines = []) {
  const byVariant = new Map();
  for (const line of checkoutLines) {
    const variantId = line?.item?.id;
    if (variantId && line?.id) {
      byVariant.set(variantId, line.id);
    }
  }

  return toWritableLineItems(cartLines).map((item) => {
    const existingId = byVariant.get(item.item.id);
    if (existingId) {
      return {
        id: existingId,
        quantity: item.quantity,
        item: { id: item.item.id }
      };
    }
    return item;
  });
}

/**
 * After cart changes: keep checkout in sync when shipping is on file so checkout_url
 * is returned (same behavior as before). On Shopify 429 / sync failure, surface the
 * error instead of faking a ready checkout link.
 */
async function summarizeCartWithShipping(
  mcpClient,
  conversationId,
  cart,
  rawResponse,
  { allowCreate = true } = {}
) {
  const savedShipping = await getConversationShippingAddress(conversationId);
  const checkoutId = await getConversationCheckoutId(conversationId);

  if (!savedShipping?.street_address && !checkoutId) {
    return formatCartSummary(cart, rawResponse);
  }

  // Rare: caller opted out of create (should not hide URL when checkout already exists).
  if (!checkoutId && !allowCreate) {
    return {
      ...formatCartSummary(cart, rawResponse, {
        checkoutUrl: null,
        shippingAddress: savedShipping
      }),
      checkout_url: null,
      needs_checkout_link: true,
      instruction:
        "Cart update succeeded and shipping is on file, but checkout_url is not available yet. " +
        "Do NOT invent a checkout link. Tell the customer their cart was updated. " +
        "If they ask to checkout/proceed, call get_my_cart to obtain checkout_url."
    };
  }

  const synced = await syncCheckoutWithCart(mcpClient, conversationId, cart, {
    shipping: savedShipping,
    allowCreate,
    force: Boolean(allowCreate && savedShipping?.street_address && !checkoutId)
  });

  if (!synced) {
    return formatCartSummary(cart, rawResponse, {
      checkoutUrl: null,
      shippingAddress: savedShipping
    });
  }

  if (
    synced.rate_limited ||
    (synced.error && !synced.checkoutUrl) ||
    ((synced.validationErrors || []).length > 0 && !synced.checkoutUrl)
  ) {
    return buildCartSummaryWithCheckoutIssue(
      cart,
      rawResponse,
      synced,
      savedShipping
    );
  }

  // Checkout URL present — share it even if Shopify also sent escalation messages
  // (item_unavailable / extension_interaction_required / requires_escalation).
  if (synced.checkoutUrl) {
    return formatCartSummary(cart, rawResponse, {
      checkoutUrl: synced.checkoutUrl,
      shippingAddress: synced.shippingAddress || savedShipping
    });
  }

  if ((synced.validationErrors || []).length > 0 || synced.error) {
    return buildCartSummaryWithCheckoutIssue(
      cart,
      rawResponse,
      synced,
      savedShipping
    );
  }

  if (synced.skipped_create) {
    return {
      ...formatCartSummary(cart, rawResponse, {
        checkoutUrl: null,
        shippingAddress: savedShipping
      }),
      checkout_url: null,
      needs_checkout_link: true,
      instruction:
        "Cart is up to date and shipping is on file, but checkout_url is not available yet. " +
        "Do NOT invent a checkout link. If the customer wants to pay, call get_my_cart."
    };
  }

  return formatCartSummary(cart, rawResponse, {
    checkoutUrl: synced.checkoutUrl || null,
    shippingAddress: synced.shippingAddress || savedShipping
  });
}

async function clearMyCart(mcpClient, conversationId) {
  const cartId = await getConversationCartId(conversationId);
  const checkoutId = await getConversationCheckoutId(conversationId);

  if (!cartId && !checkoutId) {
    return toolResult({ success: true, message: "No active cart." });
  }

  if (checkoutId) {
    try {
      await mcpClient.callTool("cancel_checkout", {
        id: checkoutId,
        meta: { "idempotency-key": crypto.randomUUID() }
      });
    } catch (error) {
      console.warn("[cart-wrapper] cancel_checkout:", error.message);
    }
  }

  if (cartId) {
    await mcpClient.callTool("cancel_cart", {
      id: cartId,
      meta: {
        "idempotency-key": crypto.randomUUID()
      }
    });
  }

  await clearConversationCartId(conversationId);
  await clearConversationCheckoutId(conversationId);
  await clearConversationShippingAddress(conversationId);

  return toolResult({ success: true, message: "Cart cleared. Use add_to_cart to start a new cart." });
}

function normalizeVariantId(id) {
  if (!id || typeof id !== "string") {
    return null;
  }

  const trimmed = id.trim();
  if (trimmed.includes("ProductVariant")) {
    return trimmed;
  }

  if (/^\d+$/.test(trimmed)) {
    return `gid://shopify/ProductVariant/${trimmed}`;
  }

  return trimmed;
}

function resolveRemoveVariantId(lineItems, { variant_id, product_title }) {
  if (variant_id) {
    const normalized = normalizeVariantId(variant_id);
    const match = lineItems.find((line) => line?.item?.id === normalized);
    return match?.item?.id || null;
  }

  if (!product_title) {
    return null;
  }

  const msg = product_title.toLowerCase();
  const scored = lineItems
    .map((line) => {
      const title = (line.item?.title || "").toLowerCase();
      if (!title) {
        return { line, score: 0 };
      }

      const tokens = title.split(/[^a-z0-9]+/).filter((t) => t.length > 2);
      let score = tokens.filter((t) => msg.includes(t)).length;
      const yearMatch = title.match(/\b(19|20)\d{2}\b/);
      if (yearMatch && msg.includes(yearMatch[0])) {
        score += 3;
      }

      return { line, score };
    })
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  const second = scored[1];
  if (!best || best.score < 2) {
    return null;
  }
  if (second && second.score >= best.score - 1 && second.score >= 2) {
    return null;
  }

  return best.line.item?.id || null;
}

const SHIPPING_REQUIRED_FIELDS = [
  "first_name",
  "last_name",
  "phone_number",
  "street_address",
  "address_locality",
  "postal_code",
  "address_country"
];

function extractAddressText(text) {
  const raw = String(text || "").trim();
  if (!raw) {
    return raw;
  }

  const prefixPattern = /^(?:please\s+)?(?:add|set|update|change)(?:\s+this)?\s+(?:the\s+)?(?:shipping\s+)?address\s*:+\s*/i;
  return raw.replace(prefixPattern, "").trim() || raw;
}

export function parseAddressText(text) {
  const raw = extractAddressText(text);
  if (!raw) {
    return null;
  }

  const parts = raw.split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length < 4) {
    return null;
  }

  const phoneIdx = parts.findIndex((part) => {
    const digits = part.replace(/\D/g, "");
    return digits.length >= 10 && digits.length <= 15;
  });
  if (phoneIdx <= 0) {
    return null;
  }

  const nameParts = parts[0].split(/\s+/).filter(Boolean);
  if (nameParts.length === 0) {
    return null;
  }

  let tail = parts.slice(phoneIdx + 1);
  if (tail.length < 2) {
    return null;
  }

  const zipOnlyPattern = /^\d{5}(?:-\d{4})?$/;
  const stateZipPattern = /^([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)$/;
  const stateOnlyPattern = /^[A-Za-z]{2}$/;

  let address_country = null;
  const lastPart = tail[tail.length - 1];
  if (
    !zipOnlyPattern.test(lastPart) &&
    !stateZipPattern.test(lastPart) &&
    !stateOnlyPattern.test(lastPart)
  ) {
    address_country = lastPart;
    tail = tail.slice(0, -1);
  }

  if (tail.length < 2) {
    return null;
  }

  let postal_code = null;
  let address_region = null;
  let address_locality = null;
  let streetParts = [];

  const tailEnd = tail[tail.length - 1];
  if (stateZipPattern.test(tailEnd)) {
    const match = tailEnd.match(stateZipPattern);
    address_region = match[1].toUpperCase();
    postal_code = match[2];
    tail = tail.slice(0, -1);
  } else if (zipOnlyPattern.test(tailEnd)) {
    postal_code = tailEnd;
    tail = tail.slice(0, -1);
    if (tail.length > 0 && stateOnlyPattern.test(tail[tail.length - 1])) {
      address_region = tail[tail.length - 1].toUpperCase();
      tail = tail.slice(0, -1);
    }
  } else {
    return null;
  }

  if (tail.length < 1) {
    return null;
  }

  address_locality = tail[tail.length - 1];
  streetParts = tail.slice(0, -1);
  if (streetParts.length === 0) {
    return null;
  }

  return {
    first_name: nameParts[0],
    last_name: nameParts.slice(1).join(" ") || nameParts[0],
    phone_number: parts[phoneIdx].replace(/\D/g, ""),
    street_address: streetParts.join(", "),
    address_locality,
    address_region: address_region || null,
    postal_code,
    address_country
  };
}

function extractExistingShipping(cart) {
  const destinations = cart?.fulfillment?.methods?.flatMap((method) => method.destinations || []) || [];
  const destination = destinations.find((entry) => entry && typeof entry === "object");
  if (!destination) {
    return {};
  }

  return {
    address_country: destination.address_country || null,
    address_region: destination.address_region || null
  };
}

function normalizeShippingAddress(input = {}, { userMessage, existingCart } = {}) {
  const merged = { ...input };
  delete merged.address_text;

  const textSources = [input.address_text, userMessage].filter(Boolean);
  let parsedFromText = false;

  for (const text of textSources) {
    const parsed = parseAddressText(text);
    if (!parsed) {
      continue;
    }

    parsedFromText = true;
    for (const [key, value] of Object.entries(parsed)) {
      if (value && !merged[key]) {
        merged[key] = value;
      }
    }
  }

  const existingShipping = extractExistingShipping(existingCart);
  for (const [key, value] of Object.entries(existingShipping)) {
    if (value && !merged[key]) {
      merged[key] = value;
    }
  }

  if (merged.address_country) {
    merged.address_country = String(merged.address_country).trim();
  }

  const missing = SHIPPING_REQUIRED_FIELDS.filter((field) => !String(merged[field] || "").trim());

  return {
    address: merged,
    missing,
    parsedFromText
  };
}

export default {
  getCartWrapperTools,
  isCartWrapperTool,
  filterCartToolsForLlm,
  callCartWrapperTool,
  buildActiveCartWrapperContextMessage
};
