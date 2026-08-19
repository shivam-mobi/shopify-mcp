import { VEHICLE_TYPE_GROUP_ID } from "../constants.js";
import { getVcdbPool, queryPool } from "../database.server.js";

export async function fetchYears() {
  return queryPool(
    getVcdbPool(),
    `SELECT basevehicle.YearID AS year
     FROM basevehicle
     INNER JOIN model ON basevehicle.ModelID = model.ModelID
     INNER JOIN vehicletype ON model.VehicleTypeID = vehicletype.VehicleTypeID
     WHERE vehicletype.VehicleTypeGroupID = ?
     GROUP BY basevehicle.YearID
     ORDER BY basevehicle.YearID DESC`,
    [VEHICLE_TYPE_GROUP_ID]
  );
}

export function matchYear(typed, years) {
  const needle = String(typed ?? "").trim();
  if (!needle) return null;

  const exact = years.find((row) => String(row.year) === needle);
  return exact ? String(exact.year) : null;
}
