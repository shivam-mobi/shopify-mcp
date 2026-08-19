import { MASTER_DATA_TABLES } from "../catalogTables.js";
import { getMasterDataPool, getVcdbPool, queryPool } from "../database.server.js";
import { resolveBaseVehicleIds } from "./modelRepository.js";
import { qualifierCheckInEngine } from "./qualifierRepository.js";

function sanitizeEngineIdList(engineId) {
  const ids = String(engineId)
    .split(",")
    .map((id) => id.trim())
    .filter((id) => /^\d+$/.test(id));
  return ids.length ? ids.join(",") : null;
}

async function fetchEnginesByBaseVehicleId(baseVehicleId) {
  const rows = await queryPool(
    getVcdbPool(),
    `SELECT
      GROUP_CONCAT(DISTINCT eb.EngineBaseID) AS EngineConfigID,
      CONCAT_WS(' ', CONCAT(NULLIF(TRIM(eb.Liter), '-'), 'L')) AS engine
     FROM basevehicle bv
     JOIN vehicle v ON bv.BaseVehicleID = v.BaseVehicleID
     JOIN vehicletoengineconfig vtec ON v.VehicleID = vtec.VehicleID
     JOIN engineconfig ec ON vtec.EngineConfigID = ec.EngineConfigID
     JOIN enginebase eb ON ec.EngineBaseID = eb.EngineBaseID
     WHERE bv.BaseVehicleID = ?
     GROUP BY engine
     ORDER BY engine`,
    [baseVehicleId]
  );

  return rows
    .map((row) => ({
      engine: String(row.engine ?? "").trim(),
      engineConfigId: String(row.EngineConfigID ?? "")
    }))
    .filter((row) => row.engine);
}

async function fetchPureflowPartNumbers(baseVehicleId, engineConfigId) {
  const ids = engineConfigId
    .split(",")
    .map((id) => Number(id.trim()))
    .filter((id) => Number.isFinite(id));

  if (!ids.length) return [];

  const placeholders = ids.map(() => "?").join(", ");
  const rows = await queryPool(
    getMasterDataPool(),
    `SELECT p.partNumber
     FROM ${MASTER_DATA_TABLES.partnumberinfo} p
     JOIN ${MASTER_DATA_TABLES.applications} a ON p.part_id = a.part_id
     WHERE a.BaseVehicleID = ?
       AND a.EngineBaseID IN (${placeholders})
       AND a.MfrLabel LIKE '%pureflow%'
     GROUP BY p.partNumber`,
    [baseVehicleId, ...ids]
  );

  return rows.map((row) => String(row.partNumber)).sort();
}

function samePartLists(lists) {
  if (!lists.length) return true;
  const sorted = lists.map((list) => [...list].sort());
  const first = sorted[0].join(",");
  return sorted.every((list) => list.join(",") === first);
}

async function shouldShowDropdown(baseVehicleId, rows) {
  if (rows.length <= 1) return false;

  const partLists = [];
  for (const row of rows) {
    partLists.push(await fetchPureflowPartNumbers(baseVehicleId, row.engineConfigId));
  }

  if (samePartLists(partLists)) {
    const qualifierResults = [];
    for (const row of rows) {
      qualifierResults.push(await qualifierCheckInEngine(baseVehicleId, row.engineConfigId));
    }
    return qualifierResults.some((result) => result === "true");
  }

  return true;
}

export async function fetchEngineCheck(year, makeName, modelName) {
  const ids = await resolveBaseVehicleIds(year, makeName, modelName);
  if (!ids.length) {
    return { engines: [], showDropdown: false };
  }

  const seen = new Set();
  const engines = [];
  let showDropdown = false;

  for (const id of ids) {
    const rows = await fetchEnginesByBaseVehicleId(id);
    if (await shouldShowDropdown(id, rows)) {
      showDropdown = true;
    }
    for (const row of rows) {
      if (!seen.has(row.engine)) {
        seen.add(row.engine);
        engines.push({ engine: row.engine });
      }
    }
  }

  engines.sort((a, b) => a.engine.localeCompare(b.engine));
  return { engines, showDropdown };
}

export async function resolveEngineSelection(year, makeName, modelName, engineName) {
  const ids = await resolveBaseVehicleIds(year, makeName, modelName);
  const needle = engineName.trim().toLowerCase();

  for (const id of ids) {
    const rows = await fetchEnginesByBaseVehicleId(id);
    const match =
      rows.find((row) => row.engine.toLowerCase() === needle) ??
      rows.find((row) => row.engine.toLowerCase().startsWith(needle)) ??
      rows.find((row) => row.engine.toLowerCase().includes(needle));

    if (match) {
      return {
        baseVehicleId: id,
        engineConfigId: match.engineConfigId,
        engine: match.engine
      };
    }
  }

  if (ids.length === 1) {
    const rows = await fetchEnginesByBaseVehicleId(ids[0]);
    if (rows[0]) {
      return {
        baseVehicleId: ids[0],
        engineConfigId: rows[0].engineConfigId,
        engine: rows[0].engine
      };
    }
  }

  return null;
}

export function matchEngineName(typed, engines) {
  const needle = typed.trim().toLowerCase();
  if (!needle) return null;

  return (
    engines.find((engine) => engine.engine.toLowerCase() === needle)?.engine ??
    engines.find((engine) => engine.engine.toLowerCase().startsWith(needle))?.engine ??
    engines.find((engine) => engine.engine.toLowerCase().includes(needle))?.engine ??
    null
  );
}

export { sanitizeEngineIdList };
