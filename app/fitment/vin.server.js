/**
 * VIN decode via S&P Global Vintelligence — same flow as
 * premium-guard-app DynamicController::vinsearchMobikasa.
 */

const VIN_PATTERN = /\b[A-HJ-NPR-Z0-9]{17}\b/;

export function extractVin(value) {
  if (!value) return null;
  const text = String(value).toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
  const match = text.match(VIN_PATTERN);
  return match ? match[0] : null;
}

function fieldValue(fields, matcher) {
  for (const field of fields) {
    const name = String(field?.name ?? "");
    if (matcher(name)) {
      return String(field?.value ?? "").trim();
    }
  }
  return "";
}

function parseVinFields(fields = []) {
  const baseVehicleId = fieldValue(fields, (name) => name.includes("ACES_BASE_VEHICLE"));
  const engineBaseId = fieldValue(fields, (name) => name.includes("ACES_ENGINE_BASE_ID"));
  const year = fieldValue(fields, (name) => /ACES_YEAR_ID/.test(name));
  const make = fieldValue(fields, (name) => /ACES_MAKE_NAME/.test(name));
  const model = fieldValue(fields, (name) => /ACES_MODEL_NAME/.test(name));
  const liters = fieldValue(fields, (name) => /ACES_LITERS/.test(name));
  const engine = liters ? `${liters.replace(/L$/i, "")}L` : "";

  if (!baseVehicleId || !engineBaseId || !year || !make || !model) {
    return null;
  }

  return {
    vin: null,
    baseVehicleId,
    engineBaseId,
    year,
    make,
    model,
    engine
  };
}

async function fetchAccessToken(baseUrl, username, password) {
  const response = await fetch(`${baseUrl}/okta`, {
    method: "POST",
    headers: {
      username,
      password
    }
  });

  if (!response.ok) {
    throw new Error(`VIN auth failed: HTTP ${response.status}`);
  }

  const data = await response.json();
  return String(data?.access_token ?? "").trim();
}

/**
 * Decode a VIN into ACES year/make/model/engine + baseVehicleId/engineBaseId.
 * Returns null when the VIN is invalid or the API has no match.
 */
export async function decodeVin(rawVin) {
  const vin = extractVin(rawVin);
  if (!vin) return null;

  const baseUrl = (process.env.VIN_API_URL || "https://vintelligence.spglobal.com").replace(/\/+$/, "");
  const username = process.env.VIN_API_USERNAME || "";
  const password = process.env.VIN_API_PASSWORD || "";

  if (!username || !password) {
    console.error("[fitment:vin] VIN_API_USERNAME / VIN_API_PASSWORD not configured");
    return null;
  }

  console.log("[fitment:vin] decode start", { vin });

  try {
    const accessToken = await fetchAccessToken(baseUrl, username, password);
    if (!accessToken) {
      console.warn("[fitment:vin] empty access token");
      return null;
    }

    const decodeResponse = await fetch(`${baseUrl}/vintelligence/decodeVin`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        accesstoken: accessToken
      },
      body: JSON.stringify({
        requiredFieldsCSVs: "",
        vinRequests: [
          { make: "", trim: "", vin, year: "" }
        ]
      })
    });

    if (!decodeResponse.ok) {
      console.error("[fitment:vin] decode HTTP", decodeResponse.status);
      return null;
    }

    const vinData = await decodeResponse.json();
    const result = Array.isArray(vinData) ? vinData[0] : null;

    if (!result || String(result.returnCode) !== "0" || !Array.isArray(result.fields)) {
      console.warn("[fitment:vin] no match", { vin, returnCode: result?.returnCode });
      return null;
    }

    const parsed = parseVinFields(result.fields);
    if (!parsed) {
      console.warn("[fitment:vin] missing ACES fields", { vin });
      return null;
    }

    parsed.vin = vin;
    console.log("[fitment:vin] decode ok", parsed);
    return parsed;
  } catch (error) {
    console.error("[fitment:vin] decode error", error.message);
    return null;
  }
}
