/**
 * Microsoft Edge online TTS (unofficial) for demo / testing better voices.
 * Not for heavy production reliance — service can change without notice.
 */
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";

const DEFAULT_VOICE = process.env.EDGE_TTS_VOICE || "en-US-AriaNeural";
const MAX_CHARS = Number(process.env.EDGE_TTS_MAX_CHARS || 2500);

function readableToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

export function sanitizeSpeakText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_CHARS);
}

/**
 * @param {string} text
 * @param {{ voice?: string }} [options]
 * @returns {Promise<{ buffer: Buffer, contentType: string, voice: string }>}
 */
export async function synthesizeEdgeSpeech(text, options = {}) {
  const input = sanitizeSpeakText(text);
  if (!input) {
    throw new Error("Text is required");
  }

  const voice = String(options.voice || DEFAULT_VOICE).trim() || DEFAULT_VOICE;
  const tts = new MsEdgeTTS();
  await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);

  const { audioStream } = tts.toStream(input);
  const buffer = await readableToBuffer(audioStream);

  if (!buffer?.length) {
    throw new Error("Edge TTS returned empty audio");
  }

  return {
    buffer,
    contentType: "audio/mpeg",
    voice
  };
}
