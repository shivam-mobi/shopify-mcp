/**
 * Gemini Service
 * Manages interactions with the Google Gemini API while keeping the
 * same streaming + tool-use interface used by the chat route.
 */
import { GoogleGenAI } from "@google/genai";
import AppConfig, { getLlmProviderConfig } from "./config.server";
import { getSystemPrompt } from "./prompts.server";

/**
 * Creates a Gemini service instance
 * @param {string} apiKey - Gemini API key
 * @returns {Object} Gemini service with methods for streaming conversations
 */
export function createGeminiService(apiKey = process.env.GEMINI_API_KEY) {
  const ai = new GoogleGenAI({ apiKey });
  const providerConfig = getLlmProviderConfig("gemini");

  const streamConversation = async ({
    messages,
    promptType = AppConfig.api.defaultPromptType,
    tools
  }, streamHandlers) => {
    const systemInstruction = getSystemPrompt(promptType);
    const contents = convertMessagesToGemini(messages);
    const geminiTools = convertToolsToGemini(tools);

    const request = {
      model: providerConfig.model,
      contents,
      config: {
        systemInstruction,
        maxOutputTokens: AppConfig.api.maxTokens,
        ...(geminiTools ? { tools: geminiTools } : {})
      }
    };

    // Use non-streaming requests when tools are enabled so Gemini 3.6
    // functionCall parts retain required thought signatures across turns.
    if (geminiTools) {
      const response = await ai.models.generateContent(request);
      return processGenerateContentResponse(response, streamHandlers);
    }

    const stream = await ai.models.generateContentStream(request);

    let streamedText = "";
    const functionCalls = [];

    for await (const chunk of stream) {
      const text = typeof chunk.text === "string" ? chunk.text : "";
      if (text) {
        streamedText += text;
        streamHandlers.onText?.(text);
      }

      const chunkCalls = chunk.functionCalls || [];
      for (const call of chunkCalls) {
        if (!call?.name) continue;
        const alreadyAdded = functionCalls.some(
          (existing) => existing.name === call.name && JSON.stringify(existing.args) === JSON.stringify(call.args)
        );
        if (!alreadyAdded) {
          functionCalls.push(call);
        }
      }
    }

    return buildFinalMessageFromParts(
      [
        ...(streamedText ? [{ text: streamedText }] : []),
        ...functionCalls.map((call) => ({
          functionCall: {
            name: call.name,
            args: call.args || {}
          }
        }))
      ],
      streamHandlers
    );
  };

  const getSystemPromptForType = (promptType) => getSystemPrompt(promptType);

  return {
    streamConversation,
    getSystemPrompt: getSystemPromptForType
  };
}

async function processGenerateContentResponse(response, streamHandlers) {
  const parts = response.candidates?.[0]?.content?.parts || [];
  return buildFinalMessageFromParts(parts, streamHandlers);
}

