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

export function shouldConfirmDuplicateAdd(
  conversationId,
  variantId,
  { confirmDuplicate = false } = {}
) {
  if (confirmDuplicate === true) return false;

  const pending = getPendingDuplicateAdd(conversationId);
  if (!pending) return true;

  const sameVariant =
    normalizeVariantKey(pending.variantId) === normalizeVariantKey(variantId);
  if (!sameVariant) return true;

  // Since we removed regex, we require the LLM to explicitly pass confirmDuplicate: true
  return true;
}

export function buildDuplicateCartHintMessage(conversationId) {
  const pending = getPendingDuplicateAdd(conversationId);
  if (!pending) return null;

  // Clear the pending state so it only applies to this single turn.
  // The LLM will read the user's message and make a final decision now.
  clearPendingDuplicateAdd(conversationId);

  return {
    role: "system",
    content:
      `A duplicate cart confirmation is pending for variant ${pending.variantId} (quantity ${pending.quantity}). ` +
      `If the customer's latest message confirms they want to add it (e.g. 'yes', 'add it', 'yup', 'please add'), ` +
      `call add_to_cart with variant_id="${pending.variantId}" and confirm_duplicate: true. ` +
      `If they decline, do not call add_to_cart. ` +
      `Once this decision is made, do not ask again.`
  };
}
