/**
 * Chat API Route
 * Handles chat interactions with the configured LLM provider and tools
 */
import MCPClient, { ensureMcpToolsWarmed } from "../mcp-client";
import { saveMessage, getConversationHistory, storeCustomerAccountUrls, getCustomerAccountUrls as getCustomerAccountUrlsFromDb, getConversationCartId } from "../db.server";
import AppConfig from "../services/config.server";
import { createSseStream } from "../services/streaming.server";
import { createLlmService } from "../services/llm.server";
import { createToolService } from "../services/tool.server";
import { handleCartToolCall, isCartTool, buildActiveCartContextMessage } from "../services/cart.server";
import {
  getCartWrapperTools,
  isCartWrapperTool,
  isCartMutationTool,
  callCartWrapperTool,
  appendFinalCartSnapshot,
  filterCartToolsForLlm,
  buildShippingAddressHintMessage,
  buildShippingEmailHintMessage
} from "../services/cart-tools.server";
import { isFitmentConfigured } from "../fitment/database.server.js";
import {
  callFitmentTool,
  getFitmentTools,
  isFitmentTool
} from "../fitment/fitment-tools.server.js";
import {
  callCatalogBrowseTool,
  getCatalogBrowseTools,
  isCatalogBrowseTool,
  buildCatalogBrowseHintMessage
} from "../services/catalog-browse-tools.server.js";
import { enrichProductsWithComparison } from "../services/product-compare.server.js";
import { buildStoreHelpHintMessage } from "../services/store-help-hints.server.js";


/**
 * Rract Router loader function for handling GET requests
 */
export async function loader({ request }) {
  // Handle OPTIONS requests (CORS preflight)
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: getCorsHeaders(request)
    });
  }

  const url = new URL(request.url);

  // Public storefront config (conversation persistence, etc.)
  if (url.searchParams.get("config") === "true") {
    return new Response(
      JSON.stringify({
        conversationStorage: AppConfig.chat.conversationStorage,
        showToolCallsInChat: AppConfig.tools.showToolCallsInChat
      }),
      { headers: getCorsHeaders(request) }
    );
  }

  // Handle history fetch requests - matches /chat?history=true&conversation_id=XYZ
  if (url.searchParams.has('history') && url.searchParams.has('conversation_id')) {
    return handleHistoryRequest(request, url.searchParams.get('conversation_id'));
  }

  // Handle SSE requests
  if (!url.searchParams.has('history') && request.headers.get("Accept") === "text/event-stream") {
    return handleChatRequest(request);
  }

  // API-only: reject all other requests
  return new Response(JSON.stringify({ error: AppConfig.errorMessages.apiUnsupported }), { status: 400, headers: getCorsHeaders(request) });
}

/**
 * React Router action function for handling POST requests
 */
export async function action({ request }) {
  return handleChatRequest(request);
}

/**
 * Handle history fetch requests
 * @param {Request} request - The request object
 * @param {string} conversationId - The conversation ID
 * @returns {Response} JSON response with chat history
 */
async function handleHistoryRequest(request, conversationId) {
  const messages = await getConversationHistory(conversationId);
  const toolService = createToolService();
  const enrichedMessages = enrichHistoryWithProductResults(messages, toolService);

  return new Response(JSON.stringify({ messages: enrichedMessages }), { headers: getCorsHeaders(request) });
}

/**
 * Handle chat requests (both GET and POST)
 * @param {Request} request - The request object
 * @returns {Response} Server-sent events stream
 */
async function handleChatRequest(request) {
  try {
    // Get message data from request body
    const body = await request.json();
    const userMessage = body.message;

    // Validate required message
    if (!userMessage) {
      return new Response(
        JSON.stringify({ error: AppConfig.errorMessages.missingMessage }),
        { status: 400, headers: getSseHeaders(request) }
      );
    }

    // Generate or use existing conversation ID
    const conversationId = body.conversation_id || Date.now().toString();
    const promptType = body.prompt_type || AppConfig.api.defaultPromptType;

    // Create a stream for the response
    const responseStream = createSseStream(async (stream) => {
      await handleChatSession({
        request,
        userMessage,
        conversationId,
        promptType,
        stream
      });
    });

    return new Response(responseStream, {
      headers: getSseHeaders(request)
    });
  } catch (error) {
    console.error('Error in chat request handler:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: getCorsHeaders(request)
    });
  }
}

/**
 * Handle a complete chat session
 * @param {Object} params - Session parameters
 * @param {Request} params.request - The request object
 * @param {string} params.userMessage - The user's message
 * @param {string} params.conversationId - The conversation ID
 * @param {string} params.promptType - The prompt type
 * @param {Object} params.stream - Stream manager for sending responses
 */
