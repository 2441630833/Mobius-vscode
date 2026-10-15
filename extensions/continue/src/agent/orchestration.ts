import { fetchwithRequestOptions } from "@continuedev/fetch";
import type { IDE } from "core";
import { ConfigHandler } from "core/config/ConfigHandler";
import { orchestrateAgentsTool } from "core/tools/definitions/orchestrateAgents";
import { orchestrateAgentsImpl } from "core/tools/implementations/orchestrateAgents";

const active = new Map<string, AbortController>();

export function cancelWorkbenchOrchestration(id: string): void {
  active.get(id)?.abort();
}

export interface WorkbenchOrchestrationRequest {
  id: string;
  request: string;
  sharedContext?: string;
  modelTitle?: string;
  workingDirectory?: string;
  allowWeb?: boolean;
}

/** Scope IDE reads to this request without mutating the window's global cwd. */
export function scopeResearchIde(ide: IDE, cwd?: string): IDE {
  if (!cwd) {
    return ide;
  }
  const scoped: IDE = Object.create(ide);
  scoped.getWorkspaceDirs = async () => [cwd];
  return scoped;
}

export async function runWorkbenchOrchestration(
  request: WorkbenchOrchestrationRequest,
  configHandler: ConfigHandler,
  ide: IDE,
) {
  if (!request.id || active.has(request.id)) {
    throw new Error("Missing or duplicate orchestration ID");
  }
  const controller = new AbortController();
  active.set(request.id, controller);
  try {
    const { config } = await configHandler.loadConfig();
    controller.signal.throwIfAborted();
    const llm = config?.selectedModelByRole.chat;
    if (!config || !llm) {
      throw new Error("No Continue chat model configured");
    }
    const items = await orchestrateAgentsImpl(
      {
        request: request.request,
        shared_context: request.sharedContext,
        model_title: request.modelTitle,
        allow_web: request.allowWeb,
      },
      {
        config,
        llm,
        ide: scopeResearchIde(ide, request.workingDirectory),
        tool: orchestrateAgentsTool,
        toolCallId: request.id,
        abortSignal: controller.signal,
        fetch: (url, init) => fetchwithRequestOptions(url, init, undefined),
      },
    );
    return { text: items.map((item) => item.content).join("\n") };
  } finally {
    active.delete(request.id);
  }
}
