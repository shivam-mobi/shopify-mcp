import { generateAuthUrl } from "./auth.server";
import { getCustomerToken, storeMcpCallLog } from "./db.server";
import AppConfig from "./services/config.server";
import {
  getCatalogAccessToken,
  hasCatalogCredentials
} from "./services/catalog-auth.server";

/**
 * In-memory tools/list cache so we don't hit Shopify on every chat message.
 * Lives until process restart (no TTL).
 */
const toolsListCache = new Map();

function getCachedToolsList(endpoint) {
  if (!AppConfig.mcp.toolsListCacheEnabled) return null;
  const entry = toolsListCache.get(endpoint);
  return entry?.tools ?? null;
}

function setCachedToolsList(endpoint, tools) {
  if (!AppConfig.mcp.toolsListCacheEnabled) return;
  toolsListCache.set(endpoint, {
    tools: Array.isArray(tools) ? tools : []
  });
}

/**
 * Client for interacting with Model Context Protocol (MCP) API endpoints.
 * Manages connections to storefront, UCP, and customer MCP endpoints.
 */
class MCPClient {
  /**
   * @param {string} hostUrl - The base URL for the shop
   * @param {string} conversationId - ID for the current conversation
   * @param {string} shopId - ID of the Shopify shop
   * @param {string} customerMcpEndpoint - Customer account MCP endpoint
   * @param {{ buyerIp?: string|null }} [options]
   */
  constructor(hostUrl, conversationId, shopId, customerMcpEndpoint, { buyerIp = null } = {}) {
    this.tools = [];
    this.customerTools = [];
    this.storefrontTools = [];
    this.ucpTools = [];
    this.storefrontMcpEndpoint = `${hostUrl}/api/mcp`;
    this.ucpMcpEndpoint = `${hostUrl}/api/ucp/mcp`;
    this.ucpAgentProfile = AppConfig.mcp.ucpAgentProfile;
    /** Buyer IP for Token-tier UCP (Shopify-Buyer-IP header). */
    this.buyerIp = buyerIp || null;

    const accountHostUrl = hostUrl.replace(/(\.myshopify\.com)$/, ".account$1");
    this.customerMcpEndpoint = customerMcpEndpoint || `${accountHostUrl}/customer/api/mcp`;
    this.customerAccessToken = "";
    this.conversationId = conversationId;
    this.shopId = shopId;
  }

  async connectToCustomerServer() {
    try {
      console.log(`Connecting to customer MCP server at ${this.customerMcpEndpoint}`);

      if (this.conversationId) {
        const dbToken = await getCustomerToken(this.conversationId);

        if (dbToken?.accessToken) {
          this.customerAccessToken = dbToken.accessToken;
        } else {
          console.log("No token in database for conversation:", this.conversationId);
        }
      }

      const cached = getCachedToolsList(this.customerMcpEndpoint);
      if (cached) {
        console.log(`[mcp] customer tools/list cache hit (${cached.length} tools)`);
        this.customerTools = cached;
        this._mergeTools(cached);
        return cached;
      }

      const headers = {
        "Content-Type": "application/json",
        Authorization: this.customerAccessToken || ""
      };

      const response = await this._makeJsonRpcRequest(
        this.customerMcpEndpoint,
        "tools/list",
        {},
        headers
      );

      const toolsData = response.result?.tools || [];
      const customerTools = this._formatToolsData(toolsData);

      setCachedToolsList(this.customerMcpEndpoint, customerTools);
      this.customerTools = customerTools;
      this._mergeTools(customerTools);

      return customerTools;
    } catch (e) {
      console.error("Failed to connect to customer MCP server:", e);
      throw e;
    }
  }

  async connectToStorefrontServer() {
    try {
      console.log(`Connecting to storefront MCP server at ${this.storefrontMcpEndpoint}`);

      const cached = getCachedToolsList(this.storefrontMcpEndpoint);
      if (cached) {
        console.log(`[mcp] storefront tools/list cache hit (${cached.length} tools)`);
        this.storefrontTools = cached;
        this._mergeTools(cached);
        return cached;
      }

      const response = await this._makeJsonRpcRequest(
        this.storefrontMcpEndpoint,
        "tools/list",
        {},
        await this._agentMcpHeaders()
      );

      const toolsData = response.result?.tools || [];
      const storefrontTools = this._formatToolsData(toolsData);

      setCachedToolsList(this.storefrontMcpEndpoint, storefrontTools);
      this.storefrontTools = storefrontTools;
      this._mergeTools(storefrontTools);

      return storefrontTools;
    } catch (e) {
      console.error("Failed to connect to storefront MCP server:", e);
      throw e;
    }
  }

