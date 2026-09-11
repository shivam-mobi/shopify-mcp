/**
 * Tool Service
 * Manages tool execution and processing
 */
import { saveMessage } from "../db.server";
import AppConfig from "./config.server";
import { enrichProductsWithComparison, buildCompareAttributes, buildLlmProductSummary, buildProductListingMetadata, resolveProductVariantId, resolveProductDescriptionHtml } from "./product-compare.server.js";

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

  const handleToolSuccess = async (toolUseResponse, toolName, toolUseId, conversationHistory, productsToDisplay, conversationId) => {
    let historyContent = toolUseResponse.content;

    if (AppConfig.tools.productSearchNames.includes(toolName)) {
      const ranked = processProductSearchResult(toolUseResponse);
      if (ranked.length > 0) {
        productsToDisplay.push(...ranked);
        historyContent = buildProductSearchToolHistory(toolUseResponse, ranked, toolName);
      }
    }

    await addToolResultToHistory(conversationHistory, toolUseId, historyContent, conversationId);
  };

  const processProductSearchResult = (toolUseResponse) => {
    try {
      console.log("Processing product search result");
      const responseData = extractToolResponseData(toolUseResponse);
      const products = extractProductsFromResponse(responseData);

      const formatted = products.map(formatProductData);
      return enrichProductsWithComparison(formatted);
    } catch (error) {
      console.error("Error processing product search results:", error);
      return [];
    }
  };

  const buildProductSearchToolHistory = (toolUseResponse, rankedProducts, toolName) => {
    const originalData = extractToolResponseData(toolUseResponse) || {};
    const products = buildLlmProductSummary(rankedProducts);
    const listingMeta = buildProductListingMetadata(rankedProducts);

    const enriched = {
      status: originalData.status || "success",
      source: toolName,
      products,
      ...listingMeta,
      ui_instruction:
        originalData.ui_instruction ||
        "CRITICAL: Top Matching Products cards are already shown in chat. " +
        "FORBIDDEN in your reply: product names, prices, 'Priced at $…', descriptions, feature bullets, numbered product lists, or recommending a specific product by name. " +
        "Reply in 1-2 short sentences only (e.g. matching products were found), then ask if they want to add one to the cart."
    };

    console.log("[tool] enriched product listing for LLM history", {
      source: toolName,
      count: products.length,
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

  const formatProductData = (product) => {
    const variant = product.variants?.[0] || product.variant;
    const priceAmount = variant?.price?.amount ?? variant?.price;
    const priceCurrency = variant?.price?.currency ?? variant?.currency ?? product.price_range?.currency;

    let price = "Price not available";
    if (product.price && typeof product.price === "string") {
      price = product.price;
    } else if (priceAmount != null && priceCurrency) {
      const majorUnits = formatMinorCurrencyAmount(priceAmount, priceCurrency);
      price = `${priceCurrency} ${majorUnits}`;
    } else if (product.price_range) {
      price = `${product.price_range.currency} ${product.price_range.min}`;
    }

    const variantId = product.variantId || product.variant_id || variant?.id;
    const availability = resolveProductAvailability(product, variant);
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

    return {
      id: normalizedVariantId || product.product_id || product.id || product.partNumber || `product-${Math.random().toString(36).substring(7)}`,
      variantId: normalizedVariantId,
      variant_id: normalizedVariantId,
      title: product.title || product.partTypeName || product.name || "Product",
      price,
      priceAmount: typeof product.priceAmount === "number" ? product.priceAmount : null,
      compareAtPrice: product.compareAtPrice || null,
      image_url: resolveProductImageUrl(product),
      description: descriptionHtml,
      descriptionHtml,
      url: productUrl,
      availableForSale: availability.availableForSale,
      inStock: availability.inStock,
      inventoryQuantity: availability.inventoryQuantity,
      vendor,
      sku: product.sku || product.partNumber || "",
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
  createToolService
};
