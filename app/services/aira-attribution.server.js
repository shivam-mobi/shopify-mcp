/**
 * AIRA checkout UTMs for Shopify Admin / analytics.
 * Only: utm_source, utm_medium, utm_campaign, utm_term
 */

export const AIRA_UTM_SOURCE = "aira";
export const AIRA_UTM_MEDIUM = "chat";
export const AIRA_UTM_CAMPAIGN = "chatbot_checkout";

/**
 * @param {string|null|undefined} conversationId
 * @returns {Record<string, string>}
 */
export function buildAiraAttribution(conversationId) {
  const attribution = {
    utm_source: AIRA_UTM_SOURCE,
    utm_medium: AIRA_UTM_MEDIUM,
    utm_campaign: AIRA_UTM_CAMPAIGN
  };

  const cid = String(conversationId || "").trim();
  if (cid) {
    attribution.utm_term = cid;
  }

  return attribution;
}

export function mergeAiraAttribution(existingAttribution, conversationId) {
  const existing =
    existingAttribution && typeof existingAttribution === "object"
      ? existingAttribution
      : {};

  return {
    ...existing,
    ...buildAiraAttribution(conversationId)
  };
}

export function withAiraAttribution(resource = {}, conversationId) {
  const next = { ...(resource || {}) };
  next.attribution = mergeAiraAttribution(next.attribution, conversationId);
  return next;
}

export function appendAiraUtmParams(url, conversationId) {
  if (!url || typeof url !== "string") {
    return url;
  }

  try {
    const parsed = new URL(url);
    parsed.searchParams.set("utm_source", AIRA_UTM_SOURCE);
    parsed.searchParams.set("utm_medium", AIRA_UTM_MEDIUM);
    parsed.searchParams.set("utm_campaign", AIRA_UTM_CAMPAIGN);

    const cid = String(conversationId || "").trim();
    if (cid) {
      parsed.searchParams.set("utm_term", cid);
    } else {
      parsed.searchParams.delete("utm_term");
    }

    return parsed.toString();
  } catch {
    return url;
  }
}

export default {
  buildAiraAttribution,
  mergeAiraAttribution,
  withAiraAttribution,
  appendAiraUtmParams
};
