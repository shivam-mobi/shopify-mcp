/**
 * No-op endpoint for Shopify Events subscription deliveries.
 *
 * Shopify CLI requires at least one `[[events.subscription]]` entry in `shopify.app.toml`.
 * This app currently doesn't need product update deliveries, so we just acknowledge
 * the request to avoid noisy 404s.
 */

export async function action({ request }) {
  if (request.method.toLowerCase() === "options") {
    return new Response(null, { status: 204 });
  }

  // Consume the body so connections are cleaned up.
  try {
    await request.text();
  } catch {
    // Ignore body read errors
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json"
    }
  });
}

