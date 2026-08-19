import { ContextItem, ToolCall } from "core";
import { ConfigHandler } from "core/config/ConfigHandler";
import { Core } from "core/core";
import { BUILT_IN_GROUP_NAME, BuiltInToolNames } from "core/tools/builtIn";
import { codebaseTool } from "core/tools/definitions/codebaseTool";
import { fetchUrlContentTool } from "core/tools/definitions/fetchUrlContent";
import { grepSearchTool } from "core/tools/definitions/grepSearch";
import { searchWebTool } from "core/tools/definitions/searchWeb";
import { serializeTool } from "core/tools/index";
import { v4 as uuidv4 } from "uuid";

/** Always available to the workbench agent — even if config load is partial. */
const REQUIRED_AGENT_TOOLS = [
  searchWebTool,
  grepSearchTool,
  fetchUrlContentTool,
  codebaseTool,
] as const;

/** OpenAI-compatible tool schema passed to the workbench chat agent. */
export type AgentChatToolSchema = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
};

/** Patch edit tools executed via continue.applyClientEditTool (extension sync apply). */
export const CLIENT_EDIT_TOOL_NAMES = new Set<string>([
  BuiltInToolNames.EditExistingFile,
  BuiltInToolNames.SingleFindAndReplace,
  BuiltInToolNames.MultiEdit,
]);

/** Executed in workbench or extension locally — not via core tools/call. */
const WORKBENCH_LOCAL_TOOL_NAMES = new Set([
  BuiltInToolNames.RunTerminalCommand,
  BuiltInToolNames.CreateNewFile,
  "write_file",
  ...CLIENT_EDIT_TOOL_NAMES,
]);

export const WRITE_FILE_TOOL_SCHEMA: AgentChatToolSchema = {
  type: "function",
  function: {
    name: "write_file",
    description:
      "Create or overwrite a file with full contents. Prefer path+contents; filePath/content aliases are also accepted. path is relative to the workspace root unless absolute.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path relative to workspace root (preferred)",
        },
        filepath: { type: "string", description: "Alias for path" },
        filePath: { type: "string", description: "Alias for path" },
        contents: {
          type: "string",
          description: "Full file contents (preferred)",
        },
        content: { type: "string", description: "Alias for contents" },
      },
      required: ["path", "contents"],
    },
  },
};

function toOpenAiSchema(
  tool: ReturnType<typeof serializeTool>,
): AgentChatToolSchema {
  return {
    type: "function",
    function: {
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
    },
  };
}

/**
 * Tools exposed to the VS Code Chat Agent — mirrors Continue GUI agent mode
 * including patch edit tools (routed to continue.applyClientEditTool).
 * Workbench prefers Copilot tools for overlaps when registered; Continue is fallback.
 */
export async function getAgentChatTools(
  configHandler: ConfigHandler,
): Promise<AgentChatToolSchema[]> {
  const { config } = await configHandler.loadConfig();
  if (!config) {
    return [WRITE_FILE_TOOL_SCHEMA];
  }

  const byName = new Map<string, AgentChatToolSchema>();

  for (const tool of config.tools) {
    const name = tool.function.name;
    if (WORKBENCH_LOCAL_TOOL_NAMES.has(name)) {
      continue;
    }
    byName.set(name, toOpenAiSchema(serializeTool(tool)));
  }

  // Workbench-local write/create + terminal (schemas from config when present).
  byName.set("write_file", WRITE_FILE_TOOL_SCHEMA);
  const createNewFileTool = config.tools.find(
    (t) => t.function.name === BuiltInToolNames.CreateNewFile,
  );
  if (createNewFileTool) {
    byName.set(
      BuiltInToolNames.CreateNewFile,
      toOpenAiSchema(serializeTool(createNewFileTool)),
    );
  }

  const terminalTool = config.tools.find(
    (t) => t.function.name === BuiltInToolNames.RunTerminalCommand,
  );
  if (terminalTool) {
    byName.set(
      BuiltInToolNames.RunTerminalCommand,
      toOpenAiSchema(serializeTool(terminalTool)),
    );
  }

  for (const editToolName of CLIENT_EDIT_TOOL_NAMES) {
    const editTool = config.tools.find((t) => t.function.name === editToolName);
    if (editTool) {
      byName.set(editToolName, toOpenAiSchema(serializeTool(editTool)));
    }
  }

  for (const tool of REQUIRED_AGENT_TOOLS) {
    byName.set(tool.function.name, toOpenAiSchema(serializeTool(tool)));
  }

  return [...byName.values()];
}

export async function callBuiltInAgentTool(
  core: Core,
  name: string,
  args: Record<string, unknown>,
  toolCallId?: string,
): Promise<{
  ok: boolean;
  contextItems: ContextItem[];
  errorMessage?: string;
}> {
  const toolCall: ToolCall = {
    id: toolCallId ?? uuidv4(),
    type: "function",
    function: {
      name,
      arguments: JSON.stringify(args ?? {}),
    },
  };

  try {
    const result = await core.invoke("tools/call", { toolCall });
    if (result.errorMessage) {
      return {
        ok: false,
        contextItems: result.contextItems ?? [],
        errorMessage: result.errorMessage,
      };
    }
    return {
      ok: true,
      contextItems: result.contextItems ?? [],
    };
  } catch (e) {
    return {
      ok: false,
      contextItems: [],
      errorMessage: e instanceof Error ? e.message : String(e),
    };
  }
}

export function formatContextItemsAsText(items: ContextItem[]): string {
  if (!items.length) {
    return "(no output)";
  }
  return items
    .map((item) => {
      const label = [item.name, item.description].filter(Boolean).join(" — ");
      return label ? `## ${label}\n${item.content}` : item.content;
    })
    .join("\n\n");
}

/** Whether a tool name should be delegated to Continue core callBuiltInTool. */
export function isCoreBuiltInTool(toolName: string): boolean {
  return !WORKBENCH_LOCAL_TOOL_NAMES.has(toolName);
}

export function isClientEditTool(toolName: string): boolean {
  return CLIENT_EDIT_TOOL_NAMES.has(toolName);
}

export { BUILT_IN_GROUP_NAME };
