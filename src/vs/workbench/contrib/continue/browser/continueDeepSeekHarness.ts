/*---------------------------------------------------------------------------------------------
 *  Mobius — DeepSeek Agent Harness Engine
 *  Modular agent harness implementation inspired by deepseek-harness (@deepseek-ai/dsh).
 *  Features:
 *  - Event-driven turn and step lifecycle (turn/start, step/start, tool/call, step/end, turn/end)
 *  - Loop hygiene guards (AntiRepetitionGuard, StepBudgetGuard)
 *  - Modular System Prompt & Working Memory assembly
 *  - Seamless tool execution via Mobius tool capability seams
 *--------------------------------------------------------------------------------------------*/

import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { localize } from '../../../../nls.js';
import { URI } from '../../../../base/common/uri.js';
import {
	ChatMessageRole,
	IChatMessage,
	IChatResponseToolUsePart,
} from '../../chat/common/languageModels.js';
import { IChatAgentResult } from '../../chat/common/participants/chatAgents.js';
import { formatSupersetToolDisplayName, loadAgentToolSuperset } from './continueCopilotToolsBridge.js';
import {
	IMobiusAgentHarness,
	IMobiusHarnessTurnContext,
} from './continueAgentHarness.js';
import { ContinueAgentToolSchema } from './continueAgentToolsBridge.js';

// ==========================================
// 1. Loop Hygiene Guards (from deepseek-harness/packages/guard)
// ==========================================

export class AntiRepetitionGuard {
	private readonly _history: Array<{ toolName: string; signature: string }> = [];
	private readonly _maxHistory = 10;

	private _computeSignature(toolName: string, parameters?: Record<string, unknown>): string {
		try {
			return `${toolName}:${JSON.stringify(parameters || {})}`;
		} catch {
			return `${toolName}:unserializable`;
		}
	}

	recordAndCheck(toolName: string, parameters?: Record<string, unknown>): { isRepeat: boolean; warning?: string } {
		const sig = this._computeSignature(toolName, parameters);
		const repeatCount = this._history.filter(h => h.signature === sig).length;

		this._history.push({ toolName, signature: sig });
		if (this._history.length > this._maxHistory) {
			this._history.shift();
		}

		if (repeatCount >= 2) {
			return {
				isRepeat: true,
				warning: `[DeepSeek Guard Warning]: Tool '${toolName}' has been executed with identical arguments ${repeatCount + 1} times. If previous outputs did not yield new information, analyze prior results or switch strategy.`,
			};
		}
		return { isRepeat: false };
	}

	reset(): void {
		this._history.length = 0;
	}
}

export class StepBudgetGuard {
	private _currentStep = 0;

	constructor(readonly maxSteps: number = 30) { }

	incrementStep(): { allowed: boolean; warning?: string } {
		this._currentStep++;
		if (this._currentStep >= this.maxSteps) {
			return {
				allowed: false,
				warning: `[DeepSeek Guard]: Step budget exhausted (${this._currentStep}/${this.maxSteps}). Concluding turn immediately.`,
			};
		}
		if (this._currentStep >= Math.floor(this.maxSteps * 0.8)) {
			return {
				allowed: true,
				warning: `[DeepSeek Guard]: Approaching step budget (${this._currentStep}/${this.maxSteps}). Please finalize deliverables and wrap up the task.`,
			};
		}
		return { allowed: true };
	}

	get step(): number {
		return this._currentStep;
	}

	reset(): void {
		this._currentStep = 0;
	}
}

// ==========================================
// 2. Working Memory & Deliverables Tracking
// ==========================================

export interface WorkingMemoryState {
	goal: string;
	activeSubGoals: string[];
	completedSubGoals: string[];
	deliverables: string[];
	observations: string[];
}

export function createWorkingMemory(goal: string): WorkingMemoryState {
	return {
		goal,
		activeSubGoals: [],
		completedSubGoals: [],
		deliverables: [],
		observations: [],
	};
}

// ==========================================
// 3. DeepSeek Agent Harness Implementation
// ==========================================

