/**
 * Resolve chat conversation from shopper_id (localStorage).
 * GET/POST /chat/shopper-session
 *
 * Body/query: shopper_id, customer_id?, action?=get|new|activate, conversation_id?
 */
import { resolveShopperSession } from "../db.server";

function getCorsHeaders(request) {
  const origin = request.headers.get("Origin") || "*";
  const requestHeaders =
    request.headers.get("Access-Control-Request-Headers") ||
    "Content-Type, Accept, X-Shopify-Shop-Id, X-Shopify-Shop-Domain";

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

async function handleShopperSession(request, params) {
  const shopperId = String(params.shopper_id || params.anonymous_shopper_id || "").trim();
  const customerId = String(
    params.customer_id || params.shopify_customer_id || ""
  ).trim();
  const action = String(params.action || "get").trim().toLowerCase();
  const conversationId = String(params.conversation_id || "").trim() || null;

  if (!shopperId && !customerId) {
    return json(request, { error: "shopper_id or customer_id is required" }, 400);
  }

  const result = await resolveShopperSession({
    anonymousShopperId: shopperId || null,
    shopifyCustomerId: customerId || null,
    firstName: params.customer_first_name || null,
    lastName: params.customer_last_name || null,
    action,
    conversationId
  });

  if (!result?.ok) {
    return json(
      request,
      { error: result?.error || "shopper_session_failed" },
      result?.error === "conversation_not_found" ? 404 : 400
    );
  }

  return json(request, {
    ok: true,
    shopper_id: result.shopper_id,
    conversation_id: result.conversation_id,
    sessions: result.sessions
  });
}

export async function loader({ request }) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: getCorsHeaders(request) });
  }

  const url = new URL(request.url);
  return handleShopperSession(request, {
    shopper_id: url.searchParams.get("shopper_id"),
    customer_id: url.searchParams.get("customer_id"),
    action: url.searchParams.get("action") || "get",
    conversation_id: url.searchParams.get("conversation_id")
  });
}

export async function action({ request }) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: getCorsHeaders(request) });
  }

  if (request.method !== "POST") {
    return json(request, { error: "Method not allowed" }, 405);
  }

  let body = {};
  try {
    body = await request.json();
  } catch {
    return json(request, { error: "Invalid JSON body" }, 400);
  }

  return handleShopperSession(request, body);
}
