import { fetchEngineCheck, resolveEngineSelection } from "./repositories/engineRepository.js";
import {
  fetchMakes,
  fetchYearsForMake,
  matchMakeName,
  searchMakeNames
} from "./repositories/makeRepository.js";
import {
  fetchModels,
  matchModelName
} from "./repositories/modelRepository.js";
import { fetchProductList } from "./repositories/productRepository.js";
import { fetchQualifierCollection } from "./repositories/qualifierRepository.js";
import { fetchYears, matchYear } from "./repositories/yearRepository.js";

function toolResult(content) {
  return {
    content: [{
      type: "text",
      text: typeof content === "string" ? content : JSON.stringify(content)
    }]
  };
}

function normalizeQualifiers(qualifiers) {
  if (!qualifiers) return [];
  if (Array.isArray(qualifiers)) return qualifiers.filter(Boolean);
  if (typeof qualifiers === "string") {
    return qualifiers.split(",").map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function formatProducts(products, vehicle, qualifiers) {
  return {
    status: products.length ? "success" : "not_found",
    vehicle,
    qualifiers,
    products: products.map((product) => ({
      id: product.variantId || product.partNumber,
      title: product.title,
      price: product.price,
      image_url: product.image_url,
      description: product.note,
      url: product.url,
      variantId: product.variantId,
      partNumber: product.partNumber,
      handle: product.handle
    }))
  };
}

async function resolveProductsFlow({ year, make, model, engine, qualifiers = [], shop = null }) {
  const selectedQualifiers = normalizeQualifiers(qualifiers);
  let engineSelection = null;

  if (engine) {
    engineSelection = await resolveEngineSelection(year, make, model, engine);
  } else {
    const engineCheck = await fetchEngineCheck(year, make, model);
    if (engineCheck.showDropdown && engineCheck.engines.length > 1) {
      return {
        status: "need_engine",
        message: "Multiple engines match this vehicle. Ask the customer to choose one.",
        vehicle: { year, make, model },
        options: engineCheck.engines.map((row) => row.engine),
        requiresEngineSelection: true
      };
    }
    if (engineCheck.engines.length >= 1) {
      engineSelection = await resolveEngineSelection(
        year,
        make,
        model,
        engineCheck.engines[0].engine
      );
    }
  }

  if (!engineSelection) {
    return {
      status: "not_found",
      message: "Could not resolve a matching engine for that vehicle.",
      vehicle: { year, make, model }
    };
  }

  let activeQualifiers = [...selectedQualifiers];
  while (true) {
    const qualifier = await fetchQualifierCollection(
      engineSelection.baseVehicleId,
      engineSelection.engineConfigId,
      activeQualifiers
    );

    if (!qualifier.showDropdown) break;

    const pending = qualifier.values.map((option) => option.id);
    const matched = pending.find((id) => activeQualifiers.includes(id));
    if (!matched) {
      return {
        status: "need_qualifier",
        message: `Ask the customer to choose ${qualifier.name}.`,
        qualifierName: qualifier.name,
        vehicle: { year, make, model, engine: engineSelection.engine },
        options: qualifier.values.map((option) => ({
          id: option.id,
          label: option.value
        }))
      };
    }
  }

  const products = await fetchProductList(
    engineSelection.baseVehicleId,
    engineSelection.engineConfigId,
    activeQualifiers,
    { year, make, model },
    shop
  );

  return formatProducts(
    products,
    { year, make, model, engine: engineSelection.engine },
    activeQualifiers
  );
}

/**
 * Main orchestrator — call whenever the user mentions year, make, model, or vehicle fitment.
 * Accepts partial info and returns the next filter to ask, or products when ready.
 */
export async function getFitmentNextStep({
  year,
  make,
  model,
  engine,
  qualifiers = [],
  shop = null
} = {}) {
  const known = {};

  if (!year && !make && !model) {
    const years = await fetchYears();
    return {
      status: "need_year",
      message: "Ask the customer for their vehicle year.",
      known,
      options: years.slice(0, 25).map((row) => String(row.year))
    };
  }

  if (!year && make) {
    const yearsForMake = await fetchYearsForMake(make);
    if (yearsForMake.length) {
      known.make = make;
      return {
        status: "need_year",
        message: `Ask which year their ${make} is.`,
        known,
        options: yearsForMake.slice(0, 25).map((row) => String(row.year))
      };
    }

    const makeMatches = await searchMakeNames(make);
    if (makeMatches.length === 1) {
      known.make = makeMatches[0].make;
      const yearsForMatchedMake = await fetchYearsForMake(known.make);
      return {
        status: "need_year",
        message: `Ask which year their ${known.make} is.`,
        known,
        options: yearsForMatchedMake.slice(0, 25).map((row) => String(row.year))
      };
    }

    if (makeMatches.length > 1) {
      return {
        status: "need_make",
        message: "Multiple makes match. Ask the customer to clarify their make.",
        known,
        options: makeMatches.map((row) => row.make)
      };
    }

    return {
      status: "need_year",
      message: "Could not find that make. Ask for the vehicle year first.",
      known,
      options: (await fetchYears()).slice(0, 25).map((row) => String(row.year))
    };
  }

  const allYears = await fetchYears();
  const matchedYear = year ? (matchYear(year, allYears) || String(year).trim()) : null;

  if (!matchedYear) {
    return {
      status: "need_year",
      message: "Ask for a valid vehicle year.",
      known,
      options: allYears.slice(0, 25).map((row) => String(row.year))
    };
  }

  known.year = matchedYear;

  if (!make) {
    const makes = await fetchMakes(matchedYear);
    return {
      status: "need_make",
      message: `Ask which make their ${matchedYear} vehicle is.`,
      known,
      options: makes.map((row) => row.make)
    };
  }

  const makes = await fetchMakes(matchedYear);
  const matchedMake = matchMakeName(make, makes);
  if (!matchedMake) {
    const suggestions = makes
      .filter((row) => row.make.toLowerCase().includes(String(make).toLowerCase()))
      .map((row) => row.make);

    return {
      status: "need_make",
      message: `"${make}" was not found for ${matchedYear}. Ask the customer to pick a make.`,
      known,
      options: suggestions.length ? suggestions : makes.map((row) => row.make)
    };
  }

  known.make = matchedMake;

  if (!model) {
    const models = await fetchModels(matchedYear, matchedMake);
    return {
      status: "need_model",
      message: `Ask which model their ${matchedYear} ${matchedMake} is.`,
      known,
      options: models.map((row) => row.model)
    };
  }

  const models = await fetchModels(matchedYear, matchedMake);
  const matchedModel = matchModelName(model, models);
  if (!matchedModel) {
    const suggestions = models
      .filter((row) => row.model.toLowerCase().includes(String(model).toLowerCase()))
      .map((row) => row.model);

    return {
      status: "need_model",
      message: `"${model}" was not found for ${matchedYear} ${matchedMake}. Ask the customer to pick a model.`,
      known,
      options: suggestions.length ? suggestions : models.map((row) => row.model)
    };
  }

  known.model = matchedModel;

  const result = await resolveProductsFlow({
    year: matchedYear,
    make: matchedMake,
    model: matchedModel,
    engine,
    qualifiers,
    shop
  });

  return { ...result, known: { ...known, ...result.vehicle } };
}

export async function lookupFitmentYears() {
  const years = await fetchYears();
  return toolResult({
    status: "need_year",
    options: years.slice(0, 50).map((row) => String(row.year))
  });
}

export async function lookupFitmentMakes({ year }) {
  const allYears = await fetchYears();
  const matchedYear = matchYear(year, allYears) || year;
  const makes = await fetchMakes(matchedYear);
  return toolResult({
    status: "need_make",
    year: matchedYear,
    options: makes.map((row) => row.make)
  });
}

export async function lookupFitmentModels({ year, make }) {
  const allYears = await fetchYears();
  const matchedYear = matchYear(year, allYears) || year;
  const makes = await fetchMakes(matchedYear);
  const matchedMake = matchMakeName(make, makes) || make;
  const models = await fetchModels(matchedYear, matchedMake);
  return toolResult({
    status: "need_model",
    year: matchedYear,
    make: matchedMake,
    options: models.map((row) => row.model)
  });
}

export async function lookupFitmentEngines({ year, make, model }) {
  const result = await fetchEngineCheck(year, make, model);
  return toolResult({
    status: result.showDropdown ? "need_engine" : "ready_for_products",
    year,
    make,
    model,
    options: result.engines.map((row) => row.engine),
    requiresEngineSelection: result.showDropdown
  });
}

export async function getFitmentQualifier({ year, make, model, engine, qualifiers = [] }) {
  const selectedQualifiers = normalizeQualifiers(qualifiers);
  const engineSelection = await resolveEngineSelection(year, make, model, engine || "");

  if (!engineSelection) {
    const engineCheck = await fetchEngineCheck(year, make, model);
    return toolResult({
      status: "need_engine",
      message: "Engine selection is required before qualifiers can be resolved.",
      options: engineCheck.engines.map((row) => row.engine),
      requiresEngineSelection: engineCheck.showDropdown
    });
  }

  const qualifier = await fetchQualifierCollection(
    engineSelection.baseVehicleId,
    engineSelection.engineConfigId,
    selectedQualifiers
  );

  if (qualifier.showDropdown) {
    return toolResult({
      status: "need_qualifier",
      qualifierName: qualifier.name,
      options: qualifier.values.map((option) => ({
        id: option.id,
        label: option.value
      })),
      resolvedEngine: engineSelection.engine
    });
  }

  return toolResult({
    status: "ready_for_products",
    message: "No additional qualifiers are required.",
    resolvedEngine: engineSelection.engine
  });
}

export async function findFitmentProducts(args, shop = null) {
  const result = await getFitmentNextStep({ ...args, shop });
  if (["need_year", "need_make", "need_model", "need_engine", "need_qualifier"].includes(result.status)) {
    return toolResult(result);
  }
  return toolResult(result);
}

export const FITMENT_TOOL_NAMES = [
  "get_fitment_next_step",
  "lookup_fitment_years",
  "lookup_fitment_makes",
  "lookup_fitment_models",
  "lookup_fitment_engines",
  "get_fitment_qualifier",
  "find_fitment_products"
];

export function getFitmentTools() {
  return [
    {
      name: "get_fitment_next_step",
      description: "PRIMARY fitment tool. Call whenever the customer mentions a vehicle, year, make, model, or asks for a part that fits their car. Pass whatever is known (year, make, model, engine, qualifiers) even if incomplete. Returns the next question to ask with DB-backed options, or products with variantId when ready. Use this before search_catalog for vehicle-related requests.",
      input_schema: {
        type: "object",
        properties: {
          year: { type: "string", description: "Vehicle year if known, e.g. 2008" },
          make: { type: "string", description: "Vehicle make if known, e.g. Ford" },
          model: { type: "string", description: "Vehicle model if known, e.g. Focus" },
          engine: { type: "string", description: "Engine if known, e.g. 2.0L" },
          qualifiers: {
            type: "array",
            items: { type: "string" },
            description: "Selected qualifiers as TypeID:value, e.g. FuelTypeID:5"
          }
        }
      }
    },
    {
      name: "lookup_fitment_years",
      description: "List valid vehicle years from the fitment database.",
      input_schema: { type: "object", properties: {} }
    },
    {
      name: "lookup_fitment_makes",
      description: "List valid makes for a given year.",
      input_schema: {
        type: "object",
        properties: {
          year: { type: "string" }
        },
        required: ["year"]
      }
    },
    {
      name: "lookup_fitment_models",
      description: "List valid models for a given year and make.",
      input_schema: {
        type: "object",
        properties: {
          year: { type: "string" },
          make: { type: "string" }
        },
        required: ["year", "make"]
      }
    },
    {
      name: "lookup_fitment_engines",
      description: "List engines for year, make, and model.",
      input_schema: {
        type: "object",
        properties: {
          year: { type: "string" },
          make: { type: "string" },
          model: { type: "string" }
        },
        required: ["year", "make", "model"]
      }
    },
    {
      name: "get_fitment_qualifier",
      description: "Get the next qualifier question (fuel, drive type, etc.) for a vehicle.",
      input_schema: {
        type: "object",
        properties: {
          year: { type: "string" },
          make: { type: "string" },
          model: { type: "string" },
          engine: { type: "string" },
          qualifiers: { type: "array", items: { type: "string" } }
        },
        required: ["year", "make", "model"]
      }
    },
    {
      name: "find_fitment_products",
      description: "Find cabin air filter products for a vehicle. Returns next filter needed or products with variantId for MCP create_cart.",
      input_schema: {
        type: "object",
        properties: {
          year: { type: "string" },
          make: { type: "string" },
          model: { type: "string" },
          engine: { type: "string" },
          qualifiers: { type: "array", items: { type: "string" } }
        }
      }
    }
  ];
}

export async function callFitmentTool(toolName, toolArgs = {}, { shop = null } = {}) {
  switch (toolName) {
    case "get_fitment_next_step":
      return toolResult(await getFitmentNextStep({ ...toolArgs, shop }));
    case "lookup_fitment_years":
      return lookupFitmentYears();
    case "lookup_fitment_makes":
      return lookupFitmentMakes(toolArgs);
    case "lookup_fitment_models":
      return lookupFitmentModels(toolArgs);
    case "lookup_fitment_engines":
      return lookupFitmentEngines(toolArgs);
    case "get_fitment_qualifier":
      return getFitmentQualifier(toolArgs);
    case "find_fitment_products":
      return findFitmentProducts(toolArgs, shop);
    default:
      throw new Error(`Unknown fitment tool: ${toolName}`);
  }
}

export function isFitmentTool(toolName) {
  return FITMENT_TOOL_NAMES.includes(toolName);
}
