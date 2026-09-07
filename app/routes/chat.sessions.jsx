/**
 * Cross-device chat session sync for logged-in storefront customers.
 * GET  /chat/sessions?customer_id=&shop=  → list sessions
 * POST /chat/sessions                     → claim local conversation ids, return list
 */
import {
  claimConversationForCustomer,
  listConversationsForCustomer
} from "../db.server";

function getCorsHeaders(request) {
  const origin = request.headers.get("Origin") || "*";
  const requestHeaders =
    request.headers.get("Access-Control-Request-Headers") || "Content-Type, Accept";

  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": requestHeaders,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Max-Age": "86400",
    "Content-Type": "application/json"
  };
}

function json(request, body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: getCorsHeaders(request)
  });
}

function normalizeCustomerId(value) {
  return String(value || "").trim();
}

function normalizeShop(value) {
  return String(value || "").trim().toLowerCase();
}

export async function loader({ request }) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: getCorsHeaders(request) });
  }

  const url = new URL(request.url);
  const customerId = normalizeCustomerId(url.searchParams.get("customer_id"));
  const shop = normalizeShop(url.searchParams.get("shop"));

  if (!customerId) {
    return json(request, { error: "Missing customer_id" }, 400);
  }

  const sessions = await listConversationsForCustomer(customerId, {
    shopDomain: shop || null
  });

  return json(request, { sessions });
}

export async function action({ request }) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: getCorsHeaders(request) });
  }

  let body = {};
  try {
    body = await request.json();
  } catch {
    return json(request, { error: "Invalid JSON body" }, 400);
  }

  const customerId = normalizeCustomerId(body.customer_id || body.shopify_customer_id);
  const shop = normalizeShop(body.shop || body.shop_domain);
  const firstName = String(body.customer_first_name || "").trim() || null;
  const lastName = String(body.customer_last_name || "").trim() || null;

  if (!customerId) {
    return json(request, { error: "Missing customer_id" }, 400);
  }

  const conversationIds = Array.isArray(body.conversation_ids)
    ? body.conversation_ids
    : body.conversation_id
      ? [body.conversation_id]
      : [];

  const claims = [];
  for (const rawId of conversationIds) {
    const conversationId = String(rawId || "").trim();
    if (!conversationId) continue;
    const result = await claimConversationForCustomer(conversationId, {
      shopifyCustomerId: customerId,
      shopDomain: shop || null,
      firstName,
      lastName
    });
    claims.push({ conversationId, ...result });
  }

  const sessions = await listConversationsForCustomer(customerId, {
    shopDomain: shop || null
  });

  return json(request, { sessions, claims });
}
