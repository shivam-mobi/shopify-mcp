/**
 * Claude Service
 * Anthropic Claude provider. Keep the shared streamConversation interface.
 */
import { Anthropic } from "@anthropic-ai/sdk";
import AppConfig, { getLlmProviderConfig } from "./config.server";
import { getSystemPrompt } from "./prompts.server";

export function createClaudeService(apiKey = process.env.CLAUDE_API_KEY) {
  const anthropic = new Anthropic({ apiKey });
  const providerConfig = getLlmProviderConfig("claude");

  const streamConversation = async ({
    messages,
    promptType = AppConfig.api.defaultPromptType,
    tools
  }, streamHandlers) => {
    const systemInstruction = getSystemPrompt(promptType);

    const stream = await anthropic.messages.stream({
      model: providerConfig.model,
      max_tokens: AppConfig.api.maxTokens,
      system: systemInstruction,
      messages,
      tools: tools && tools.length > 0 ? tools : undefined
    });

    if (streamHandlers.onText) {
      stream.on("text", streamHandlers.onText);
    }

    if (streamHandlers.onMessage) {
      stream.on("message", streamHandlers.onMessage);
    }

    if (streamHandlers.onContentBlock) {
      stream.on("contentBlock", streamHandlers.onContentBlock);
    }

    const finalMessage = await stream.finalMessage();

    if (streamHandlers.onToolUse && finalMessage.content) {
      for (const content of finalMessage.content) {
        if (content.type === "tool_use") {
          await streamHandlers.onToolUse(content);
        }
      }
    }

    return finalMessage;
  };

  return {
    streamConversation,
    getSystemPrompt
  };
}

export default {
  createClaudeService
};
