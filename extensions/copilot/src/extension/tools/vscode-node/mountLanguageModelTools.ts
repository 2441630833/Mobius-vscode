/*---------------------------------------------------------------------------------------------
 *  Mobius — mount all Copilot languageModelTool implementations via vscode.lm.registerTool.
 *  package.json only contributes tool *data*; without this, invokeTool throws
 *  "does not have an implementation registered".
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ILogService } from '../../../platform/log/common/logService';
import { getContributedToolName } from '../common/toolNames';
import { isVscodeLanguageModelTool } from '../common/toolsRegistry';
import { IToolsService } from '../common/toolsService';

export const ENSURE_COPILOT_TOOLS_MOUNTED_COMMAND = 'github.copilot.chat.ensureToolsMounted';

export type MountLanguageModelToolsResult = {
	readonly ok: boolean;
	readonly mounted: number;
	readonly skipped: number;
	readonly failed: number;
	readonly toolIds: string[];
	readonly errors: string[];
};

/**
 * Register every Copilot tool that implements vscode.LanguageModelTool.
 * Idempotent: tools already registered count as skipped, not failed.
 */
export function mountCopilotLanguageModelTools(
	toolsService: IToolsService,
	logService: ILogService | undefined,
	store: { push(d: { dispose(): void }): void },
): MountLanguageModelToolsResult {
	let mounted = 0;
	let skipped = 0;
	let failed = 0;
	const toolIds: string[] = [];
	const errors: string[] = [];

	for (const [name, tool] of toolsService.copilotTools) {
		if (!isVscodeLanguageModelTool(tool)) {
			skipped++;
			continue;
		}
		const toolId = String(getContributedToolName(name));
		try {
			const disposable = vscode.lm.registerTool(toolId, tool);
			store.push(disposable);
			mounted++;
			toolIds.push(toolId);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (/already has an implementation|already registered/i.test(message)) {
				skipped++;
				toolIds.push(toolId);
				continue;
			}
			// Tool data from package.json may race activation on cold start — surface clearly.
			failed++;
			errors.push(`${toolId}: ${message}`);
			logService?.error(`[copilot] Failed to register language model tool ${toolId}`, err);
			console.error(`[copilot] Failed to register language model tool ${toolId}:`, err);
		}
	}

	if (mounted === 0 && skipped === 0 && failed === 0) {
		const msg = 'copilotTools map was empty — ToolRegistry may not have loaded node/allTools';
		errors.push(msg);
		failed = 1;
		logService?.error(`[copilot] ${msg}`);
		console.error(`[copilot] ${msg}`);
	}

	const ok = failed === 0 && (mounted + skipped) > 0;
	logService?.info(
		`[copilot] languageModelTools mount: mounted=${mounted} skipped=${skipped} failed=${failed} totalIds=${toolIds.length}`,
	);
	console.log(
		`[copilot] languageModelTools mount: mounted=${mounted} skipped=${skipped} failed=${failed}`,
	);
	if (errors.length) {
		logService?.warn(`[copilot] languageModelTools mount errors:\n${errors.join('\n')}`);
	}

	return { ok, mounted, skipped, failed, toolIds, errors };
}
