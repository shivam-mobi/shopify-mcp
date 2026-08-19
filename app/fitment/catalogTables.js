/**
 * Verified MySQL table names per database (from SHOW TABLES on dev RDS).
 * Use these in raw SQL — do not guess casing (Linux MySQL is case-sensitive).
 */

/** DB 1 — pureflownew_master_vcdb_dev (VCDB / ACES) */
export const VCDB_TABLES = {
  basevehicle: "basevehicle",
  make: "make",
  model: "model",
  vehicletype: "vehicletype",
  vehicle: "vehicle",
  vehicletoengineconfig: "vehicletoengineconfig",
  engineconfig: "engineconfig",
  enginebase: "enginebase",
};

/** DB 2 — pureflownew_shopify_dev */
export const SHOPIFY_TABLES = {
  yearsLookup: "years_lookup",
  shopifyProductsNew: "shopify_products_new",
};

/** DB 3 — pureflownew_master_data_dev (applications, parts) */
export const MASTER_DATA_TABLES = {
  partnumberinfo: "partnumberinfo",
  applications: "applications",
  imageMapper: "image_mapper",
  fueltypeWebDisplayMappings: "fueltype_web_display_mappings",
};

/** DB 4 — pureflownew_chat_dev (Drizzle schema in src/db/schema.ts) */
export const CHAT_TABLES = {
  chatSessions: "chat_sessions",
  chatMessages: "chat_messages",
  llmCallLogs: "llm_call_logs",
  apiLogs: "api_logs",
};
