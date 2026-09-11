/**
 * POST /chat/speak — Edge TTS audio for assistant read-aloud (demo).
 * Body: { text: string, voice?: string }
 * Returns: audio/mpeg
 */
import AppConfig from "../services/config.server.js";
import { sanitizeSpeakText, synthesizeEdgeSpeech } from "../services/edge-tts.server.js";

function getCorsHeaders(request, contentType = "application/json") {
  const origin = request.headers.get("Origin") || "*";
  const requestHeaders =
    request.headers.get("Access-Control-Request-Headers") || "Content-Type, Accept";

  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": requestHeaders,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Max-Age": "86400",
    "Content-Type": contentType
  };
}

function json(request, body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: getCorsHeaders(request)
  });
}

export async function loader({ request }) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: getCorsHeaders(request) });
  }

  return json(request, {
    ok: true,
    endpoint: "/chat/speak",
    enabled: AppConfig.speak.enabled && AppConfig.speak.edgeEnabled,
    usage: "POST JSON { text, voice? } → audio/mpeg (Microsoft Edge TTS demo)"
  });
}

export async function action({ request }) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: getCorsHeaders(request) });
  }

  if (request.method !== "POST") {
    return json(request, { error: "Method not allowed" }, 405);
  }

  if (!AppConfig.speak.enabled) {
    return json(request, { error: "Speak feature is disabled" }, 403);
  }

  if (!AppConfig.speak.edgeEnabled) {
    return json(request, { error: "Edge TTS is disabled" }, 403);
  }

  let body = {};
  try {
    body = await request.json();
  } catch {
    return json(request, { error: "Invalid JSON body" }, 400);
  }

  const text = sanitizeSpeakText(body?.text);
  if (!text) {
    return json(request, { error: "text is required" }, 400);
  }

  try {
    const { buffer, contentType, voice } = await synthesizeEdgeSpeech(text, {
      voice: body?.voice || AppConfig.speak.edgeVoice
    });

    console.log("[edge-tts] synthesized", {
      chars: text.length,
      bytes: buffer.length,
      voice
    });

    return new Response(buffer, {
      status: 200,
      headers: {
        ...getCorsHeaders(request, contentType),
        "Cache-Control": "no-store",
        "X-Edge-TTS-Voice": voice
      }
    });
  } catch (error) {
    console.error("[edge-tts] failed", error?.message || error);
    return json(
      request,
      {
        error: "Edge TTS failed",
        message: String(error?.message || error)
      },
      502
    );
  }
}
