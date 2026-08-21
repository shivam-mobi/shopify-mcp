import mysql from "mysql2/promise";

let vcdbPool;
let masterDataPool;
let shopifyPool;

function createPool(config) {
  console.log("[fitment:db] createPool", {
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user
  });
  return mysql.createPool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    waitForConnections: true,
    connectionLimit: 10
  });
}

export function isFitmentConfigured() {
  return Boolean(
    process.env.FITMENT_ENABLED === "true" &&
    process.env.DB_HOST_1 &&
    process.env.DB_HOST_2 &&
    process.env.DB_HOST_3
  );
}

export function getVcdbPool() {
  if (!vcdbPool) {
    console.log("[fitment:db] init VCDB pool (DB_HOST_1)");
    vcdbPool = createPool({
      host: process.env.DB_HOST_1 || "localhost",
      port: Number(process.env.DB_PORT_1 || 3306),
      database: process.env.DB_DATABASE_1 || "pureflownew_master_vcdb_dev",
      user: process.env.DB_USERNAME_1 || "root",
      password: process.env.DB_PASSWORD_1 || ""
    });
  }
  return vcdbPool;
}

export function getMasterDataPool() {
  if (!masterDataPool) {
    console.log("[fitment:db] init master-data pool (DB_HOST_3)");
    masterDataPool = createPool({
      host: process.env.DB_HOST_3 || "localhost",
      port: Number(process.env.DB_PORT_3 || 3306),
      database: process.env.DB_DATABASE_3 || "pureflownew_master_data_dev",
      user: process.env.DB_USERNAME_3 || "root",
      password: process.env.DB_PASSWORD_3 || ""
    });
  }
  return masterDataPool;
}

export function getShopifySyncPool() {
  if (!shopifyPool) {
    console.log("[fitment:db] init shopify-sync pool (DB_HOST_2)");
    shopifyPool = createPool({
      host: process.env.DB_HOST_2 || "localhost",
      port: Number(process.env.DB_PORT_2 || 3306),
      database: process.env.DB_DATABASE_2 || "pureflownew_shopify_dev",
      user: process.env.DB_USERNAME_2 || "root",
      password: process.env.DB_PASSWORD_2 || ""
    });
  }
  return shopifyPool;
}

export async function queryPool(pool, sql, params = []) {
  const started = Date.now();
  const sqlPreview = String(sql).replace(/\s+/g, " ").trim().slice(0, 120);
  console.log("[fitment:db] query start", {
    sqlPreview,
    params,
    elapsedMsHint: "pending"
  });
  try {
    const [rows] = await pool.execute(sql, params);
    console.log("[fitment:db] query ok", {
      sqlPreview,
      rowCount: Array.isArray(rows) ? rows.length : null,
      ms: Date.now() - started
    });
    return rows;
  } catch (error) {
    console.error("[fitment:db] query FAIL", {
      sqlPreview,
      params,
      ms: Date.now() - started,
      code: error.code,
      errno: error.errno,
      message: error.message,
      address: error.address,
      port: error.port,
      syscall: error.syscall,
      fatal: error.fatal
    });
    throw error;
  }
}
