/**
 * Shopify Dev Dashboard Catalogs / agent credentials → Bearer access token.
 * Token expires ~60 minutes; cached in-memory and refreshed before expiry.
 *
 * Docs: https://shopify.dev/docs/agents/get-started/authentication
 */
import AppConfig from "./config.server";

const TOKEN_URL = "https://api.shopify.com/auth/access_token";
/** Refresh this many ms before JWT exp */
const REFRESH_SKEW_MS = 2 * 60 * 1000;

let cachedToken = null;
let cachedExpiresAtMs = 0;
let inflight = null;

export function hasCatalogCredentials() {
  const { clientId, clientSecret } = AppConfig.mcp.catalog;
  return Boolean(clientId && clientSecret);
}

/**
 * @param {{ force?: boolean }} [options]
 * @returns {Promise<string|null>} Bearer token, or null if Catalogs creds are not configured
 */
export async function getCatalogAccessToken({ force = false } = {}) {
  if (!hasCatalogCredentials()) {
    return null;
  }

  const now = Date.now();
  if (
    !force &&
    cachedToken &&
    cachedExpiresAtMs - REFRESH_SKEW_MS > now
  ) {
    return cachedToken;
  }

  if (inflight) {
    return inflight;
  }

  inflight = fetchCatalogAccessToken()
    .then((token) => {
      inflight = null;
      return token;
    })
    .catch((error) => {
      inflight = null;
      throw error;
    });

  return inflight;
}

async function fetchCatalogAccessToken() {
  const { clientId, clientSecret } = AppConfig.mcp.catalog;

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "client_credentials"
    })
  });

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    const detail =
      body?.error_description ||
      body?.error ||
      body?.message ||
      JSON.stringify(body);
    throw new Error(
      `Catalog access_token failed (${response.status}): ${detail}`
    );
  }

  const accessToken = body?.access_token;
  if (!accessToken || typeof accessToken !== "string") {
    throw new Error("Catalog access_token response missing access_token");
  }

  const expiresAtMs = readJwtExpiryMs(accessToken) || Date.now() + 55 * 60 * 1000;
  cachedToken = accessToken;
  cachedExpiresAtMs = expiresAtMs;

  console.log("[catalog-auth] access_token refreshed", {
    expiresAt: new Date(expiresAtMs).toISOString(),
    scopes: readJwtClaim(accessToken, "scopes") || null
  });

  return accessToken;
}

function readJwtExpiryMs(jwt) {
  const exp = readJwtClaim(jwt, "exp");
  if (typeof exp !== "number") return null;
  return exp * 1000;
}

function readJwtClaim(jwt, claim) {
  try {
    const parts = String(jwt).split(".");
    if (parts.length < 2) return null;
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8")
    );
    return payload?.[claim] ?? null;
  } catch {
    try {
      const parts = String(jwt).split(".");
      const payload = JSON.parse(
        Buffer.from(parts[1], "base64").toString("utf8")
      );
      return payload?.[claim] ?? null;
    } catch {
      return null;
    }
  }
}

/** Clear cache (tests / forced re-auth). */
export function clearCatalogAccessTokenCache() {
  cachedToken = null;
  cachedExpiresAtMs = 0;
}
