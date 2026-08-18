/**
 * Shared app URL helpers for server-side code.
 */
export function getAppUrl() {
  const url = process.env.APP_URL || process.env.SHOPIFY_APP_URL || "";
  return url.replace(/\/+$/, "");
}

export function getRedirectUrl() {
  return process.env.REDIRECT_URL || `${getAppUrl()}/auth/callback`;
}

export function getAppHostname() {
  if (!getAppUrl()) return "localhost";
  return new URL(getAppUrl()).hostname;
}
