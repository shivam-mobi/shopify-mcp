/**
 * Configuration Service
 * Centralizes all configuration values for the chat service
 */

const providerName = (process.env.LLM_PROVIDER || "gemini").toLowerCase();

export const AppConfig = {
  api: {
    provider: providerName,
    defaultPromptType: "standardAssistant",
    maxTokens: Number(process.env.LLM_MAX_TOKENS || 2000),
    providers: {
      gemini: {
        name: "gemini",
        displayName: "Gemini",
        model: process.env.GEMINI_MODEL || "gemini-3.6-flash",
        apiKeyEnv: "GEMINI_API_KEY"
      },
      claude: {
        name: "claude",
        displayName: "Claude",
        model: process.env.CLAUDE_MODEL || "claude-sonnet-4-20250514",
        apiKeyEnv: "CLAUDE_API_KEY"
      },
      openai: {
        name: "openai",
        displayName: "OpenAI",
        model: process.env.OPENAI_MODEL || "gpt-4o",
        apiKeyEnv: "OPENAI_API_KEY"
      }
    }
  },

  errorMessages: {
    missingMessage: "Message is required",
    apiUnsupported: "This endpoint only supports server-sent events (SSE) requests or history requests.",
    authFailed: "Authentication failed with the LLM provider",
    apiKeyError: "Please check your LLM API key in environment variables",
    rateLimitExceeded: "Rate limit exceeded",
    rateLimitDetails: "Please try again later",
    genericError: "Failed to get a response from the LLM provider"
  },

  mcp: {
    ucpAgentProfile: process.env.UCP_AGENT_PROFILE ||
      "https://shopify.dev/ucp/agent-profiles/examples/2026-04-08/valid-with-capabilities.json",
    /** Persist Shopify MCP tool calls to SQLite (set MCP_LOG_ENABLED=false to disable). */
    logCalls: process.env.MCP_LOG_ENABLED !== "false"
  },

  fitment: {
    enabled: process.env.FITMENT_ENABLED === "true"
  },

  chat: {
    /** localStorage = shared across tabs; sessionStorage = per tab only */
    conversationStorage:
      process.env.CHAT_CONVERSATION_STORAGE === "sessionStorage"
        ? "sessionStorage"
        : "localStorage"
  },

  tools: {
    productSearchNames: [
      "search_catalog",
      "search_shop_catalog",
      "find_fitment_products",
      "get_fitment_next_step"
    ],
    /** Show "Calling tool: …" in the storefront chat UI (set CHAT_SHOW_TOOL_CALLS=true in dev). */
    showToolCallsInChat: process.env.CHAT_SHOW_TOOL_CALLS === "true"
  }
};

export function getLlmProviderConfig(name = AppConfig.api.provider) {
  const provider = AppConfig.api.providers[name];
  if (!provider) {
    throw new Error(
      `Unknown LLM provider "${name}". Available providers: ${Object.keys(AppConfig.api.providers).join(", ")}`
    );
  }
  return provider;
}

export default AppConfig;
