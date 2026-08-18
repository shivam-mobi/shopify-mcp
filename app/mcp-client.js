import { generateAuthUrl } from "./auth.server";
import { getCustomerToken } from "./db.server";
import AppConfig from "./services/config.server";

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
   */
  constructor(hostUrl, conversationId, shopId, customerMcpEndpoint) {
    this.tools = [];
    this.customerTools = [];
    this.storefrontTools = [];
    this.ucpTools = [];
    this.storefrontMcpEndpoint = `${hostUrl}/api/mcp`;
    this.ucpMcpEndpoint = `${hostUrl}/api/ucp/mcp`;
    this.ucpAgentProfile = AppConfig.mcp.ucpAgentProfile;

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

      const response = await this._makeJsonRpcRequest(
        this.storefrontMcpEndpoint,
        "tools/list",
        {},
        { "Content-Type": "application/json" }
      );

      const toolsData = response.result?.tools || [];
      const storefrontTools = this._formatToolsData(toolsData);

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

      const response = await this._makeJsonRpcRequest(
        this.ucpMcpEndpoint,
        "tools/list",
        {},
        { "Content-Type": "application/json" }
      );

      const toolsData = response.result?.tools || [];
      const ucpTools = this._formatToolsData(toolsData, { stripUcpMeta: true });

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
        { "Content-Type": "application/json" }
      );

      return response.result || response;
    } catch (error) {
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
        { "Content-Type": "application/json" }
      );

      return response.result || response;
    } catch (error) {
      console.error(`Error calling UCP tool ${toolName}:`, error);
      throw error;
    }
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
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        method,
        id: 1,
        params
      })
    });

    if (!response.ok) {
      const error = await response.text();
      const errorObj = new Error(`Request failed: ${response.status} ${error}`);
      errorObj.status = response.status;
      throw errorObj;
    }

    return await response.json();
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
