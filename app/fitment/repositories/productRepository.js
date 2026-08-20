import { MASTER_DATA_TABLES, SHOPIFY_TABLES } from "../catalogTables.js";
import {
  BRAND_IDS_PUREFLOW_AND_FEBREZE,
  PART_TERMINOLOGY_CABIN_AIR_FILTER,
  PG_IMAGE_ASSET_BASE_URL
} from "../constants.js";
import { QUALIFIER_COLUMNS } from "../qualifierConfig.js";
import { getMasterDataPool, getShopifySyncPool, queryPool } from "../database.server.js";
import { sanitizeEngineIdList } from "./engineRepository.js";

function buildProductQualifierWhere(selectedQualifiers = []) {
  const clauses = [];

  for (const item of selectedQualifiers) {
    if (!item || item === "noqualifier") continue;
    const [type, id] = item.split(":");
    if (!type || !id || !QUALIFIER_COLUMNS.includes(type) || !/^\d+$/.test(id)) {
      continue;
    }
    clauses.push(` AND (a.${type}=${id} OR a.${type} IS NULL)`);
  }

  return clauses.join("");
}

function firstImage(raw) {
  if (!raw) return "";
  const trimmed = String(raw).trim();
  if (!trimmed) return "";

  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed) && parsed.length) {
        const first = parsed[0];
        if (typeof first === "string") return first;
        if (first && typeof first === "object" && first.src) {
          return String(first.src);
        }
      }
    } catch {
      // fall through
    }
  }

  return trimmed.split(",")[0]?.trim() ?? "";
}

function buildPartImageUrl(fileName) {
  const name = String(fileName).trim();
  if (!name) return "";
  if (name.startsWith("http://") || name.startsWith("https://")) return name;
  return `${PG_IMAGE_ASSET_BASE_URL}${name.replace(/^\//, "")}`;
}

async function fetchCatalogPartNumbers(baseVehicleId, engineId, qualifierWhere) {
  const brandList = BRAND_IDS_PUREFLOW_AND_FEBREZE.map((id) => `'${id}'`).join(", ");

  const rows = await queryPool(
    getMasterDataPool(),
    `SELECT
      p.partNumber,
      GROUP_CONCAT(DISTINCT a.note SEPARATOR '; ') AS note_merged
     FROM ${MASTER_DATA_TABLES.partnumberinfo} p
     JOIN ${MASTER_DATA_TABLES.applications} a ON p.part_id = a.part_id
     WHERE a.BaseVehicleID = ?
       AND a.EngineBaseID IN (${engineId})
       ${qualifierWhere}
       AND p.BrandID IN (${brandList})
       AND p.PartTerminologyID = ?
     GROUP BY p.partNumber`,
    [baseVehicleId, PART_TERMINOLOGY_CABIN_AIR_FILTER]
  );

  return rows
    .map((row) => ({
      partNumber: String(row.partNumber ?? "").trim(),
      note_merged: String(row.note_merged ?? "").trim()
    }))
    .filter((row) => row.partNumber);
}

async function fetchPartImageMap(skus) {
  const safeSkus = skus
    .map((sku) => sku.trim())
    .filter((sku) => /^[A-Za-z0-9._-]+$/.test(sku));

  if (!safeSkus.length) return new Map();

  const inList = safeSkus.map((sku) => `'${sku.replace(/'/g, "''")}'`).join(",");
  const rows = await queryPool(
    getMasterDataPool(),
    `SELECT p.partNumber, im.fileName
     FROM ${MASTER_DATA_TABLES.partnumberinfo} p
     JOIN ${MASTER_DATA_TABLES.imageMapper} im ON im.part_id = p.part_id
     WHERE p.partNumber IN (${inList})
     ORDER BY p.partNumber,
       CASE WHEN im.AssetType = 'p04' THEN 1 ELSE 0 END ASC,
       im.AssetType DESC,
       SUBSTRING(im.fileName, INSTR(im.fileName, '-') + 1, 1)`
  );

  const map = new Map();
  for (const row of rows) {
    const sku = String(row.partNumber ?? "").trim();
    const fileName = String(row.fileName ?? "").trim();
    if (!sku || !fileName || map.has(sku)) continue;
    map.set(sku, buildPartImageUrl(fileName));
  }

  return map;
}

/**
 * Match catalog part numbers to shopify_products_new (same as pureflow-chatbot2).
 * variant_id from this table is what cart/MCP uses.
 */
async function fetchShopifyProducts(skus, vehicle = {}) {
  if (!skus.length) return [];

  const year = vehicle?.year ? Number(vehicle.year) : null;
  const make = vehicle?.make ?? "";
  const model = vehicle?.model ?? "";

  const placeholders = skus.map(() => "?").join(", ");
  const rows = await queryPool(
    getShopifySyncPool(),
    `SELECT
      product_sku AS sku,
      product_title,
      product_price,
      images,
      handle,
      brand,
      variant_id
     FROM ${SHOPIFY_TABLES.shopifyProductsNew}
     WHERE product_sku IN (${placeholders})
       AND (deleted IS NULL OR deleted = 0)
     ORDER BY
       CASE WHEN ? != '' AND make = ? THEN 0 ELSE 1 END,
       CASE WHEN ? != '' AND model = ? THEN 0 ELSE 1 END,
       CASE WHEN ? IS NOT NULL AND year = ? THEN 0 ELSE 1 END`,
    [...skus, make, make, model, model, year, year]
  );

  return rows.map((row) => ({
    sku: String(row.sku ?? "").trim(),
    product_title: row.product_title ? String(row.product_title) : "",
    product_price: row.product_price != null ? String(row.product_price) : "",
    images: row.images ? String(row.images) : "",
    handle: row.handle ? String(row.handle) : "",
    brand: row.brand ? String(row.brand) : "",
    variant_id:
      row.variant_id !== undefined && row.variant_id !== null
        ? row.variant_id
        : undefined
  }));
}

/**
 * Catalog applications → part numbers, then keep only SKUs in shopify_products_new
 * (with variant_id). Matches pureflow-chatbot2 ProductListController::productlist.
 */
export async function fetchProductList(
  baseVehicleId,
  engineId,
  selectedQualifiers = [],
  vehicle = {},
  _shop = null
) {
  const safeEngineId = sanitizeEngineIdList(engineId);
  if (!safeEngineId) return [];

  const qualifierWhere = buildProductQualifierWhere(selectedQualifiers);
  const catalogParts = await fetchCatalogPartNumbers(baseVehicleId, safeEngineId, qualifierWhere);
  if (!catalogParts.length) return [];

  const shopifyRows = await fetchShopifyProducts(
    catalogParts.map((part) => part.partNumber),
    vehicle
  );
  const partImages = await fetchPartImageMap(catalogParts.map((part) => part.partNumber));
  const notes = new Map(catalogParts.map((part) => [part.partNumber, part.note_merged ?? ""]));

  const seen = new Set();
  const products = [];

  for (const row of shopifyRows) {
    if (!row.sku || seen.has(row.sku)) continue;
    seen.add(row.sku);

    products.push({
      partNumber: row.sku,
      title: row.product_title || row.brand || row.sku,
      note: notes.get(row.sku) ?? "",
      image_url: partImages.get(row.sku) || firstImage(row.images),
      price: row.product_price ? `$${row.product_price}` : "",
      handle: row.handle ?? "",
      variantId:
        row.variant_id !== undefined && row.variant_id !== null
          ? String(row.variant_id)
          : "",
      url: row.handle ? `/products/${row.handle}` : ""
    });
  }

  return products;
}
