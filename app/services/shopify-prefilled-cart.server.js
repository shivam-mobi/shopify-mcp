/**
 * Classic Shopify cart permalinks (/cart/{variantId}:{qty}) with optional
 * checkout prefill query params when ShopperCart shipping is on file.
 */
import { getConversationShippingAddress } from "../db.server.js";
import { appendAiraUtmParams } from "./aira-attribution.server.js";

const PREFILL_REQUIRED_FIELDS = [
  "first_name",
  "last_name",
  "street_address",
  "address_locality",
  "postal_code",
  "address_country",
  "phone_number"
];

function isBlank(value) {
  return !String(value ?? "").trim();
}

export function extractNumericVariantId(variantId) {
  const raw = String(variantId || "").trim();
  if (!raw) return null;

  const gidMatch = raw.match(/ProductVariant\/(\d+)/i);
  if (gidMatch) return gidMatch[1];

  if (/^\d+$/.test(raw)) return raw;
  return null;
}

export function resolveStorefrontBaseUrl() {
  return (
    process.env.STOREFRONT_URL ||
    process.env.SHOPIFY_STOREFRONT_URL ||
    ""
  )
    .trim()
    .replace(/\/+$/, "");
}

export function buildClassicCartPermalink(variantId, quantity = 1, shopBaseUrl = null) {
  const numeric = extractNumericVariantId(variantId);
  if (!numeric) return null;

  const base = (shopBaseUrl || resolveStorefrontBaseUrl()).replace(/\/+$/, "");
  if (!base) return null;

  const qty = Math.max(1, Number(quantity) || 1);
  return `${base}/cart/${numeric}:${qty}`;
}

export function isClassicCartPermalink(url) {
  if (!url || typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    return (
      /^\/cart\/[^/]+$/i.test(parsed.pathname) &&
      !/^\/cart\/c\//i.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

export function isShippingCompleteForCartPrefill(shipping = {}) {
  if (!shipping || typeof shipping !== "object") return false;
  return PREFILL_REQUIRED_FIELDS.every((field) => !isBlank(shipping[field]));
}

function formatPhoneForCheckoutPrefill(phone, country) {
  const raw = String(phone || "").trim();
  if (!raw) return raw;

  const digits = raw.replace(/\D/g, "");
  const countryUpper = String(country || "").trim().toUpperCase();
  const isUs =
    countryUpper === "US" ||
    countryUpper === "USA" ||
    countryUpper === "UNITED STATES";

  if (isUs && digits.length === 11 && digits.startsWith("1")) {
    const ten = digits.slice(1);
    return `+1-${ten.slice(0, 3)}-${ten.slice(3, 6)}-${ten.slice(6)}`;
  }
  if (isUs && digits.length === 10) {
    return `+1-${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  }

  return raw.startsWith("+") ? raw : raw;
}

/**
 * Append checkout[email] and checkout[shipping_address][*] to a classic /cart/ URL.
 * Returns the original URL when shipping is incomplete or URL is not a cart permalink.
 */
export function buildPrefilledCartPermalink(cartUrl, shipping = {}) {
  if (!cartUrl || !isClassicCartPermalink(cartUrl)) {
    return cartUrl || null;
  }
  if (!isShippingCompleteForCartPrefill(shipping)) {
    return cartUrl;
  }

  try {
    const parsed = new URL(cartUrl);
    const params = parsed.searchParams;

    if (!isBlank(shipping.email)) {
      params.set("checkout[email]", String(shipping.email).trim());
    }

    params.set("checkout[shipping_address][first_name]", String(shipping.first_name).trim());
    params.set("checkout[shipping_address][last_name]", String(shipping.last_name).trim());
    params.set(
      "checkout[shipping_address][address1]",
      String(shipping.street_address).trim()
    );

    if (!isBlank(shipping.extended_address)) {
      params.set(
        "checkout[shipping_address][address2]",
        String(shipping.extended_address).trim()
      );
    }

    params.set(
      "checkout[shipping_address][city]",
      String(shipping.address_locality).trim()
    );
    params.set(
      "checkout[shipping_address][province]",
      String(shipping.address_region).trim().toUpperCase()
    );
    params.set(
      "checkout[shipping_address][zip]",
      String(shipping.postal_code).trim()
    );
    params.set(
      "checkout[shipping_address][country]",
      String(shipping.address_country).trim().toUpperCase()
    );
    params.set(
      "checkout[shipping_address][phone]",
      formatPhoneForCheckoutPrefill(shipping.phone_number, shipping.address_country)
    );

    parsed.search = params.toString();
    return parsed.toString();
  } catch {
    return cartUrl;
  }
}

function resolveBaseCartUrl(product = {}, shopBaseUrl) {
  return (
    product.checkout_url ||
    buildClassicCartPermalink(
      product.variantId || product.variant_id || product.id,
      1,
      shopBaseUrl
    )
  );
}

function enrichBuyNowFields(product = {}, shipping, conversationId, shopBaseUrl) {
  const baseUrl = resolveBaseCartUrl(product, shopBaseUrl);
  if (!baseUrl) {
    return product;
  }

  const buyNowUrl = appendAiraUtmParams(
    buildPrefilledCartPermalink(baseUrl, shipping),
    conversationId
  );

  const variants = Array.isArray(product.variants)
    ? product.variants.map((variant) => {
        const variantBase =
          variant.checkout_url ||
          buildClassicCartPermalink(
            variant.id || variant.variantId || variant.variant_id,
            1,
            shopBaseUrl
          ) ||
          baseUrl;

        return {
          ...variant,
          checkout_url: variantBase,
          buy_now_url: appendAiraUtmParams(
            buildPrefilledCartPermalink(variantBase, shipping),
            conversationId
          )
        };
      })
    : product.variants;

  return {
    ...product,
    checkout_url: baseUrl,
    buy_now_url: buyNowUrl,
    ...(variants ? { variants } : {})
  };
}

/**
 * Attach buy_now_url (prefilled when ShopperCart.shippingAddress is complete).
 */
export async function applyBuyNowUrlsToProducts(products = [], conversationId) {
  if (!Array.isArray(products) || products.length === 0) {
    return products;
  }

  const shipping = conversationId
    ? await getConversationShippingAddress(conversationId)
    : null;
  const shopBaseUrl = resolveStorefrontBaseUrl();

  return products.map((product) =>
    enrichBuyNowFields(product, shipping, conversationId, shopBaseUrl)
  );
}

export default {
  applyBuyNowUrlsToProducts,
  buildClassicCartPermalink,
  buildPrefilledCartPermalink,
  isClassicCartPermalink,
  isShippingCompleteForCartPrefill
};
