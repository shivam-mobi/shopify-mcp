/**
 * Tool Service
 * Manages tool execution and processing
 */
import { saveMessage } from "../db.server";
import AppConfig from "./config.server";

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
    } else {
      console.log("Tool use error", toolUseResponse.error);
      await addToolResultToHistory(conversationHistory, toolUseId, toolUseResponse.error.data, conversationId);
    }
  };

  const handleToolSuccess = async (toolUseResponse, toolName, toolUseId, conversationHistory, productsToDisplay, conversationId) => {
    if (AppConfig.tools.productSearchNames.includes(toolName)) {
      productsToDisplay.push(...processProductSearchResult(toolUseResponse));
    }

    addToolResultToHistory(conversationHistory, toolUseId, toolUseResponse.content, conversationId);
  };

  const processProductSearchResult = (toolUseResponse) => {
    try {
      console.log("Processing product search result");
      const responseData = extractToolResponseData(toolUseResponse);
      const products = extractProductsFromResponse(responseData);

      return products
        .slice(0, AppConfig.tools.maxProductsToDisplay)
        .map(formatProductData);
    } catch (error) {
      console.error("Error processing product search results:", error);
      return [];
    }
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

  const formatProductData = (product) => {
    const variant = product.variants?.[0] || product.variant;
    const priceAmount = variant?.price?.amount ?? variant?.price;
    const priceCurrency = variant?.price?.currency ?? variant?.currency ?? product.price_range?.currency;

    let price = "Price not available";
    if (priceAmount != null && priceCurrency) {
      const majorUnits = formatMinorCurrencyAmount(priceAmount, priceCurrency);
      price = `${priceCurrency} ${majorUnits}`;
    } else if (product.price_range) {
      price = `${product.price_range.currency} ${product.price_range.min}`;
    }

    return {
      id: product.product_id || product.id || variant?.id || `product-${Math.random().toString(36).substring(7)}`,
      title: product.title || product.name || "Product",
      price,
      image_url: product.image_url || product.image?.url || product.featured_image?.url || "",
      description: product.description || "",
      url: product.url || product.online_store_url || ""
    };
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