export class DeepSeekAgentHarness implements IMobiusAgentHarness {
	readonly id = 'deepseek';
	readonly name = 'DeepSeek Agent Harness';
	readonly description = 'Modular agent harness inspired by deepseek-harness: event-driven turn/step lifecycle, loop-hygiene anti-repetition guards, and capability seams.';
	readonly version = '0.2.1';

	readonly capabilities = {
		supportsLoopGuards: true,
		supportsEventLifecycle: true,
		supportsModularPrompts: true,
		supportsWorkingMemory: true,
	};

	async executeTurn(context: IMobiusHarnessTurnContext): Promise<IChatAgentResult> {
		const {
			request,
			progress,
			history,
			token,
			modelId,
			cwd,
			services,
			executeTool,
		} = context;

		const logService = services.logService;
		logService.info(`[DeepSeek Harness] turn/start - query: "${request.message.slice(0, 80)}"`);

		progress([{
			kind: 'markdownContent',
			content: new MarkdownString(
				localize('mobius.deepseekHarness.active', "⚡ **DeepSeek Agent Harness (dsh)** active · Event lifecycle & Loop hygiene enabled\n\n"),
			),
		}]);

		// Initialize guards and working memory
		const antiRepetitionGuard = new AntiRepetitionGuard();
		const stepBudgetGuard = new StepBudgetGuard(25);
		const memory = createWorkingMemory(request.message);

		// Load tools superset (capability seams)
		const tools: readonly ContinueAgentToolSchema[] = await loadAgentToolSuperset(
			services.languageModelToolsService,
			services.commandService,
			services.logService,
			services.configurationService,
		);

		// Prepare conversation messages
		const messages: IChatMessage[] = [];

		// Modular System Prompt assembly (DeepSeek Harness style)
		const systemPrompt = this._assembleSystemPrompt(cwd, memory);
		messages.push({
			role: ChatMessageRole.System,
			content: [{ type: 'text', value: systemPrompt }],
		});

		// Append existing relevant history
		for (const h of history.slice(-6)) {
			if (h.request?.message) {
				messages.push({
					role: ChatMessageRole.User,
					content: [{ type: 'text', value: h.request.message }],
				});
			}
			if (h.response) {
				const responseText = h.response.map(r => 'value' in r ? (typeof r.value === 'string' ? r.value : '') : '').join('\n');
				if (responseText.trim()) {
					messages.push({
						role: ChatMessageRole.Assistant,
						content: [{ type: 'text', value: responseText }],
					});
				}
			}
		}

		// Append current user message
		messages.push({
			role: ChatMessageRole.User,
			content: [{ type: 'text', value: request.message }],
		});

		let guardIntervention: string | undefined = undefined;

		// Turn loop
		while (!token.isCancellationRequested) {
			const budgetCheck = stepBudgetGuard.incrementStep();
			if (!budgetCheck.allowed) {
				progress([{
					kind: 'markdownContent',
					content: new MarkdownString(`\n\n> ⚠️ ${budgetCheck.warning}\n`),
				}]);
				break;
			}
			if (budgetCheck.warning) {
				guardIntervention = (guardIntervention ? `${guardIntervention}\n` : '') + budgetCheck.warning;
			}

			// If guard generated a warning, inject into messages as steering reminder
			if (guardIntervention) {
				messages.push({
					role: ChatMessageRole.User,
					content: [{ type: 'text', value: guardIntervention }],
				});
				guardIntervention = undefined;
			}

			logService.info(`[DeepSeek Harness] step/start - step ${stepBudgetGuard.step}`);

			// Send model request
			let assistantText = '';
			const toolUses: IChatResponseToolUsePart[] = [];

			try {
				const response = await services.languageModelsService.sendChatRequest(
					modelId,
					undefined,
					messages,
					{
						tools,
						tool_choice: 'auto',
					},
					token,
				);

				for await (const part of response.stream) {
					if (token.isCancellationRequested) {
						break;
					}
					const parts = Array.isArray(part) ? part : [part];
					for (const item of parts) {
						if (item.type === 'text' && item.value) {
							assistantText += item.value;
							progress([{ kind: 'markdownContent', content: new MarkdownString(item.value) }]);
						} else if (item.type === 'tool_use') {
							toolUses.push(item);
						}
					}
				}
				await response.result;
			} catch (err: unknown) {
				const errMsg = err instanceof Error ? err.message : String(err);
				logService.error(`[DeepSeek Harness] LLM call failed: ${errMsg}`);
				progress([{
					kind: 'markdownContent',
					content: new MarkdownString(`\n\n❌ Error communicating with model: ${errMsg}\n`),
				}]);
				break;
			}

			if (token.isCancellationRequested) {
				break;
			}

			// Commit assistant message to conversation log
			if (assistantText.trim()) {
				messages.push({
					role: ChatMessageRole.Assistant,
					content: [{ type: 'text', value: assistantText }],
				});
			}

			// If no tools were invoked, evaluate turn completion
			if (toolUses.length === 0) {
				logService.info('[DeepSeek Harness] No tool calls requested. Turn complete.');
				break;
			}

			// Execute tool calls with loop hygiene checks
			for (const call of toolUses) {
				if (token.isCancellationRequested) {
					break;
				}

				// 1. Anti-repetition guard check
				const repetition = antiRepetitionGuard.recordAndCheck(call.name, call.parameters as Record<string, unknown>);
				if (repetition.isRepeat && repetition.warning) {
					guardIntervention = repetition.warning;
					logService.warn(`[DeepSeek Harness][AntiRepetitionGuard] ${repetition.warning}`);
					progress([{
						kind: 'markdownContent',
						content: new MarkdownString(`\n> 🛡️ ${repetition.warning}\n`),
					}]);
				}

				// 2. Announce tool execution
				const displayName = formatSupersetToolDisplayName(call.name);
				progress([{
					kind: 'externalToolInvocationUpdate',
					toolCallId: call.toolCallId,
					toolName: call.name,
					isComplete: false,
					invocationMessage: `${displayName}…`,
				}]);

				// 3. Execute tool via capability seam
				logService.info(`[DeepSeek Harness] tool/call -> ${call.name}`);
				const outcome = await executeTool(
					call,
					cwd,
					request.sessionResource,
					request.requestId,
					token,
				);

				if (outcome.editUri) {
					memory.deliverables.push(outcome.editUri.toString());
				}

				progress([{
					kind: 'externalToolInvocationUpdate',
					toolCallId: call.toolCallId,
					toolName: call.name,
					isComplete: true,
					pastTenseMessage: outcome.ok ? `${displayName} done` : `${displayName} failed`,
				}]);

				// 4. Feed tool result back to model messages
				messages.push({
					role: ChatMessageRole.User,
					content: [{
						type: 'text',
						value: `[Tool Result: ${call.name} (${outcome.ok ? 'SUCCESS' : 'FAILURE'})]\n${outcome.text}`,
					}],
				});
			}

			logService.info(`[DeepSeek Harness] step/end - step ${stepBudgetGuard.step}`);
		}

		logService.info(`[DeepSeek Harness] turn/end - completed in ${stepBudgetGuard.step} steps`);
		return {};
	}

	private _assembleSystemPrompt(cwd: URI | undefined, memory: WorkingMemoryState): string {
		const workspacePath = cwd?.fsPath ?? 'workspace';
		return `# DeepSeek Agent Harness (dsh) System Spine

You are an autonomous engineering agent running in the Mobius platform under the DeepSeek Harness runtime.
You plan tasks methodically, invoke tools accurately, and verify results before completing.

## Working Context
- Workspace: \`${workspacePath}\`
- Goal: "${memory.goal}"

## Operational Principles
1. **Action-Oriented Execution**: When user requests modifications or inspection, use the appropriate tools immediately. Do not ask for redundant permission.
2. **Deterministic Verification**: Verify code, build, or tests after changes.
3. **Loop Hygiene**: Avoid repeating identical searches or operations that previously failed or produced no results. If an approach encounters a blocker, formulate an alternative hypothesis.
4. **Deliverables Integrity**: Ensure all created or modified files are complete and functional without leaving half-done drafts.
5. **Clear Finality**: When the user request is accomplished, provide a concise summary of results and deliverables.
`;
	}
}