  async connectToUcpServer() {
    try {
      console.log(`Connecting to UCP MCP server at ${this.ucpMcpEndpoint}`);

      const cached = getCachedToolsList(this.ucpMcpEndpoint);
      if (cached) {
        console.log(`[mcp] ucp tools/list cache hit (${cached.length} tools)`);
        this.ucpTools = cached;
        this._mergeTools(cached, { preferNew: true });
        return cached;
      }

      const response = await this._makeJsonRpcRequest(
        this.ucpMcpEndpoint,
        "tools/list",
        {},
        await this._agentMcpHeaders()
      );

      const toolsData = response.result?.tools || [];
      const ucpTools = this._formatToolsData(toolsData, { stripUcpMeta: true });

      setCachedToolsList(this.ucpMcpEndpoint, ucpTools);
      this.ucpTools = ucpTools;
      this._mergeTools(ucpTools, { preferNew: true });

      return ucpTools;
    } catch (e) {
      console.warn("Failed to connect to UCP MCP server:", e.message);
      return [];
    }
  }

  async callTool(toolName, toolArgs) {
    if (this.customerTools.some((tool) => tool.name === toolName)) {
      return this.callCustomerTool(toolName, toolArgs);
    }

    if (this.ucpTools.some((tool) => tool.name === toolName)) {
      return this.callUcpTool(toolName, toolArgs);
    }

    if (this.storefrontTools.some((tool) => tool.name === toolName)) {
      return this.callStorefrontTool(toolName, toolArgs);
    }

    throw new Error(`Tool ${toolName} not found`);
  }

  async callStorefrontTool(toolName, toolArgs) {
    try {
      console.log("Calling storefront tool", toolName, toolArgs);

      const response = await this._makeJsonRpcRequest(
        this.storefrontMcpEndpoint,
        "tools/call",
        { name: toolName, arguments: toolArgs },
        await this._agentMcpHeaders()
      );

      return response.result || response;
    } catch (error) {
      if (error.status === 401 && hasCatalogCredentials()) {
        console.warn("[mcp] storefront 401 — refreshing catalog token and retrying");
        const response = await this._makeJsonRpcRequest(
          this.storefrontMcpEndpoint,
          "tools/call",
          { name: toolName, arguments: toolArgs },
          await this._agentMcpHeaders({ forceRefresh: true })
        );
        return response.result || response;
      }
      console.error(`Error calling storefront tool ${toolName}:`, error);
      throw error;
    }
  }

  async callUcpTool(toolName, toolArgs) {
    try {
      const argsWithMeta = this._injectUcpMeta(toolArgs);
      console.log("Calling UCP tool", toolName, argsWithMeta);

      const response = await this._makeJsonRpcRequest(
        this.ucpMcpEndpoint,
        "tools/call",
        { name: toolName, arguments: argsWithMeta },
        await this._agentMcpHeaders()
      );

      return response.result || response;
    } catch (error) {
      if (error.status === 401 && hasCatalogCredentials()) {
        console.warn("[mcp] UCP 401 — refreshing catalog token and retrying");
        const argsWithMeta = this._injectUcpMeta(toolArgs);
        const response = await this._makeJsonRpcRequest(
          this.ucpMcpEndpoint,
          "tools/call",
          { name: toolName, arguments: argsWithMeta },
          await this._agentMcpHeaders({ forceRefresh: true })
        );
        return response.result || response;
      }
      console.error(`Error calling UCP tool ${toolName}:`, error);
      throw error;
    }
  }

  /**
   * Headers for storefront + UCP MCP.
   * When CATALOG_CLIENT_ID/SECRET are set, attach Bearer (Token tier)
   * and Shopify-Buyer-IP (required by Shopify when authenticated).
   */
  async _agentMcpHeaders({ forceRefresh = false } = {}) {
    const headers = { "Content-Type": "application/json" };

    try {
      const token = await getCatalogAccessToken({ force: forceRefresh });
      if (token) {
        headers.Authorization = `Bearer ${token}`;
        const buyerIp =
          this.buyerIp ||
          AppConfig.mcp.catalog.buyerIpFallback ||
          "127.0.0.1";
        headers["Shopify-Buyer-IP"] = buyerIp;
      }
    } catch (error) {
      console.warn(
        "[mcp] catalog access_token unavailable — continuing without Bearer:",
        error.message
      );
    }

    return headers;
  }

