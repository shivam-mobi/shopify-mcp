/**
 * When add_to_cart targets a variant already in the cart, require confirmation once.
 */

const PENDING_TTL_MS = 30 * 60 * 1000;
const pendingByConversation = new Map();

function normalizeKey(conversationId) {
  return String(conversationId || "").trim();
}

function normalizeVariantKey(variantId) {
  const id = String(variantId || "").trim();
  if (!id) return "";
  const match = id.match(/(\d+)\s*$/);
  return match ? match[1] : id;
}

export function findCartLineForVariant(lineItems = [], variantId) {
  const target = normalizeVariantKey(variantId);
  if (!target) return null;

  for (const line of lineItems) {
    const lineId = normalizeVariantKey(line?.item?.id);
    if (lineId && lineId === target) {
      return line;
    }
  }
  return null;
}

export function setPendingDuplicateAdd(
  conversationId,
  { variantId, quantity = 1, title = null, currentQuantity = 1 } = {}
) {
  const key = normalizeKey(conversationId);
  const variant = String(variantId || "").trim();
  if (!key || !variant) return;

  pendingByConversation.set(key, {
    variantId: variant,
    quantity: Math.max(1, Number(quantity) || 1),
    title: title ? String(title).trim() : null,
    currentQuantity: Math.max(1, Number(currentQuantity) || 1),
    expiresAt: Date.now() + PENDING_TTL_MS
  });
}

export function getPendingDuplicateAdd(conversationId) {
  const key = normalizeKey(conversationId);
  if (!key) return null;

  const row = pendingByConversation.get(key);
  if (!row) return null;
  if (row.expiresAt && row.expiresAt < Date.now()) {
    pendingByConversation.delete(key);
    return null;
  }
  return row;
}

export function clearPendingDuplicateAdd(conversationId) {
  const key = normalizeKey(conversationId);
  if (key) pendingByConversation.delete(key);
}

const AFFIRMATIVE_PATTERN =
  /^(yes|yeah|yep|yup|sure|ok|okay|confirm|add\s+(it|another|one|more)|one\s+more|add\s+one\s+more|please\s+add|go\s+ahead|do\s+it)[!.?\s]*$/i;

const NEGATIVE_PATTERN =
  /^(no|nope|nah|don't|do not|cancel|never\s*mind|skip)[!.?\s]*$/i;

export function isDuplicateAddConfirmation(userMessage = "") {
  const text = String(userMessage || "").trim();
  if (!text) return false;
  if (NEGATIVE_PATTERN.test(text)) return false;
  if (AFFIRMATIVE_PATTERN.test(text)) return true;
  return /\b(add\s+another|one\s+more|yes\s+add|add\s+one\s+more)\b/i.test(text);
}

export function shouldConfirmDuplicateAdd(
  conversationId,
  variantId,
  { confirmDuplicate = false, userMessage = "" } = {}
) {
  if (confirmDuplicate === true) return false;

  const pending = getPendingDuplicateAdd(conversationId);
  if (!pending) return true;

  const sameVariant =
    normalizeVariantKey(pending.variantId) === normalizeVariantKey(variantId);
  if (!sameVariant) return true;

  if (isDuplicateAddConfirmation(userMessage)) {
    return false;
  }

  return true;
}

export function buildDuplicateCartHintMessage(conversationId, userMessage = "") {
  const pending = getPendingDuplicateAdd(conversationId);
  if (!pending) return null;

  const text = String(userMessage || "").trim();
  if (isDuplicateAddConfirmation(text)) {
    return {
      role: "system",
      content:
        `The customer confirmed adding another of the pending product (variant ${pending.variantId}). ` +
        `Call add_to_cart with variant_id="${pending.variantId}" and quantity ${pending.quantity}, ` +
        "and set confirm_duplicate: true. Do not ask again."
    };
  }

  if (NEGATIVE_PATTERN.test(text)) {
    clearPendingDuplicateAdd(conversationId);
    return {
      role: "system",
      content:
        "The customer declined adding another of the same product. Do not call add_to_cart for that duplicate. Ask what else they need."
    };
  }

  return null;
}
