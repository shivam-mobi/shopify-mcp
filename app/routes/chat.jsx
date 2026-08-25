/**
 * Chat API Route
 * Handles chat interactions with the configured LLM provider and tools
 */
import MCPClient from "../mcp-client";
import { saveMessage, getConversationHistory, storeCustomerAccountUrls, getCustomerAccountUrls as getCustomerAccountUrlsFromDb, getConversationCartId } from "../db.server";
import AppConfig from "../services/config.server";
import { createSseStream } from "../services/streaming.server";
import { createLlmService } from "../services/llm.server";
import { createToolService } from "../services/tool.server";
import { handleCartToolCall, isCartTool, buildActiveCartContextMessage } from "../services/cart.server";
import {
  getCartWrapperTools,
  isCartWrapperTool,
  callCartWrapperTool,
  filterCartToolsForLlm,
  buildShippingAddressHintMessage
} from "../services/cart-tools.server";
import { isFitmentConfigured } from "../fitment/database.server.js";
import {
  callFitmentTool,
  getFitmentTools,
  isFitmentTool
} from "../fitment/fitment-tools.server.js";


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
      JSON.stringify({ conversationStorage: AppConfig.chat.conversationStorage }),
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

  return new Response(JSON.stringify({ messages }), { headers: getCorsHeaders(request) });
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

  const mcpClient = new MCPClient(
    shopDomain,
    conversationId,
    shopId,
    mcpApiUrl,
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
    const cartWrapperTools = getCartWrapperTools();
    const mcpToolsForLlm = filterCartToolsForLlm(mcpClient.tools);
    const allTools = [...mcpToolsForLlm, ...cartWrapperTools, ...fitmentTools];

    console.log(`Total MCP tools available to LLM: ${mcpClient.tools.length} (${mcpToolsForLlm.length} after cart filter)`);
    console.log(`Cart wrapper tools: ${cartWrapperTools.length}`);
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

    // Save user message to the database
    await saveMessage(conversationId, 'user', userMessage);

    // Fetch all messages from the database for this conversation
    const dbMessages = await getConversationHistory(conversationId);

    // Format messages for the LLM provider
    conversationHistory = dbMessages.map(dbMessage => ({
      role: dbMessage.role,
      content: parseStoredMessageContent(dbMessage.content)
    }));

    const activeCartId = await getConversationCartId(conversationId);
    const activeCartContext = buildActiveCartContextMessage(activeCartId);
    if (activeCartContext) {
      conversationHistory.unshift(activeCartContext);
    }

    const shippingAddressHint = buildShippingAddressHintMessage(userMessage);
    if (shippingAddressHint) {
      conversationHistory.unshift(shippingAddressHint);
    }

    // Execute the conversation stream
    let finalMessage = { role: 'user', content: userMessage };

    while (finalMessage.stop_reason !== "end_turn") {
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
              stream.sendMessage({
                type: 'tool_use',
                tool_use_message: toolUseMessage
              });
            }

            // Route fitment tools locally; keep Shopify MCP tools unchanged
            let toolUseResponse;
            try {
              if (isFitmentTool(toolName)) {
                console.log("[chat] fitment tool invoke", { toolName, toolArgs, shop });
                toolUseResponse = await callFitmentTool(toolName, toolArgs, { shop });
                console.log("[chat] fitment tool success", { toolName });
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
              }
            } catch (historyError) {
              console.error("[chat] failed to record tool result", historyError);
              await toolService.addToolResultToHistory(
                conversationHistory,
                toolUseId,
                `Tool failed: ${historyError.message}`,
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
    }

    // Signal end of turn
    stream.sendMessage({ type: 'end_turn' });

    // Send product results if available
    if (productsToDisplay.length > 0) {
      console.log(
        "[chat] product_results to client:",
        productsToDisplay.map((p) => ({
          title: p.title,
          inStock: p.inStock,
          availableForSale: p.availableForSale,
          inventoryQuantity: p.inventoryQuantity
        }))
      );
      stream.sendMessage({
        type: 'product_results',
        products: productsToDisplay
      });
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
