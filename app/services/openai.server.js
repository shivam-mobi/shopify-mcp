/**
 * OpenAI Service
 * OpenAI Chat Completions provider. Keep the shared streamConversation interface.
 */
import OpenAI from "openai";
import { storeLlmRequestLog } from "../db.server";
import AppConfig, { getLlmProviderConfig } from "./config.server";
import { getSystemPrompt } from "./prompts.server";

export function createOpenAIService(apiKey = process.env.OPENAI_API_KEY) {
  const openai = new OpenAI({ apiKey });
  const providerConfig = getLlmProviderConfig("openai");

  const streamConversation = async ({
    messages,
    promptType = AppConfig.api.defaultPromptType,
    tools
  }, streamHandlers) => {
    const systemInstruction = getSystemPrompt(promptType);
    const openAiMessages = convertMessagesToOpenAI(messages, systemInstruction);
    const openAiTools = convertToolsToOpenAI(tools);

    const request = {
      model: providerConfig.model,
      messages: openAiMessages,
      max_tokens: AppConfig.api.maxTokens,
      ...(openAiTools ? { tools: openAiTools } : {})
    };

    try {
      const stream = await openai.chat.completions.create({
        ...request,
        stream: true
      });

      let streamedText = "";
      const toolCallsByIndex = new Map();
      const chunks = [];

      for await (const chunk of stream) {
        chunks.push(chunk);
        const choice = chunk.choices?.[0];
        const delta = choice?.delta;
        if (!delta) continue;

        if (typeof delta.content === "string" && delta.content) {
          streamedText += delta.content;
          streamHandlers.onText?.(delta.content);
          streamHandlers.onContentBlock?.({ type: "text", text: delta.content });
        }

        if (Array.isArray(delta.tool_calls)) {
          for (const toolCallDelta of delta.tool_calls) {
            const index = toolCallDelta.index ?? 0;
            const existing = toolCallsByIndex.get(index) || {
              id: "",
              name: "",
              arguments: ""
            };

            if (toolCallDelta.id) {
              existing.id = toolCallDelta.id;
            }
            if (toolCallDelta.function?.name) {
              existing.name += toolCallDelta.function.name;
            }
            if (toolCallDelta.function?.arguments) {
              existing.arguments += toolCallDelta.function.arguments;
            }

            toolCallsByIndex.set(index, existing);
          }
        }
      }

      const content = [];
      if (streamedText) {
        content.push({ type: "text", text: streamedText });
      }

      const toolCalls = [...toolCallsByIndex.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, call]) => call)
        .filter((call) => call.name);

      for (const call of toolCalls) {
        content.push({
          type: "tool_use",
          id: call.id || `tool_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
          name: call.name,
          input: parseToolArguments(call.arguments)
        });
      }

      const finalMessage = {
        role: "assistant",
        content,
        stop_reason: toolCalls.length > 0 ? "tool_use" : "end_turn"
      };

      await storeLlmRequestLog({
        provider: "openai",
        statusCode: 200,
        request,
        response: { streamed: true, chunks, finalMessage }
      });

      streamHandlers.onMessage?.(finalMessage);

      if (streamHandlers.onToolUse) {
        for (const block of content) {
          if (block.type === "tool_use") {
            await streamHandlers.onToolUse(block);
          }
        }
      }

      return finalMessage;
    } catch (error) {
      await storeLlmRequestLog({
        provider: "openai",
        statusCode: error?.status || error?.statusCode || 0,
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

/**
 * Converts Claude-style messages into OpenAI chat messages.
 */
function convertMessagesToOpenAI(messages = [], systemInstruction) {
  const openAiMessages = [];

  if (systemInstruction) {
    openAiMessages.push({
      role: "system",
      content: systemInstruction
    });
  }

  for (const message of messages) {
    const content = message.content;

    if (typeof content === "string") {
      openAiMessages.push({
        role: message.role === "assistant" ? "assistant" : "user",
        content
      });
      continue;
    }

    if (!Array.isArray(content)) {
      openAiMessages.push({
        role: message.role === "assistant" ? "assistant" : "user",
        content: content == null ? "" : String(content)
      });
      continue;
    }

    const textParts = [];
    const toolCalls = [];
    const toolResults = [];

    for (const block of content) {
      if (block.type === "text" && block.text) {
        textParts.push(block.text);
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          type: "function",
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input || {})
          }
        });
      } else if (block.type === "tool_result") {
        toolResults.push({
          role: "tool",
          tool_call_id: block.tool_use_id,
          content: stringifyToolResult(block.content)
        });
      }
    }

    if (toolCalls.length > 0) {
      openAiMessages.push({
        role: "assistant",
        content: textParts.length ? textParts.join("\n") : null,
        tool_calls: toolCalls
      });
    } else if (textParts.length > 0 || message.role === "assistant") {
      openAiMessages.push({
        role: message.role === "assistant" ? "assistant" : "user",
        content: textParts.join("\n")
      });
    }

    openAiMessages.push(...toolResults);
  }

  return openAiMessages;
}

function convertToolsToOpenAI(tools) {
  if (!tools || tools.length === 0) {
    return undefined;
  }

  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description || "",
      parameters: tool.input_schema || tool.inputSchema || {
        type: "object",
        properties: {}
      }
    }
  }));
}

function parseToolArguments(rawArguments) {
  if (!rawArguments) {
    return {};
  }

  try {
    const parsed = JSON.parse(rawArguments);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function stringifyToolResult(content) {
  if (content == null) {
    return "";
  }

  if (typeof content === "string") {
    return content;
  }

  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

export default {
  createOpenAIService
};