async function handleChatSession({
  request,
  userMessage,
  conversationId,
  promptType,
  stream
}) {
  // Initialize services
  const llmService = createLlmService();
  const toolService = createToolService();

  // Initialize MCP client
  await ensureMcpToolsWarmed();

  const shopId = request.headers.get("X-Shopify-Shop-Id");
  const shopDomainHeader = request.headers.get("X-Shopify-Shop-Domain");
  const shopDomain = request.headers.get("Origin");
  // Admin API requires *.myshopify.com — never pass a custom storefront domain.
  const shop = resolveAdminShopDomain({
    shopDomainHeader,
    origin: shopDomain
  });
  console.log("[chat] shop resolve:", {
    shopDomainHeader,
    origin: shopDomain,
    adminShop: shop
  });
  const customerAccountUrls = await getCustomerAccountUrls(shopDomain, conversationId);
  const mcpApiUrl = customerAccountUrls?.mcpApiUrl ?? null;
  const buyerIp = getBuyerIpFromRequest(request);

  const mcpClient = new MCPClient(
    shopDomain,
    conversationId,
    shopId,
    mcpApiUrl,
    { buyerIp }
  );

  try {
    // Send conversation ID to client
    stream.sendMessage({ type: 'id', conversation_id: conversationId });

    // Connect to MCP servers and get available tools
    let storefrontMcpTools = [], ucpMcpTools = [], customerMcpTools = [];

    try {
      ucpMcpTools = await mcpClient.connectToUcpServer();
      console.log(`Connected to UCP MCP with ${ucpMcpTools.length} tools`);
    } catch (error) {
      console.warn('Failed to connect to UCP MCP server:', error.message);
    }

    try {
      storefrontMcpTools = await mcpClient.connectToStorefrontServer();
      console.log(`Connected to storefront MCP with ${storefrontMcpTools.length} tools`);
    } catch (error) {
      console.warn('Failed to connect to storefront MCP server:', error.message);
    }

    try {
      customerMcpTools = await mcpClient.connectToCustomerServer();
      console.log(`Connected to customer MCP with ${customerMcpTools.length} tools`);
    } catch (error) {
      console.warn('Failed to connect to customer MCP server:', error.message);
    }

    const fitmentTools = isFitmentConfigured() ? getFitmentTools() : [];
    const catalogBrowseTools = getCatalogBrowseTools();
    const cartWrapperTools = getCartWrapperTools();
    const mcpToolsForLlm = filterCartToolsForLlm(mcpClient.tools);
    const allTools = [...mcpToolsForLlm, ...cartWrapperTools, ...fitmentTools, ...catalogBrowseTools];

    console.log(`Total MCP tools available to LLM: ${mcpClient.tools.length} (${mcpToolsForLlm.length} after cart filter)`);
    console.log(`Cart wrapper tools: ${cartWrapperTools.length}`);
    console.log(`Catalog browse tools: ${catalogBrowseTools.length}`);
    if (fitmentTools.length) {
      console.log(`Fitment tools enabled: ${fitmentTools.length}`);
    }
    console.log(`Combined tools available to LLM: ${allTools.length}`);

    if (allTools.length === 0) {
      console.warn('No tools available for this chat session');
    }

    // Prepare conversation state
    let conversationHistory = [];
    let productsToDisplay = [];
    let fitmentOptionsToDisplay = null;

    // Save user message to the database
    await saveMessage(conversationId, 'user', userMessage);

    // Fetch all messages from the database for this conversation
    const dbMessages = await getConversationHistory(conversationId);

    // Format messages for the LLM provider (skip UI-only product carousels)
    conversationHistory = dbMessages
      .map((dbMessage) => ({
        role: dbMessage.role,
        content: parseStoredMessageContent(dbMessage.content)
      }))
      .filter((msg) => !isProductResultsOnlyMessage(msg.content))
      .map((msg) => ({
        ...msg,
        content: stripProductResultsBlocks(msg.content)
      }))
      .filter((msg) => {
        if (Array.isArray(msg.content) && msg.content.length === 0) return false;
        return true;
      });

    const activeCartId = await getConversationCartId(conversationId);
    const activeCartContext = buildActiveCartContextMessage(activeCartId);
    if (activeCartContext) {
      conversationHistory.unshift(activeCartContext);
    }

    const shippingAddressHint = buildShippingAddressHintMessage(userMessage);
    if (shippingAddressHint) {
      conversationHistory.unshift(shippingAddressHint);
    }

    const shippingEmailHint = buildShippingEmailHintMessage(userMessage);
    if (shippingEmailHint) {
      conversationHistory.unshift(shippingEmailHint);
    }

    const storeHelpHint = buildStoreHelpHintMessage(userMessage);
    if (storeHelpHint) {
      conversationHistory.unshift(storeHelpHint);
    }

    const catalogBrowseHint = buildCatalogBrowseHintMessage(userMessage, conversationHistory);
    if (catalogBrowseHint) {
      conversationHistory.unshift(catalogBrowseHint);
    }

    // Execute the conversation stream
    let finalMessage = { role: 'user', content: userMessage };

    while (finalMessage.stop_reason !== "end_turn") {
      let cartMutatedThisTurn = false;

      finalMessage = await llmService.streamConversation(
        {
          messages: conversationHistory,
          promptType,
          tools: allTools
        },
        {
          // Handle text chunks
          onText: (textDelta) => {
            stream.sendMessage({
              type: 'chunk',
              chunk: textDelta
            });
          },

          // Handle complete messages
          onMessage: (message) => {
            conversationHistory.push({
              role: message.role,
              content: message.content
            });

            saveMessage(conversationId, message.role, JSON.stringify(message.content))
              .catch((error) => {
                console.error("Error saving message to database:", error);
              });

            // Send a completion message
            stream.sendMessage({ type: 'message_complete' });
          },

          // Handle tool use requests
          onToolUse: async (content) => {
            const toolName = content.name;
            const toolArgs = content.input;
            const toolUseId = content.id;

            const toolUseMessage = `Calling tool: ${toolName} with arguments: ${JSON.stringify(toolArgs)}`;

            if (AppConfig.tools.showToolCallsInChat) {
              console.log("[chat] tool_use SSE → client", { toolName, toolArgs });
              stream.sendMessage({
                type: 'tool_use',
                tool_use_message: toolUseMessage,
                tool_name: toolName
              });
            }

            // Route fitment tools locally; keep Shopify MCP tools unchanged
            let toolUseResponse;
            try {
              if (isFitmentTool(toolName)) {
                console.log("[chat] fitment tool invoke", { toolName, toolArgs, shop });
                toolUseResponse = await callFitmentTool(toolName, toolArgs, { shop, conversationId });
                console.log("[chat] fitment tool success", { toolName });
              } else if (isCatalogBrowseTool(toolName)) {
                console.log("[chat] catalog browse invoke", { toolName, toolArgs, shop });
                toolUseResponse = await callCatalogBrowseTool(toolName, toolArgs, {
                  shop,
                  conversationId,
                  messages: conversationHistory,
                  currentUserMessage: userMessage
                });
                console.log("[chat] catalog browse success", { toolName });
              } else if (isCartWrapperTool(toolName)) {
                console.log("[chat] cart wrapper invoke", { toolName, toolArgs });
                toolUseResponse = await callCartWrapperTool(
                  mcpClient,
                  conversationId,
                  toolName,
                  toolArgs,
                  { userMessage }
                );
              } else if (isCartTool(toolName)) {
                toolUseResponse = await handleCartToolCall(
                  mcpClient,
                  conversationId,
                  toolName,
                  toolArgs,
                  { userMessage }
                );
              } else {
                toolUseResponse = await mcpClient.callTool(toolName, toolArgs);
              }
            } catch (error) {
              console.error("[chat] tool catch", {
                toolName,
                toolArgs,
                shop,
                message: error.message,
                code: error.code,
                errno: error.errno,
                address: error.address,
                port: error.port,
                syscall: error.syscall,
                stack: error.stack
              });
              toolUseResponse = {
                error: {
                  type: "internal_error",
                  data: `Tool failed: ${error.message}`
                }
              };
            }

            // Always record a tool result so OpenAI history stays valid
            try {
              if (toolUseResponse?.error) {
                await toolService.handleToolError(
                  toolUseResponse,
                  toolName,
                  toolUseId,
                  conversationHistory,
                  stream.sendMessage,
                  conversationId
                );
              } else {
                await toolService.handleToolSuccess(
                  toolUseResponse,
                  toolName,
                  toolUseId,
                  conversationHistory,
                  productsToDisplay,
                  conversationId
                );

                if (isCartMutationTool(toolName) && !toolUseResponse?.error) {
                  cartMutatedThisTurn = true;
                }

                const choiceOptions = toolService.extractFitmentChoiceOptions(toolUseResponse);
                if (choiceOptions?.options?.length) {
                  fitmentOptionsToDisplay = choiceOptions;
                }
              }
            } catch (historyError) {
              console.error("[chat] failed to record tool result", historyError);
              await toolService.handleToolError(
                {
                  error: {
                    type: "internal_error",
                    data: historyError.message
                  }
                },
                toolName,
                toolUseId,
                conversationHistory,
                stream.sendMessage,
                conversationId
              );
            }

            // Signal new message to client
            stream.sendMessage({ type: 'new_message' });
          },

          // Handle content block completion
          onContentBlock: (contentBlock) => {
            if (contentBlock.type === 'text') {
              stream.sendMessage({
                type: 'content_block_complete',
                content_block: contentBlock
              });
            }
          }
        }
      );

      if (cartMutatedThisTurn) {
        await appendFinalCartSnapshot(mcpClient, conversationId, conversationHistory);
      }
    }

    // Signal end of turn
    stream.sendMessage({ type: 'end_turn' });

    // Clickable engine / qualifier choices (after assistant text)
    if (fitmentOptionsToDisplay?.options?.length) {
      stream.sendMessage({
        type: 'fitment_options',
        field: fitmentOptionsToDisplay.field,
        title: fitmentOptionsToDisplay.title,
        options: fitmentOptionsToDisplay.options
      });
    }

    // Send product results if available
    if (productsToDisplay.length > 0) {
      productsToDisplay = enrichProductsWithComparison(productsToDisplay);
      console.log(
        "[chat] product_results to client:",
        productsToDisplay.map((p) => ({
          title: p.title,
          inStock: p.inStock,
          filterType: p.filterType,
          isBest: p.isBest,
          compareScore: p.compareScore
        }))
      );
      stream.sendMessage({
        type: 'product_results',
        products: productsToDisplay
      });

      // Persist so product cards restore after page refresh
      try {
        await saveMessage(
          conversationId,
          "assistant",
          JSON.stringify([{ type: "product_results", products: productsToDisplay }])
        );
      } catch (persistError) {
        console.error("[chat] failed to persist product_results", persistError);
      }
    }
  } catch (error) {
    // The streaming handler takes care of error handling
    throw error;
  }
}

