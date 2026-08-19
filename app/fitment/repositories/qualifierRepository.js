import { MASTER_DATA_TABLES } from "../catalogTables.js";
import {
  DATA_QUALIFIERS_SELECT,
  QUALIFIER_MAIN_TABLE,
  VEHICLE_DEFINITION,
  VCDB_SELECTS_PER_QUALIFIER,
  VCDB_TABLE_JOINS,
  VCDB_TABLES_PER_QUALIFIER
} from "../qualifierConfig.js";
import { getMasterDataPool, getVcdbPool, queryPool } from "../database.server.js";

function sanitizeEngineIdList(engineId) {
  const ids = String(engineId)
    .split(",")
    .map((id) => id.trim())
    .filter((id) => /^\d+$/.test(id));
  return ids.length ? ids.join(",") : null;
}

function areArraysIdentical(arrays) {
  if (!arrays.length) return true;
  const sorted = arrays.map((array) => [...array].sort());
  const first = sorted[0].join(",");
  return sorted.every((array) => array.join(",") === first);
}

function selectedTypes(selected) {
  const types = new Set();
  for (const item of selected) {
    if (!item || item === "noqualifier") continue;
    const type = item.split(":")[0];
    if (type) types.add(type);
  }
  return types;
}

function buildQualifierWhere(selected) {
  const clauses = [];
  for (const item of selected) {
    if (!item || item === "noqualifier") continue;
    const [type, id] = item.split(":");
    const column = QUALIFIER_MAIN_TABLE[type ?? ""];
    if (!column || !id || !/^\d+$/.test(id)) continue;
    clauses.push(` AND ${column}=${id}`);
  }
  return clauses.join("");
}

async function fetchPartNumbersForQualifier(baseVehicleId, engineId, qualifierType, qualifierId) {
  if (!/^[A-Za-z0-9_]+$/.test(qualifierType)) return [];

  const rows = await queryPool(
    getMasterDataPool(),
    `SELECT p.partNumber
     FROM ${MASTER_DATA_TABLES.partnumberinfo} p
     LEFT JOIN ${MASTER_DATA_TABLES.applications} a ON p.part_id = a.part_id
     WHERE a.BaseVehicleID = ?
       AND a.EngineBaseID IN (${engineId})
       AND (a.${qualifierType} = ? OR a.${qualifierType} IS NULL)
       AND a.MfrLabel LIKE '%pureflow%'
     GROUP BY p.partNumber`,
    [baseVehicleId, qualifierId]
  );

  return rows.map((row) => String(row.partNumber)).sort();
}

async function fetchVcdbQualifierRow(baseVehicleId, engineId, extraWhere = "") {
  const dataSql = `
    ${DATA_QUALIFIERS_SELECT}
    FROM ${MASTER_DATA_TABLES.applications} a
    JOIN ${MASTER_DATA_TABLES.partnumberinfo} pi ON a.part_id = pi.part_id
    WHERE a.BaseVehicleID = ${baseVehicleId}
      AND a.EngineBaseID IN (${engineId})
      AND a.MfrLabel LIKE '%pureflow%'
  `;

  const dataRows = await queryPool(getMasterDataPool(), dataSql);
  const row = dataRows[0];
  if (!row?.data_json) return null;

  let dataJson;
  try {
    dataJson = JSON.parse(row.data_json);
  } catch {
    return null;
  }

  const vcdbTables = [];
  const vcdbSelects = [];

  for (const [qualifierType, qualifierIds] of Object.entries(dataJson)) {
    if (qualifierType === "PositionID") continue;

    const ids = qualifierIds ?? [];
    const nonZero = ids.filter((id) => id !== 0);

    if (nonZero.length >= 1 || ids[0] !== 0) {
      if (VEHICLE_DEFINITION[qualifierType]) {
        vcdbTables.push(...(VCDB_TABLES_PER_QUALIFIER[qualifierType] ?? []));
        const originalSelect = VCDB_SELECTS_PER_QUALIFIER[qualifierType];
        if (!originalSelect) continue;

        const condition = ids[0] === 0 ? "!= -1000" : `IN(${ids.join(",")})`;
        vcdbSelects.push(originalSelect.replace("[CONDITION]", condition));
      }
    }
  }

  if (!vcdbSelects.length) return null;

  vcdbTables.push("vehicletoengineconfig", "engineconfig");
  const uniqueTables = [...new Set(vcdbTables)];

  let vcdbQuery = `SELECT ${vcdbSelects.join(", ")} FROM vehicle`;
  for (const table of uniqueTables) {
    const join = VCDB_TABLE_JOINS[table];
    if (join) vcdbQuery += ` ${join}`;
  }
  vcdbQuery += ` WHERE vehicle.BaseVehicleID = ${baseVehicleId} AND engineconfig.EngineBaseID IN (${engineId})${extraWhere}`;

  const vcdbRows = await queryPool(getVcdbPool(), vcdbQuery);
  return vcdbRows[0] ?? null;
}