async function buildFinalMessageFromParts(parts, streamHandlers) {
  const content = [];
  const serializedParts = serializeGeminiParts(parts);

  if (serializedParts.length > 0) {
    content.push({
      type: "gemini_parts",
      parts: serializedParts
    });
  }

  for (const part of parts) {
    if (part.text) {
      const textBlock = {
        type: "text",
        text: part.text,
        ...(part.thoughtSignature ? { thought_signature: part.thoughtSignature } : {})
      };
      content.push(textBlock);
      streamHandlers.onText?.(part.text);
      streamHandlers.onContentBlock?.({ type: "text", text: part.text });
    }

    if (part.functionCall?.name) {
      content.push({
        type: "tool_use",
        id: part.functionCall.id || `tool_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        name: part.functionCall.name,
        input: part.functionCall.args || {},
        ...(part.thoughtSignature ? { thought_signature: part.thoughtSignature } : {})
      });
    }
  }

  const functionCalls = content.filter((block) => block.type === "tool_use");

  const finalMessage = {
    role: "assistant",
    content,
    stop_reason: functionCalls.length > 0 ? "tool_use" : "end_turn"
  };

  streamHandlers.onMessage?.(finalMessage);

  if (streamHandlers.onToolUse) {
    for (const block of functionCalls) {
      await streamHandlers.onToolUse(block);
    }
  }

  return finalMessage;
}

/**
 * Converts stored Claude-style messages into Gemini contents.
 */
function convertMessagesToGemini(messages = []) {
  const contents = [];
  const toolUseNames = new Map();

  for (const message of messages) {
    const content = message.content;

    if (Array.isArray(content)) {
      const geminiPartsBlock = content.find((block) => block.type === "gemini_parts" && block.parts?.length);
      if (geminiPartsBlock && message.role === "assistant") {
        for (const block of content) {
          if (block.type === "tool_use") {
            toolUseNames.set(block.id, block.name);
          }
        }
        contents.push({
          role: "model",
          parts: geminiPartsBlock.parts
        });
        continue;
      }
    }

    const role = message.role === "assistant" ? "model" : "user";
    const parts = [];

    if (typeof content === "string") {
      if (content.trim()) {
        parts.push({ text: content });
      }
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "gemini_parts") {
          continue;
        }

        if (block.type === "text" && block.text) {
          parts.push({
            text: block.text,
            ...(block.thought_signature ? { thoughtSignature: block.thought_signature } : {})
          });
        } else if (block.type === "tool_use") {
          toolUseNames.set(block.id, block.name);
          parts.push(buildFunctionCallPart(block));
        } else if (block.type === "tool_result") {
          const name = toolUseNames.get(block.tool_use_id) || "unknown_tool";
          parts.push({
            functionResponse: {
              name,
              response: normalizeToolResponse(block.content)
            }
          });
        }
      }
    } else if (content && typeof content === "object") {
      parts.push({ text: JSON.stringify(content) });
    }

    if (!parts.length) continue;

    const last = contents[contents.length - 1];
    if (last && last.role === role) {
      last.parts.push(...parts);
    } else {
      contents.push({ role, parts });
    }
  }

  if (contents.length && contents[0].role !== "user") {
    contents.unshift({ role: "user", parts: [{ text: "Hello" }] });
  }

  return contents;
}

function buildFunctionCallPart(block) {
  return {
    functionCall: {
      name: block.name,
      args: block.input || {}
    },
    thoughtSignature: block.thought_signature || "skip_thought_signature_validator"
  };
}

function serializeGeminiParts(parts = []) {
  return parts.map((part) => {
    const serialized = {};

    if (part.text) serialized.text = part.text;
    if (part.functionCall) serialized.functionCall = part.functionCall;
    if (part.functionResponse) serialized.functionResponse = part.functionResponse;
    if (part.thoughtSignature) serialized.thoughtSignature = part.thoughtSignature;

    return serialized;
  }).filter((part) => Object.keys(part).length > 0);
}

function normalizeToolResponse(content) {
  if (content == null) {
    return { result: "" };
  }

  if (typeof content === "object" && !Array.isArray(content)) {
    return content;
  }

  if (typeof content === "string") {
    try {
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
      return { result: parsed };
    } catch {
      return { result: content };
    }
  }

  return { result: content };
}

function convertToolsToGemini(tools) {
  if (!tools || tools.length === 0) {
    return undefined;
  }

  return [{
    functionDeclarations: tools.map((tool) => ({
      name: tool.name,
      description: tool.description || "",
      parameters: sanitizeSchema(tool.input_schema || tool.inputSchema || {
        type: "object",
        properties: {}
      })
    }))
  }];
}

function sanitizeSchema(schema) {
  if (!schema || typeof schema !== "object") {
    return { type: "object", properties: {} };
  }

  if (Array.isArray(schema)) {
    return schema.map(sanitizeSchema);
  }

  const cleaned = {};
  const allowedKeys = new Set([
    "type",
    "properties",
    "required",
    "description",
    "enum",
    "items",
    "nullable"
  ]);

  for (const [key, value] of Object.entries(schema)) {
    if (!allowedKeys.has(key)) continue;

    if (key === "properties" && value && typeof value === "object") {
      cleaned.properties = Object.fromEntries(
        Object.entries(value).map(([propName, propSchema]) => [
          propName,
          sanitizeSchema(propSchema)
        ])
      );
    } else if (key === "items") {
      cleaned.items = sanitizeSchema(value);
    } else {
      cleaned[key] = value;
    }
  }

  if (!cleaned.type) {
    cleaned.type = "object";
  }

  return cleaned;
}

export default {
  createGeminiService
};
