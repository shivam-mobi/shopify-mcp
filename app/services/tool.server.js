/**
 * Tool Service
 * Manages tool execution and processing
 */
import { saveMessage, setConversationCatalogPaginationCursor } from "../db.server.js";
import AppConfig from "./config.server.js";
import {
  extractCatalogPaginationCursorFromResponse,
  isCatalogSearchToolName
} from "./catalog-pagination.server.js";
import {
  enrichProductsWithComparison,
  buildLlmProductSummary,
  buildProductListingMetadata,
  resolveProductBrand,
  resolveProductVariantId,
  resolveProductDescriptionHtml,
  extractCatalogGenderFilter,
  filterProductsByCatalogGender
} from "./product-compare.server.js";
import { applyBuyNowUrlsToProducts } from "./shopify-prefilled-cart.server.js";
import { normalizeCatalogSearchArgs } from "./catalog-search-args.server.js";
import { parsePriceRange } from "./product-search/search-product.server.js";

export { normalizeCatalogSearchArgs };

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
      let ranked = processProductSearchResult(toolUseResponse, toolArgs, toolName);
      if (ranked.length > 0) {
        // Notes/reviews UI only for get_product_details — not browse listings
        if (toolName === "get_product_details") {
          ranked = ranked.map((product) => ({
            ...product,
            showDetailProfile: true
          }));
        }
        // Same brand the LLM history already computes (BRAND_* tags / vendor) — copy onto UI cards
        ranked = ranked.map((product) => {
          const brand = resolveProductBrand(product);
          if (!brand) return product;
          return {
            ...product,
            brand,
            vendor: product.vendor || brand
          };
        });
        ranked = await applyBuyNowUrlsToProducts(ranked, conversationId);

        if (toolName === "get_product_details") {
          const forUi = pickDetailProductsForUi(ranked, toolArgs);
          productsToDisplay.length = 0;
          productsToDisplay.push(...forUi);
        } else {
          productsToDisplay.push(...ranked);
        }
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

    if (conversationId && isCatalogSearchToolName(toolName)) {
      const cursor = extractCatalogPaginationCursorFromResponse(toolUseResponse);
      await setConversationCatalogPaginationCursor(conversationId, cursor);
    }

    await addToolResultToHistory(conversationHistory, toolUseId, historyContent, conversationId);
  };

  const processProductSearchResult = (toolUseResponse, toolArgs = null, toolName = null) => {
    try {
      const responseData = extractToolResponseData(toolUseResponse);
      const products = extractProductsFromResponse(responseData);
      // search_product echoes the filters/sort it applied; prefer those over the raw args.
      const applied = responseData?.applied;
      const priceFilter = extractPriceFilter(
        applied?.filters ? { filters: applied.filters } : toolArgs
      );
      const genderFilter = extractCatalogGenderFilter(toolArgs);

      const catalogProducts = genderFilter
        ? filterProductsByCatalogGender(products, genderFilter)
        : products;

      const sort = String(applied?.sort || toolArgs?.catalog?.sort || toolArgs?.sort || "").toLowerCase();
      const priceSort = sort === "price_asc" || sort === "price_desc" ? sort : null;
      const offerFilter =
        applied?.filters?.applicable_offer ||
        applied?.filters?.applicableOffer ||
        applied?.applicable_offer ||
        applied?.applicableOffer ||
        toolArgs?.filters?.applicable_offer ||
        toolArgs?.filters?.applicableOffer ||
        toolArgs?.applicable_offer ||
        toolArgs?.applicableOffer ||
        null;
      const formatted = catalogProducts
        .map((product) => formatProductData(product, priceFilter, priceSort, offerFilter))
        .filter(Boolean);
      if (priceFilter && formatted.length < catalogProducts.length) {
        console.warn("[tool] price filter hid cards the search returned — index may be stale, run npm run meili:sync", {
          priceFilter,
          returned: catalogProducts.length,
          shown: formatted.length
        });
      }

      return enrichProductsWithComparison(formatted);
    } catch (error) {
      console.error("Error processing product search results:", error);
      return [];
    }
  };

  const normalizeVariantGid = (value) => {
    const raw = String(value || "").trim();
    if (!raw) return "";
    const variantMatch = raw.match(/ProductVariant\/(\d+)/i);
    if (variantMatch) return variantMatch[1];
    return raw;
  };

  const extractDisplayVariantIds = (toolArgs) => {
    if (!toolArgs || typeof toolArgs !== "object") return [];
    const fromArgs = [
      ...(Array.isArray(toolArgs.display_ids) ? toolArgs.display_ids : []),
      ...(Array.isArray(toolArgs.display_variant_ids)
        ? toolArgs.display_variant_ids
        : [])
    ];
    return fromArgs.map(normalizeVariantGid).filter(Boolean);
  };

  const productVariantKey = (product) =>
    normalizeVariantGid(
      product?.variant_id || product?.variantId || product?.id
    );

  const filterProductsByVariantIds = (products, variantIds) => {
    if (!Array.isArray(products) || !products.length) return [];
    if (!Array.isArray(variantIds) || !variantIds.length) return products;

    const wanted = new Set(variantIds.map(normalizeVariantGid).filter(Boolean));
    const matched = products.filter((product) => {
      const id = productVariantKey(product);
      return id && wanted.has(id);
    });

    if (!matched.length) return products;

    const order = new Map(variantIds.map((id, index) => [normalizeVariantGid(id), index]));
    return matched.sort((a, b) => {
      const aKey = productVariantKey(a);
      const bKey = productVariantKey(b);
      return (order.get(aKey) ?? 0) - (order.get(bKey) ?? 0);
    });
  };

  /** Cards shown after get_product_details — driven by display_ids or full fetch set. */
  const pickDetailProductsForUi = (products, toolArgs) => {
    if (!Array.isArray(products) || !products.length) return [];

    const displayIds = extractDisplayVariantIds(toolArgs);
    if (displayIds.length) {
      return filterProductsByVariantIds(products, displayIds);
    }

    const maxUiCards = 10;
    return products.slice(0, maxUiCards);
  };

  /**
   * Budget from search tool args, in cents to match card variant prices.
   * The tool takes US dollars; parsePriceRange is the same parser the search uses.
   */
  const extractPriceFilter = (toolArgs) => {
    if (!toolArgs || typeof toolArgs !== "object") return null;
    const filters = toolArgs.catalog?.filters || toolArgs.filters || {};
    const range = parsePriceRange(filters.price, filters);
    if (!range) return null;
    return {
      min: range.min != null ? Math.round(range.min * 100) : null,
      max: range.max != null ? Math.round(range.max * 100) : null
    };
  };

  const isPriceInFilterRange = (priceCents, priceFilter) => {
    if (!priceFilter) return true;
    if (priceCents == null || !Number.isFinite(priceCents)) return false;
    if (priceFilter.min != null && priceCents < priceFilter.min) return false;
    if (priceFilter.max != null && priceCents > priceFilter.max) return false;
    return true;
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

    const searchNote = typeof originalData.note === "string" && originalData.note ? originalData.note : null;
    const matchInstruction = searchNote
      ? `FOLLOW the note field first: ${searchNote} `
      : rankedProducts.length > 0
        ? "Say matching products were found (generic only), then ask if they want to add one to the cart. Do NOT name brands, titles, or prices in this browse reply."
        : "No products to show: say you could not find a match and ask them to rephrase.";
    const isFirstPage = !originalData.pagination?.offset;
    const pageInstruction = !pagination
      ? ""
      : pagination.has_next_page
        ? ` If the customer asks for more products/results/next page, call ${toolName} again with the same query/filters plus pagination: { cursor } from THIS tool result. ` +
          "CRITICAL: copy the cursor EXACTLY as the full string value — do not truncate, rewrite, re-encode, shorten, or change any character. A single wrong character causes Malformed cursor and zero products."
        : rankedProducts.length > 0
          ? ` has_next_page is false: ${isFirstPage ? `these ${rankedProducts.length} are ALL the matching products` : "this is the last page"}. ` +
            `If the customer asks for more, do NOT call ${toolName} again with the same search; say that is everything for this search and offer to widen it (similar scents from other brands, or drop a filter).`
          : "";

    const enriched = {
      status: originalData.status || "success",
      source: toolName,
      ...(originalData.match_quality ? { match_quality: originalData.match_quality } : {}),
      ...(searchNote ? { note: searchNote } : {}),
      products,
      ...listingMeta,
      ...(pagination ? { pagination } : {}),
      result_count: products.length,
      ui_instruction:
        isDetail
          ? "get_product_details: Product Details cards are shown BELOW your text (listing cards above stay visible). products[] is INTERNAL ONLY — do not paste metafield lists into chat. " +
            "ids[] = batch fetch every variant you need from the latest search. display_ids[] = OPTIONAL UI subset when your answer focuses on specific product(s); copy GIDs exactly from ids[]. " +
            "When you name specific products in text, include each one's variant in display_ids (same count, max 5). Omit display_ids to show detail cards for all ids[] fetched. " +
            "Use this tool for ANY follow-up about shown products (reviews, scent, notes, compare, concentration, which one, etc.) — not only reviews. " +
            "Reply briefly in natural language; say full detail is in the cards below. NEVER say details are above."
          : "CRITICAL: Top Matching Products cards are shown BELOW your text in the UI (text first, then cards). products[] (price, tags, scent_notes, description) / cheapest_* are for YOUR use only (history). " +
            "DEFAULT browse reply: 1-2 short generic sentences only — FORBIDDEN to list product names, prices, bullets, or 'here are some options'. " +
            "Say cards are shown below (NEVER say above). " +
            "FOLLOW-UP on shown cards (reviews, scent/notes, compare, cheapest, which one, EDP/EDT, differences, gift fit, or any product question): call get_product_details ONCE with ids:[every variant_id needed from this products[]]; use display_ids only for the product(s) your answer highlights. " +
            "CHEAPEST / MOST EXPENSIVE (mandatory when asked): Use ONLY cheapest_title, cheapest_price, cheapest_position (or most_expensive_*) from THIS tool result — or read cheapest_answer / most_expensive_answer verbatim. " +
            "Compare every products[].price_amount_cents across ALL cards; the lowest wins even if another card shares the same brand name (e.g. first 'Sauvage' is NOT automatically cheapest). Do NOT guess from memory or an older search result. " +
            "Price-only cheapest/most expensive questions: answer in one short sentence from cheapest_* / most_expensive_* without calling get_product_details. " +
            "FOLLOW-UP — best / recommend / suggest: NEVER invent a universal best. If the customer gave a preference (floral, fresh, woody, daytime, evening, gift, EDP, women/men, budget), " +
            "pick ONE product from products[] using gender, fragrance_type, scent_notes, tags, description, and price; say why in one short sentence; offer to add it. " +
            "If they ask for the best with NO preference, ask one short preference question — do not pick randomly. " +
            "Never dump the full catalog list in chat. " +
            matchInstruction +
            pageInstruction
    };

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
    const listAmount =
      variant?.compare_at_price?.amount ??
      variant?.list_price?.amount ??
      variant?.compareAtPrice?.amount;
    const listCurrency =
      variant?.compare_at_price?.currency ??
      variant?.list_price?.currency ??
      variant?.compareAtPrice?.currency ??
      priceCurrency;
    if (listAmount != null && listCurrency && Number(listAmount) > 0) {
      compareAtPrice = `${listCurrency} ${formatMinorCurrencyAmount(listAmount, listCurrency)}`;
    }

    const optionLabel =
      variant.options?.[0]?.label ||
      variant.title ||
      variant.name ||
      "Option";

    const variantImage =
      (Array.isArray(variant.images) && variant.images[0]?.url) ||
      variant.image_url ||
      variant.image?.url ||
      (Array.isArray(variant.media) &&
        variant.media.find((item) => item?.url && (!item.type || item.type === "image"))?.url) ||
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
      checkout_url: variant.checkout_url || null,
      url: variant.url || null,
      title: optionLabel,
      label: optionLabel,
      position: variant.position ?? null,
      price,
      priceAmountCents:
        priceAmountCents != null && Number.isFinite(priceAmountCents)
          ? priceAmountCents
          : null,
      compareAtPrice,
      applicable_offer: variant.applicable_offer || null,
      available: availability.availableForSale !== false && availability.inStock !== false,
      availableForSale: availability.availableForSale,
      inStock: availability.inStock,
      inventoryQuantity: availability.inventoryQuantity,
      images: Array.isArray(variant.images) ? variant.images : (variantImage ? [{ url: variantImage, position: 1 }] : []),
      image_url: variantImage
    };
  };

  /**
   * Format a catalog product for chat cards.
   * When priceFilter is set: default to the cheapest in-stock variant in range (dearest for
   * price_desc); drop the product (return null) if none. Without a budget, price sorts still
   * preselect the cheapest / dearest in-stock size so the card matches the list order.
   * All variants stay on the card (selectable).
   */
  const formatProductData = (product, priceFilter = null, priceSort = null, offerFilter = null) => {
    const byPrice = (a, b) => {
      const diff =
        (a.priceAmountCents ?? Number.POSITIVE_INFINITY) -
        (b.priceAmountCents ?? Number.POSITIVE_INFINITY);
      return priceSort === "price_desc" ? -diff : diff;
    };
    const rawVariants = Array.isArray(product.variants)
      ? product.variants
      : product.variant
        ? [product.variant]
        : [];

    const variants = rawVariants
      .map((variant) => formatVariantOption(variant, product))
      .filter(Boolean);

    const normalizeOffer = (val) => String(val || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
    const requestedOffer = offerFilter || null;
    const productOffer = product.applicable_offer || product.applicableOffer || null;

    const variantMatchesOffer = (v, offer) => {
      if (!v) return false;
      const vOffer = normalizeOffer(v.applicable_offer || v.applicableOffer);
      if (!vOffer) return false;
      if (!offer) return true;
      return vOffer === normalizeOffer(offer);
    };

    let selectedVariant = null;

    if (priceFilter) {
      // 1. Budget is active (e.g. under $30 or $40)
      const inRangeAvailable = variants.filter(
        (variant) =>
          variant.available &&
          isPriceInFilterRange(variant.priceAmountCents, priceFilter)
      );

      // If no in-stock size is within the requested budget/min, drop this product
      if (inRangeAvailable.length === 0) {
        return null;
      }

      // If an offer was requested (or product has an offer), prefer an in-range size with that offer
      const targetOffer = requestedOffer || productOffer;
      const inRangeWithOffer = targetOffer
        ? inRangeAvailable.filter((v) => variantMatchesOffer(v, targetOffer))
        : [];

      if (inRangeWithOffer.length > 0) {
        selectedVariant = inRangeWithOffer.slice().sort(byPrice)[0];
      } else {
        selectedVariant = inRangeAvailable.slice().sort(byPrice)[0];
      }

      // Sort chips: in-range in-stock first (in selection order), then the rest
      variants.sort((a, b) => {
        const aIn = a.available && isPriceInFilterRange(a.priceAmountCents, priceFilter);
        const bIn = b.available && isPriceInFilterRange(b.priceAmountCents, priceFilter);
        if (aIn !== bIn) return aIn ? -1 : 1;
        return byPrice(a, b);
      });
    } else if (requestedOffer) {
      // 2. No price filter, but the shopper specifically asked for a promotion (e.g. "2 for $75 offer")
      const offerAvailable = variants.filter(
        (variant) => variant.available && variantMatchesOffer(variant, requestedOffer)
      );

      if (offerAvailable.length > 0) {
        selectedVariant = priceSort ? offerAvailable.slice().sort(byPrice)[0] : offerAvailable[0];
      } else {
        // If all sizes with the requested offer are OOS, still preselect it so user sees the deal and OOS status
        const offerAny = variants.filter((v) => variantMatchesOffer(v, requestedOffer));
        if (offerAny.length > 0) {
          selectedVariant = offerAny[0];
        }
      }
    } else if (priceSort) {
      // 3. Sorted by price (e.g. cheap to expensive)
      selectedVariant =
        variants.filter((variant) => variant.available).sort(byPrice)[0] ||
        variants[0] ||
        null;
    } else {
      // 4. Default browse / search: prefer variant with active offer if available, else first in-stock
      const offerAvailable = productOffer
        ? variants.filter((v) => v.available && variantMatchesOffer(v, productOffer))
        : [];
      selectedVariant =
        offerAvailable[0] ||
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

    const brand = resolveProductBrand({
      brand: product.brand,
      vendor: product.vendor || variant?.product?.vendor || "",
      tags: product.tags || variant?.tags,
      attributes: product.attributes
    });
    const vendor = brand || product.vendor || variant?.product?.vendor || "";

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
      brand,
      sku: product.sku || product.partNumber || selectedVariant?.sku || "",
      productType: product.productType || product.product_type || "",
      product_type: product.product_type || product.productType || "",
      tags: Array.isArray(product.tags) ? product.tags : product.tags,
      similarity:
        typeof product.similarity === "number" && Number.isFinite(product.similarity)
          ? product.similarity
          : Number.isFinite(Number(product.similarity))
            ? Number(product.similarity)
            : Number.isFinite(Number(product.score))
              ? Number(product.score)
              : null,
      match_type: product.match_type || null,
      fragrance_family: product.fragrance_family || null,
      scent_type: product.scent_type || null,
      applicable_offer: selectedVariant?.applicable_offer || product.applicable_offer || null,
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
      checkout_url:
        selectedVariant?.checkout_url ||
        product.checkout_url ||
        variant?.checkout_url ||
        null
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
