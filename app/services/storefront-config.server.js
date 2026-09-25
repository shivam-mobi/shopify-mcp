/**
 * Storefront shop host — prefer SHOPIFY_STORE_DOMAIN over STOREFRONT_URL.
 */

function hostnameFromStoreUrl(raw = "") {
  const value = String(raw || "").trim();
  if (!value) return null;
  try {
    const url = value.includes("://") ? new URL(value) : new URL(`https://${value}`);
    return url.hostname.replace(/\/$/, "").toLowerCase();
  } catch {
    const host = value.replace(/^https?:\/\//, "").split("/")[0];
    return host ? host.toLowerCase() : null;
  }
}

function normalizeShopHostname(raw = "") {
  const value = String(raw || "").trim();
  if (!value) return null;
  if (value.includes("://")) {
    return hostnameFromStoreUrl(value);
  }
  const host = value.replace(/\/$/, "").split("/")[0];
  return host ? host.toLowerCase() : null;
}

/** Hostname for Storefront GraphQL (e.g. pureairflow.myshopify.com). */
export function resolveStorefrontShopHostname(shop) {
  const fromArg = normalizeShopHostname(shop);
  if (fromArg) return fromArg;

  return (
    normalizeShopHostname(process.env.SHOPIFY_STORE_DOMAIN) ||
    normalizeShopHostname(process.env.SHOPIFY_SHOP) ||
    hostnameFromStoreUrl(process.env.STOREFRONT_URL) ||
    hostnameFromStoreUrl(process.env.SHOPIFY_STOREFRONT_URL)
  );
}

/** Base URL for MCP warmup and relative product links. */
export function resolveStorefrontHostUrl() {
  const host = resolveStorefrontShopHostname();
  if (!host) return "";
  return `https://${host}`.replace(/\/+$/, "");
}
