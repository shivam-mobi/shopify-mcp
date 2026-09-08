/**
 * Claude Service
 * Anthropic Claude provider. Keep the shared streamConversation interface.
 */
import { Anthropic } from "@anthropic-ai/sdk";
import { storeLlmRequestLog } from "../db.server";
import AppConfig, { getLlmProviderConfig } from "./config.server";
import { getSystemPrompt } from "./prompts.server";

export function createClaudeService(apiKey = process.env.CLAUDE_API_KEY) {
  const anthropic = new Anthropic({ apiKey });
  const providerConfig = getLlmProviderConfig("claude");

  const streamConversation = async ({
    messages,
    promptType = AppConfig.api.defaultPromptType,
    tools,
    conversationId = null
  }, streamHandlers) => {
    const systemInstruction = getSystemPrompt(promptType);
    const request = {
      model: providerConfig.model,
      max_tokens: AppConfig.api.maxTokens,
      system: systemInstruction,
      messages,
      tools: tools && tools.length > 0 ? tools : undefined
    };

    try {
      const stream = await anthropic.messages.stream(request);

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

      await storeLlmRequestLog({
        provider: "claude",
        statusCode: 200,
        conversationId,
        request,
        response: finalMessage
      });

      if (streamHandlers.onToolUse && finalMessage.content) {
        for (const content of finalMessage.content) {
          if (content.type === "tool_use") {
            await streamHandlers.onToolUse(content);
          }
        }
      }

      return finalMessage;
    } catch (error) {
      await storeLlmRequestLog({
        provider: "claude",
        statusCode: error?.status || error?.statusCode || 0,
        conversationId,
        request,
        response: {
          error: true,
          name: error?.name,
          message: error?.message,
          status: error?.status || error?.statusCode || 0,
          details: error?.error
        }
      });
      throw error;
    }
  };

  return {
    streamConversation,
    getSystemPrompt
  };
}

export default {
  createClaudeService
};