  async callCustomerTool(toolName, toolArgs) {
    try {
      console.log("Calling customer tool", toolName, toolArgs);

      let accessToken = this.customerAccessToken;

      if (!accessToken) {
        const dbToken = await getCustomerToken(this.conversationId);

        if (dbToken?.accessToken) {
          accessToken = dbToken.accessToken;
          this.customerAccessToken = accessToken;
        } else {
          console.log("No token in database for conversation:", this.conversationId);
        }
      }

      const headers = {
        "Content-Type": "application/json",
        Authorization: accessToken
      };

      try {
        const response = await this._makeJsonRpcRequest(
          this.customerMcpEndpoint,
          "tools/call",
          { name: toolName, arguments: toolArgs },
          headers
        );

        return response.result || response;
      } catch (error) {
        if (error.status === 401) {
          console.log("Unauthorized, generating authorization URL for customer");

          const authResponse = await generateAuthUrl(this.conversationId, this.shopId);

          return {
            error: {
              type: "auth_required",
              data: `You need to authorize the app to access your customer data. [Click here to authorize](${authResponse.url})`
            }
          };
        }

        throw error;
      }
    } catch (error) {
      console.error(`Error calling customer tool ${toolName}:`, error);
      return {
        error: {
          type: "internal_error",
          data: `Error calling tool ${toolName}: ${error.message}`
        }
      };
    }
  }

  _injectUcpMeta(toolArgs = {}) {
    return {
      ...toolArgs,
      meta: {
        "ucp-agent": {
          profile: this.ucpAgentProfile
        }
      }
    };
  }

  _mergeTools(newTools, { preferNew = false } = {}) {
    for (const tool of newTools) {
      const existingIndex = this.tools.findIndex((existing) => existing.name === tool.name);

      if (existingIndex >= 0) {
        if (preferNew) {
          this.tools[existingIndex] = tool;
        }
        continue;
      }

      this.tools.push(tool);
    }
  }

  _stripUcpMetaFromSchema(schema) {
    if (!schema || typeof schema !== "object") {
      return schema;
    }

    const cleaned = { ...schema };

    if (cleaned.properties?.meta) {
      const { meta, ...remainingProperties } = cleaned.properties;
      cleaned.properties = remainingProperties;
    }

    if (Array.isArray(cleaned.required)) {
      cleaned.required = cleaned.required.filter((field) => field !== "meta");
      if (cleaned.required.length === 0) {
        delete cleaned.required;
      }
    }

    return cleaned;
  }

  async _makeJsonRpcRequest(endpoint, method, params, headers) {
    const startedAt = Date.now();
    const server = this._resolveMcpServer(endpoint);
    const toolName = method === "tools/call" ? params?.name : null;
    const sanitizedHeaders = this._sanitizeHeaders(headers);
    const requestPayload = {
      jsonrpc: "2.0",
      method,
      id: 1,
      params
    };

    let statusCode = 0;
    let responseBody = null;

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(requestPayload)
      });

      statusCode = response.status;

      if (!response.ok) {
        const errorText = await response.text();
        responseBody = { error: errorText };
        const errorObj = new Error(`Request failed: ${response.status} ${errorText}`);
        errorObj.status = response.status;
        throw errorObj;
      }

      responseBody = await response.json();
      return responseBody;
    } catch (error) {
      if (responseBody == null) {
        statusCode = Number.isInteger(error.status) ? error.status : 0;
        responseBody = { error: error.message };
      }

      throw error;
    } finally {
      if (AppConfig.mcp.logCalls) {
        const durationMs = Date.now() - startedAt;

        void storeMcpCallLog({
          conversationId: this.conversationId,
          server,
          method,
          toolName,
          endpoint,
          request: {
            headers: sanitizedHeaders,
            body: requestPayload
          },
          response: responseBody,
          statusCode,
          durationMs
        });
      }
    }
  }

  _resolveMcpServer(endpoint) {
    if (endpoint.includes("/ucp/mcp")) {
      return "ucp";
    }

    if (endpoint.includes("/customer/")) {
      return "customer";
    }

    return "storefront";
  }

  _sanitizeHeaders(headers = {}) {
    const sanitized = {};

    for (const [key, value] of Object.entries(headers)) {
      sanitized[key] = key.toLowerCase() === "authorization" ? "[REDACTED]" : value;
    }

    return sanitized;
  }

  _formatToolsData(toolsData, { stripUcpMeta = false } = {}) {
    return toolsData.map((tool) => {
      let inputSchema = tool.inputSchema || tool.input_schema;

      if (stripUcpMeta) {
        inputSchema = this._stripUcpMetaFromSchema(inputSchema);
      }

      return {
        name: tool.name,
        description: tool.description,
        input_schema: inputSchema
      };
    });
  }
}

export default MCPClient;

const MCP_WARMUP_KEY = "__shopAiMcpToolsWarmup";

/**
 * Discover Customer Account MCP URL the same way chat does (well-known).
 * @param {string} storefrontUrl e.g. https://manishclothes.myshopify.com
 * @returns {Promise<string|null>}
 */
