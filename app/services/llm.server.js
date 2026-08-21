/**
 * LLM factory
 *
 * Chat code should only import createLlmService().
 * Switch models with LLM_PROVIDER in .env (gemini | claude | openai).
 *
 * To add a new provider:
 * 1. Create app/services/<provider>.server.js
 * 2. Export createXService() with this interface:
 *      { streamConversation({ messages, promptType, tools }, handlers) }
 *    streamConversation must return:
 *      { role: "assistant", content: [...], stop_reason: "end_turn" | "tool_use" }
 *    content blocks:
 *      { type: "text", text }
 *      { type: "tool_use", id, name, input }
 * 3. Register it in llmProviders below
 * 4. Add its config in config.server.js
 * 5. Set LLM_PROVIDER=<name> in .env
 */
import { createGeminiService } from "./gemini.server";
import { createClaudeService } from "./claude.server";
import { createOpenAIService } from "./openai.server";
import AppConfig, { getLlmProviderConfig } from "./config.server";

const llmProviders = {
  gemini: createGeminiService,
  claude: createClaudeService,
  openai: createOpenAIService
};

export function registerLlmProvider(name, factory) {
  llmProviders[name.toLowerCase()] = factory;
}

export function createLlmService() {
  const providerName = AppConfig.api.provider;
  const factory = llmProviders[providerName];

  if (!factory) {
    throw new Error(
      `LLM provider "${providerName}" is not registered. Available: ${Object.keys(llmProviders).join(", ")}`
    );
  }

  const providerConfig = getLlmProviderConfig(providerName);
  const apiKey = process.env[providerConfig.apiKeyEnv];

  if (!apiKey) {
    throw new Error(
      `Missing ${providerConfig.apiKeyEnv} for provider "${providerName}". Add it to your .env file.`
    );
  }

  console.log(`Using LLM provider: ${providerConfig.displayName} (${providerConfig.model})`);
  return factory(apiKey);
}

export default {
  createLlmService,
  registerLlmProvider
};
