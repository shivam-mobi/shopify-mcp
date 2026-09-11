/**
 * Cart wrapper tools for the LLM.
 * The model calls simple intents; this module builds correct Shopify UCP payloads.
 */
import {
  clearConversationCartId,
  clearConversationCheckout,
  clearConversationCheckoutId,
  clearConversationShippingAddress,
  getConversationCartId,
  getConversationCheckoutId,
  getConversationShippingAddress,
  setConversationCheckoutId,
  setConversationCheckoutUrl,
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
import {
  appendAiraUtmParams,
  withAiraAttribution
} from "./aira-attribution.server.js";
import AppConfig from "./config.server.js";

const TOOL_FAILURE_USER_MESSAGE = AppConfig.errorMessages.toolFailure;

const SHIPPING_ASK_LIST_TEXT =
  "1. First Name\n2. Last Name\n3. Phone Number\n4. Email (optional)\n5. Street Address\n6. City\n7. State/Region\n8. Postal Code\n9. Country";

export const CART_MUTATION_TOOL_NAMES = new Set([
  "add_to_cart",
  "remove_from_cart",
  "update_cart_items",
  "clear_my_cart"
]);

export function isCartMutationTool(toolName) {
  return CART_MUTATION_TOOL_NAMES.has(toolName);
}

const RATE_LIMIT_CUSTOMER_INSTRUCTION =
  `The customer was already shown: "${TOOL_FAILURE_USER_MESSAGE}" ` +
  "Do not add any other sentence. No follow-up questions, no 'let me know if you need something else', " +
  "no rate limits, 429, or retry timers.";
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
  "update_cart_items",
  "get_my_cart",
  "set_cart_shipping",
  "remove_cart_shipping",
  "clear_my_cart",
  "apply_discount_code"
];

