/**
 * Import storefront theme cart into the conversation UCP cart.
 * Theme cart is source of truth: empty theme clears the chatbot cart.
 * POST /chat/theme-cart-import
 * Body: { conversation_id, items: [{ variant_id, quantity }] }
 */
import MCPClient from "../mcp-client";
import { mergeThemeCartIntoConversation } from "../services/cart-tools.server.js";
import { syncCustomerContextFromRequest } from "../services/customer-context.server.js";

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

function resolveMcpHostUrl(request, body = {}) {
  const origin = request.headers.get("Origin");
  if (origin && /^https?:\/\//i.test(origin)) {
    return origin.replace(/\/+$/, "");
  }

  const raw =
    request.headers.get("X-Shopify-Shop-Domain") ||
    body?.shop_domain ||
    body?.shop ||
    null;
  if (!raw) return null;

  const value = String(raw).trim().replace(/\/+$/, "");
  if (/^https?:\/\//i.test(value)) return value;
  return `https://${value}`;
}

function getBuyerIpFromRequest(request) {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }

  const realIp = request.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;

  const cfIp = request.headers.get("cf-connecting-ip")?.trim();
  if (cfIp) return cfIp;

  return null;
}

export async function loader({ request }) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: getCorsHeaders(request) });
  }
  return json(request, {
    ok: true,
    endpoint: "/chat/theme-cart-import",
    usage: "POST { conversation_id, items: [{ variant_id, quantity }] }"
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

  const conversationId = String(body?.conversation_id || "").trim();
  if (!conversationId) {
    return json(request, { error: "conversation_id is required" }, 400);
  }

  const hostUrl = resolveMcpHostUrl(request, body);
  if (!hostUrl) {
    return json(request, { error: "shop domain is required" }, 400);
  }

  const shopId = request.headers.get("X-Shopify-Shop-Id");
  const buyerIp = getBuyerIpFromRequest(request);
  const mcpClient = new MCPClient(hostUrl, conversationId, shopId, null, {
    buyerIp
  });

  try {
    // Bind shared shopper cart before merge (non-fatal if it fails).
    await syncCustomerContextFromRequest(conversationId, body);

    await mcpClient.connectToUcpServer();
    const result = await mergeThemeCartIntoConversation(
      mcpClient,
      conversationId,
      body?.items || []
    );
    return json(request, result);
  } catch (error) {
    console.error("[theme-cart-import] failed", error?.message || error);
    return json(
      request,
      {
        success: false,
        error: "theme_cart_import_failed",
        message: String(error?.message || error)
      },
      500
    );
  }
}
