/*---------------------------------------------------------------------------------------------
 *  Mobius — delegate Agents-window shell commands to VS Code run_in_terminal tool
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { URI } from '../../../../base/common/uri.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { TerminalToolId } from '../../chat/common/tools/terminalToolIds.js';
import {
	CountTokensCallback,
	ILanguageModelToolsService,
	IToolResult,
	IToolResultTextPart,
} from '../../chat/common/tools/languageModelToolsService.js';

/** OpenAI tool schema exposed to the Continue LM (matches continue-config naming). */
export const RUN_TERMINAL_COMMAND_TOOL = {
	type: 'function',
	function: {
		name: 'run_terminal_command',
		description: 'Run a terminal command in the IDE shell and return stdout/stderr. On Windows PowerShell use ; to chain commands (not &&). Use for git, npm, builds, tests, etc.',
		parameters: {
			type: 'object',
			properties: {
				command: {
					type: 'string',
					description: 'Shell command to execute in the session working directory.',
				},
				waitForCompletion: {
					type: 'boolean',
					description: 'Wait for the command to finish and return output. Default true. Set false only for long-running servers.',
				},
			},
			required: ['command'],
		},
	},
} as const;

export interface TerminalCommandContext {
	readonly sessionResource: URI;
	readonly workingDirectory?: URI;
	readonly chatRequestId?: string;
}

export async function executeRunTerminalCommand(
	toolsService: ILanguageModelToolsService,
	logService: ILogService,
	context: TerminalCommandContext,
	command: string,
	waitForCompletion: boolean,
	token: CancellationToken,
): Promise<{ ok: boolean; text: string }> {
	const trimmed = command.trim();
	if (!trimmed) {
		return { ok: false, text: 'run_terminal_command requires a non-empty command' };
	}

	const tool = toolsService.getTool(TerminalToolId.RunInTerminal);
	if (!tool) {
		logService.warn('[Continue] run_in_terminal tool is not registered');
		return { ok: false, text: 'Terminal tool is not available in this session' };
	}

	const countTokens: CountTokensCallback = async () => 0;

	try {
		const result = await toolsService.invokeTool({
			callId: generateUuid(),
			toolId: TerminalToolId.RunInTerminal,
			chatRequestId: context.chatRequestId,
			parameters: {
				command: trimmed,
				explanation: 'Mobius Continue Agent shell command',
				goal: 'Execute user-requested terminal command',
				mode: waitForCompletion === false ? 'async' : 'sync',
			},
			context: {
				sessionResource: context.sessionResource,
				workingDirectory: context.workingDirectory,
			},
		}, countTokens, token);

		const text = formatToolResult(result);
		const ok = !result.toolResultError;
		return { ok, text: text || (ok ? '(command completed with no output)' : 'Terminal command failed') };
	} catch (err) {
		logService.warn('[Continue] run_terminal_command failed', err);
		return { ok: false, text: err instanceof Error ? err.message : String(err) };
	}
}

function formatToolResult(result: IToolResult): string {
	const parts: string[] = [];
	if (typeof result.toolResultMessage === 'string' && result.toolResultMessage.trim()) {
		parts.push(result.toolResultMessage.trim());
	}
	for (const part of result.content) {
		if (part.kind === 'text' && (part as IToolResultTextPart).value) {
			parts.push((part as IToolResultTextPart).value);
		}
	}
	if (result.toolResultError && typeof result.toolResultError === 'string') {
		parts.push(result.toolResultError);
	}
	return parts.join('\n\n').trim();
}
