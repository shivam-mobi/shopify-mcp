import { MASTER_DATA_TABLES, SHOPIFY_TABLES } from "../catalogTables.js";
import {
  BRAND_IDS_PUREFLOW_AND_FEBREZE,
  PART_TERMINOLOGY_CABIN_AIR_FILTER
} from "../constants.js";
import { QUALIFIER_COLUMNS } from "../qualifierConfig.js";
import { getMasterDataPool, getShopifySyncPool, queryPool } from "../database.server.js";
import {
  fetchShopifyVariantsByIds,
  toVariantGid
} from "../../services/shopify-products.server.js";
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

/**
 * Resolve catalog SKUs → variant_id from shopify_products_new
 * matched on product_sku + year/make/model.
 * Title, price, and image are loaded from Shopify Admin API.
 */
async function fetchVariantIdsBySkus(skus, vehicle = {}) {
  if (!skus.length) return [];

  const year = vehicle?.year ? Number(vehicle.year) : null;
  const make = vehicle?.make ?? "";
  const model = vehicle?.model ?? "";

  const placeholders = skus.map(() => "?").join(", ");
  const rows = await queryPool(
    getShopifySyncPool(),
    `SELECT
      product_sku AS sku,
      variant_id
     FROM ${SHOPIFY_TABLES.shopifyProductsNew}
     WHERE product_sku IN (${placeholders})
       AND make = ?
       AND model = ?
       AND year = ?
       AND variant_id IS NOT NULL
       AND variant_id != ''
       AND variant_id != '0'`,
    [...skus, make, model, year]
  );

  return rows
    .map((row) => ({
      sku: String(row.sku ?? "").trim(),
      variant_id: row.variant_id
    }))
    .filter((row) => row.sku && toVariantGid(row.variant_id));
}

/**
 * Catalog applications → part numbers → MySQL variant_id → Shopify title/price/image.
 */
export async function fetchProductList(
  baseVehicleId,
  engineId,
  selectedQualifiers = [],
  vehicle = {},
  shop = null,
  conversationId = null
) {
  const safeEngineId = sanitizeEngineIdList(engineId);
  if (!safeEngineId) return [];

  const qualifierWhere = buildProductQualifierWhere(selectedQualifiers);
  const catalogParts = await fetchCatalogPartNumbers(baseVehicleId, safeEngineId, qualifierWhere);
  if (!catalogParts.length) return [];

  const variantRows = await fetchVariantIdsBySkus(
    catalogParts.map((part) => part.partNumber),
    vehicle
  );

  console.log("[fitment] MySQL part numbers:", catalogParts.map((p) => p.partNumber));
  console.log("[fitment] MySQL variant_id rows (before Shopify):", variantRows);

  if (!variantRows.length) {
    console.warn("[fitment] No variant_id found in shopify_products_new — skipping Shopify call");
    return [];
  }

  const notes = new Map(catalogParts.map((part) => [part.partNumber, part.note_merged ?? ""]));
  console.log(
    "[fitment] Calling Shopify with variant_ids:",
    variantRows.map((row) => row.variant_id)
  );
  const shopifyById = await fetchShopifyVariantsByIds(
    shop,
    variantRows.map((row) => row.variant_id),
    conversationId
  );

  const seen = new Set();
  const products = [];

  for (const row of variantRows) {
    if (!row.sku || seen.has(row.sku)) continue;
    seen.add(row.sku);

    const gid = toVariantGid(row.variant_id);
    const live =
      shopifyById.get(gid) ||
      shopifyById.get(String(row.variant_id).trim()) ||
      null;

    if (!live) {
      console.warn(
        `Shopify variant not resolved for sku=${row.sku} variant_id=${row.variant_id} shop=${shop}`
      );
      continue;
    }

    products.push({
      partNumber: row.sku,
      title: live.title || row.sku,
      note: notes.get(row.sku) ?? "",
      image_url: live.image_url || "",
      price: live.price || "",
      priceAmount: live.priceAmount ?? null,
      compareAtPrice: live.compareAtPrice || null,
      handle: live.handle ?? "",
      variantId: live.variantId || gid,
      url: live.url || "",
      availableForSale: live.availableForSale === true,
      inStock: live.inStock === true,
      inventoryQuantity:
        typeof live.inventoryQuantity === "number" ? live.inventoryQuantity : null,
      vendor: live.vendor || "",
      sku: live.sku || row.sku,
      filterType: live.filterType || "standard",
      isHepa: live.isHepa === true,
      hasAntibacterial: live.hasAntibacterial === true,
      hasCharcoal: live.hasCharcoal === true,
      hasParticulate: live.hasParticulate === true,
      yGroup: live.yGroup || "",
      features: Array.isArray(live.features) ? live.features : [],
      tags: Array.isArray(live.tags) ? live.tags : [],
      descriptionHtml: live.descriptionHtml || "",
      pdfTitle: live.pdfTitle || null,
      pdfUrl: live.pdfUrl || null,
      youtubeUrl: live.youtubeUrl || null
    });
  }

  if (variantRows.length > 0 && products.length === 0) {
    throw new Error(
      `Failed to load Shopify product details for ${variantRows.length} fitment variant(s)`
    );
  }

  return products;
}
