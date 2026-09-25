/**
 * Cross-conversation recall: cabin vehicles, home sizes, freshener searches.
 */
import prisma from "../db.server.js";
import { extractFilterSizes } from "./catalog-search.server.js";

export const SEARCH_INTENT = {
  CABIN: "cabin",
  HOME: "home",
  FRESHENER: "freshener"
};

const MAX_AGE_DAYS = 90;
const CAP_BY_INTENT = {
  [SEARCH_INTENT.CABIN]: 5,
  [SEARCH_INTENT.HOME]: 3,
  [SEARCH_INTENT.FRESHENER]: 3
};

const LIMIT_BY_CONTEXT = {
  welcome: 5,
  cabin: 3,
  home: 2,
  freshener: 2,
  mixed: 5
};

function normalizeText(value) {
  const text = String(value || "").trim();
  return text.length ? text : null;
}

function normalizeIntent(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === SEARCH_INTENT.CABIN || raw === SEARCH_INTENT.HOME || raw === SEARCH_INTENT.FRESHENER) {
    return raw;
  }
  return null;
}

function parseVehicleYear(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1900 || n > 2100) return null;
  return Math.floor(n);
}

function extractMervFromText(text = "") {
  const match = String(text || "").match(/\bmerv[\s-]*(\d{1,2})\b/i);
  return match ? `MERV ${match[1]}` : null;
}

function daysAgoLabel(date) {
  const ms = date?.getTime?.() || 0;
  if (!ms) return "";
  const days = Math.floor((Date.now() - ms) / (24 * 60 * 60 * 1000));
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
  return `${Math.floor(days / 30)} months ago`;
}

export function detectSearchIntentFromMessage(userMessage = "") {
  const text = String(userMessage || "").trim().toLowerCase();
  if (!text) return null;

  if (
    /\b(home|furnace)\b/.test(text) &&
    /\b(filter|filters|furnace)\b/.test(text)
  ) {
    return SEARCH_INTENT.HOME;
  }
  if (/\b(home\s*filter|furnace\s*filter)\b/.test(text)) {
    return SEARCH_INTENT.HOME;
  }
  if (/\b(freshener|fresheners|air\s*freshener|scent)\b/.test(text)) {
    return SEARCH_INTENT.FRESHENER;
  }
  if (
    /\b(cabin|cabin\s*air|vehicle|fitment|year|make|model|vin)\b/.test(text) ||
    (/\b(filter|filters)\b/.test(text) &&
      /\b(car|vehicle|truck|suv)\b/.test(text))
  ) {
    return SEARCH_INTENT.CABIN;
  }
  return null;
}

function vehicleFromPayload(data = {}) {
  const vehicle = data.vehicle && typeof data.vehicle === "object" ? data.vehicle : {};
  const known = data.known && typeof data.known === "object" ? data.known : {};
  const year = parseVehicleYear(vehicle.year ?? known.year);
  const make = normalizeText(vehicle.make ?? known.make);
  const model = normalizeText(vehicle.model ?? known.model);
  const engine = normalizeText(vehicle.engine ?? known.engine);
  if (!year || !make || !model) return null;
  return { year, make, model, engine };
}

