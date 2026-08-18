/**
 * Sync APP_URL from .env into theme extension and Shopify config files.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const envPath = path.join(root, ".env");

function loadEnv() {
  if (!fs.existsSync(envPath)) {
    throw new Error(".env file not found. Add APP_URL to .env first.");
  }

  const env = {};
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    env[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim();
  }
  return env;
}

function normalizeUrl(url) {
  return url.replace(/\/+$/, "");
}

function updateFile(filePath, updater) {
  if (!fs.existsSync(filePath)) return false;
  const original = fs.readFileSync(filePath, "utf8");
  const updated = updater(original);
  if (updated !== original) {
    fs.writeFileSync(filePath, updated);
    console.log(`Updated ${path.relative(root, filePath)}`);
  }
  return true;
}

const env = loadEnv();
const appUrl = normalizeUrl(env.APP_URL || "");

if (!appUrl) {
  throw new Error("APP_URL is missing in .env");
}

let url;
try {
  url = new URL(appUrl);
} catch {
  throw new Error(`APP_URL is not a valid URL: ${appUrl}`);
}

const appHost = url.hostname;
const redirectUrl = `${appUrl}/auth/callback`;
const authRedirectUrl = `${appUrl}/api/auth`;
const callbackRedirectUrl = `${appUrl}/callback`;

updateFile(path.join(root, "extensions/chat-bubble/blocks/chat-interface.liquid"), (content) =>
  content.replace(
    /apiUrl:\s*"[^"]*"/,
    `apiUrl: ${JSON.stringify(appUrl)}`
  )
);

for (const file of fs.readdirSync(root)) {
  if (!file.startsWith("shopify.app") || !file.endsWith(".toml")) continue;

  updateFile(path.join(root, file), (content) =>
    content
      .replace(/application_url\s*=\s*"[^"]*"/, `application_url = "${appUrl}"`)
      .replace(
        /redirect_urls\s*=\s*\[\s*"[^"]*"\s*\]/,
        `redirect_urls = [ "${authRedirectUrl}" ]`
      )
      .replace(
        /redirect_uris\s*=\s*\[\s*\n\s*"[^"]*"\s*\n\s*\]/,
        `redirect_uris = [\n  "${callbackRedirectUrl}"\n]`
      )
  );
}

let envContent = fs.readFileSync(envPath, "utf8");
const envLines = envContent.split("\n");
const keysToSet = {
  APP_URL: appUrl,
  SHOPIFY_APP_URL: appUrl,
  REDIRECT_URL: redirectUrl
};

const seen = new Set();
const nextLines = envLines.map((line) => {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return line;

  const index = trimmed.indexOf("=");
  if (index === -1) return line;

  const key = trimmed.slice(0, index).trim();
  if (!(key in keysToSet)) return line;

  seen.add(key);
  return `${key}=${keysToSet[key]}`;
});

for (const [key, value] of Object.entries(keysToSet)) {
  if (!seen.has(key)) {
    nextLines.push(`${key}=${value}`);
  }
}

fs.writeFileSync(envPath, `${nextLines.join("\n").replace(/\n?$/, "\n")}`);

console.log(`APP_URL synced: ${appUrl}`);
console.log(`Allowed host: ${appHost}`);
console.log(`Redirect URL: ${redirectUrl}`);
