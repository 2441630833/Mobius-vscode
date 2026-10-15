/*---------------------------------------------------------------------------------------------
 * Mobius parallel research preflight. The extension owns LangGraph and model/tool execution.
 *--------------------------------------------------------------------------------------------*/
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IChatProgress } from '../../chat/common/chatService/chatService.js';

export const MULTI_AGENT_ENABLED = 'continue.multiAgent.enabled';
export const MULTI_AGENT_MAX_PARALLEL = 'continue.multiAgent.maxParallelAgents';

export function resolveParallelAgentSetting(value: unknown): number {
	return typeof value === 'number' && Number.isInteger(value) && value >= 5 && value <= 10 ? value : 10;
}

export function shouldOrchestrateRequest(options: {
	enabled: boolean; agentMode: boolean; lightweight: boolean; codeChange: boolean; investigate: boolean;
}): boolean {
	return options.enabled && options.agentMode && !options.lightweight && (options.codeChange || options.investigate);
}

export async function runParallelResearch(
	commandService: ICommandService,
	request: { request: string; modelTitle: string; workingDirectory?: string; allowWeb: boolean; maxAgents?: number },
	progress: (parts: IChatProgress[]) => void,
	token: CancellationToken,
): Promise<string | undefined> {
	if (token.isCancellationRequested) { return undefined; }
	const id = generateUuid();
	const cancel = token.onCancellationRequested(() => {
		void commandService.executeCommand('continue.cancelAgentOrchestration', id);
	});
	try {
		progress([{ kind: 'markdownContent', content: new MarkdownString('正在评估任务难度、编排专业子智能体；每项任务独立总结后，将统一汇总。\n\n') }]);
		const result = await commandService.executeCommand<{ text: string; contributionReport?: string }>('continue.orchestrateAgents', {
			...request, id, maxAgents: resolveParallelAgentSetting(request.maxAgents),
			sharedContext: `User request: ${request.request.slice(0, 7000)}\nWorking directory: ${request.workingDirectory ?? '(none)'}`,
		});
		if (token.isCancellationRequested) { return undefined; }
		if (!result?.text) { throw new Error('Parallel research returned no result'); }
		if (result.contributionReport) {
			progress([{ kind: 'markdownContent', content: new MarkdownString(result.contributionReport + '\n\n') }]);
		}
		progress([{ kind: 'markdownContent', content: new MarkdownString('专业子任务与两层总结阶段已结束，主智能体将核对结果、继续实施并验证。\n\n') }]);
		return result.text;
	} finally { cancel.dispose(); }
}
