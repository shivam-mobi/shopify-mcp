import { storeShopifyEventLog } from "../db.server";
import {
  syncArticleFromEvent,
  deleteArticleFromEvent,
  fetchAndSyncArticleById,
  syncPageFromEvent,
  deletePageFromEvent,
  fetchAndSyncPageById,
} from "../services/knowledge-sync.server";

export const loader = async () => {
  return new Response(
    JSON.stringify({
      status: "ok",
      endpoint: "/events",
      supported_events: ["article-event", "page-event"],
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }
  );
};

export const action = async ({ request }) => {
  if (request.method.toLowerCase() === "options") {
    return new Response(null, { status: 204 });
  }

  let rawBody = "";
  try {
    rawBody = await request.text();
  } catch (err) {
    console.error("[Events] Error reading request body:", err);
  }

  let payload = {};
  try {
    payload = rawBody ? JSON.parse(rawBody) : {};
  } catch (err) {
    console.warn("[Events] Could not parse JSON body:", err);
  }

  const topicHeader =
    request.headers.get("x-shopify-topic") ||
    payload.topic ||
    payload.handle ||
    "EVENT_SUBSCRIPTION";

  const actionType = String(
    payload.action || payload.event_type || ""
  ).toLowerCase();

  console.log(`[Events] Received event delivery: topic="${topicHeader}", action="${actionType}"`);

  let status = "processed";
  let errorMessage = null;

  try {
    const articleData = payload.data?.article || payload.article;
    const pageData = payload.data?.page || payload.page;

    if (articleData) {
      if (actionType === "delete" || payload.action === "delete") {
        await deleteArticleFromEvent(articleData);
      } else {
        // If query only returned { id, title, handle }, fetch full body via Admin API and sync
        if (articleData.body || articleData.body_html) {
          await syncArticleFromEvent(articleData);
        } else {
          await fetchAndSyncArticleById(articleData.id);
        }
      }
    } else if (pageData) {
      if (actionType === "delete" || payload.action === "delete") {
        await deletePageFromEvent(pageData);
      } else {
        // If query only returned { id, title, handle }, fetch full body via Admin API and sync
        if (pageData.body || pageData.body_html) {
          await syncPageFromEvent(pageData);
        } else {
          await fetchAndSyncPageById(pageData.id);
        }
      }
    }
  } catch (err) {
    status = "error";
    errorMessage = err?.message || String(err);
    console.error("[Events] Error processing event:", err);
  }

  // Persist into shopifyEventLogs
  await storeShopifyEventLog({
    topic: String(topicHeader),
    eventId:
      request.headers.get("x-shopify-event-id") ||
      request.headers.get("x-shopify-webhook-id") ||
      null,
    apiVersion: request.headers.get("x-shopify-api-version") || "2026-10",
    payload,
    status,
    errorMessage,
  });

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};