/**
 * Get the customer MCP API URL for a shop
 * @param {string} shopDomain - The shop domain
 * @param {string} conversationId - The conversation ID
 * @returns {string} The customer MCP API URL
 */
async function getCustomerAccountUrls(shopDomain, conversationId) {
  try {
    // Check if the customer account URL exists in the DB
    const existingUrls = await getCustomerAccountUrlsFromDb(conversationId);

    // If URL exists, return early with the MCP API URL
    if (existingUrls) return existingUrls;

    // If not, query for it from the Shopify API
    const { hostname } = new URL(shopDomain);

    const urls = await Promise.all([
      fetch(`https://${hostname}/.well-known/customer-account-api`).then(res => res.json()),
      fetch(`https://${hostname}/.well-known/openid-configuration`).then(res => res.json()),
    ]).then(async ([mcpResponse, openidResponse]) => {
      const response = {
        mcpApiUrl: mcpResponse.mcp_api,
        authorizationUrl: openidResponse.authorization_endpoint,
        tokenUrl: openidResponse.token_endpoint,
      };

      await storeCustomerAccountUrls({
        conversationId,
        mcpApiUrl: mcpResponse.mcp_api,
        authorizationUrl: openidResponse.authorization_endpoint,
        tokenUrl: openidResponse.token_endpoint,
      });

      return response;
    });

    return urls;
  } catch (error) {
    console.warn("Error getting customer MCP API URL (customer accounts may be disabled):", error.message);
    return null;
  }
}

