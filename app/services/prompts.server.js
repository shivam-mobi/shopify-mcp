import AppConfig from "./config.server";
import systemPrompts from "../prompts/prompts.json";

export function getSystemPrompt(promptType = AppConfig.api.defaultPromptType) {
  return systemPrompts.systemPrompts[promptType]?.content ||
    systemPrompts.systemPrompts[AppConfig.api.defaultPromptType].content;
}