export async function discoverCustomerMcpUrl(storefrontUrl) {
  const hostUrl = String(storefrontUrl || "").trim().replace(/\/+$/, "");
  if (!hostUrl) return null;

  const { hostname } = new URL(hostUrl);
  const response = await fetch(`https://${hostname}/.well-known/customer-account-api`, {
    headers: { Accept: "application/json" }
  });

  if (!response.ok) {
    throw new Error(
      `Customer account discovery failed: HTTP ${response.status} from https://${hostname}/.well-known/customer-account-api`
    );
  }

  const payload = await response.json();
  const mcpApi = String(payload?.mcp_api || "").trim();
  if (!mcpApi) {
    throw new Error(
      `Customer account discovery returned no mcp_api from https://${hostname}/.well-known/customer-account-api`
    );
  }

  return mcpApi.replace(/\/+$/, "");
}

/**
 * Prefetch storefront + UCP (+ customer) tools/list when the server starts.
 * Fail at boot so broken MCP is visible before shoppers hit chat.
 */
export async function warmMcpToolsAtStartup({
  failHard = AppConfig.mcp.warmupFailHard
} = {}) {
  if (!AppConfig.mcp.toolsListCacheEnabled || !AppConfig.mcp.warmupOnStart) {
    console.log("[mcp] startup tools warmup skipped (cache/warmup disabled)");
    return { skipped: true };
  }

  const hostUrl = String(
    process.env.STOREFRONT_URL ||
      process.env.SHOPIFY_STOREFRONT_URL ||
      ""
  )
    .trim()
    .replace(/\/+$/, "");

  if (!hostUrl) {
    const message =
      "[mcp] STOREFRONT_URL is required to warm MCP tools at startup";
    if (failHard) {
      throw new Error(message);
    }
    console.warn(message);
    return { skipped: true };
  }

  console.log(`[mcp] warming tools/list cache from ${hostUrl}`);

  if (hasCatalogCredentials()) {
    try {
      await getCatalogAccessToken({ force: true });
      console.log("[mcp] catalog Bearer token ready (Token tier)");
    } catch (tokenError) {
      console.warn(
        "[mcp] catalog Bearer token failed — UCP will run without Token tier:",
        tokenError.message
      );
    }
  } else {
    console.log("[mcp] CATALOG_CLIENT_ID/SECRET not set — UCP uses anonymous tier");
  }

  let customerMcpUrl = null;
  try {
    customerMcpUrl = await discoverCustomerMcpUrl(hostUrl);
    console.log(`[mcp] discovered customer MCP: ${customerMcpUrl}`);
  } catch (discoveryError) {
    if (AppConfig.mcp.warmupRequireCustomer && failHard) {
      throw new Error(`[mcp] customer discovery failed: ${discoveryError.message}`);
    }
    console.warn(`[mcp] customer discovery skipped: ${discoveryError.message}`);
  }

  const client = new MCPClient(hostUrl, "startup-warmup", null, customerMcpUrl, {
    buyerIp: AppConfig.mcp.catalog.buyerIpFallback || "127.0.0.1"
  });

  try {
    const storefrontTools = await client.connectToStorefrontServer();
    if (!storefrontTools.length) {
      throw new Error(`Storefront tools/list returned 0 tools from ${client.storefrontMcpEndpoint}`);
    }

    const ucpTools = await client.connectToUcpServer();
    if (!ucpTools.length) {
      throw new Error(`UCP tools/list returned 0 tools from ${client.ucpMcpEndpoint}`);
    }

    let customerCount = 0;
    if (customerMcpUrl) {
      const customerTools = await client.connectToCustomerServer();
      customerCount = customerTools.length;
      if (!customerCount && AppConfig.mcp.warmupRequireCustomer) {
        throw new Error(`Customer tools/list returned 0 tools from ${customerMcpUrl}`);
      }
    } else if (AppConfig.mcp.warmupRequireCustomer && failHard) {
      throw new Error("Customer MCP URL was not discovered at startup");
    }

    console.log(
      `[mcp] startup warmup ok — storefront:${storefrontTools.length} ucp:${ucpTools.length} customer:${customerCount}`
    );

    return {
      storefront: storefrontTools.length,
      ucp: ucpTools.length,
      customer: customerCount,
      customerMcpUrl
    };
  } catch (error) {
    console.error("[mcp] startup tools warmup FAILED:", error.message);
    if (failHard) {
      throw error;
    }
    return { error: error.message };
  }
}

/**
 * Start warmup once per process. Await before serving chat if fail-hard is on.
 */
export function ensureMcpToolsWarmed() {
  if (!globalThis[MCP_WARMUP_KEY]) {
    globalThis[MCP_WARMUP_KEY] = warmMcpToolsAtStartup()
      .then((result) => {
        if (result?.error) {
          throw new Error(result.error);
        }
        return result;
      })
      .catch((error) => {
        console.error("[mcp] fatal: cannot start without MCP tools —", error.message);
        process.exit(1);
      });
  }
  return globalThis[MCP_WARMUP_KEY];
}