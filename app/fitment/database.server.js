import mysql from "mysql2/promise";

let vcdbPool;
let masterDataPool;
let shopifyPool;

function createPool(config) {
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
  const [rows] = await pool.execute(sql, params);
  return rows;
}