/**
 * Extract hostname from Origin URL or bare shop domain header.
 */
function getShopHostname(origin) {
  if (!origin) return null;

  const value = String(origin).trim();
  if (!value) return null;

  // Already a bare hostname (e.g. store.myshopify.com from theme)
  if (!value.includes("://") && /^[a-z0-9.-]+$/i.test(value)) {
    return value.toLowerCase();
  }

  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isMyshopifyDomain(hostname) {
  return Boolean(hostname && /\.myshopify\.com$/i.test(hostname));
}

/**
 * Admin API / offline sessions only accept *.myshopify.com shop args.
 * Prefer theme permanent_domain header, then env, never a custom domain like pureflowair.com.
 */
function resolveAdminShopDomain({ shopDomainHeader, origin } = {}) {
  const fromHeader = getShopHostname(shopDomainHeader);
  if (isMyshopifyDomain(fromHeader)) {
    return fromHeader;
  }

  const fromOrigin = getShopHostname(origin);
  if (isMyshopifyDomain(fromOrigin)) {
    return fromOrigin;
  }

  const fromEnv = getShopHostname(
    process.env.SHOPIFY_STORE_DOMAIN || process.env.SHOPIFY_SHOP || ""
  );
  if (isMyshopifyDomain(fromEnv)) {
    return fromEnv;
  }

  console.warn("[chat] No valid *.myshopify.com shop for Admin API", {
    shopDomainHeader,
    origin,
    envShop: process.env.SHOPIFY_STORE_DOMAIN || process.env.SHOPIFY_SHOP || null
  });
  return null;
}

function parseStoredMessageContent(raw) {
  if (raw == null) return "";
  if (typeof raw !== "string") return raw;

  const trimmed = raw.trim();
  if (!trimmed) return raw;

  // Years like "2005" are valid JSON numbers. Keep them as plain text
  // so Gemini still sees a user turn.
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return raw;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return raw;
  }
}

