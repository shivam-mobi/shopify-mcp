/**
 * Sync storefront customer addresses from Liquid into DB.
 * POST /chat/customer-addresses
 */
import { upsertStoreCustomerAddresses, listStoreCustomerAddresses } from "../db.server";

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

  const addresses = await listStoreCustomerAddresses(customerId, {
    shopDomain: shop || null
  });

  return json(request, { addresses, count: addresses.length });
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

  const customerId = normalizeCustomerId(body.customer_id || body.shopify_customer_id);
  const shop = normalizeShop(body.shop || body.shop_domain);
  const email = String(body.customer_email || body.email || "").trim() || null;
  const firstName = String(body.customer_first_name || "").trim() || null;
  const lastName = String(body.customer_last_name || "").trim() || null;
  const addresses = Array.isArray(body.addresses)
    ? body.addresses
    : Array.isArray(body.customer_addresses)
      ? body.customer_addresses
      : [];

  if (!customerId) {
    return json(request, { error: "Missing customer_id" }, 400);
  }
  if (!shop) {
    return json(request, { error: "Missing shop" }, 400);
  }

  const result = await upsertStoreCustomerAddresses({
    shopifyCustomerId: customerId,
    shopDomain: shop,
    email,
    firstName,
    lastName,
    addresses
  });

  if (!result.ok) {
    return json(request, { error: result.error || "Sync failed" }, 400);
  }

  return json(request, {
    ok: true,
    address_count: result.addressCount,
    shopify_customer_id: result.shopifyCustomerId,
    shop: result.shopDomain
  });
}
