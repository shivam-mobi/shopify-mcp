/**
 * Normalize LLM search_catalog args before MCP / post-filters.
 */
export function normalizeCatalogSearchArgs(toolArgs = {}) {
  if (!toolArgs || typeof toolArgs !== "object") {
    return toolArgs;
  }

  const hasCatalogWrapper =
    toolArgs.catalog != null && typeof toolArgs.catalog === "object";
  const catalog = hasCatalogWrapper
    ? { ...toolArgs.catalog }
    : { ...toolArgs };

  if (hasCatalogWrapper) {
    if (toolArgs.filters != null && typeof toolArgs.filters === "object") {
      const existingFilters =
        catalog.filters != null && typeof catalog.filters === "object"
          ? { ...catalog.filters }
          : {};
      const topFilters = { ...toolArgs.filters };
      const mergedFilters = { ...existingFilters, ...topFilters };
      if (existingFilters.price || topFilters.price) {
        mergedFilters.price = {
          ...(existingFilters.price && typeof existingFilters.price === "object"
            ? existingFilters.price
            : {}),
          ...(topFilters.price && typeof topFilters.price === "object"
            ? topFilters.price
            : {})
        };
      }
      catalog.filters = mergedFilters;
      console.warn("[tool] hoisted top-level filters → catalog.filters", {
        filters: mergedFilters
      });
    }

    if (toolArgs.pagination != null && typeof toolArgs.pagination === "object") {
      catalog.pagination = {
        ...(catalog.pagination && typeof catalog.pagination === "object"
          ? catalog.pagination
          : {}),
        ...toolArgs.pagination
      };
      console.warn("[tool] hoisted top-level pagination → catalog.pagination", {
        pagination: catalog.pagination
      });
    }
  }

  if (catalog.context != null && typeof catalog.context === "object") {
    const context = { ...catalog.context };

    if (context.filters != null && typeof context.filters === "object") {
      const nestedFilters = { ...context.filters };
      delete context.filters;

      const existingFilters =
        catalog.filters != null && typeof catalog.filters === "object"
          ? { ...catalog.filters }
          : {};

      const mergedFilters = {
        ...existingFilters,
        ...nestedFilters
      };

      if (existingFilters.price || nestedFilters.price) {
        mergedFilters.price = {
          ...(existingFilters.price && typeof existingFilters.price === "object"
            ? existingFilters.price
            : {}),
          ...(nestedFilters.price && typeof nestedFilters.price === "object"
            ? nestedFilters.price
            : {})
        };
      }

      catalog.filters = mergedFilters;
      console.warn(
        "[tool] hoisted filters from catalog.context → catalog.filters",
        { filters: mergedFilters }
      );
    }

    if (Object.keys(context).length > 0) {
      catalog.context = context;
    } else {
      delete catalog.context;
    }
  }

  if (hasCatalogWrapper) {
    const { filters: _f, pagination: _p, ...rest } = toolArgs;
    return { ...rest, catalog };
  }

  return catalog;
}