function isProductResultsOnlyMessage(content) {
  if (!Array.isArray(content) || content.length === 0) return false;
  return content.every((block) => block?.type === "product_results");
}

function stripProductResultsBlocks(content) {
  if (!Array.isArray(content)) return content;
  return content.filter((block) => block?.type !== "product_results");
}

/**
 * Restore product carousels in history.
 * Prefers saved product_results messages; for older chats, rebuilds from tool_result payloads.
 */
function enrichHistoryWithProductResults(messages, toolService) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;

  const hasSavedProductResults = messages.some((message) => {
    const content = parseStoredMessageContent(message.content);
    return Array.isArray(content) && content.some((block) => block?.type === "product_results");
  });

  if (hasSavedProductResults) {
    return messages;
  }

  const out = [];
  let pendingProducts = [];

  const flushPendingProducts = (afterMessage) => {
    if (pendingProducts.length === 0) return;

    const seen = new Set();
    const unique = pendingProducts.filter((product) => {
      const key = String(product.id || product.title || "");
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    unique.sort((a, b) => Number(b.inStock === true) - Number(a.inStock === true));
    pendingProducts = [];

    if (unique.length === 0) return;

    out.push({
      id: `ui-products-${afterMessage?.id || out.length}`,
      conversationId: afterMessage?.conversationId,
      role: "assistant",
      content: JSON.stringify([{ type: "product_results", products: unique }]),
      createdAt: afterMessage?.createdAt || new Date().toISOString()
    });
  };

  for (const message of messages) {
    const content = parseStoredMessageContent(message.content);

    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type !== "tool_result") continue;

        const toolContent = block.content;
        const normalizedContent = Array.isArray(toolContent)
          ? toolContent
          : typeof toolContent === "string"
            ? [{ type: "text", text: toolContent }]
            : toolContent;

        const products = toolService.processProductSearchResult({
          content: normalizedContent
        });
        if (products.length > 0) {
          pendingProducts.push(...products);
        }
      }
    }

    out.push(message);

    const hasAssistantText = message.role === "assistant" && (
      (Array.isArray(content) && content.some((block) => block?.type === "text" && block.text)) ||
      (typeof content === "string" && content.trim().length > 0)
    );

    if (hasAssistantText) {
      flushPendingProducts(message);
    }
  }

  flushPendingProducts(messages[messages.length - 1]);
  return out;
}

/**
 * Buyer IP for Shopify Token-tier UCP (Shopify-Buyer-IP header).
 * @param {Request} request
 * @returns {string|null}
 */
function getBuyerIpFromRequest(request) {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }

  const realIp = request.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;

  const cfIp = request.headers.get("cf-connecting-ip")?.trim();
  if (cfIp) return cfIp;

  const ngrokIp = request.headers.get("x-forwarded-for") ||
    request.headers.get("fly-client-ip") ||
    request.headers.get("true-client-ip");
  if (ngrokIp) {
    return String(ngrokIp).split(",")[0].trim();
  }

  return null;
}

/**
 * Gets CORS headers for the response
 * @param {Request} request - The request object
 * @returns {Object} CORS headers object
 */
function getCorsHeaders(request) {
  const origin = request.headers.get("Origin") || "*";
  const requestHeaders = request.headers.get("Access-Control-Request-Headers") || "Content-Type, Accept";

  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": requestHeaders,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Max-Age": "86400" // 24 hours
  };
}

/**
 * Get SSE headers for the response
 * @param {Request} request - The request object
 * @returns {Object} SSE headers object
 */
function getSseHeaders(request) {
  const origin = request.headers.get("Origin") || "*";

  return {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,OPTIONS,POST",
    "Access-Control-Allow-Headers": "X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version"
  };
}
