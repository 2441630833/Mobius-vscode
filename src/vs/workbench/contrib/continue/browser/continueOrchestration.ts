/*---------------------------------------------------------------------------------------------
 * Mobius parallel research preflight. The extension owns LangGraph and model/tool execution.
 *--------------------------------------------------------------------------------------------*/
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IChatProgress } from '../../chat/common/chatService/chatService.js';

export const MULTI_AGENT_ENABLED = 'continue.multiAgent.enabled';

export function shouldOrchestrateRequest(options: {
	enabled: boolean; agentMode: boolean; lightweight: boolean; codeChange: boolean; investigate: boolean;
}): boolean {
	return options.enabled && options.agentMode && !options.lightweight && (options.codeChange || options.investigate);
}

export async function runParallelResearch(
	commandService: ICommandService,
	request: { request: string; modelTitle: string; workingDirectory?: string; allowWeb: boolean },
	progress: (parts: IChatProgress[]) => void,
	token: CancellationToken,
): Promise<string | undefined> {
	if (token.isCancellationRequested) { return undefined; }
	const id = generateUuid();
	const cancel = token.onCancellationRequested(() => {
		void commandService.executeCommand('continue.cancelAgentOrchestration', id);
	});
	try {
		progress([{ kind: 'markdownContent', content: new MarkdownString('正在安排子智能体并行调研，完成后汇总并继续执行。\n\n') }]);
		const result = await commandService.executeCommand<{ text: string }>('continue.orchestrateAgents', {
			...request, id,
			sharedContext: `User request: ${request.request.slice(0, 7000)}\nWorking directory: ${request.workingDirectory ?? '(none)'}`,
		});
		if (token.isCancellationRequested) { return undefined; }
		if (!result?.text) { throw new Error('Parallel research returned no result'); }
		progress([{ kind: 'markdownContent', content: new MarkdownString('子智能体调研已汇总，正在核对结果并继续执行。\n\n') }]);
		return result.text;
	} finally { cancel.dispose(); }
}
