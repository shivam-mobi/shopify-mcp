import { VEHICLE_TYPE_GROUP_ID } from "../constants.js";
import { getVcdbPool, queryPool } from "../database.server.js";

export async function fetchMakes(year) {
  return queryPool(
    getVcdbPool(),
    `SELECT make.MakeName AS make
     FROM basevehicle
     JOIN make ON basevehicle.MakeID = make.MakeID
     JOIN model ON basevehicle.ModelID = model.ModelID
     JOIN vehicletype ON model.VehicleTypeID = vehicletype.VehicleTypeID
     WHERE vehicletype.VehicleTypeGroupID = ?
       AND basevehicle.YearID = ?
     GROUP BY make.MakeID, make.MakeName
     ORDER BY make.MakeName ASC`,
    [VEHICLE_TYPE_GROUP_ID, Number(year)]
  );
}

export async function fetchYearsForMake(makeName) {
  const needle = String(makeName ?? "").trim();
  if (!needle) return [];

  return queryPool(
    getVcdbPool(),
    `SELECT DISTINCT basevehicle.YearID AS year
     FROM basevehicle
     JOIN make ON basevehicle.MakeID = make.MakeID
     JOIN model ON basevehicle.ModelID = model.ModelID
     JOIN vehicletype ON model.VehicleTypeID = vehicletype.VehicleTypeID
     WHERE vehicletype.VehicleTypeGroupID = ?
       AND (LOWER(make.MakeName) = LOWER(?) OR LOWER(make.MakeName) LIKE LOWER(?))
     ORDER BY basevehicle.YearID DESC`,
    [VEHICLE_TYPE_GROUP_ID, needle, `%${needle}%`]
  );
}

export async function searchMakeNames(partial) {
  const needle = String(partial ?? "").trim();
  if (!needle) return [];

  return queryPool(
    getVcdbPool(),
    `SELECT DISTINCT make.MakeName AS make
     FROM basevehicle
     JOIN make ON basevehicle.MakeID = make.MakeID
     JOIN model ON basevehicle.ModelID = model.ModelID
     JOIN vehicletype ON model.VehicleTypeID = vehicletype.VehicleTypeID
     WHERE vehicletype.VehicleTypeGroupID = ?
       AND LOWER(make.MakeName) LIKE LOWER(?)
     ORDER BY make.MakeName ASC
     LIMIT 30`,
    [VEHICLE_TYPE_GROUP_ID, `%${needle}%`]
  );
}

export function matchMakeName(typed, makes) {
  const needle = String(typed ?? "").trim().toLowerCase();
  if (!needle) return null;

  const exact = makes.find((row) => row.make.toLowerCase() === needle);
  if (exact) return exact.make;

  if (needle.length >= 2) {
    const startsWith = makes.find((row) => row.make.toLowerCase().startsWith(needle));
    if (startsWith) return startsWith.make;
  }

  return null;
}