export function getCartWrapperTools() {
  return [
    {
      name: "add_to_cart",
      description:
        "Add ONE product to the customer's cart (or increase that one product's qty). Always keeps existing cart items. " +
        "Pass variant_id from the latest catalog products[] (gid://shopify/ProductVariant/...). " +
        "If the customer message includes variant_id: gid://..., use that EXACT id — do not swap to a different product. " +
        "When they name a product, match products[].title and use that row's variant_id. " +
        "For changing MULTIPLE products at once (increase each qty, set several qtys, remove several items), " +
        "call update_cart_items ONCE — do NOT call add_to_cart repeatedly. " +
        "Server handles merge — never call create_cart or update_cart directly.",
      input_schema: {
        type: "object",
        properties: {
          variant_id: {
            type: "string",
            description: "Shopify ProductVariant GID from catalog search results (exact id for the chosen product)"
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
        "Reduce quantity or remove ONE specific product line. Do NOT use for remove-all / empty-cart — use clear_my_cart instead. " +
        "Do NOT use for multiple products — use update_cart_items once instead. " +
        "DEFAULT reduces quantity by 1 (does NOT remove the whole line). " +
        "For 'reduce 1 qty' / 'remove one' / 'decrease quantity': pass quantity:1 (or omit quantity — default is 1). " +
        "ONLY to delete one product entirely (customer names one product), pass remove_all:true. " +
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
      name: "update_cart_items",
      description:
        "Change MULTIPLE cart lines in ONE call (single Shopify cart update + checkout sync). " +
        "Use when the customer wants to update more than one product: " +
        "increase/decrease qty for each item, set several quantities, or remove several products. " +
        "Prefer adjust_all_delta:+1 when they say increase qty for each / every product. " +
        "Or pass items[] with variant_id (from cart/get_my_cart) plus quantity (absolute), " +
        "quantity_delta (+/-), or remove:true / quantity:0 to delete that line. " +
        "Do NOT call add_to_cart or remove_from_cart in a loop for multi-line changes. " +
        "For emptying the entire cart, use clear_my_cart. For a single product only, prefer add_to_cart / remove_from_cart.",
      input_schema: {
        type: "object",
        properties: {
          adjust_all_delta: {
            type: "integer",
            description:
              "Add this amount to EVERY current cart line qty (e.g. 1 = +1 each, -1 = -1 each). " +
              "Lines that reach 0 are removed. Use alone or together with items[]."
          },
          items: {
            type: "array",
            description: "Per-line changes. Prefer variant_id from the current cart.",
            items: {
              type: "object",
              properties: {
                variant_id: {
                  type: "string",
                  description: "ProductVariant GID for a cart line"
                },
                product_title: {
                  type: "string",
                  description: "Fallback match if variant_id unknown"
                },
                quantity: {
                  type: "integer",
                  description:
                    "Absolute final quantity for this line. 0 removes the line. Prefer this when the customer gives an exact qty."
                },
                quantity_delta: {
                  type: "integer",
                  description:
                    "Relative change (+1 / -2). Ignored if quantity or remove is set."
                },
                remove: {
                  type: "boolean",
                  description: "Set true to remove this entire product line"
                }
              }
            }
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
        "YOU convert the customer's free-text into structured fields when you can (name, phone, street, city, state, ZIP, country). " +
        "NEVER invent First/Last Name from street or building names (Cooper Square is NOT a person). NEVER invent or guess a phone number. " +
        "If the customer only sent an address line, pass address fields only — leave name/phone blank if missing and the server will ask, OR reuse them when updating an address already on file. " +
        "For partial updates (email, name, phone, or one address field), pass ONLY the fields the customer gave — the server merges any missing fields from the saved shipping address on file. " +
        "Use 2-letter US state (New York → NY) and ISO country (USA → US). Keep phone in E.164 with + when the customer gave it. " +
        "Required before save: First Name, Last Name, Phone Number, Street Address, City, Postal Code, Country (State/Region too for US). " +
        "Email is optional — pass it when the customer provides one. " +
        "When asking for missing shipping fields (2+ required items), use this EXACT list and always include item 4 Email (optional):\n" +
        SHIPPING_ASK_LIST_TEXT + "\n" +
        "If the customer already gave an email, pass it on set_cart_shipping — do not wait until after the address is saved. " +
        "The server validates ALL required fields before Shopify — never call with blank fields you can fill yourself. " +
        "If success:false / shipping_saved:false, read issues[] and ask the customer ONLY for missing or invalid fields listed there. " +
        "If empty_cart:true, ask the customer to add a product to their cart first — do NOT show a generic error. " +
        "Never re-ask the full address form. Never claim it was saved.",
      input_schema: {
        type: "object",
        properties: {
          address_text: {
            type: "string",
            description:
              "Optional raw customer message. Prefer structured fields when you can convert the address yourself."
          },
          first_name: { type: "string", description: "First Name (required)" },
          last_name: { type: "string", description: "Last Name (required)" },
          phone_number: {
            type: "string",
            description:
              "Phone Number (required). Prefer E.164 with + when provided. 10-digit US numbers are also fine."
          },
          email: {
            type: "string",
            description:
              "Email address (optional). For order confirmation and updates — not a substitute for first/last name."
          },
          street_address: { type: "string", description: "Street Address (required)" },
          extended_address: { type: "string" },
          address_locality: { type: "string", description: "City (required)" },
          address_region: {
            type: "string",
            description: "State/Region (required for US). Use 2-letter code (NY, CA)."
          },
          postal_code: { type: "string", description: "Postal Code / ZIP (required)" },
          address_country: {
            type: "string",
            description: "Country (required). ISO 2-letter code (US not USA)."
          }
        }
      }
    },
    {
      name: "remove_cart_shipping",
      description:
        "Remove the saved shipping address from checkout. Keeps cart products and the same checkout session. " +
        "Use when the customer asks to remove, clear, or delete their shipping address. " +
        "Do NOT call set_cart_shipping with empty fields.",
      input_schema: {
        type: "object",
        properties: {}
      }
    },
    {
      name: "clear_my_cart",
      description:
        "Empty the entire cart in one call. Use when the customer says remove all products, remove everything, " +
        "empty cart, clear cart, delete all items, or start over. Do NOT call remove_from_cart repeatedly for this.",
      input_schema: {
        type: "object",
        properties: {}
      }
    },
    {
      name: "apply_discount_code",
      description:
        "Apply or clear a Shopify discount / promo code on checkout (same UCP checkout session). " +
        "Call when the customer gives a coupon/promo/discount code (e.g. SAVE10, WELCOME20). " +
        "Requires at least one product in the cart. Uses existing create_checkout / update_checkout — does not change cart lines. " +
        "Pass code with the promo string. Pass clear:true to remove applied codes. " +
        "If success:false, tell the customer EXACTLY the tool customer_message / issues text " +
        "(e.g. the code is not available to them) — do NOT say the discount was applied. " +
        "If success:true, confirm briefly and mention updated total when present.",
      input_schema: {
        type: "object",
        properties: {
          code: {
            type: "string",
            description: "Discount / promo code to apply (required unless clear:true)"
          },
          clear: {
            type: "boolean",
            description: "Set true to remove discount codes from checkout"
          }
        }
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
    case "update_cart_items":
      return updateCartItems(mcpClient, conversationId, toolArgs);
    case "get_my_cart":
      return getMyCart(mcpClient, conversationId);
    case "set_cart_shipping":
      return setCartShipping(mcpClient, conversationId, toolArgs, context);
    case "remove_cart_shipping":
      return removeCartShipping(mcpClient, conversationId);
    case "clear_my_cart":
      return clearMyCart(mcpClient, conversationId);
    case "apply_discount_code":
      return applyDiscountCode(mcpClient, conversationId, toolArgs);
    default:
      return toolError(`Unknown cart wrapper tool: ${toolName}`);
  }
}

/** Inject when the user's message looks like a shipping address. */
export function buildShippingAddressHintMessage(userMessage) {
  const text = extractAddressText(userMessage);
  const parsed = parseAddressText(userMessage) || parseAddressLineOnly(text);
  if (!parsed) {
    return null;
  }

  const hasPhone = Boolean(extractPhoneFromText(text));
  const hasEmail = Boolean(extractEmailFromText(text));
  const hasName = Boolean(parseAddressText(userMessage)?.first_name || extractNamePartsFromText(text));
  const addressOnly = Boolean(parseAddressLineOnly(text));

  let content =
    "The customer's latest message contains a shipping address. " +
    "Call set_cart_shipping with structured fields YOU convert (street, city, state, ZIP, country). ";

  if (addressOnly || (!hasName && !hasPhone)) {
    content +=
      "They did NOT give a person name or phone in this message — do NOT invent name from the street/building and do NOT guess a phone. " +
      "Omit first_name, last_name, and phone_number (or leave blank). The server will ask ONLY for what is missing. " +
      "If you must ask for missing fields, use this EXACT list (always include item 4 Email (optional)):\n" +
      `${SHIPPING_ASK_LIST_TEXT}\n`;
  } else {
    content +=
      "Include first_name, last_name, and phone_number only if the customer provided them. ";
  }

  if (hasEmail) {
    content += "Include email when the customer provided one — email is optional but helpful for order updates. ";
  } else {
    content +=
      "Email is optional — you may offer to add one for order updates after the address is saved. ";
  }

  content +=
    "Use 2-letter US state and ISO country (US). The server validates all fields before Shopify. " +
    "If anything is missing or invalid, ask ONLY for those fields — never re-list the full form.";

  return { role: "system", content };
}

/** When the customer only asks to add/update email (no address in message). */
export function buildShippingEmailHintMessage(userMessage) {
  const text = String(userMessage || "").trim();
  const email = extractEmailFromText(text);
  if (!email) {
    return null;
  }

  const wantsEmail =
    /\b(emails?|e-mail)\b/i.test(text) ||
    /\badd\s+(?:the\s+)?email\b/i.test(text) ||
    /\bupdate\s+(?:my\s+)?email\b/i.test(text);
  if (!wantsEmail) {
    return null;
  }

  if (parseAddressText(userMessage) || parseAddressLineOnly(extractAddressText(text))) {
    return null;
  }

  return {
    role: "system",
    content:
      `The customer wants to add or update email: ${email}. ` +
      "If shipping is already on file, call set_cart_shipping with email and reuse saved name/phone/address fields (pass email only — server merges the rest). " +
      "If required address fields are still missing, ask in ONE message using this EXACT numbered list (never omit item 4):\n" +
      `${SHIPPING_ASK_LIST_TEXT}\n` +
      `Pass email: "${email}" on set_cart_shipping together with any address fields you already have — ` +
      "do NOT say email will be added only after the rest of the address is saved."
  };
}

export function buildActiveCartWrapperContextMessage(cartId) {
  if (!cartId) {
    return null;
  }

  return {
    role: "system",
    content:
      "This conversation has an active cart. Use add_to_cart to add products or increase qty for ONE product, " +
      "remove_from_cart for ONE product or reduce that product's qty (NOT for remove-all), " +
      "update_cart_items ONCE for multi-product qty changes or multi-product removes " +
      "(e.g. increase each qty, set several qtys, remove several items — never loop add_to_cart), " +
      "clear_my_cart to remove all products / empty cart, " +
      "get_my_cart to show contents, set_cart_shipping to save address, remove_cart_shipping to clear address, " +
      "apply_discount_code when they give a promo/coupon code. " +
      "Do NOT call create_cart, update_cart, or get_cart directly."
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
      cart: withAiraAttribution({ line_items: [newItem] }, conversationId)
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

  // Prefer Shopify's update_cart payload. Only re-fetch when the new variant is missing
  // (some responses omit new lines / stale fulfillment).
  let verified = null;
  let verifiedCart = extractCartPayload(response);
  let added = (verifiedCart?.line_items || []).some(
    (line) => line?.item?.id === variantId
  );

  if (!added) {
    verified = await fetchLiveCart(mcpClient, conversationId);
    verifiedCart = verified?.cart || verifiedCart;
    added = (verifiedCart?.line_items || []).some(
      (line) => line?.item?.id === variantId
    );
  }

  console.log("[cart-wrapper] add_to_cart", {
    conversationId,
    variantId,
    before: live.cart.line_items?.length || 0,
    merged: merged.length,
    after: verifiedCart?.line_items?.length || 0,
    added,
    reFetched: Boolean(verified)
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

  // Prefer update_cart payload; re-fetch only if Shopify response doesn't reflect the change.
  let cartForSummary = extractCartPayload(response);
  let rawForSummary = response;
  const targetAfter = (cartForSummary?.line_items || []).find(
    (line) => line?.item?.id === removeVariantId
  );
  const qtyMatches =
    nextQty <= 0
      ? !targetAfter
      : Number(targetAfter?.quantity) === nextQty;

  if (!qtyMatches) {
    const verified = await fetchLiveCart(mcpClient, conversationId);
    if (verified?.cart) {
      cartForSummary = verified.cart;
      rawForSummary = verified.raw;
    }
  }

  console.log("[cart-wrapper] remove_from_cart", {
    conversationId,
    variantId: removeVariantId,
    currentQty,
    reduceBy,
    nextQty: Math.max(0, nextQty),
    wantsFullRemove,
    remainingLines: lineItems.length,
    reFetched: !qtyMatches,
    userMessagePreview: userMessage.slice(0, 80)
  });

  const summary = await summarizeCartWithShipping(
    mcpClient,
    conversationId,
    cartForSummary,
    rawForSummary
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

/**
 * Bulk cart line updates in one Shopify update_cart + one checkout sync.
 * Supports adjust-all delta and per-line set / delta / remove.
 */
async function updateCartItems(mcpClient, conversationId, toolArgs = {}) {
  const live = await fetchLiveCart(mcpClient, conversationId);
  if (!live?.cart?.line_items?.length) {
    return toolError("Cart is empty.");
  }

  const adjustments = Array.isArray(toolArgs.items) ? toolArgs.items : [];
  const adjustAllRaw = toolArgs.adjust_all_delta;
  const adjustAllDelta =
    adjustAllRaw == null || adjustAllRaw === ""
      ? null
      : Number(adjustAllRaw);

  if (
    !adjustments.length &&
    (adjustAllDelta == null || !Number.isFinite(adjustAllDelta) || adjustAllDelta === 0)
  ) {
    return toolError(
      "Pass adjust_all_delta (e.g. 1 to increase every line) and/or items[] with variant_id + quantity / quantity_delta / remove."
    );
  }

  /** @type {Map<string, { quantity: number, item: { id: string }, title?: string }>} */
  const byVariant = new Map();
  for (const line of live.cart.line_items) {
    const variantId = line?.item?.id;
    if (!variantId) continue;
    byVariant.set(variantId, {
      quantity: Math.max(1, Number(line.quantity) || 1),
      item: { id: variantId },
      title: line.item?.title || "Product"
    });
  }

  const changes = [];
  const issues = [];

  const applyQty = (variantId, nextQty, title) => {
    const prev = byVariant.get(variantId);
    const previousQuantity = prev ? prev.quantity : 0;
    const safeNext = Math.max(0, Number(nextQty) || 0);

    if (safeNext <= 0) {
      byVariant.delete(variantId);
      changes.push({
        variant_id: variantId,
        title: title || prev?.title || "Product",
        action: "removed",
        previous_quantity: previousQuantity,
        new_quantity: 0
      });
      return;
    }

    byVariant.set(variantId, {
      quantity: safeNext,
      item: { id: variantId },
      title: title || prev?.title || "Product"
    });
    changes.push({
      variant_id: variantId,
      title: title || prev?.title || "Product",
      action: previousQuantity === 0 ? "added" : "updated",
      previous_quantity: previousQuantity,
      new_quantity: safeNext
    });
  };

  if (adjustAllDelta != null && Number.isFinite(adjustAllDelta) && adjustAllDelta !== 0) {
    const snapshot = Array.from(byVariant.entries());
    for (const [variantId, entry] of snapshot) {
      applyQty(variantId, entry.quantity + adjustAllDelta, entry.title);
    }
  }

  for (const raw of adjustments) {
    if (!raw || typeof raw !== "object") continue;

    const targetId =
      resolveRemoveVariantId(live.cart.line_items, {
        variant_id: raw.variant_id,
        product_title: raw.product_title
      }) || normalizeVariantId(raw.variant_id);

    if (!targetId || !byVariant.has(targetId)) {
      // Already removed by adjust_all_delta — ignore further remove on same line.
      if (raw.remove === true || Number(raw.quantity) === 0) continue;
      issues.push(
        `Could not find product in cart: ${raw.variant_id || raw.product_title || "unknown"}`
      );
      continue;
    }

    const current = byVariant.get(targetId);
    const title = current?.title || "Product";

    if (raw.remove === true || Number(raw.quantity) === 0) {
      applyQty(targetId, 0, title);
      continue;
    }

    if (raw.quantity != null && raw.quantity !== "") {
      applyQty(targetId, Number(raw.quantity), title);
      continue;
    }

    if (raw.quantity_delta != null && raw.quantity_delta !== "") {
      const delta = Number(raw.quantity_delta);
      if (!Number.isFinite(delta) || delta === 0) continue;
      applyQty(targetId, current.quantity + delta, title);
      continue;
    }

    issues.push(`No quantity / quantity_delta / remove for: ${title}`);
  }

  if (!changes.length) {
    return toolResult({
      success: false,
      issues: issues.length ? issues : ["No cart lines were changed."],
      instruction:
        "Nothing changed. If products were not found, call get_my_cart then retry update_cart_items with exact variant_id values."
    });
  }

  const lineItems = Array.from(byVariant.values()).map((entry) => ({
    quantity: entry.quantity,
    item: { id: entry.item.id }
  }));

  if (!lineItems.length) {
    const cleared = await clearMyCart(mcpClient, conversationId);
    const clearedData = extractToolResultData(cleared) || {};
    return toolResult({
      ...clearedData,
      success: true,
      empty: true,
      items: [],
      changes,
      issues: issues.length ? issues : undefined,
      action: "bulk_updated",
      instruction:
        "All listed products were removed and the cart is now empty. " +
        "Base your reply on changes[]. Do not invent remaining items."
    });
  }

  const response = await updateCartLineItems(
    mcpClient,
    conversationId,
    live.cartId,
    live.cart,
    lineItems
  );

  let cartForSummary = extractCartPayload(response);
  let rawForSummary = response;

  // Verify expected line count / qtys; re-fetch only if Shopify response looks incomplete.
  const expectedByVariant = new Map(
    lineItems.map((line) => [line.item.id, line.quantity])
  );
  const actualLines = cartForSummary?.line_items || [];
  const looksComplete =
    actualLines.length === expectedByVariant.size &&
    actualLines.every((line) => {
      const id = line?.item?.id;
      if (!id || !expectedByVariant.has(id)) return false;
      return Number(line.quantity) === expectedByVariant.get(id);
    });

  if (!looksComplete) {
    const verified = await fetchLiveCart(mcpClient, conversationId);
    if (verified?.cart) {
      cartForSummary = verified.cart;
      rawForSummary = verified.raw;
    }
  }

  console.log("[cart-wrapper] update_cart_items", {
    conversationId,
    adjustAllDelta,
    changeCount: changes.length,
    remainingLines: lineItems.length,
    reFetched: !looksComplete,
    issues
  });

  const summary = await summarizeCartWithShipping(
    mcpClient,
    conversationId,
    cartForSummary,
    rawForSummary
  );

  return toolResult({
    ...summary,
    success: true,
    action: "bulk_updated",
    changes,
    issues: issues.length ? issues : undefined,
    instruction: [
      "Cart was updated in one bulk operation. State quantities ONLY from items[].",
      "Summarize changes[] briefly. Do not call add_to_cart/remove_from_cart again for this request.",
      issues.length ? `Note issues: ${issues.join("; ")}` : null,
      summary.instruction
    ]
      .filter(Boolean)
      .join(" ")
  });
}

/**
 * After cart mutation tools finish in an assistant turn, inject one authoritative cart
 * snapshot from the last mutation tool payload (already synced) — no second get_my_cart.
 */
export async function appendFinalCartSnapshot(
  mcpClient,
  conversationId,
  conversationHistory,
  lastMutationResponse = null
) {
  const data = extractToolResultData(lastMutationResponse);

  const cleared =
    Boolean(data?.empty) ||
    (typeof data?.message === "string" && /cleared|no active cart/i.test(data.message));

  const snapshot = {
    final_cart_snapshot: true,
    empty: cleared,
    items: Array.isArray(data?.items) ? data.items : [],
    checkout_url: data?.checkout_url || null,
    checkout_url_changed: Boolean(data?.checkout_url_changed),
    total: data?.total || null,
    subtotal: data?.subtotal || null,
    currency: data?.currency || null
  };

  const content =
    "FINAL CART SNAPSHOT after cart updates in this turn. " +
    "When replying to the customer, state EVERY product quantity ONLY from snapshot.items[].quantity below. " +
    "Ignore items[] from earlier add_to_cart/remove_from_cart/update_cart_items tool results in this same turn. " +
    (snapshot.checkout_url
      ? `CRITICAL: If you share a checkout link, use ONLY this exact snapshot.checkout_url: ${snapshot.checkout_url} ` +
        "as [click here to proceed to checkout](URL). " +
        "FORBIDDEN: reusing any older checkout/cart URL from earlier messages in this chat. "
      : "Do not invent a checkout link. ") +
    JSON.stringify(snapshot);

  conversationHistory.push({ role: "system", content });
  console.log("[cart-wrapper] final_cart_snapshot", {
    conversationId,
    reused: true,
    itemCount: snapshot.items.length,
    items: snapshot.items.map((item) => ({ title: item.title, quantity: item.quantity }))
  });

  return snapshot;
}

/**
 * Merge storefront theme cart lines into the conversation UCP cart.
 * Rule: per variant qty = max(chatQty, themeQty) so neither side loses items.
 * Empty theme payload is a no-op (does not wipe chat cart).
 */
export async function mergeThemeCartIntoConversation(
  mcpClient,
  conversationId,
  themeItems = []
) {
  const incoming = [];
  const seen = new Map();

  (Array.isArray(themeItems) ? themeItems : []).forEach((item) => {
    const variantId = normalizeVariantId(item?.variant_id || item?.variantId || item?.id);
    const qty = Math.max(0, Number(item?.quantity) || 0);
    if (!variantId || qty <= 0) return;
    seen.set(variantId, (seen.get(variantId) || 0) + qty);
  });

  seen.forEach((quantity, variantId) => {
    incoming.push({ quantity, item: { id: variantId } });
  });

  if (!incoming.length) {
    const live = await fetchLiveCart(mcpClient, conversationId);
    const items = (live?.cart?.line_items || []).map((line) => ({
      title: line.item?.title || "Product",
      quantity: line.quantity || 1,
      variant_id: line.item?.id
    }));
    return {
      success: true,
      merged: false,
      empty: !items.length,
      items,
      message: "No theme cart items to import."
    };
  }

  const live = await fetchLiveCart(mcpClient, conversationId);

  if (!live) {
    const response = await mcpClient.callTool("create_cart", {
      cart: withAiraAttribution({ line_items: toWritableLineItems(incoming) }, conversationId)
    });
    await persistCartFromResponse(conversationId, response);
    const cart = extractCartPayload(response);
    const items = (cart?.line_items || []).map((line) => ({
      title: line.item?.title || "Product",
      quantity: line.quantity || 1,
      variant_id: line.item?.id
    }));

    console.log("[cart-wrapper] theme_cart_import created cart", {
      conversationId,
      itemCount: items.length
    });

    return {
      success: true,
      merged: true,
      created: true,
      empty: !items.length,
      items
    };
  }

  const byVariant = new Map();
  (live.cart.line_items || []).forEach((line) => {
    const id = line?.item?.id;
    if (!id) return;
    byVariant.set(id, {
      quantity: Math.max(1, Number(line.quantity) || 1),
      item: { id },
      title: line.item?.title || "Product"
    });
  });

  let changed = false;
  incoming.forEach((item) => {
    const id = item.item.id;
    const themeQty = Math.max(1, Number(item.quantity) || 1);
    const existing = byVariant.get(id);
    if (!existing) {
      byVariant.set(id, {
        quantity: themeQty,
        item: { id },
        title: "Product"
      });
      changed = true;
      return;
    }
    if (themeQty > existing.quantity) {
      existing.quantity = themeQty;
      changed = true;
    }
  });

  if (!changed) {
    const items = Array.from(byVariant.values()).map((entry) => ({
      title: entry.title,
      quantity: entry.quantity,
      variant_id: entry.item.id
    }));
    return {
      success: true,
      merged: false,
      empty: !items.length,
      items,
      message: "Chat cart already includes theme items."
    };
  }

  const lineItems = Array.from(byVariant.values()).map((entry) => ({
    quantity: entry.quantity,
    item: { id: entry.item.id }
  }));

  const response = await updateCartLineItems(
    mcpClient,
    conversationId,
    live.cartId,
    live.cart,
    lineItems
  );

  let cart = extractCartPayload(response);
  const expected = new Map(lineItems.map((line) => [line.item.id, line.quantity]));
  const looksComplete =
    Array.isArray(cart?.line_items) &&
    cart.line_items.length === expected.size &&
    cart.line_items.every((line) => {
      const id = line?.item?.id;
      return id && expected.has(id) && Number(line.quantity) === expected.get(id);
    });

  if (!looksComplete) {
    const verified = await fetchLiveCart(mcpClient, conversationId);
    if (verified?.cart) cart = verified.cart;
  }

  // Skip checkout sync here — next add/remove/get_my_cart will align checkout.
  const items = (cart?.line_items || []).map((line) => ({
    title: line.item?.title || "Product",
    quantity: line.quantity || 1,
    variant_id: line.item?.id
  }));

  console.log("[cart-wrapper] theme_cart_import merged", {
    conversationId,
    themeCount: incoming.length,
    itemCount: items.length,
    changed
  });

  return {
    success: true,
    merged: true,
    empty: !items.length,
    items
  };
}

function extractToolResultData(toolResponse) {
  if (toolResponse?.structuredContent) {
    return toolResponse.structuredContent;
  }

  const text = toolResponse?.content?.find((block) => block.type === "text")?.text;
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
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

/**
 * Apply / clear discount codes via existing UCP create_checkout / update_checkout.
 * Does not change cart line items; safe no-op path if Shopify rejects the code.
 */
async function applyDiscountCode(mcpClient, conversationId, toolArgs = {}) {
  const clear = Boolean(toolArgs.clear);
  const rawCode = String(toolArgs.code || toolArgs.discount_code || "").trim();

  if (!clear && !rawCode) {
    return toolResult({
      success: false,
      discount_applied: false,
      issues: ["Missing discount code."],
      message: "Pass a discount code, or clear:true to remove codes.",
      instruction:
        "Ask the customer for the promo/discount code, then call apply_discount_code again."
    });
  }

  const live = await fetchLiveCart(mcpClient, conversationId);
  if (!live?.cart?.line_items?.length) {
    return toolResult({
      success: false,
      discount_applied: false,
      empty_cart: true,
      issues: ["Cart is empty."],
      message: "Add a product to the cart before applying a discount code.",
      instruction:
        "Cart is empty. Ask them to add a product first, then retry apply_discount_code."
    });
  }

  const discounts = clear
    ? { codes: [] }
    : { codes: [rawCode] };

  console.log("[cart-wrapper] apply_discount_code", {
    conversationId,
    clear,
    codes: discounts.codes
  });

  const synced = await syncCheckoutWithCart(mcpClient, conversationId, live.cart, {
    force: true,
    allowCreate: true,
    discounts
  });

  if (synced?.rate_limited) {
    return toolResult({
      success: false,
      discount_applied: false,
      rate_limited: true,
      retry_after_seconds: synced.retry_after_seconds || null,
      message: TOOL_FAILURE_USER_MESSAGE,
      instruction: RATE_LIMIT_CUSTOMER_INSTRUCTION
    });
  }

  if (synced?.error && !synced?.checkout?.id) {
    return toolResult({
      success: false,
      discount_applied: false,
      issues: [String(synced.error)],
      message: String(synced.error),
      instruction:
        "Discount was NOT applied. Tell the customer briefly using issues. Do not invent a discount."
    });
  }

  const checkout = synced?.checkout || null;
  const summary = summarizeDiscountOutcome(
    checkout,
    discounts.codes,
    clear,
    collectCheckoutMessages(checkout, synced)
  );

  // Rejected promo (e.g. discount_code_user_ineligible): surface Shopify's text clearly.
  // Clear rejected code on checkout only (promo is applied on checkout, not cart lines).
  if (!summary.success && !clear) {
    const customerMessage =
      summary.customer_message ||
      summary.message ||
      (rawCode
        ? `The ${rawCode} discount code is not available to you right now`
        : "That discount code is not available to you right now");

    try {
      const checkoutId = await getConversationCheckoutId(conversationId);
      if (checkoutId) {
        await syncCheckoutWithCart(mcpClient, conversationId, live.cart, {
          force: true,
          allowCreate: false,
          discounts: { codes: [] }
        });
      }
    } catch (clearError) {
      console.warn("[cart-wrapper] failed to clear rejected discount code", clearError.message);
    }

    return toolResult({
      success: false,
      discount_applied: false,
      discount_error_code: summary.error_code || "discount_code_user_ineligible",
      customer_message: customerMessage,
      issues: [customerMessage],
      message: customerMessage,
      instruction:
        `Reply to the customer with ONLY this exact sentence: "${customerMessage}". ` +
        "Do not say the discount was applied. Do not invent savings. Do not list the full cart unless they ask."
    });
  }

  const cartSummary = formatCartSummary(live.cart, live.raw, {
    checkoutUrl: synced?.checkoutUrl || null,
    checkoutUrlChanged: Boolean(synced?.checkoutUrlChanged),
    shippingAddress: synced?.shippingAddress || null,
    conversationId,
    checkout
  });

  const discountInstruction = summary.instruction;
  const totalInstruction = summary.success
    ? " CRITICAL: Quote `total` (after discount) to the customer — never quote `subtotal` as what they pay. Include `order_discount` savings when present."
    : "";

  return toolResult({
    ...cartSummary,
    success: summary.success,
    discount_applied: summary.discount_applied,
    discount_cleared: summary.discount_cleared,
    discount_error_code: summary.error_code,
    customer_message: summary.customer_message || summary.message,
    discount_codes: summary.codes?.length ? summary.codes : cartSummary.discount_codes,
    discounts_applied: summary.applied,
    issues: summary.issues,
    message: summary.message,
    instruction: [cartSummary.instruction, discountInstruction, totalInstruction]
      .filter(Boolean)
      .join(" "),
    checkout_url: synced?.checkoutUrl || cartSummary?.checkout_url || null,
    checkout_url_changed: Boolean(synced?.checkoutUrlChanged)
  });
}

async function setCartShipping(mcpClient, conversationId, address, context = {}) {
  const live = await fetchLiveCart(mcpClient, conversationId);
  if (!live?.cart?.line_items?.length) {
    return toolResult({
      success: false,
      shipping_saved: false,
      empty_cart: true,
      customer_message:
        "Please add at least one product to your cart first — then I can save your shipping address.",
      issues: ["Cart is empty. Add a product before setting a shipping address."],
      instruction:
        "The shipping address was NOT saved because the cart is empty. " +
        "Ask the customer to add a product to their cart first, then call set_cart_shipping again. " +
        "Do NOT show a generic tool failure message."
    });
  }

  const savedShipping = await getConversationShippingAddress(conversationId);

  const normalized = normalizeShippingAddress(address, {
    userMessage: context.userMessage,
    existingCart: live.cart,
    savedShipping
  });

  const validation = validateShippingAddressFields(normalized.address);
  if (validation.issues.length > 0) {
    return shippingValidationFailure(validation, normalized.address);
  }

  const resolved = normalized.address;

  resolved.phone_number = normalizePhoneNumber(
    resolved.phone_number,
    resolved.address_country
  );

  const destination = buildShippingDestination(resolved);
  const cartLineItems = toWritableLineItems(live.cart.line_items);
  const buyer = buildCheckoutBuyer(resolved, live.cart?.buyer);

  try {
    await mcpClient.callTool("update_cart", buildPreservedCartUpdate({
      cartId: live.cartId,
      existingCart: live.cart,
      incomingCart: {
        context: {
          address_country: resolved.address_country,
          address_region: resolved.address_region,
          postal_code: resolved.postal_code
        },
        ...(buyer ? { buyer } : {})
      },
      incomingBuyer: buyer,
      lineItems: cartLineItems,
      conversationId
    }));

    const synced = await syncCheckoutWithCart(mcpClient, conversationId, live.cart, {
      shipping: destination,
      force: true,
      allowCreate: true
    });

  if (synced?.rate_limited || /rate limit|too many requests/i.test(String(synced?.error || ""))) {
    return toolResult({
      success: false,
      shipping_saved: false,
      rate_limited: true,
      user_message: TOOL_FAILURE_USER_MESSAGE,
      instruction:
        "Shipping was NOT saved because Shopify rate-limited checkout. " +
        RATE_LIMIT_CUSTOMER_INSTRUCTION +
        " Do NOT claim the address was saved. Do NOT share a checkout link."
    });
  }

  // Prefer shipping from the sync response. Only get_checkout again when Shopify
  // did not return a matching address (keeps validation / mismatch cases correct).
  let verification = null;
  if (synced?.checkoutId) {
    const syncedAddress = synced.shippingAddress
      ? {
          ...synced.shippingAddress,
          phone_number:
            synced.shippingAddress.phone_number ||
            synced.checkout?.buyer?.phone_number ||
            destination.phone_number,
          email:
            resolved.email ||
            savedShipping?.email ||
            synced.checkout?.buyer?.email ||
            undefined
        }
      : null;
    const syncErrors = synced.validationErrors || [];
    const syncLooksGood =
      syncedAddress?.street_address &&
      shippingAddressMatchesExpected(syncedAddress, destination) &&
      syncErrors.length === 0;

    if (syncLooksGood) {
      verification = {
        shippingAddress: syncedAddress,
        checkout: synced.checkout || null,
        checkoutUrl: synced.checkoutUrl || null,
        validationErrors: [],
        buyerPhone: synced.checkout?.buyer?.phone_number || null,
        buyerEmail: synced.checkout?.buyer?.email || null
      };
      console.log("[cart-wrapper] set_cart_shipping reused sync (skipped get_checkout verify)", {
        conversationId,
        checkoutId: synced.checkoutId
      });
    } else {
      verification = await fetchVerifiedCheckoutShipping(mcpClient, synced.checkoutId);
    }
  }

  const verifiedAddress = verification?.shippingAddress
    ? {
        ...verification.shippingAddress,
        phone_number:
          verification.shippingAddress.phone_number ||
          verification.buyerPhone ||
          destination.phone_number,
        email:
          verification.buyerEmail ||
          resolved.email ||
          savedShipping?.email ||
          undefined
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
    return /phone|email|address|postal|zip|delivery|shipping|fulfillment|buyer|destination|region|state|locality|city|country|name|street|first_name|last_name/i.test(
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

  const checkoutUrl = verification?.checkoutUrl || synced.checkoutUrl || null;
  const persisted = await persistLatestCheckoutUrl(conversationId, checkoutUrl);
  const checkoutUrlChanged = Boolean(
    persisted.changed || synced.checkoutUrlChanged
  );

  console.log("[cart-wrapper] set_cart_shipping verified", {
    conversationId,
    itemCount: cartLineItems.length,
    checkoutId: synced.checkoutId,
    savedStreet: verifiedAddress.street_address,
    savedPhone: verifiedAddress.phone_number || verification?.buyerPhone || null,
    checkoutUrl: persisted.checkoutUrl || checkoutUrl,
    checkoutUrlChanged
  });

  return toolResult(
    formatCartSummary(live.cart, live.raw, {
      checkoutUrl: persisted.checkoutUrl || checkoutUrl,
      checkoutUrlChanged,
      shippingAddress: {
        ...verifiedAddress,
        phone_number:
          verifiedAddress.phone_number ||
          verification?.buyerPhone ||
          destination.phone_number,
        email:
          verifiedAddress.email ||
          verification?.buyerEmail ||
          resolved.email ||
          undefined
      },
      conversationId
    })
  );
  } catch (error) {
    console.warn("[cart-wrapper] set_cart_shipping failed", {
      conversationId,
      message: error.message
    });
    return toolResult({
      success: false,
      shipping_saved: false,
      issues: [String(error.message || "Could not save shipping address.")],
      customer_message:
        "I couldn't save your shipping address right now. Please check the details and try again.",
      instruction:
        "Shipping was NOT saved. Tell the customer using issues if helpful. Never say it was saved."
    });
  }
}

/** Shopify MCP marks checkout as required even when cart_id is provided. */
function buildCreateCheckoutArgs(cartId, cart, overrides = {}, conversationId = null) {
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

  if (overrides.discounts) {
    checkout.discounts = overrides.discounts;
  }

  return {
    cart_id: cartId,
    checkout: withAiraAttribution(checkout, conversationId)
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

function buildCheckoutBuyer(destination = {}, existingBuyer = null) {
  const phone = !isBlank(destination?.phone_number)
    ? normalizePhoneNumber(destination.phone_number, destination.address_country)
    : existingBuyer?.phone_number || null;
  const email = !isBlank(destination?.email)
    ? normalizeEmail(destination.email)
    : existingBuyer?.email || null;

  if (!phone && !email) {
    return existingBuyer || undefined;
  }

  return {
    ...(existingBuyer || {}),
    ...(phone ? { phone_number: phone } : {}),
    ...(email ? { email } : {})
  };
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function isValidEmail(email) {
  const normalized = normalizeEmail(email);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized);
}

function extractEmailFromText(text) {
  const match = String(text || "").match(
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i
  );
  return match ? normalizeEmail(match[0]) : null;
}

function buildShippingDestination(resolved) {
  const phone = normalizePhoneNumber(resolved.phone_number, resolved.address_country);
  const destination = {
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

  if (!isBlank(resolved.email)) {
    destination.email = normalizeEmail(resolved.email);
  }

  return destination;
}

function buildCheckoutFulfillment(destination, lineItemIds = []) {
  if (!destination?.street_address) {
    return null;
  }

  return {
    methods: [
      {
        type: "shipping",
        ...(lineItemIds.length ? { line_item_ids: lineItemIds } : {}),
        destinations: [destination]
      }
    ]
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
      buyerPhone: checkout?.buyer?.phone_number || null,
      buyerEmail: checkout?.buyer?.email || null
    };
  } catch (error) {
    console.warn("[cart-wrapper] get_checkout verify failed", { checkoutId, message: error.message });
    return null;
  }
}

/**
 * Prefer continue_url from the update/create_checkout response.
 * Only call get_checkout when Shopify did not return a usable URL.
 */
async function fetchFreshCheckoutUrl(
  mcpClient,
  checkoutId,
  fallbackUrl = null,
  conversationId = null
) {
  if (fallbackUrl) {
    return appendAiraUtmParams(fallbackUrl, conversationId);
  }

  const verified = await fetchVerifiedCheckoutShipping(mcpClient, checkoutId);
  return appendAiraUtmParams(
    verified?.checkoutUrl || null,
    conversationId
  );
}

/**
 * Save latest buyer checkout/cart URL. Marks changed when the Shopify link
 * itself changes (ignores AIRA utm_* noise).
 */
async function persistLatestCheckoutUrl(conversationId, checkoutUrl) {
  if (!conversationId || !checkoutUrl) {
    return { changed: false, checkoutUrl: checkoutUrl || null };
  }

  const result = await setConversationCheckoutUrl(conversationId, checkoutUrl);
  const previousIdentity = checkoutUrlIdentity(result?.previousUrl);
  const nextIdentity = checkoutUrlIdentity(result?.checkoutUrl || checkoutUrl);
  const changed = Boolean(
    result?.previousUrl && previousIdentity && nextIdentity && previousIdentity !== nextIdentity
  );

  if (changed) {
    console.log("[cart-wrapper] checkout_url updated in DB", {
      conversationId,
      previousUrl: result.previousUrl,
      checkoutUrl: result.checkoutUrl
    });
  }

  return {
    changed,
    checkoutUrl: result?.checkoutUrl || checkoutUrl,
    previousUrl: result?.previousUrl || null
  };
}

/** Compare Shopify cart/checkout links without AIRA UTM query noise. */
function checkoutUrlIdentity(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    const keep = [];
    for (const [key, value] of parsed.searchParams.entries()) {
      if (key.toLowerCase().startsWith("utm_")) continue;
      keep.push(`${key}=${value}`);
    }
    keep.sort();
    return `${parsed.origin}${parsed.pathname}${keep.length ? `?${keep.join("&")}` : ""}`;
  } catch {
    return raw.split("#")[0];
  }
}

/**
 * Prefer the freshest buyer link from checkout sync, else latest cart continue_url.
 * Always persist and flag when it differs from what we last stored.
 */
async function resolveAndPersistBuyerUrl({
  conversationId,
  preferredUrl = null,
  cart = null,
  forceChanged = false
} = {}) {
  const cartContinue = cart?.continue_url
    ? appendAiraUtmParams(cart.continue_url, conversationId)
    : null;
  const preferred = preferredUrl
    ? appendAiraUtmParams(preferredUrl, conversationId)
    : null;

  // Prefer explicit checkout/sync URL; fall back to latest cart continue_url.
  const candidate = preferred || cartContinue || null;
  if (!candidate) {
    return { checkoutUrl: null, checkoutUrlChanged: false };
  }

  const persisted = await persistLatestCheckoutUrl(conversationId, candidate);
  const changed = Boolean(forceChanged || persisted.changed);

  return {
    checkoutUrl: persisted.checkoutUrl || candidate,
    checkoutUrlChanged: changed,
    previousUrl: persisted.previousUrl || null
  };
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
    email: destination.email || undefined,
    street_address: destination.street_address,
    extended_address: destination.extended_address || undefined,
    address_locality: destination.address_locality,
    address_region: destination.address_region || undefined,
    postal_code: destination.postal_code,
    address_country: destination.address_country
  };
}

/**
 * Build UCP discounts payload for checkout.
 * When explicitDiscounts is provided (including clear { codes: [] }), use it.
 * Otherwise preserve codes already on the checkout so PUT updates do not wipe them.
 */
function resolveCheckoutDiscounts(explicitDiscounts = null, existingCheckout = null) {
  if (explicitDiscounts && Object.prototype.hasOwnProperty.call(explicitDiscounts, "codes")) {
    const codes = Array.isArray(explicitDiscounts.codes)
      ? explicitDiscounts.codes.map((code) => String(code || "").trim()).filter(Boolean)
      : [];
    return { codes };
  }

  // Only carry codes that actually applied — rejected codes often remain in codes[].
  const applied = Array.isArray(existingCheckout?.discounts?.applied)
    ? existingCheckout.discounts.applied
    : [];
  const appliedCodes = applied
    .map((entry) => String(entry?.code || "").trim())
    .filter(Boolean);
  if (appliedCodes.length > 0) {
    return { codes: appliedCodes };
  }

  return null;
}

function summarizeDiscountOutcome(checkout, requestedCodes = [], clear = false, extraMessages = []) {
  const codes = Array.isArray(checkout?.discounts?.codes)
    ? checkout.discounts.codes.map((code) => String(code || "").trim()).filter(Boolean)
    : [];
  const applied = Array.isArray(checkout?.discounts?.applied)
    ? checkout.discounts.applied
    : [];
  const messagePools = [
    ...(Array.isArray(checkout?.messages) ? checkout.messages : []),
    ...(Array.isArray(extraMessages) ? extraMessages : [])
  ];
  const discountRejections = extractDiscountRejectionMessages(messagePools);

  if (clear) {
    const cleared = codes.length === 0;
    return {
      success: cleared,
      discount_applied: false,
      discount_cleared: cleared,
      codes,
      applied,
      error_code: null,
      issues: cleared ? [] : ["Could not clear discount codes."],
      message: cleared
        ? "Discount codes cleared from checkout."
        : "Could not clear discount codes.",
      instruction: cleared
        ? "Confirm discounts were removed. Share checkout_url if present."
        : "Tell the customer the discount could not be cleared."
    };
  }

  const requested = (requestedCodes || []).map((code) => String(code || "").trim()).filter(Boolean);
  const requestedLower = new Set(requested.map((code) => code.toLowerCase()));
  const appliedMatching = applied.filter((entry) => {
    const code = String(entry?.code || "").trim().toLowerCase();
    return code && requestedLower.has(code);
  });

  // Shopify often echoes rejected codes in discounts.codes — never treat that as success.
  // Only applied[] (matching the requested code) means the promo actually took effect.
  const successFinal = discountRejections.length === 0 && appliedMatching.length > 0;

  const issues = [];
  if (!successFinal) {
    if (discountRejections.length) {
      issues.push(...discountRejections.map((entry) => entry.content));
    } else {
      issues.push(
        requested.length
          ? `Discount code "${requested.join(", ")}" was not applied.`
          : "Discount code was not applied."
      );
    }
  }

  const customerMessage = successFinal
    ? `Discount applied${requested.length ? `: ${requested.join(", ")}` : ""}.`
    : issues[0];

  return {
    success: successFinal,
    discount_applied: successFinal,
    discount_cleared: false,
    codes,
    applied,
    error_code: discountRejections[0]?.code || null,
    issues,
    message: customerMessage,
    customer_message: customerMessage,
    instruction: successFinal
      ? "Confirm the discount briefly. Mention updated totals from this tool result when available. Share checkout_url if present. CRITICAL: Quote `total` after discount — never subtotal as what they pay."
      : "Discount was NOT applied. Tell the customer EXACTLY the text in customer_message (or issues[0]) — e.g. that the code is not available to them. " +
        "Do NOT say the discount was applied. Do NOT invent a discounted total. You may still list cart items and the normal total."
  };
}

/**
 * Pull Shopify discount rejection warnings (e.g. discount_code_user_ineligible).
 */
function extractDiscountRejectionMessages(messages = []) {
  if (!Array.isArray(messages)) return [];

  const out = [];
  const seen = new Set();
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const code = String(msg.code || "").trim();
    const content = String(msg.content || msg.message || msg.description || "").trim();
    const type = String(msg.type || "").toLowerCase();
    const codeLower = code.toLowerCase();
    const blob = `${codeLower} ${content.toLowerCase()}`;

    const isDiscountRejection =
      /^discount_code_/.test(codeLower) ||
      /discount_code_user_ineligible|discount_code_not_found|discount_code_expired|discount_code_invalid|promo|coupon/.test(
        blob
      ) ||
      ((type === "warning" || type === "error") && /discount|promo|coupon/.test(blob));

    if (!isDiscountRejection) continue;
    if (!content && !code) continue;

    const key = `${codeLower}|${content.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      code: code || null,
      content: content || code,
      type: type || null
    });
  }
  return out;
}

/** Collect messages from a checkout object and/or raw MCP tool response. */
function collectCheckoutMessages(...sources) {
  const messages = [];
  const seen = new Set();
  for (const source of sources) {
    if (!source) continue;
    const pools = [
      source.messages,
      source.checkout?.messages,
      source.structuredContent?.messages,
      source.structuredContent?.checkout?.messages
    ];
    // Parsed text body
    if (typeof source.content?.[0]?.text === "string") {
      try {
        const parsed = JSON.parse(source.content[0].text);
        pools.push(parsed?.messages, parsed?.checkout?.messages);
      } catch {
        /* ignore */
      }
    }
    for (const pool of pools) {
      if (!Array.isArray(pool)) continue;
      for (const message of pool) {
        const key = `${message?.code || ""}|${message?.content || message?.message || ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        messages.push(message);
      }
    }
  }
  return messages;
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
  { shipping = null, force = false, allowCreate = true, discounts = null } = {}
) {
  const savedShipping =
    shipping || (await getConversationShippingAddress(conversationId));
  const hasShipping = Boolean(savedShipping?.street_address);

  if (!cart?.id || !cart?.line_items?.length) {
    return null;
  }

  // No shipping and not forced → nothing to sync (cart-only browsing).
  // Discount apply uses force:true so checkout can be created/updated without shipping.
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
      destination,
      conversationId,
      { discounts }
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
          writableShippingAddress({
            ...updated.shippingAddress,
            email:
              savedShipping?.email ||
              updated.checkout?.buyer?.email ||
              undefined
          })
        );
      }

      const checkoutUrl = await fetchFreshCheckoutUrl(
        mcpClient,
        updated.checkout.id,
        updated.checkoutUrl,
        conversationId
      );
      const persisted = await persistLatestCheckoutUrl(conversationId, checkoutUrl);

      console.log("[cart-wrapper] updated existing checkout", {
        conversationId,
        checkoutId: updated.checkout.id,
        hasShipping: Boolean(updated.shippingAddress?.street_address),
        validationErrors,
        checkoutUrl: persisted.checkoutUrl,
        checkoutUrlChanged: persisted.changed
      });

      return {
        checkoutId: updated.checkout.id,
        checkoutUrl: persisted.checkoutUrl,
        checkoutUrlChanged: persisted.changed,
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
        checkoutUrl: appendAiraUtmParams(updated.checkoutUrl || null, conversationId),
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

  const created = await createCheckoutFromCart(
    mcpClient,
    cart,
    destination,
    conversationId,
    { discounts }
  );
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
      writableShippingAddress({
        ...created.shippingAddress,
        email:
          savedShipping?.email ||
          created.checkout?.buyer?.email ||
          undefined
      })
    );
  }

  console.log("[cart-wrapper] created checkout", {
    conversationId,
    checkoutId: created.checkout.id,
    hasShipping: Boolean(created.shippingAddress?.street_address),
    validationErrors
  });

  const checkoutUrl = await fetchFreshCheckoutUrl(
    mcpClient,
    created.checkout.id,
    created.checkoutUrl,
    conversationId
  );
  const persisted = await persistLatestCheckoutUrl(conversationId, checkoutUrl);

  return {
    checkoutId: created.checkout.id,
    checkoutUrl: persisted.checkoutUrl,
    checkoutUrlChanged: persisted.changed,
    shippingAddress: created.shippingAddress || null,
    checkout: created.checkout,
    validationErrors,
    rate_limited: created.rate_limited || false,
    retry_after_seconds: created.retry_after_seconds || null
  };
}

async function updateExistingCheckout(
  mcpClient,
  checkoutId,
  cart,
  destination,
  conversationId = null,
  { discounts = null } = {}
) {
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
    const checkoutBody = withAiraAttribution(
      {
        line_items: lineItems,
        buyer: buildCheckoutBuyer(destination, existing.buyer)
      },
      conversationId
    );

    if (destination) {
      const lineItemIds = lineItems.map((line) => line.id).filter(Boolean);
      checkoutBody.fulfillment = buildCheckoutFulfillment(destination, lineItemIds);
    } else if (existing.fulfillment) {
      // Preserve existing fulfillment when only items change.
      checkoutBody.fulfillment = existing.fulfillment;
    }

    const discountsPayload = resolveCheckoutDiscounts(discounts, existing);
    if (discountsPayload) {
      checkoutBody.discounts = discountsPayload;
    }

    const initialFulfillmentLineIds = destination
      ? lineItems.map((line) => line.id).filter(Boolean)
      : [];

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
        checkoutUrl: appendAiraUtmParams(
          extractContinueUrl(getResponse) || existing.continue_url || null,
          conversationId
        ),
        shippingAddress: null,
        validationErrors: responseErrors,
        error: responseErrors[0]?.readable || extractToolErrorText(updateResponse)
      };
    }

    let checkout = checkoutFromUpdate || existing;
    if (!checkout?.id) {
      return {
        error: extractToolErrorText(updateResponse) || "update_checkout failed",
        validationErrors: responseErrors
      };
    }

    // Keep Shopify discount warnings (e.g. discount_code_user_ineligible) on the checkout
    // object — they often live on the tool response, not nested under checkout.
    checkout = {
      ...checkout,
      messages: collectCheckoutMessages(updateResponse, checkout, existing)
    };

    // New cart lines get checkout ids only after the first update — re-attach
    // shipping to ALL line ids so the address is not dropped.
    let shippingAddress = extractShippingDestination(checkout);
    let validationErrors = [
      ...responseErrors,
      ...extractCheckoutValidationErrors(checkout)
    ];

    if (destination) {
      const allLineItems = buildCheckoutLineItems(checkout.line_items);
      const allLineIds = allLineItems.map((line) => line.id).filter(Boolean);
      const needsFulfillmentRefresh =
        allLineIds.length > initialFulfillmentLineIds.length ||
        !shippingAddress?.street_address;

      if (needsFulfillmentRefresh && allLineIds.length > 0) {
        const retryBody = {
          line_items: allLineItems,
          buyer: buildCheckoutBuyer(destination, existing.buyer),
          fulfillment: buildCheckoutFulfillment(destination, allLineIds)
        };
        const retryDiscounts = resolveCheckoutDiscounts(discounts, checkout);
        if (retryDiscounts) {
          retryBody.discounts = retryDiscounts;
        }
        const retryResponse = await mcpClient.callTool("update_checkout", {
          id: checkout.id,
          checkout: withAiraAttribution(retryBody, conversationId)
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
          checkout: {
            ...retried,
            messages: collectCheckoutMessages(retryResponse, updateResponse, retried, checkout)
          },
          checkoutUrl: appendAiraUtmParams(
            extractContinueUrl(retryResponse) || retried.continue_url,
            conversationId
          ),
          shippingAddress: shippingAddress || null,
          validationErrors,
          error: retryErrors[0]?.readable || null
        };
      }
    }

    return {
      checkout,
      checkoutUrl: appendAiraUtmParams(
        extractContinueUrl(updateResponse) || checkout.continue_url,
        conversationId
      ),
      shippingAddress: shippingAddress || null,
      validationErrors
    };
  } catch (error) {
    return { error: error.message, ...parseShopifyTransportError(error) };
  }
}

async function createCheckoutFromCart(
  mcpClient,
  cart,
  destination,
  conversationId = null,
  { discounts = null } = {}
) {
  try {
    const overrides = {};
    if (destination?.phone_number || destination?.email) {
      overrides.buyer = buildCheckoutBuyer(destination, cart?.buyer);
    }
    if (cart?.context) {
      overrides.context = cart.context;
    }
    // Include shipping destination on create when available so Shopify does not
    // return delivery_address_required for phone-only checkout. update_checkout
    // below still binds line_item_ids once checkout line ids exist.
    if (destination?.street_address) {
      overrides.fulfillment = buildCheckoutFulfillment(destination);
    }
    const discountsPayload = resolveCheckoutDiscounts(discounts, null);
    if (discountsPayload) {
      overrides.discounts = discountsPayload;
    }

    const response = await mcpClient.callTool(
      "create_checkout",
      buildCreateCheckoutArgs(cart.id, cart, overrides, conversationId)
    );
    let checkout = extractCheckoutPayload(response);
    const createErrors = extractCheckoutValidationErrors(response);

    if (!checkout?.id) {
      return {
        error: createErrors[0]?.readable || extractToolErrorText(response) || "create_checkout failed",
        validationErrors: createErrors,
        checkout: null,
        messages: collectCheckoutMessages(response)
      };
    }

    checkout = {
      ...checkout,
      messages: collectCheckoutMessages(response, checkout)
    };

    let shippingAddress = extractShippingDestination(checkout);
    let checkoutUrl = appendAiraUtmParams(
      extractContinueUrl(response) || checkout.continue_url,
      conversationId
    );
    let validationErrors = [
      ...createErrors,
      ...extractCheckoutValidationErrors(checkout)
    ];

    if (destination?.street_address) {
      const lineItems = buildCheckoutLineItems(checkout.line_items || cart.line_items);
      const lineItemIds = lineItems.map((line) => line.id).filter(Boolean);
      const updateBody = {
        ...(lineItems.length ? { line_items: lineItems } : {}),
        buyer: buildCheckoutBuyer(destination, checkout.buyer),
        fulfillment: buildCheckoutFulfillment(destination, lineItemIds)
      };
      const keepDiscounts = resolveCheckoutDiscounts(discounts, checkout);
      if (keepDiscounts) {
        updateBody.discounts = keepDiscounts;
      }
      const updateResponse = await mcpClient.callTool("update_checkout", {
        id: checkout.id,
        checkout: withAiraAttribution(updateBody, conversationId)
      });
      const updateErrors = extractCheckoutValidationErrors(updateResponse);
      const updatedCheckout = extractCheckoutPayload(updateResponse);
      if (updatedCheckout?.id) {
        checkout = {
          ...updatedCheckout,
          messages: collectCheckoutMessages(updateResponse, response, updatedCheckout, checkout)
        };
        shippingAddress = extractShippingDestination(checkout);
        checkoutUrl = appendAiraUtmParams(
          extractContinueUrl(updateResponse) || checkout.continue_url || checkoutUrl,
          conversationId
        );
      } else {
        shippingAddress = null;
        checkout = {
          ...checkout,
          messages: collectCheckoutMessages(updateResponse, response, checkout)
        };
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

function buildCartSummaryWithCheckoutIssue(cart, rawResponse, synced, savedShipping, conversationId = null) {
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
    checkoutUrlChanged: Boolean(synced?.checkoutUrlChanged),
    shippingAddress: checkoutUrl ? synced?.shippingAddress || savedShipping : null,
    conversationId
  });

  if (checkoutUrl && !rateLimited) {
    return {
      ...summary,
      success: true,
      cart_updated: true,
      checkout_url: summary.checkout_url || checkoutUrl,
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
    user_message: rateLimited ? TOOL_FAILURE_USER_MESSAGE : undefined,
    shopify_errors: rateLimited
      ? [{ content: TOOL_FAILURE_USER_MESSAGE }]
      : issues.map((content) => ({ content })),
    issues: rateLimited ? [TOOL_FAILURE_USER_MESSAGE] : issues,
    checkout_url: null,
    instruction: rateLimited
      ? "The cart items/totals above DID update successfully. " +
        "Checkout sync FAILED due to rate limiting. " +
        RATE_LIMIT_CUSTOMER_INSTRUCTION +
        " Do NOT share a checkout link. Do NOT claim checkout is ready."
      : "The cart items/totals above DID update successfully. " +
        "Checkout sync FAILED — read issues[] / shopify_errors and tell the customer that exact problem. " +
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

  // Existing checkout: always update line items, then return the freshest continue_url.
  if (checkoutId) {
    const synced = await syncCheckoutWithCart(mcpClient, conversationId, cart, {
      shipping: savedShipping,
      allowCreate,
      force: true
    });

    if (
      synced?.rate_limited ||
      (synced?.error && !synced?.checkoutUrl && !cart?.continue_url) ||
      ((synced?.validationErrors || []).length > 0 && !synced?.checkoutUrl && !cart?.continue_url)
    ) {
      return buildCartSummaryWithCheckoutIssue(
        cart,
        rawResponse,
        synced,
        savedShipping,
        conversationId
      );
    }

    const resolved = await resolveAndPersistBuyerUrl({
      conversationId,
      preferredUrl: synced?.checkoutUrl || null,
      cart,
      // Cart lines changed — always force the model to use THIS link, not an older chat link.
      forceChanged: true
    });

    console.log("[cart-wrapper] summarize buyer url after cart change", {
      conversationId,
      checkoutId,
      checkoutUrl: resolved.checkoutUrl,
      checkoutUrlChanged: resolved.checkoutUrlChanged,
      previousUrl: resolved.previousUrl || null
    });

    return formatCartSummary(cart, rawResponse, {
      checkoutUrl: resolved.checkoutUrl,
      checkoutUrlChanged: resolved.checkoutUrlChanged,
      shippingAddress: synced?.shippingAddress || savedShipping || null,
      conversationId,
      checkout: synced?.checkout || null
    });
  }

  if (!savedShipping?.street_address && !checkoutId) {
    const resolved = await resolveAndPersistBuyerUrl({
      conversationId,
      preferredUrl: null,
      cart,
      forceChanged: Boolean(cart?.continue_url)
    });
    return formatCartSummary(cart, rawResponse, {
      checkoutUrl: resolved.checkoutUrl,
      checkoutUrlChanged: resolved.checkoutUrlChanged,
      conversationId
    });
  }

  // Rare: caller opted out of create (should not hide URL when checkout already exists).
  if (!checkoutId && !allowCreate) {
    return {
      ...formatCartSummary(cart, rawResponse, {
        checkoutUrl: null,
        shippingAddress: savedShipping,
        conversationId
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
    const resolved = await resolveAndPersistBuyerUrl({
      conversationId,
      cart,
      forceChanged: Boolean(cart?.continue_url)
    });
    return formatCartSummary(cart, rawResponse, {
      checkoutUrl: resolved.checkoutUrl,
      checkoutUrlChanged: resolved.checkoutUrlChanged,
      shippingAddress: savedShipping,
      conversationId
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
      savedShipping,
      conversationId
    );
  }

  const resolved = await resolveAndPersistBuyerUrl({
    conversationId,
    preferredUrl: synced.checkoutUrl || null,
    cart,
    forceChanged: true
  });

  if (resolved.checkoutUrl) {
    return formatCartSummary(cart, rawResponse, {
      checkoutUrl: resolved.checkoutUrl,
      checkoutUrlChanged: resolved.checkoutUrlChanged,
      shippingAddress: synced.shippingAddress || savedShipping,
      conversationId,
      checkout: synced.checkout || null
    });
  }

  if ((synced.validationErrors || []).length > 0 || synced.error) {
    return buildCartSummaryWithCheckoutIssue(
      cart,
      rawResponse,
      synced,
      savedShipping,
      conversationId
    );
  }

  if (synced.skipped_create) {
    return {
      ...formatCartSummary(cart, rawResponse, {
        checkoutUrl: null,
        shippingAddress: savedShipping,
        conversationId,
        checkout: synced.checkout || null
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
    shippingAddress: synced.shippingAddress || savedShipping,
    conversationId,
    checkout: synced.checkout || null
  });
}

async function stripCheckoutShipping(mcpClient, checkoutId, cart, conversationId = null) {
  try {
    const getResponse = await mcpClient.callTool("get_checkout", { id: checkoutId });
    const existing = extractCheckoutPayload(getResponse);
    if (!existing?.id) {
      return { error: "checkout not found" };
    }

    const lineItems = buildUpdateCheckoutLineItems(cart.line_items, existing.line_items);
    const stripBody = {
      ...(lineItems.length ? { line_items: lineItems } : {}),
      fulfillment: { methods: [] }
    };
    const keepDiscounts = resolveCheckoutDiscounts(null, existing);
    if (keepDiscounts) {
      stripBody.discounts = keepDiscounts;
    }
    const updateResponse = await mcpClient.callTool("update_checkout", {
      id: checkoutId,
      checkout: withAiraAttribution(stripBody, conversationId)
    });

    const checkout = extractCheckoutPayload(updateResponse) || existing;
    const shippingAddress = extractShippingDestination(checkout);
    const checkoutUrl = await fetchFreshCheckoutUrl(
      mcpClient,
      checkout.id || checkoutId,
      extractContinueUrl(updateResponse) || checkout.continue_url || null,
      conversationId
    );

    return {
      checkout,
      checkoutUrl,
      shippingAddress,
      validationErrors: extractCheckoutValidationErrors(updateResponse)
    };
  } catch (error) {
    return { error: error.message, ...parseShopifyTransportError(error) };
  }
}

async function removeCartShipping(mcpClient, conversationId) {
  const savedShipping = await getConversationShippingAddress(conversationId);
  const checkoutId = await getConversationCheckoutId(conversationId);

  if (!savedShipping?.street_address && !checkoutId) {
    return toolResult({
      success: true,
      shipping_removed: true,
      message: "No shipping address was on file.",
      instruction: "Confirm there was no saved shipping address. Cart items are unchanged."
    });
  }

  await clearConversationShippingAddress(conversationId);

  const live = await fetchLiveCart(mcpClient, conversationId);
  let checkoutUrl = null;

  if (checkoutId && live?.cart) {
    const stripped = await stripCheckoutShipping(mcpClient, checkoutId, live.cart, conversationId);
    if (stripped?.checkout?.id) {
      await setConversationCheckoutId(conversationId, stripped.checkout.id);
      const persisted = await persistLatestCheckoutUrl(conversationId, stripped.checkoutUrl);
      checkoutUrl = persisted.checkoutUrl;
    } else {
      console.warn("[cart-wrapper] strip checkout shipping failed", {
        conversationId,
        checkoutId,
        error: stripped?.error
      });
    }
  }

  if (live?.cart) {
    return toolResult({
      ...formatCartSummary(live.cart, live.raw, { checkoutUrl, conversationId }),
      shipping_removed: true,
      shipping_saved: false,
      instruction: checkoutUrl
        ? "Shipping address was removed from checkout. Cart items are unchanged. " +
          "You may share checkout_url — the customer will enter their address on the Shopify checkout page."
        : "Shipping address was removed. Cart items are unchanged. " +
          "Do NOT share a checkout link until the customer sets a new shipping address."
    });
  }

  return toolResult({
    success: true,
    shipping_removed: true,
    message: "Shipping address removed.",
    instruction: "Confirm shipping was removed. Cart items are unchanged if any remain."
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
  await clearConversationCheckout(conversationId);
  await clearConversationShippingAddress(conversationId);

  return toolResult({ success: true, message: "Cart cleared. Use add_to_cart to start a new cart." });
}

function normalizeVariantId(id) {
  if (id == null || id === "") {
    return null;
  }

  const trimmed = String(id).trim();
  if (!trimmed) {
    return null;
  }

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

const SHIPPING_FIELD_LABELS = {
  first_name: "First Name",
  last_name: "Last Name",
  phone_number: "Phone Number",
  email: "Email",
  street_address: "Street Address",
  address_locality: "City",
  address_region: "State/Region",
  postal_code: "Postal Code",
  address_country: "Country"
};

const SHIPPING_REQUIRED_FIELDS = [
  "first_name",
  "last_name",
  "phone_number",
  "street_address",
  "address_locality",
  "postal_code",
  "address_country"
];

function isBlank(value) {
  return !String(value ?? "").trim();
}

function isEmailLikeName(firstName, lastName) {
  const first = String(firstName || "").trim().toLowerCase();
  const last = String(lastName || "").trim().toLowerCase();
  return first.includes("@") || last.includes("@") || /\.(com|net|org|io)$/i.test(last);
}

function hasValidPhoneDigits(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  return digits.length >= 10 && digits.length <= 15;
}

function isPlaceholderPhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (!digits) return false;
  if (/^1?(234567890|1234567890|5555555555|9999999999|0000000000)$/.test(digits)) return true;
  if (/^(\d)\1+$/.test(digits)) return true;
  return false;
}

function extractPhoneFromText(text) {
  const match = String(text || "").match(
    /(\+\d{1,3}[\s\-().]*\d[\d\s\-().]{6,}\d|\b\d{3}[\s\-().]*\d{3}[\s\-().]*\d{4}\b)/
  );
  return match ? match[1].trim() : null;
}

function extractNamePartsFromText(text) {
  const raw = extractAddressText(text);
  if (!raw) return null;

  // Strip emails first so "Jane Doe, jane@x.com, +1..." never becomes last_name.
  const withoutEmail = raw.replace(
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    " "
  );

  const phoneMatch = withoutEmail.match(/(\+?\d[\d\s\-().]{8,}\d)/);
  let nameSegment = phoneMatch
    ? withoutEmail.slice(0, phoneMatch.index)
    : withoutEmail;
  // Name is the first comma-separated segment only (before email/phone/street).
  nameSegment = nameSegment.split(",")[0].replace(/[,\s]+$/g, "").trim();

  if (!nameSegment || /^\d+\s/.test(nameSegment)) return null;

  const parts = nameSegment
    .split(/\s+/)
    .map((part) => part.replace(/^[,;]+|[,;]+$/g, "").trim())
    .filter(Boolean);
  if (
    parts.length >= 2 &&
    parts.length <= 5 &&
    /^[A-Za-z]/.test(parts[0]) &&
    parts.every((part) => !part.includes("@"))
  ) {
    return {
      first_name: parts[0],
      last_name: parts.slice(1).join(" ")
    };
  }

  return null;
}

/**
 * Prefer LLM-structured shipping fields. Only fill blanks from the customer
 * message — never overwrite values the model already passed.
 */
function sanitizeShippingFromContext(address = {}, userMessage = "") {
  const merged = { ...address };
  const text = extractAddressText(userMessage);

  const addressFromLine = parseAddressLineOnly(text);
  if (addressFromLine) {
    for (const [key, value] of Object.entries(addressFromLine)) {
      if (value && isBlank(merged[key])) {
        merged[key] = value;
      }
    }
  }

  const nameFromText = extractNamePartsFromText(text);
  if (nameFromText) {
    if (isBlank(merged.first_name)) {
      merged.first_name = nameFromText.first_name;
    }
    if (isBlank(merged.last_name)) {
      merged.last_name = nameFromText.last_name;
    }
  }

  if (isBlank(merged.phone_number)) {
    const phoneInText = extractPhoneFromText(text);
    if (phoneInText) {
      merged.phone_number = phoneInText;
    }
  }

  if (isBlank(merged.email)) {
    const emailInText = extractEmailFromText(text);
    if (emailInText) {
      merged.email = emailInText;
    }
  }

  return merged;
}

function applySavedShippingDefaults(address = {}, savedShipping = null) {
  if (!savedShipping) {
    return address;
  }

  const merged = { ...address };
  const mergeFields = [
    "first_name",
    "last_name",
    "phone_number",
    "email",
    "street_address",
    "extended_address",
    "address_locality",
    "address_region",
    "postal_code",
    "address_country"
  ];

  for (const field of mergeFields) {
    if (isBlank(merged[field]) && !isBlank(savedShipping[field])) {
      merged[field] = savedShipping[field];
    }
  }

  return merged;
}

function normalizeCountryCode(country) {
  const raw = String(country || "").trim();
  if (!raw) return raw;

  const upper = raw.toUpperCase();
  if (upper === "USA" || upper === "UNITED STATES" || upper === "U.S." || upper === "U.S.A.") {
    return "US";
  }

  return upper.length === 2 ? upper : raw;
}

function validateShippingAddressFields(address = {}) {
  const missing = SHIPPING_REQUIRED_FIELDS.filter((field) => isBlank(address[field]));
  const missingLabels = missing.map((field) => SHIPPING_FIELD_LABELS[field] || field);
  const issues = missingLabels.map((label) => `${label} is required.`);

  if (!isBlank(address.first_name) && String(address.first_name).trim().length < 2) {
    issues.push("First Name looks too short.");
  }
  if (!isBlank(address.last_name) && String(address.last_name).trim().length < 2) {
    issues.push("Last Name looks too short.");
  }
  if (!isBlank(address.first_name) && !isBlank(address.last_name) && isEmailLikeName(address.first_name, address.last_name)) {
    issues.push("First and last name look invalid — do not use an email address as the name.");
  }

  if (!isBlank(address.phone_number) && !hasValidPhoneDigits(address.phone_number)) {
    issues.push("Phone Number looks invalid — include a valid number with area code.");
  }
  if (!isBlank(address.phone_number) && isPlaceholderPhone(address.phone_number)) {
    issues.push("Phone Number looks invalid — do not use placeholder numbers.");
  }

  if (!isBlank(address.email) && !isValidEmail(address.email)) {
    issues.push("Email address looks invalid.");
  }

  if (!isBlank(address.street_address) && String(address.street_address).trim().length < 3) {
    issues.push("Street Address looks incomplete.");
  }

  if (!isBlank(address.address_locality) && String(address.address_locality).trim().length < 2) {
    issues.push("City looks incomplete.");
  }

  if (!isBlank(address.postal_code) && String(address.postal_code).trim().length < 3) {
    issues.push("Postal Code looks incomplete.");
  }

  if (!isBlank(address.address_country)) {
    const country = normalizeCountryCode(address.address_country);
    if (!/^[A-Z]{2}$/.test(country)) {
      issues.push("Country looks invalid — use a 2-letter ISO code (for example US).");
    }
  }

  if (isUsLikeCountry(address.address_country)) {
    if (isBlank(address.address_region) && !missing.includes("address_region")) {
      issues.push("State/Region is required.");
    }
    if (!isBlank(address.address_region) && !/^[A-Za-z]{2}$/.test(String(address.address_region).trim())) {
      issues.push("State/Region looks invalid — use a 2-letter US code (for example NY).");
    }
    if (!isBlank(address.postal_code) && !/^\d{5}(?:-\d{4})?$/.test(String(address.postal_code).trim())) {
      issues.push("Postal Code looks invalid for a US address.");
    }
  }

  return {
    missing,
    missingLabels,
    issues: [...new Set(issues)]
  };
}

function summarizeProvidedShippingFields(address = {}) {
  const fieldOrder = [
    "first_name",
    "last_name",
    "phone_number",
    "email",
    "street_address",
    "extended_address",
    "address_locality",
    "address_region",
    "postal_code",
    "address_country"
  ];

  return fieldOrder
    .filter((key) => !isBlank(address[key]))
    .map((key) => ({
      field: key,
      label: key === "email" ? "Email (optional)" : (SHIPPING_FIELD_LABELS[key] || key),
      value: String(address[key]).trim()
    }));
}

function shippingValidationFailure(validation, address = {}) {
  const providedFields = summarizeProvidedShippingFields(address);
  const failedLabels = validation.issues
    .map((issue) => issue.replace(/ is required\.?$| looks .*$/i, "").trim())
    .filter(Boolean);
  const uniqueFailed = [...new Set(
    validation.missingLabels.length
      ? validation.missingLabels
      : failedLabels
  )];

  const providedSummary = providedFields
    .map((entry) => `${entry.label}: ${entry.value}`)
    .join("; ");

  let customerMessage;
  if (providedFields.length > 0 && uniqueFailed.length > 0) {
    customerMessage =
      `I couldn't save your shipping address yet. I already have: ${providedSummary}. ` +
      `I still need: ${uniqueFailed.join(", ")}.`;
  } else if (uniqueFailed.length > 0) {
    customerMessage =
      `I couldn't save your shipping address yet. Please provide: ${uniqueFailed.join(", ")}.`;
  } else {
    customerMessage = validation.issues[0] || "Some shipping details look invalid.";
  }

  const addressCoreProvided = providedFields.some((entry) =>
    ["street_address", "address_locality", "postal_code", "address_country"].includes(entry.field)
  );
  const askWithFullList = validation.missingLabels.length >= 2 && !addressCoreProvided;

  const instructionParts = [
    "The shipping address was NOT saved.",
    providedFields.length > 0
      ? "First tell the customer which fields we ALREADY HAVE (use provided_fields with values). " +
        "Then ask ONLY for missing_fields — never re-ask for anything in provided_fields."
      : null,
    askWithFullList
      ? "Ask in ONE message using this EXACT numbered list (always include item 4 Email (optional)):\n" +
        `${SHIPPING_ASK_LIST_TEXT}\n` +
        `Still required: ${validation.missingLabels.join(", ")}.`
      : uniqueFailed.length > 0
        ? `Ask only for: ${uniqueFailed.join(", ")}. Email is optional — do not require it unless the customer wants order updates.`
        : "Ask the customer to fix the issues listed.",
    "If a saved address exists, pass only the field the customer is updating on set_cart_shipping — the server fills the rest from saved shipping.",
    "Never say the address was saved."
  ];

  return toolResult({
    success: false,
    shipping_saved: false,
    issues: validation.issues,
    provided_fields: providedFields,
    missing_fields: validation.missingLabels,
    customer_message: customerMessage,
    instruction: instructionParts.filter(Boolean).join(" ")
  });
}

function extractAddressText(text) {
  const raw = String(text || "").trim();
  if (!raw) {
    return raw;
  }

  let cleaned = raw.replace(
    /^(?:please\s+)?(?:could you\s+(?:pls\s+)?|pls\s+)?(?:add|set|update|change)(?:\s+this)?\s+(?:the\s+)?(?:shipping\s+)?address\s*:+\s*/i,
    ""
  ).trim();
  cleaned = cleaned.replace(
    /^(?:please\s+|could you\s+(?:pls\s+)?|pls\s+)?(?:update|change|set)\s+/i,
    ""
  ).trim();

  return cleaned || raw;
}

/** Street/city/state/ZIP/country lines without a person name or phone. */
export function parseAddressLineOnly(text) {
  const raw = extractAddressText(text);
  if (!raw || extractPhoneFromText(raw)) {
    return null;
  }

  const parts = raw.split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length < 3) {
    return null;
  }

  const zipOnlyPattern = /^\d{5}(?:-\d{4})?$/;
  const stateZipPattern = /^([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)$/;
  const stateOnlyPattern = /^[A-Za-z]{2}$/;

  let tail = [...parts];
  let address_country = null;
  const lastPart = tail[tail.length - 1];
  if (
    !zipOnlyPattern.test(lastPart) &&
    !stateZipPattern.test(lastPart) &&
    !stateOnlyPattern.test(lastPart)
  ) {
    address_country = normalizeCountryCode(lastPart);
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
  streetParts = tail.length === 1 ? [tail[0]] : tail.slice(0, -1);
  if (!streetParts.length) {
    return null;
  }

  return {
    street_address: streetParts.join(", "),
    address_locality,
    address_region: address_region || null,
    postal_code,
    address_country: address_country || "US"
  };
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

function normalizeShippingAddress(input = {}, { userMessage, existingCart, savedShipping = null } = {}) {
  const merged = { ...input };
  delete merged.address_text;

  const textSources = [input.address_text, userMessage].filter(Boolean);
  let parsedFromText = false;

  for (const text of textSources) {
    for (const parsed of [parseAddressText(text), parseAddressLineOnly(text)].filter(Boolean)) {
      parsedFromText = true;
      for (const [key, value] of Object.entries(parsed)) {
        if (value && isBlank(merged[key])) {
          merged[key] = value;
        }
      }
    }
  }

  const existingShipping = extractExistingShipping(existingCart);
  for (const [key, value] of Object.entries(existingShipping)) {
    if (value && isBlank(merged[key])) {
      merged[key] = value;
    }
  }

  const primaryText = String(userMessage || input.address_text || "").trim();
  let sanitized = sanitizeShippingFromContext(merged, primaryText);
  sanitized = applySavedShippingDefaults(sanitized, savedShipping);

  if (sanitized.address_country) {
    sanitized.address_country = normalizeCountryCode(sanitized.address_country);
  }

  if (sanitized.address_region) {
    sanitized.address_region = String(sanitized.address_region).trim().toUpperCase();
  }

  if (!isBlank(sanitized.email)) {
    sanitized.email = normalizeEmail(sanitized.email);
  }

  const missing = SHIPPING_REQUIRED_FIELDS.filter((field) => isBlank(sanitized[field]));

  return {
    address: sanitized,
    missing,
    parsedFromText
  };
}

export default {
  getCartWrapperTools,
  isCartWrapperTool,
  isCartMutationTool,
  filterCartToolsForLlm,
  callCartWrapperTool,
  appendFinalCartSnapshot,
  mergeThemeCartIntoConversation,
  buildActiveCartWrapperContextMessage,
  buildShippingEmailHintMessage
};
