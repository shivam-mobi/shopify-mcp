/**
 * Tool Service
 * Manages tool execution and processing
 */
import { saveMessage } from "../db.server";
import AppConfig from "./config.server";
import { enrichProductsWithComparison, buildCompareAttributes, buildLlmProductSummary, buildProductListingMetadata, resolveProductVariantId, resolveProductDescriptionHtml } from "./product-compare.server.js";

/**
 * Fix LLM mistakes for search_catalog args:
 * - filters must be catalog.filters, never inside catalog.context
 * - filters/pagination must not sit top-level beside catalog (Shopify ignores them)
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

  // Hoist misplaced top-level filters/pagination into catalog when using { catalog: {...} }
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

/**
 * Creates a tool service instance
 * @returns {Object} Tool service with methods for managing tools
 */
export function createToolService() {
  const handleToolError = async (toolUseResponse, toolName, toolUseId, conversationHistory, sendMessage, conversationId) => {
    if (toolUseResponse.error.type === "auth_required") {
      console.log("Auth required for tool:", toolName);
      await addToolResultToHistory(conversationHistory, toolUseId, toolUseResponse.error.data, conversationId);
      sendMessage({ type: 'auth_required' });
      return;
    }

    const userMessage = AppConfig.errorMessages.toolFailure;
    console.log("Tool use error", { toolName, error: toolUseResponse.error });

    await addToolResultToHistory(
      conversationHistory,
      toolUseId,
      JSON.stringify({
        error: true,
        tool: toolName,
        user_message: userMessage,
        instruction:
          "The customer was already shown user_message in the chat UI. " +
          "Do NOT send any additional assistant reply for this tool failure. " +
          "If the platform requires text, output user_message exactly and nothing else — " +
          "no follow-up questions, no 'let me know if you need something else', no alternate help offers."
      }),
      conversationId
    );

    sendMessage({ type: 'tool_error', message: userMessage });
  };

  const handleToolSuccess = async (
    toolUseResponse,
    toolName,
    toolUseId,
    conversationHistory,
    productsToDisplay,
    conversationId,
    toolArgs = null
  ) => {
    let historyContent = toolUseResponse.content;

    if (AppConfig.tools.productSearchNames.includes(toolName)) {
      let ranked = processProductSearchResult(toolUseResponse, toolArgs);
      if (ranked.length > 0) {
        // Notes/reviews UI only for get_product_details — not browse listings
        if (toolName === "get_product_details") {
          ranked = ranked.map((product) => ({
            ...product,
            showDetailProfile: true
          }));
        }
        productsToDisplay.push(...ranked);
      }
      // Always rewrite history (including empty after price-range drop) so the LLM
      // does not treat the raw MCP payload as confirmed matches.
      historyContent = buildProductSearchToolHistory(
        toolUseResponse,
        ranked,
        toolName,
        toolArgs
      );
    }

    await addToolResultToHistory(conversationHistory, toolUseId, historyContent, conversationId);
  };

  const processProductSearchResult = (toolUseResponse, toolArgs = null) => {
    try {
      console.log("Processing product search result");
      const responseData = extractToolResponseData(toolUseResponse);
      const products = extractProductsFromResponse(responseData);
      const priceFilter = extractPriceFilter(toolArgs);

      const formatted = products
        .map((product) => formatProductData(product, priceFilter))
        .filter(Boolean);

      return enrichProductsWithComparison(formatted);
    } catch (error) {
      console.error("Error processing product search results:", error);
      return [];
    }
  };

  /** Read catalog.filters.price (or filters.price) from search tool args. Amounts are minor units. */
  const extractPriceFilter = (toolArgs) => {
    if (!toolArgs || typeof toolArgs !== "object") return null;

    const price =
      toolArgs.catalog?.filters?.price ||
      toolArgs.filters?.price ||
      null;

    if (!price || typeof price !== "object") return null;

    const minRaw = price.min;
    const maxRaw = price.max;
    const min = minRaw == null || minRaw === "" ? null : Number(minRaw);
    const max = maxRaw == null || maxRaw === "" ? null : Number(maxRaw);

    const hasMin = min != null && Number.isFinite(min);
    const hasMax = max != null && Number.isFinite(max);
    if (!hasMin && !hasMax) return null;

    return {
      min: hasMin ? min : null,
      max: hasMax ? max : null
    };
  };

  const isPriceInFilterRange = (priceCents, priceFilter) => {
    if (!priceFilter) return true;
    if (priceCents == null || !Number.isFinite(priceCents)) return false;
    if (priceFilter.min != null && priceCents < priceFilter.min) return false;
    if (priceFilter.max != null && priceCents > priceFilter.max) return false;
    return true;
  };

  const CATALOG_QUERY_STOPWORDS = new Set([
    "perfume",
    "perfumes",
    "cologne",
    "colognes",
    "fragrance",
    "fragrances",
    "eau",
    "de",
    "parfum",
    "toilette",
    "for",
    "the",
    "and",
    "a",
    "an",
    "men",
    "women",
    "mens",
    "womens",
    "man",
    "woman",
    "gift",
    "under",
    "over",
    "below",
    "above",
    "oz",
    "set",
    "spray"
  ]);

  /**
   * Whether ranked catalog products clearly match distinctive terms in the search query.
   * Used so the LLM does not claim "more Gucci" when page 2 has no Gucci.
   */
  const evaluateCatalogQueryMatch = (toolArgs, rankedProducts = []) => {
    const resultCount = rankedProducts.length;
    const query = String(
      toolArgs?.catalog?.query || toolArgs?.query || ""
    ).trim();

    if (resultCount === 0) {
      return { query_match: false, match_count: 0, result_count: 0 };
    }

    const tokens = query
      .toLowerCase()
      .split(/[^a-z0-9]+/i)
      .map((t) => t.trim())
      .filter((t) => t.length > 2 && !CATALOG_QUERY_STOPWORDS.has(t));

    // No distinctive brand/keyword → treat results as a soft match
    if (tokens.length === 0) {
      return { query_match: true, match_count: resultCount, result_count: resultCount };
    }

    let matchCount = 0;
    for (const product of rankedProducts) {
      const tagBlob = Array.isArray(product.tags)
        ? product.tags.join(" ")
        : String(product.tags || "");
      const blob = [
        product.title,
        product.name,
        product.vendor,
        product.brand,
        tagBlob
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      if (tokens.some((token) => blob.includes(token))) {
        matchCount += 1;
      }
    }

    return {
      query_match: matchCount > 0,
      match_count: matchCount,
      result_count: resultCount
    };
  };

  const buildProductSearchToolHistory = (
    toolUseResponse,
    rankedProducts,
    toolName,
    toolArgs = null
  ) => {
    const originalData = extractToolResponseData(toolUseResponse) || {};
    const isDetail = toolName === "get_product_details";
    const products = buildLlmProductSummary(rankedProducts, {
      forListing: !isDetail
    });
    const listingMeta = buildProductListingMetadata(rankedProducts);
    const matchInfo = evaluateCatalogQueryMatch(toolArgs, rankedProducts);

    const pagination = originalData.pagination && typeof originalData.pagination === "object"
      ? {
          cursor: originalData.pagination.cursor || null,
          has_next_page: originalData.pagination.has_next_page === true,
          total_count:
            typeof originalData.pagination.total_count === "number"
              ? originalData.pagination.total_count
              : null
        }
      : null;

    const matchInstruction = matchInfo.query_match
      ? "query_match is true: say matching products were found (generic only), then ask if they want to add one to the cart. Do NOT name brands, titles, or prices in this browse reply."
      : rankedProducts.length > 0
        ? "query_match is false: products below are NOT a clear match for the customer's search (common after show more). " +
          "Say you could not find products matching their request, but a few other options are shown below. " +
          "Ask if they want to try another brand or name. Do NOT say you found their brand or 'more [brand] products'."
        : "No products to show: say you could not find a match and ask them to rephrase.";

    const enriched = {
      status: originalData.status || "success",
      source: toolName,
      products,
      ...listingMeta,
      ...(pagination ? { pagination } : {}),
      query_match: isDetail ? true : matchInfo.query_match,
      match_count: matchInfo.match_count,
      result_count: matchInfo.result_count,
      ui_instruction:
        isDetail
          ? "get_product_details: Product Details card is shown BELOW your text (text first, then the card). products[] is INTERNAL ONLY — do not paste into chat. " +
            "FORBIDDEN: Price, Fragrance Type/Family, Scent Type, Key Notes, Top/Middle/Base Notes, Average Rating, bullets, field lists. " +
            "NEVER say details are above — always say below. " +
            "REQUIRED: 1-2 short sentences only — e.g. \"I've pulled up the full details below — would you like to add it to your cart?\""
          : "CRITICAL: Top Matching Products cards are shown BELOW your text in the UI (text first, then cards). products[] (price, tags, scent_notes, description) / cheapest_* are for YOUR use only (history). " +
            "DEFAULT browse reply: 1-2 short generic sentences only — FORBIDDEN to list product names, prices, bullets, or 'here are some options'. " +
            "Say cards are shown below (NEVER say above). " +
            "FOLLOW-UP — cheapest / most expensive / compare shown cards: answer briefly from products[] or cheapest_* / most_expensive_* (name or #N + price once), then offer to add it. " +
            "FOLLOW-UP — best / recommend / suggest: NEVER invent a universal best. If the customer gave a preference (floral, fresh, woody, daytime, evening, gift, EDP, women/men, budget), " +
            "pick ONE product from products[] using gender, fragrance_type, scent_notes, tags, description, and price; say why in one short sentence; offer to add it. " +
            "If they ask for the best with NO preference, ask one short preference question — do not pick randomly. " +
            "Never dump the full catalog list in chat. " +
            matchInstruction +
            (pagination
              ? " If the customer asks for more products/results/next page and pagination.has_next_page is true, call search_catalog again with the same query/filters and pagination.cursor from this result."
              : "")
    };

    console.log("[tool] enriched product listing for LLM history", {
      source: toolName,
      count: products.length,
      query_match: matchInfo.query_match,
      match_count: matchInfo.match_count,
      first_product_variant_id: listingMeta.first_product_variant_id
    });

    return [{
      type: "text",
      text: JSON.stringify(enriched)
    }];
  };

  const extractToolResponseData = (toolUseResponse) => {
    if (toolUseResponse.structuredContent) {
      return toolUseResponse.structuredContent;
    }

    if (toolUseResponse.content?.length > 0) {
      const content = toolUseResponse.content[0].text;

      if (typeof content === "object") {
        return content;
      }

      if (typeof content === "string") {
        try {
          return JSON.parse(content);
        } catch {
          return null;
        }
      }
    }

    return null;
  };

  const extractProductsFromResponse = (responseData) => {
    if (!responseData) {
      return [];
    }

    if (Array.isArray(responseData.products)) {
      return responseData.products;
    }

    if (Array.isArray(responseData.ucp?.products)) {
      return responseData.ucp.products;
    }

    return [];
  };

  const shouldBuildCompareAttrs = (product) => {
    return !product.filterType && product.isHepa == null;
  };

  const formatVariantOption = (variant, product) => {
    if (!variant || typeof variant !== "object") return null;

    const availability = resolveProductAvailability(product, variant);
    const priceAmount = variant?.price?.amount ?? variant?.price;
    const priceCurrency =
      variant?.price?.currency ??
      variant?.currency ??
      product.price_range?.min?.currency ??
      product.price_range?.currency ??
      "USD";

    let price = null;
    if (priceAmount != null && priceCurrency) {
      price = `${priceCurrency} ${formatMinorCurrencyAmount(priceAmount, priceCurrency)}`;
    }

    let compareAtPrice = null;
    const listAmount = variant?.list_price?.amount ?? variant?.compareAtPrice?.amount;
    const listCurrency =
      variant?.list_price?.currency ?? variant?.compareAtPrice?.currency ?? priceCurrency;
    if (listAmount != null && listCurrency && Number(listAmount) > 0) {
      compareAtPrice = `${listCurrency} ${formatMinorCurrencyAmount(listAmount, listCurrency)}`;
    }

    const optionLabel =
      variant.options?.[0]?.label ||
      variant.title ||
      variant.name ||
      "Option";

    const variantImage =
      (Array.isArray(variant.media) &&
        variant.media.find((item) => item?.url && (!item.type || item.type === "image"))?.url) ||
      variant.image?.url ||
      variant.image_url ||
      null;

    const normalizedVariantId = resolveProductVariantId({
      variantId: variant.id,
      variant_id: variant.id,
      id: variant.id
    });

    if (!normalizedVariantId) return null;

    const priceAmountCents =
      priceAmount == null || priceAmount === ""
        ? null
        : Number(priceAmount);

    return {
      id: normalizedVariantId,
      variantId: normalizedVariantId,
      variant_id: normalizedVariantId,
      title: optionLabel,
      label: optionLabel,
      price,
      priceAmountCents:
        priceAmountCents != null && Number.isFinite(priceAmountCents)
          ? priceAmountCents
          : null,
      compareAtPrice,
      available: availability.availableForSale !== false && availability.inStock !== false,
      availableForSale: availability.availableForSale,
      inStock: availability.inStock,
      inventoryQuantity: availability.inventoryQuantity,
      image_url: variantImage
    };
  };

  /**
   * Format a catalog product for chat cards.
   * When priceFilter is set: default to cheapest in-stock variant in range;
   * drop the product (return null) if none. All variants stay on the card (selectable).
   */
  const formatProductData = (product, priceFilter = null) => {
    const rawVariants = Array.isArray(product.variants)
      ? product.variants
      : product.variant
        ? [product.variant]
        : [];

    const variants = rawVariants
      .map((variant) => formatVariantOption(variant, product))
      .filter(Boolean);

    let selectedVariant = null;

    if (priceFilter) {
      const inRangeAvailable = variants.filter(
        (variant) =>
          variant.available &&
          isPriceInFilterRange(variant.priceAmountCents, priceFilter)
      );

      // No in-stock size within the requested budget/min → hide the card
      if (inRangeAvailable.length === 0) {
        return null;
      }

      selectedVariant = inRangeAvailable
        .slice()
        .sort(
          (a, b) =>
            (a.priceAmountCents ?? Number.POSITIVE_INFINITY) -
            (b.priceAmountCents ?? Number.POSITIVE_INFINITY)
        )[0];

      // Sort chips: in-range in-stock first (cheapest first), then the rest
      variants.sort((a, b) => {
        const aIn =
          a.available && isPriceInFilterRange(a.priceAmountCents, priceFilter);
        const bIn =
          b.available && isPriceInFilterRange(b.priceAmountCents, priceFilter);
        if (aIn !== bIn) return aIn ? -1 : 1;
        return (
          (a.priceAmountCents ?? Number.POSITIVE_INFINITY) -
          (b.priceAmountCents ?? Number.POSITIVE_INFINITY)
        );
      });
    } else {
      // Prefer first in-stock variant so cards don't default to an OOS size
      selectedVariant =
        variants.find((variant) => variant.available) ||
        variants[0] ||
        null;
    }

    // Keep full variant list for the UI; strip internal cents field
    const variantsForClient = variants.map(
      ({ priceAmountCents: _cents, ...rest }) => rest
    );

    const legacyVariant = product.variants?.[0] || product.variant;
    const variant = selectedVariant
      ? rawVariants.find((item) => {
          const id = resolveProductVariantId({
            variantId: item?.id,
            variant_id: item?.id,
            id: item?.id
          });
          return id && id === selectedVariant.id;
        }) || legacyVariant
      : legacyVariant;

    const priceAmount = selectedVariant
      ? null
      : variant?.price?.amount ?? variant?.price;
    const priceCurrency =
      variant?.price?.currency ??
      variant?.currency ??
      product.price_range?.min?.currency ??
      product.price_range?.currency;

    let price = "Price not available";
    if (selectedVariant?.price) {
      price = selectedVariant.price;
    } else if (product.price && typeof product.price === "string") {
      price = product.price;
    } else if (priceAmount != null && priceCurrency) {
      const majorUnits = formatMinorCurrencyAmount(priceAmount, priceCurrency);
      price = `${priceCurrency} ${majorUnits}`;
    } else if (product.price_range?.min?.amount != null) {
      const currency = product.price_range.min.currency || product.price_range.currency || "USD";
      price = `${currency} ${formatMinorCurrencyAmount(product.price_range.min.amount, currency)}`;
    } else if (product.price_range) {
      price = `${product.price_range.currency} ${product.price_range.min}`;
    }

    const variantId =
      selectedVariant?.id ||
      product.variantId ||
      product.variant_id ||
      variant?.id;
    const availability = selectedVariant
      ? {
          availableForSale: selectedVariant.availableForSale,
          inStock: selectedVariant.inStock,
          inventoryQuantity: selectedVariant.inventoryQuantity
        }
      : resolveProductAvailability(product, variant);
    const storefrontBase = (
      process.env.STOREFRONT_URL ||
      process.env.SHOPIFY_STOREFRONT_URL ||
      ""
    ).trim().replace(/\/+$/, "");

    let productUrl =
      product.url ||
      product.online_store_url ||
      product.onlineStoreUrl ||
      "";
    if (!productUrl && product.handle) {
      productUrl = `/products/${product.handle}`;
    }
    if (productUrl.includes("yourstore.com") && storefrontBase) {
      productUrl = productUrl.replace(/https?:\/\/(?:www\.)?yourstore\.com/gi, storefrontBase);
    } else if (productUrl.startsWith("/") && storefrontBase) {
      productUrl = `${storefrontBase}${productUrl}`;
    }

    const vendor =
      product.vendor ||
      product.brand ||
      variant?.product?.vendor ||
      "";

    const normalizedVariantId = resolveProductVariantId({ variantId, variant_id: product.variant_id, id: variantId });

    const descriptionHtml = resolveProductDescriptionHtml(product);
    const imageUrl =
      selectedVariant?.image_url ||
      resolveProductImageUrl(product);

    const fullDescription = stripHtmlToPlain(descriptionHtml)
      .replace(/\s+/g, " ")
      .trim();
    const shortDescription = fullDescription.slice(0, 180);
    const sizeLabels = [
      ...new Set(
        [
          ...(Array.isArray(product.options)
            ? product.options.flatMap((opt) =>
                (opt?.values || []).map((v) => v?.label || v).filter(Boolean)
              )
            : []),
          ...variantsForClient.map((v) => v.title || v.label).filter(Boolean)
        ].map((label) => String(label).trim())
      )
    ].filter(Boolean);

    return {
      id: normalizedVariantId || product.product_id || product.id || product.partNumber || `product-${Math.random().toString(36).substring(7)}`,
      productId: product.id || product.product_id || null,
      variantId: normalizedVariantId,
      variant_id: normalizedVariantId,
      title: product.title || product.partTypeName || product.name || "Product",
      price,
      priceAmountCents:
        selectedVariant?.priceAmountCents != null &&
        Number.isFinite(Number(selectedVariant.priceAmountCents))
          ? Number(selectedVariant.priceAmountCents)
          : null,
      priceAmount: typeof product.priceAmount === "number" ? product.priceAmount : null,
      compareAtPrice: selectedVariant?.compareAtPrice || product.compareAtPrice || null,
      image_url: imageUrl,
      description: descriptionHtml,
      descriptionHtml,
      shortDescription: shortDescription || null,
      fullDescription: fullDescription || null,
      sizes: sizeLabels,
      url: productUrl,
      availableForSale: availability.availableForSale,
      inStock: availability.inStock,
      inventoryQuantity: availability.inventoryQuantity,
      variants: variantsForClient,
      vendor,
      sku: product.sku || product.partNumber || selectedVariant?.sku || "",
      productType: product.productType || product.product_type || "",
      product_type: product.product_type || product.productType || "",
      productCategory: product.productCategory,
      fragrance: product.fragrance,
      durationDays: product.durationDays,
      hasOdorEliminator: product.hasOdorEliminator,
      filterType: product.filterType,
      isHepa: product.isHepa,
      hasAntibacterial: product.hasAntibacterial,
      hasCharcoal: product.hasCharcoal,
      hasParticulate: product.hasParticulate,
      yGroup: product.yGroup || "",
      features: Array.isArray(product.features) ? product.features : undefined,
      tags: Array.isArray(product.tags) ? product.tags : product.tags,
      fragrance_family: product.fragrance_family || null,
      scent_type: product.scent_type || null,
      key_notes: product.key_notes || null,
      top_notes: product.top_notes || null,
      middle_notes: product.middle_notes || null,
      base_notes: product.base_notes || null,
      product_type_metafield: product.product_type_metafield || null,
      product_review_summary: product.product_review_summary || null,
      average_rating: (() => {
        const n = Number(product.average_rating);
        return Number.isFinite(n) && n > 0 ? n : null;
      })(),
      total_reviews: (() => {
        const n = Number(product.total_reviews);
        return Number.isFinite(n) && n >= 0 ? n : null;
      })(),
      showDetailProfile: product.showDetailProfile === true,
      ...(shouldBuildCompareAttrs(product)
        ? buildCompareAttributes({
            tags: product.tags,
            title: product.title || product.partTypeName || product.name || "",
            descriptionHtml,
            vendor,
            sku: product.sku || product.partNumber || "",
            productType: product.productType || product.product_type || "",
            product_type: product.product_type || product.productType || ""
          })
        : {})
    };
  };

  const stripHtmlToPlain = (html = "") =>
    String(html || "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&nbsp;/g, " ")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .trim();

  const resolveProductAvailability = (product, variant) => {
    const qty =
      typeof product.inventoryQuantity === "number"
        ? product.inventoryQuantity
        : typeof variant?.inventoryQuantity === "number"
          ? variant.inventoryQuantity
          : null;

    let availableForSale = null;

    if (typeof product.availableForSale === "boolean") {
      availableForSale = product.availableForSale;
    } else if (typeof product.inStock === "boolean") {
      availableForSale = product.inStock;
    } else if (variant?.availability && typeof variant.availability.available === "boolean") {
      availableForSale = variant.availability.available;
      if (typeof variant.availability.quantity === "number" && qty == null) {
        return finalizeAvailability(availableForSale, variant.availability.quantity);
      }
    } else if (typeof variant?.availableForSale === "boolean") {
      availableForSale = variant.availableForSale;
    }

    return finalizeAvailability(availableForSale, qty);
  };

  const finalizeAvailability = (availableForSale, qty) => {
    // Explicit: inventory 0 => out of stock for UI/cart
    if (qty === 0) {
      return {
        availableForSale: false,
        inStock: false,
        inventoryQuantity: 0
      };
    }

    if (availableForSale === false) {
      return {
        availableForSale: false,
        inStock: false,
        inventoryQuantity: qty
      };
    }

    if (availableForSale === true) {
      return {
        availableForSale: true,
        inStock: qty == null || qty > 0,
        inventoryQuantity: qty
      };
    }

    // Unknown — only treat as in stock if qty is positive; qty null stays unknown/in-stock for catalog
    if (qty != null) {
      return {
        availableForSale: qty > 0,
        inStock: qty > 0,
        inventoryQuantity: qty
      };
    }

    return {
      availableForSale: true,
      inStock: true,
      inventoryQuantity: null
    };
  };

  const resolveProductImageUrl = (product) => {
    if (product.image_url) return product.image_url;
    if (product.partImage) return product.partImage;
    if (product.image?.url) return product.image.url;
    if (product.featured_image?.url) return product.featured_image.url;

    // UCP search_catalog uses media[] (first image = featured)
    if (Array.isArray(product.media)) {
      const mediaImage = product.media.find(
        (item) => item?.url && (!item.type || item.type === "image")
      );
      if (mediaImage?.url) return mediaImage.url;
    }

    if (Array.isArray(product.images) && product.images.length) {
      const first = product.images[0];
      if (typeof first === "string") return first;
      if (first?.url) return first.url;
      if (first?.src) return first.src;
    }

    return "";
  };

  const formatMinorCurrencyAmount = (amount, currency) => {
    const zeroDecimalCurrencies = new Set(["JPY", "KRW", "VND"]);
    if (zeroDecimalCurrencies.has(currency)) {
      return String(amount);
    }

    return (Number(amount) / 100).toFixed(2);
  };

  const addToolResultToHistory = async (conversationHistory, toolUseId, content, conversationId) => {
    const toolResultMessage = {
      role: 'user',
      content: [{
        type: "tool_result",
        tool_use_id: toolUseId,
        content: content
      }]
    };

    conversationHistory.push(toolResultMessage);

    if (conversationId) {
      try {
        await saveMessage(conversationId, 'user', JSON.stringify(toolResultMessage.content));
      } catch (error) {
        console.error('Error saving tool result to database:', error);
      }
    }
  };

  return {
    handleToolError,
    handleToolSuccess,
    processProductSearchResult,
    addToolResultToHistory
  };
}

export default {
  createToolService,
  normalizeCatalogSearchArgs
};
