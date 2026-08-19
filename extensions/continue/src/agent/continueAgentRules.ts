import { ConfigHandler } from "core/config/ConfigHandler";
import { getSystemMessageWithRules } from "core/llm/rules/getSystemMessageWithRules";
import { UserChatMessage } from "core";

/**
 * Rules text for the workbench Continue Chat Agent (Agents window).
 * Uses the same applicability logic as the Continue GUI.
 */
export async function getAgentChatRules(
  configHandler: ConfigHandler,
  userMessage?: string,
): Promise<{ text: string }> {
  const { config } = await configHandler.loadConfig();
  if (!config?.rules?.length) {
    return { text: "" };
  }

  const message: UserChatMessage | undefined = userMessage?.trim()
    ? { role: "user", content: userMessage }
    : undefined;

  const { systemMessage } = getSystemMessageWithRules({
    baseSystemMessage: "",
    userMessage: message,
    availableRules: config.rules,
    contextItems: [],
  });

  return { text: systemMessage.trim() };
}