export async function qualifierCheckInEngine(baseVehicleId, engineId) {
  const safeEngineId = sanitizeEngineIdList(engineId);
  if (!safeEngineId) return "fail";

  const vcdbRow = await fetchVcdbQualifierRow(baseVehicleId, safeEngineId);
  if (!vcdbRow) return "fail";

  let show = "true";

  for (const [qualifierType, qualifierTypeJson] of Object.entries(vcdbRow)) {
    if (!qualifierTypeJson) continue;

    let qualifierTypeJsonArray;
    try {
      qualifierTypeJsonArray = JSON.parse(qualifierTypeJson);
    } catch {
      continue;
    }

    const qualCount = Object.keys(qualifierTypeJsonArray).length;

    if (qualCount > 1) {
      const partResults = [];
      for (const qualifierId of Object.keys(qualifierTypeJsonArray)) {
        partResults.push(
          await fetchPartNumbersForQualifier(
            baseVehicleId,
            safeEngineId,
            qualifierType,
            Number(qualifierId)
          )
        );
      }
      show = areArraysIdentical(partResults) ? "false" : "true";
    } else {
      show = "false";
    }

    if (show === "false") break;
  }

  return show;
}

export async function fetchQualifierCollection(
  baseVehicleId,
  engineId,
  selectedQualifiers = []
) {
  const empty = { showDropdown: false, name: "", values: [] };
  const safeEngineId = sanitizeEngineIdList(engineId);
  if (!safeEngineId) return empty;

  const extraWhere = buildQualifierWhere(selectedQualifiers);
  const vcdbRow = await fetchVcdbQualifierRow(baseVehicleId, safeEngineId, extraWhere);
  if (!vcdbRow) return empty;

  const alreadySelected = selectedTypes(selectedQualifiers);

  for (const [qualifierType, qualifierTypeJson] of Object.entries(vcdbRow)) {
    if (!qualifierTypeJson || alreadySelected.has(qualifierType)) continue;

    let qualifierTypeJsonArray;
    try {
      qualifierTypeJsonArray = JSON.parse(qualifierTypeJson);
    } catch {
      continue;
    }

    const qualifierName = String(VEHICLE_DEFINITION[qualifierType] ?? qualifierType);
    const values = [];
    const partResults = [];

    for (const [qualifierId, detail] of Object.entries(qualifierTypeJsonArray)) {
      values.push({
        id: `${qualifierType}:${qualifierId}`,
        value: String(detail?.Value ?? qualifierId)
      });
      partResults.push(
        await fetchPartNumbersForQualifier(
          baseVehicleId,
          safeEngineId,
          qualifierType,
          Number(qualifierId)
        )
      );
    }

    const qualCount = values.length;
    const show = qualCount > 1 && !areArraysIdentical(partResults);

    if (show) {
      return { showDropdown: true, name: qualifierName, values };
    }

    return empty;
  }

  return empty;
}

export function matchQualifierOption(typed, options) {
  const needle = typed.trim().toLowerCase();
  if (!needle) return null;

  return (
    options.find((option) => option.id.toLowerCase() === needle) ??
    options.find((option) => option.value.toLowerCase() === needle) ??
    options.find((option) => option.value.toLowerCase().startsWith(needle)) ??
    options.find((option) => option.value.toLowerCase().includes(needle)) ??
    null
  );
}