function parseToolPayload(toolUseResponse) {
  if (toolUseResponse?.structuredContent && typeof toolUseResponse.structuredContent === "object") {
    return toolUseResponse.structuredContent;
  }
  const text = toolUseResponse?.content?.[0]?.text;
  if (!text || typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function findExistingRow(shopperId, record) {
  const intent = record.intent;
  const rows = await prisma.shopperSearchMemory.findMany({
    where: { shopperId, intent },
    orderBy: { lastUsedAt: "desc" },
    take: 20
  });

  return rows.find((row) => {
    if (intent === SEARCH_INTENT.HOME) {
      const size = normalizeText(record.homeFilterSize)?.toLowerCase();
      const merv = normalizeText(record.homeMerv)?.toLowerCase();
      const rowSize = normalizeText(row.homeFilterSize)?.toLowerCase();
      const rowMerv = normalizeText(row.homeMerv)?.toLowerCase();
      return rowSize === size && rowMerv === merv;
    }
    if (intent === SEARCH_INTENT.FRESHENER) {
      const y = record.vehicleYear ?? null;
      const make = normalizeText(record.vehicleMake)?.toLowerCase();
      const model = normalizeText(record.vehicleModel)?.toLowerCase();
      const rowMake = normalizeText(row.vehicleMake)?.toLowerCase();
      const rowModel = normalizeText(row.vehicleModel)?.toLowerCase();
      return (
        (row.vehicleYear ?? null) === y &&
        rowMake === (make || null) &&
        rowModel === (model || null)
      );
    }
    const engine = normalizeText(record.vehicleEngine)?.toLowerCase();
    const rowEngine = normalizeText(row.vehicleEngine)?.toLowerCase();
    return (
      row.vehicleYear === record.vehicleYear &&
      normalizeText(row.vehicleMake)?.toLowerCase() ===
        normalizeText(record.vehicleMake)?.toLowerCase() &&
      normalizeText(row.vehicleModel)?.toLowerCase() ===
        normalizeText(record.vehicleModel)?.toLowerCase() &&
      rowEngine === (engine || null)
    );
  });
}

async function pruneIntentRows(shopperId, intent) {
  const cap = CAP_BY_INTENT[intent] || 5;
  const rows = await prisma.shopperSearchMemory.findMany({
    where: { shopperId, intent },
    orderBy: { lastUsedAt: "desc" },
    select: { id: true }
  });
  const excess = rows.slice(cap);
  if (!excess.length) return;
  await prisma.shopperSearchMemory.deleteMany({
    where: { id: { in: excess.map((r) => r.id) } }
  });
}

export async function recordShopperSearchMemory(shopperId, record) {
  const id = String(shopperId || "").trim();
  const intent = normalizeIntent(record?.intent);
  if (!id || !intent) return null;

  const now = new Date();
  const payload = {
    intent,
    vehicleYear: record.vehicleYear ?? null,
    vehicleMake: normalizeText(record.vehicleMake),
    vehicleModel: normalizeText(record.vehicleModel),
    vehicleEngine: normalizeText(record.vehicleEngine),
    homeFilterSize: normalizeText(record.homeFilterSize),
    homeMerv: normalizeText(record.homeMerv)
  };

  if (intent === SEARCH_INTENT.CABIN) {
    if (!payload.vehicleYear || !payload.vehicleMake || !payload.vehicleModel) return null;
  } else if (intent === SEARCH_INTENT.HOME) {
    if (!payload.homeFilterSize) return null;
  }

  try {
    const existing = await findExistingRow(id, payload);
    if (existing) {
      await prisma.shopperSearchMemory.update({
        where: { id: existing.id },
        data: {
          useCount: existing.useCount + 1,
          lastUsedAt: now,
          vehicleEngine: payload.vehicleEngine ?? existing.vehicleEngine,
          homeMerv: payload.homeMerv ?? existing.homeMerv
        }
      });
    } else {
      await prisma.shopperSearchMemory.create({
        data: {
          shopperId: id,
          ...payload,
          lastUsedAt: now
        }
      });
    }
    await pruneIntentRows(id, intent);
    return true;
  } catch (error) {
    console.warn("[shopper-memory] record failed:", error?.message || error);
    return null;
  }
}

export async function listShopperSearchMemory(
  shopperId,
  { intent = null, limit = LIMIT_BY_CONTEXT.mixed, maxAgeDays = MAX_AGE_DAYS } = {}
) {
  const id = String(shopperId || "").trim();
  if (!id) return [];

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - Math.max(1, maxAgeDays));

  const where = {
    shopperId: id,
    lastUsedAt: { gte: cutoff }
  };
  if (intent) {
    where.intent = normalizeIntent(intent) || intent;
  }

  const take = Math.max(1, Math.min(20, Number(limit) || LIMIT_BY_CONTEXT.mixed));

  return prisma.shopperSearchMemory.findMany({
    where,
    orderBy: { lastUsedAt: "desc" },
    take
  });
}

/** Short phrase for the customer reply (no dates). */
export function formatMemoryOfferPhrase(row) {
  if (row.intent === SEARCH_INTENT.HOME) {
    const size = row.homeFilterSize || "";
    const merv = row.homeMerv ? ` ${row.homeMerv}` : "";
    return size ? `home filter ${size}${merv}` : "home filter";
  }
  if (row.intent === SEARCH_INTENT.FRESHENER) {
    if (row.vehicleYear && row.vehicleMake && row.vehicleModel) {
      return `car air fresheners for your ${row.vehicleYear} ${row.vehicleMake} ${row.vehicleModel}`;
    }
    return "car air fresheners";
  }
  if (row.vehicleYear && row.vehicleMake && row.vehicleModel) {
    const engine = row.vehicleEngine ? ` ${row.vehicleEngine}` : "";
    return `cabin filter for your ${row.vehicleYear} ${row.vehicleMake} ${row.vehicleModel}${engine}`;
  }
  return "cabin filter search";
}

export function formatMemoryLine(row) {
  const when = daysAgoLabel(row.lastUsedAt);
  if (row.intent === SEARCH_INTENT.HOME) {
    const size = row.homeFilterSize || "home filter";
    const merv = row.homeMerv ? ` ${row.homeMerv}` : "";
    return `Home filter ${size}${merv} (${when})`;
  }
  if (row.intent === SEARCH_INTENT.FRESHENER) {
    if (row.vehicleYear && row.vehicleMake && row.vehicleModel) {
      return `Fresheners for ${row.vehicleYear} ${row.vehicleMake} ${row.vehicleModel} (${when})`;
    }
    return `Car air fresheners (${when})`;
  }
  if (row.vehicleYear && row.vehicleMake && row.vehicleModel) {
    const engine = row.vehicleEngine ? ` ${row.vehicleEngine}` : "";
    return `Cabin filter — ${row.vehicleYear} ${row.vehicleMake} ${row.vehicleModel}${engine} (${when})`;
  }
  return `Cabin filter search (${when})`;
}

export function buildSuggestionFromMemory(row) {
  if (!row) return null;
  if (row.intent === SEARCH_INTENT.HOME && row.homeFilterSize) {
    const merv = row.homeMerv ? ` ${row.homeMerv}` : "";
    return {
      label: `Home ${row.homeFilterSize}${merv}`,
      message: `Home furnace filter ${row.homeFilterSize}${merv}`
    };
  }
  if (row.intent === SEARCH_INTENT.FRESHENER) {
    if (row.vehicleYear && row.vehicleMake && row.vehicleModel) {
      return {
        label: `Fresheners — ${row.vehicleYear} ${row.vehicleMake} ${row.vehicleModel}`,
        message: `Car air fresheners for my ${row.vehicleYear} ${row.vehicleMake} ${row.vehicleModel}`
      };
    }
    return {
      label: "Car air fresheners",
      message: "Show car air fresheners"
    };
  }
  if (row.vehicleYear && row.vehicleMake && row.vehicleModel) {
    const engine = row.vehicleEngine ? ` ${row.vehicleEngine}` : "";
    return {
      label: `${row.vehicleYear} ${row.vehicleMake} ${row.vehicleModel}`,
      message: `Cabin air filter for ${row.vehicleYear} ${row.vehicleMake} ${row.vehicleModel}${engine}`
    };
  }
  return null;
}

/** Newest saved searches for this shopper, loaded at the start of a chat turn. */
export async function loadShopperMemoriesForTurn(shopperId) {
  return listShopperSearchMemory(shopperId, { limit: 8 });
}

/**
 * Facts for the model. Does not decide when to speak them — the system prompt does.
 */
export function buildShopperSearchMemoryContextMessage(rows = []) {
  const lines = (Array.isArray(rows) ? rows : []).map(formatMemoryLine).filter(Boolean);
  if (!lines.length) return null;

  return {
    role: "system",
    content:
      "SAVED SHOPPER SEARCHES (newest first; this is the full set for this shopper): " +
      `${lines.join("; ")}. ` +
      "This overrides the default blank size question and the default year/make/model question. " +
      "If the latest customer message is trying to buy or find a filter and does not already give a new size or a new vehicle, " +
      "you MUST suggest from this list in one short sentence and wait. " +
      "If they named home or cabin, offer only that type, in the same style as: \"You can consider the saved search for the home filter size of 20x20.\" " +
      "If they did not say home or cabin (for example \"want to purchase filter\"), ask one question and list the saved searches. " +
      "Shape: \"Would you like to continue with a past search: a cabin filter for your 2020 Honda Civic 1.5L, a cabin filter for your 2008 Ford Focus 2.0L, or a home filter 20x20 or 10x10?\" " +
      "Use only their real saved items. Do NOT say \"You can purchase\". " +
      "Do NOT ask Width × Length × Thickness. Do NOT ask year, make, and model. " +
      "Do NOT call search_store_products or get_fitment_next_step until they confirm a saved search or give new details. " +
      "A plain hi/hello must NOT mention this list. " +
      "Do not invent past searches that are not in this list."
  };
}

/** One simple greeting sentence (plain words, no extra follow-up question). */
export const STANDARD_STORE_HELP_LINE =
  "I can help with cabin air filters, cabin filter air fresheners, and home filters.";

export function formatCompactGreeting(firstName) {
  const name = String(firstName || "").trim();
  if (name) return `Hi ${name}! ${STANDARD_STORE_HELP_LINE}`;
  return STANDARD_STORE_HELP_LINE;
}

/**
 * Dynamic past-search list rule. When withStandardIntro is true, keep the catalog help line first, then continue-offer.
 */
export function buildPastSearchOfferInstruction(offers = [], options = {}) {
  const list = (Array.isArray(offers) ? offers : [])
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  if (!list.length) return null;

  const maxInReply = Math.max(1, Number(options.maxInReply) || 3);
  const confirmBeforeTools = options.confirmBeforeTools === true;
  const withStandardIntro = options.withStandardIntro === true;

  const listText = list.join("; ");

  let text = withStandardIntro
    ? `Include this standard help line in the customer-visible reply (you may adapt wording slightly but keep cabin filters, fresheners, and home filters — do not say vehicle fitment): "${STANDARD_STORE_HELP_LINE}" ` +
      `Then ask if they want to continue with any of these past searches (full set — only these): ${listText}. `
    : "Past searches this shopper may continue (this is the full set — treat it as authoritative): " +
      listText +
      ". ";

  text +=
    `When mentioning past searches, use only items from that list (at most ${maxInReply}) with the same specifics. ` +
    "Do not invent past searches beyond that list. " +
    "Do not paraphrase specifics into vague wording. " +
    "Ask which listed item they want to continue with, or confirm one before acting.";

  if (confirmBeforeTools) {
    text +=
      " After they choose, use the normal store tool for that kind of search; do not run tools for every listed item at once.";
  }

  return text;
}

export function buildWelcomeSearchMemoryLines(rows = []) {
  if (!Array.isArray(rows) || !rows.length) return [];
  return selectMemoriesForGreeting(rows, LIMIT_BY_CONTEXT.welcome).map(
    formatMemoryOfferPhrase
  );
}

const GREETING_MEMORY_MAX = 3;

/**
 * Up to 3 rows for greetings: prefer one per intent (cabin + home + freshener), then fill by recency.
 */
export function selectMemoriesForGreeting(rows = [], max = GREETING_MEMORY_MAX) {
  const list = Array.isArray(rows) ? rows : [];
  const cap = Math.max(1, Math.min(GREETING_MEMORY_MAX, Number(max) || GREETING_MEMORY_MAX));
  if (!list.length) return [];

  const picked = [];
  const seenIntent = new Set();

  for (const row of list) {
    if (picked.length >= cap) break;
    const intent = normalizeIntent(row.intent);
    if (!intent || seenIntent.has(intent)) continue;
    seenIntent.add(intent);
    picked.push(row);
  }

  for (const row of list) {
    if (picked.length >= cap) break;
    if (picked.some((p) => p.id === row.id)) continue;
    picked.push(row);
  }

  return picked.slice(0, cap);
}

export function getRecentSearchOffers(rows = []) {
  return selectMemoriesForGreeting(rows, GREETING_MEMORY_MAX)
    .map(formatMemoryOfferPhrase)
    .filter(Boolean);
}

/** @deprecated use getRecentSearchOffers */
export function getRecentSearchSnippet(rows = []) {
  const offers = getRecentSearchOffers(rows);
  return offers.length ? offers.join("; ") : null;
}

export async function recordSearchMemoryFromTool({
  shopperId,
  toolName,
  toolArgs = {},
  toolUseResponse
} = {}) {
  const id = String(shopperId || "").trim();
  if (!id || toolUseResponse?.error) return null;

  const data = parseToolPayload(toolUseResponse);
  if (!data || typeof data !== "object") return null;

  if (toolName === "get_fitment_next_step" || toolName === "find_fitment_products") {
    const products = Array.isArray(data.products) ? data.products : [];
    if (data.status !== "success" || !products.length) return null;
    const vehicle = vehicleFromPayload(data);
    if (!vehicle) return null;
    return recordShopperSearchMemory(id, {
      intent: SEARCH_INTENT.CABIN,
      vehicleYear: vehicle.year,
      vehicleMake: vehicle.make,
      vehicleModel: vehicle.model,
      vehicleEngine: vehicle.engine
    });
  }

  if (toolName === "search_store_products") {
    if (!data.success || !data.found) return null;
    const category = String(data.category || toolArgs.category || "").toLowerCase();
    const query = String(data.query || toolArgs.query || "");

    if (category === "home_filter" || category === "home") {
      const sizes = extractFilterSizes(query);
      const size = sizes[0] || normalizeText(query);
      if (!size) return null;
      return recordShopperSearchMemory(id, {
        intent: SEARCH_INTENT.HOME,
        homeFilterSize: size,
        homeMerv: extractMervFromText(query)
      });
    }

    if (category === "freshener" || category === "fresheners") {
      return recordShopperSearchMemory(id, {
        intent: SEARCH_INTENT.FRESHENER
      });
    }
  }

  return null;
}

export function memoriesToSuggestionPayload(rows = []) {
  const options = rows
    .map(buildSuggestionFromMemory)
    .filter(Boolean)
    .slice(0, 3)
    .map((item) => ({
      label: item.label,
      value: item.message
    }));
  if (!options.length) return null;
  return {
    title: "Continue from a recent search",
    options
  };
}
