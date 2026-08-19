import { VEHICLE_TYPE_GROUP_ID } from "../constants.js";
import { getVcdbPool, queryPool } from "../database.server.js";

export async function fetchModels(year, makeName) {
  const makeId = await resolveMakeId(year, makeName);
  if (makeId == null) return [];

  const rows = await queryPool(
    getVcdbPool(),
    `SELECT model.ModelName AS model, basevehicle.BaseVehicleID AS baseVehicleId
     FROM basevehicle
     JOIN model ON basevehicle.ModelID = model.ModelID
     JOIN vehicletype ON model.VehicleTypeID = vehicletype.VehicleTypeID
     WHERE vehicletype.VehicleTypeGroupID = ?
       AND basevehicle.YearID = ?
       AND basevehicle.MakeID = ?
     GROUP BY model.ModelName, basevehicle.BaseVehicleID
     ORDER BY model.ModelName ASC`,
    [VEHICLE_TYPE_GROUP_ID, Number(year), makeId]
  );

  const seen = new Set();
  const models = [];
  for (const row of rows) {
    if (!seen.has(row.model)) {
      seen.add(row.model);
      models.push({ model: row.model });
    }
  }
  return models;
}

export function matchModelName(typed, models) {
  const needle = String(typed ?? "").trim().toLowerCase();
  if (!needle) return null;

  const exact = models.find((row) => row.model.toLowerCase() === needle);
  if (exact) return exact.model;

  const startsWith = models.find((row) => row.model.toLowerCase().startsWith(needle));
  if (startsWith) return startsWith.model;

  return null;
}

export async function resolveMakeId(year, makeName) {
  const rows = await queryPool(
    getVcdbPool(),
    `SELECT make.MakeID AS makeId
     FROM basevehicle
     JOIN make ON basevehicle.MakeID = make.MakeID
     JOIN model ON basevehicle.ModelID = model.ModelID
     JOIN vehicletype ON model.VehicleTypeID = vehicletype.VehicleTypeID
     WHERE vehicletype.VehicleTypeGroupID = ?
       AND basevehicle.YearID = ?
       AND make.MakeName = ?
     GROUP BY make.MakeID
     LIMIT 1`,
    [VEHICLE_TYPE_GROUP_ID, Number(year), makeName]
  );

  return rows[0]?.makeId ?? null;
}

export async function resolveBaseVehicleIds(year, makeName, modelName) {
  const makeId = await resolveMakeId(year, makeName);
  if (makeId == null) return [];

  const rows = await queryPool(
    getVcdbPool(),
    `SELECT basevehicle.BaseVehicleID AS baseVehicleId
     FROM basevehicle
     JOIN model ON basevehicle.ModelID = model.ModelID
     JOIN vehicletype ON model.VehicleTypeID = vehicletype.VehicleTypeID
     WHERE vehicletype.VehicleTypeGroupID = ?
       AND basevehicle.YearID = ?
       AND basevehicle.MakeID = ?
       AND model.ModelName = ?
     GROUP BY basevehicle.BaseVehicleID`,
    [VEHICLE_TYPE_GROUP_ID, Number(year), makeId, modelName]
  );

  return rows.map((row) => Number(row.baseVehicleId));
}
