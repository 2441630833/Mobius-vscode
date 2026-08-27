/*---------------------------------------------------------------------------------------------
 *  Mobius — built-in Continue chat agents for local / Agents-window sessions
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IMarkerService, MarkerSeverity } from '../../../../platform/markers/common/markers.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';
import { localize } from '../../../../nls.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { ITextFileService } from '../../../services/textfile/common/textfiles.js';
import {
	ChatMessageRole,
	IChatMessage,
	IChatMessageImagePart,
	IChatResponseToolUsePart,
	ILanguageModelsService,
} from '../../chat/common/languageModels.js';
import { IChatTodoListService } from '../../chat/common/tools/chatTodoListService.js';
import {
	IChatAgentData,
	IChatAgentHistoryEntry,
	IChatAgentImplementation,
	IChatAgentRequest,
	IChatAgentResult,
	IChatAgentService,
} from '../../chat/common/participants/chatAgents.js';
import { IChatProgress } from '../../chat/common/chatService/chatService.js';
import { ChatAgentLocation, ChatModeKind } from '../../chat/common/constants.js';
import { IPromptsService } from '../../chat/common/promptSyntax/service/promptsService.js';
import { SaveReason } from '../../../common/editor.js';
import { ILanguageModelToolsService } from '../../chat/common/tools/languageModelToolsService.js';
import { CONTINUE_EXTENSION_ID, isContinuePhysicalAiIde } from './continueProduct.js';
import { CONTINUE_LM_VENDOR } from './continueLanguageModelProvider.js';
import { buildContinueSkillsContext, buildContinueSkillsContextFast, type ContinueSkillsContext, extractSkillRoutingQuery, hasScaffoldProjectIntent, hasWebSearchIntent, loadSkillWarmSnapshot } from './continueSkillsContext.js';
import { ContinueSkillEmbeddingIndex } from './continueSkillEmbeddings.js';
import { classifySkillRoutingOutcome, ContinueSkillFeedbackStore } from './continueSkillFeedback.js';
import { AgentMemoryStore, ContinueSelfEvolving, TaskExecutionRecorder } from './continueSelfEvolving.js';
import {
	ContinueAgentToolSchema,
	invokeContinueBuiltInTool,
	invokeContinueClientEditTool,
} from './continueAgentToolsBridge.js';
import {
	formatSupersetToolDisplayName,
	isCopilotSearchTimeoutError,
	isCopilotSearchUnavailableResult,
	isUnsupportedContinueAgentTool,
	loadAgentToolSuperset,
	loadContinueAgentRules,
	tryInvokeCopilotTool,
	unsupportedCopilotToolRecovery,
} from './continueCopilotToolsBridge.js';
import { executeRunTerminalCommand } from './continueTerminalTool.js';
import { executeGodotTool, bootstrapGameModeGodotLivePreview, createGodotAutoPreviewState, createGodotToolHost, ensureGodotPreviewLaunched, gameDevSystemHint, GodotAutoPreviewState, hasGameDevIntent, isGameDevProjectUri, isGodotTool, openGodotLiveEditorIfNeeded, trackGodotToolCall } from './continueGodotTools.js';
import { bootstrapChipModeDetect, createFpgaToolHost, executeFpgaTool, isFpgaTool } from './continueFpgaTools.js';
import { chipDesignSystemHint, isChipModeExplicitlySelected } from './continueChipDesign.js';
import {
	ccgsRelativePath,
	gameStudioWorkflowSystemHint,
	isGameModeExplicitlySelected,
	loadGameStudioBootstrapContext,
	resolveCcgsRootUri,
} from './continueGameStudioWorkflow.js';
import {
	gameFactory3AWorkflowSystemHint,
	gf3aRelativePath,
	loadGameFactory3ABootstrapContext,
	resolveGameFactory3ARootUri,
} from './continueGameFactory3AWorkflow.js';
import { acquireIndexingPause } from './continueIndexingPause.js';
import { preprocessAgentRequestOcr, collectAgentRequestImageParts } from './continueOcrPreprocessor.js';
import { BUNDLED_ONNX_OCR } from './continueModelConfig.js';
import { RunInTerminalTool } from '../../terminalContrib/chatAgentTools/browser/tools/runInTerminalTool.js';

const CONTINUE_AGENT_IDS = {
	ask: `${CONTINUE_EXTENSION_ID}.chat`,
	edit: `${CONTINUE_EXTENSION_ID}.edits`,
	agent: `${CONTINUE_EXTENSION_ID}.agent`,
	game: `${CONTINUE_EXTENSION_ID}.game`,
	chip: `${CONTINUE_EXTENSION_ID}.chip`,
} as const;

/**
 * Coding tasks run until the user task is complete (not merely until the model
 * stops talking). This guard only aborts pathological runaway loops.
 */
const RUNAWAY_TOOL_TURN_GUARD = 500;
/** Soft cap for pure short Q&A tool loops before forcing an answer. */
const QA_TOOL_TURNS = 16;
/** After this many turns with no writes on a change request, force an edit nudge. */
const EXPLORE_BEFORE_EDIT_NUDGE_TURN = 2;
/** Extra tool turns when a coding run hit the soft cap with zero writes. */
const EDIT_RESCUE_EXTRA_TURNS = 12;
/** How many times to re-ask "is the task done?" before accepting a no-tool stop with writes. */
const MAX_COMPLETION_VERIFY_NUDGES = 3;
/** Lightweight one-shot edits — fewer completion loops before accepting done. */
const LIGHTWEIGHT_COMPLETION_VERIFY_NUDGES = 1;
/** Lightweight tasks — cap post-tool stall nudges. */
const LIGHTWEIGHT_POST_TOOL_CONTINUE_NUDGES = 2;
/** Tool-loop cap for lightweight edits (single-file / small scope). */
const LIGHTWEIGHT_MAX_TURNS = 16;
/** Tool-loop cap for README/markdown-only doc updates. */
const DOC_EDIT_MAX_TURNS = 10;
/** How many times to force compile/problem fixes before accepting done. */
const MAX_COMPILE_FIX_NUDGES = 4;
/** Wait for language services to refresh markers after edits. */
const MARKER_SETTLE_MS = 900;
/** Cap how many times we re-nudge after workspace search failures. */
const MAX_SEARCH_FAILURE_NUDGES = 3;
/** Cap narrated-tool loops (model talks about tools but never calls them). */
const MAX_NARRATED_TOOL_NUDGES = 3;
/** Cap how many times we re-nudge after dead-end Copilot tools (skill/view_image/…). */
const MAX_DEAD_END_TOOL_NUDGES = 3;
/** After tools ran, allow this many empty/no-tool nudge retries before accepting a stop. */
const MAX_POST_TOOL_CONTINUE_NUDGES = 4;
/** Cap stream/API error recoveries so a broken provider cannot loop forever. */
const MAX_STREAM_ERROR_RECOVERIES = 2;
/** Transient "Canceled" / EH blips — retry quietly with backoff (coding tasks hit this often). */
const MAX_TRANSIENT_CANCEL_RECOVERIES = 12;
/** One-shot rescue after hard stream-error budget is spent on a still-unfinished coding task. */
const MAX_STREAM_ERROR_TASK_RESCUES = 1;
/** Extra budget for TPM/429 rate limits — wait and retry instead of dumping tool noise. */
const MAX_RATE_LIMIT_RECOVERIES = 5;

const PATCH_EDIT_TOOLS = new Set([
	'edit_existing_file',
	'single_find_and_replace',
	'multi_edit',
	'replace_string_in_file',
	'multi_replace_string_in_file',
	'insert_edit_into_file',
	'apply_patch',
]);

const WRITE_SUCCESS_TOOLS = new Set([
	'write_file',
	'create_new_file',
	'create_file',
	...PATCH_EDIT_TOOLS,
]);

const FINAL_ANSWER_NUDGE = `Write your final answer to the user now in the same language they used.
Summarize what you found or changed from tool results. If information is incomplete, say so clearly.
Output ONLY the user-facing answer — no tool calls, no planning, no "let me search" narration.
NEVER claim the tool budget is exhausted or ask the user to send another message. Forbidden phrases: "工具调用已用完", "请回复任意消息", "请在下一轮", "我将立即执行". Just report status.`;

const FINAL_ANSWER_RETRY_NUDGE = `Your previous turn produced no user-visible answer. Tools are DISABLED.
Using ONLY the tool results already in this conversation, write the complete final answer now in the user's language.
If results are incomplete, still give the best answer you can and note the gaps.
FORBIDDEN: asking the user to send another message so you can continue. Forbidden: "工具调用已用完", "请回复任意消息".`;

const TEXTUAL_TOOL_NUDGE = `Your previous turn wrote tool calls as plain chat text. That is INVALID and was ignored — nothing was executed.
You MUST use the API native function-calling channel (the tools parameter / tool_calls). Emit a real tool_use now for the remaining edits.
Do NOT write angle-bracket markup, fake XML, or markdown fences that look like tools.`;

const NARRATED_TOOL_NUDGE = `Your previous turn ONLY NARRATED a tool call in chat prose (e.g. "executing now", "calling run_in_terminal", "GO NOW") without native function calling. NOTHING ran.
Stop narrating. Emit exactly ONE real tool_use via the tools API (tool_calls). Zero prose before the tool call. Forbidden: "executing", "calling the tool", "here is the tool call", staccato ALL-CAPS filler.`;

const FINISH_REMAINING_EDITS_NUDGE = `You stopped early and asked the user to reply (e.g. "请回复继续修改" / "工具调用已用完") instead of finishing.
That is incorrect — tools are STILL available in this same request with no turn quota. Do NOT wait.
Call edit tools NOW for every remaining file: replace_string_in_file, multi_replace_string_in_file, insert_edit_into_file, apply_patch, or write_file.
Forbidden: asking the user to reply again, listing remaining work without editing, or promising to continue next turn.`;

const CONTINUE_UNTIL_TASK_DONE_NUDGE = `Stop condition is TASK COMPLETION — not "I paused" or "tools feel used up".
If ANY requested change is still missing, call edit tools NOW and finish every remaining file.
When (and only when) the user's task is fully complete: update manage_todo_list so every item is completed, give a short done summary, and end with a line containing exactly: TASK_COMPLETE
Forbidden: "工具调用已用完", "请回复任意消息", asking the user to ping you, or stopping while work remains.`;

const SEARCH_FAILURE_RECOVERY_HINT =
	'Next: do NOT stop. Retry grep_search with a short literal string (no | alternation), or use file_search / list_dir / read_file, then continue the task.';

const SEARCH_FAILURE_CONTINUE_NUDGE =
	`A workspace search timed out or failed. Do NOT stop or ask the user.
Retry with a simpler literal grep_search query, or file_search / list_dir, then continue editing immediately.`;

const DEAD_END_TOOL_CONTINUE_NUDGE =
	`A tool just failed because it is unavailable in Continue Agent (skill / view_image / tool_search / edit_files / test_search / vscode_askQuestions).
Do NOT retry those tools and do NOT stop. Skills already in <skill-context> (if any) are enough guidance.
Call grep_search / read_file / list_dir NOW to find the code, then replace_string_in_file / multi_replace_string_in_file / write_file to finish the user task.`;

const STREAM_ERROR_CONTINUE_NUDGE =
	`The previous model response failed (provider/stream error). Do NOT stop or ask the user to ping you.
Continue the user task: call grep_search / read_file / replace_string_in_file / write_file as needed.`;

const RATE_LIMIT_USER_MESSAGE =
	`Model hit a TPM / rate limit (HTTP 429). Edits already applied are kept.
Wait 1–2 minutes, then send「继续」to resume. Do not retry immediately.`;

const POST_TOOL_CONTINUE_NUDGE =
	`You stopped after tool results without finishing. Tools are STILL available — do NOT end the turn.
Read the latest tool output, then call the NEXT tool (read_file / grep_search / run_in_terminal / edit tools) or give a complete final answer that solves the user's request.
A tool error is NOT a stop signal — recover and continue. Forbidden: stopping silently, "先这样", "稍后继续", or asking the user to ping you.`;

const INVESTIGATE_CONTINUE_NUDGE =
	`Investigation is incomplete. Continue NOW with tools: inspect the API/runtime data path, compare source vs served content, then fix or clearly report the root cause.
Do not stop after a single terminal/read call. Forbidden: asking the user to continue.`;

const TODO_LIST_FORCE_NUDGE =
	`You must call manage_todo_list NOW before other tools. Split the user's request into 3–7 actionable items in their language, mark the first item in-progress, then continue the work. Do NOT narrate the plan only in chat text.`;

function isWorkspaceSearchTool(toolName: string): boolean {
	return toolName === 'grep_search'
		|| toolName === 'file_search'
		|| toolName === 'file_glob_search'
		|| toolName === 'semantic_search'
		|| toolName === 'codebase'
		|| toolName === 'text_search';
}

function isDeadEndContinueTool(toolName: string): boolean {
	return isUnsupportedContinueAgentTool(toolName);
}

/** Detect provider TPM / HTTP 429 rate-limit failures. */
export function isRateLimitError(message: string): boolean {
	const msg = message.trim();
	if (!msg) {
		return false;
	}
	return /\b429\b/.test(msg)
		|| /TPM rate limit/i.test(msg)
		|| /rate.?limit/i.test(msg)
		|| /too many requests/i.test(msg)
		|| /tokens per (minute|min)\b/i.test(msg)
		|| /insufficient_quota/i.test(msg);
}

/** Backoff before retrying after a rate-limit error (ms). */
export function rateLimitBackoffMs(attempt: number, message: string): number {
	const retryAfterSec = message.match(/retry[- ]after[:\s]+(\d+)/i)?.[1]
		?? message.match(/try again in (\d+)\s*(s|sec|seconds)?/i)?.[1]
		?? message.match(/wait (\d+)\s*(s|sec|seconds)?/i)?.[1];
	if (retryAfterSec) {
		const sec = Number(retryAfterSec);
		if (Number.isFinite(sec) && sec > 0) {
			return Math.min(120_000, Math.max(5_000, sec * 1000));
		}
	}
	// 15s → 30s → 60s → 90s → 120s
	return Math.min(120_000, 15_000 * Math.min(attempt + 1, 8));
}

/**
 * Stream aborted by provider / extension host / network — not the user clicking Stop.
 * These must retry the same turn quietly; treating them as fatal after 2 tries aborts
 * mid-edit ("Model stream failed repeatedly (Canceled)").
 */
export function isTransientStreamCancelError(message: string): boolean {
	const msg = message.trim();
	if (!msg) {
		return false;
	}
	return /^cancel+ed\.?$/i.test(msg)
		|| /\bcancel+ed\b/i.test(msg)
		|| /extension host.*(exit|crash|restart|disposed)/i.test(msg)
		|| /ECONNRESET|ETIMEDOUT|EPIPE|socket hang up|network error|fetch failed/i.test(msg);
}

function transientCancelBackoffMs(attemptZeroBased: number): number {
	return Math.min(8_000, 400 * Math.pow(2, Math.min(attemptZeroBased, 4)));
}

async function delayCancellable(ms: number, token: CancellationToken): Promise<void> {
	if (ms <= 0 || token.isCancellationRequested) {
		return;
	}
	await new Promise<void>((resolve) => {
		const timer = setTimeout(() => resolve(), ms);
		const sub = token.onCancellationRequested(() => {
			clearTimeout(timer);
			sub.dispose();
			resolve();
		});
	});
}

function buildCompileFixNudge(problemSummary: string): string {
	return `Compile/typecheck Errors are still present — the task is NOT complete.
Fix these Errors NOW with edit tools (and re-run get_errors / the project compile command afterward).
Do NOT emit TASK_COMPLETE until get_errors shows 0 Errors and compile succeeds.

Current Errors:
${problemSummary}`;
}

const AGENT_EXECUTE_SYSTEM = `You are Mobius Agent — an autonomous coding agent that EXECUTES.

CRITICAL RULES:
1. Do NOT stall in long reasoning, questionnaires, or design interviews when the user already gave product intent (name, audience, style). Infer sensible defaults and BUILD.
2. Prefer tools over talk. To edit EXISTING files prefer replace_string_in_file (one change), multi_replace_string_in_file (several changes), or apply_patch. Use create_file for new files only. Use insert_edit_into_file only when replacing a whole section with exact new code. Use write_file only for large rewrites (>60% of file) or after patch tools fail twice.
3. To inspect the workspace use list_dir / read_file. To search code use grep_search or semantic_search. Prefer short literal queries (a symbol or path fragment) over broad regex with | alternation. If a search times out or fails, immediately retry with a simpler literal query, file_search, or list_dir — do NOT stop or ask the user. If semantic_search returns no results or is unavailable, immediately use grep_search.
4. EXTERNAL / UP-TO-DATE KNOWLEDGE: Call search_web ONCE first. Optionally call fetch_webpage ONCE for one official page. Then ANSWER immediately — do NOT repeat search_web with rephrased queries.
5. RESEARCH LIMIT: At most 2× search_web and 3× fetch_webpage per question. Snippets may be incomplete — synthesize the best answer you have instead of looping tools.
6. After list_dir/read_file/grep_search on a CODING task, your NEXT action must be a patch edit tool (not write_file) unless the user asked a pure question. Prefer editing early over long exploration.
7. After writing files, briefly report the paths you changed. Do not dump huge code in chat if a tool already wrote it.
8. On Windows PowerShell chain commands with ; not &&. Example: git status; git add .; git commit -m "message"
9. If a <skill-context> is present, use it as implementation guidance — but NEVER let a skill block execution with endless clarifying questions when the brief is already enough to ship a first version. Ignore any skill HARD-GATE or "ask one question at a time" rules in Agent mode. Do NOT call skill / view_image / tool_search / edit_files / test_search / vscode_askQuestions / vscode_reviewPlan — those are unavailable here; skill bodies are already injected when relevant, and attached images are sent directly to vision-capable models (or OCR'd locally for text-only models). For edits use replace_string_in_file / multi_replace_string_in_file / insert_edit_into_file / apply_patch / write_file.
10. Output concrete files under the workspace (e.g. web/, docs/) when building — start with the highest-value deliverable immediately.
11. NEVER ask for confirmation before editing. Do NOT call vscode_askQuestions / ask_questions / vscode_reviewPlan. Forbidden: "请确认", "是否按以上", "是否一并", "要我继续吗", "should I proceed", "please confirm", "may I edit", "ready to apply?". When the change is clear enough, call edit tools in the SAME turn — propose-then-wait is failure. If scope is slightly ambiguous, pick the narrower sensible default and edit; do not ask.
12. Keep working until the USER TASK is fully complete — including investigation/debug ("为什么/检查/排查"). Forbidden: stopping right after one terminal or read call, "请回复继续修改", "请回复任意消息", "由于本轮工具调用已用完", "我将立即对以上文件执行修改", "reply continue". There is NO tool-turn quota. After tools return — including tool ERRORS — either call the next tool or write the complete conclusion — never end silently because a tool failed.
13. COMPILE GATE (mandatory after code edits): Before TASK_COMPLETE, call get_errors and fix every Error. If the package has compile/typecheck/build, run it via run_in_terminal and fix failures. The task is complete ONLY when Errors are gone and compile succeeds — then give a short done summary and end with a line containing exactly: TASK_COMPLETE
14. TERMINAL OUTPUT: Recent terminal scrollback is NOT prefetched into the prompt. When the user asks about a build failure, crash, or log, call run_in_terminal (re-run or inspect via shell) or get_errors — do not assume you already saw terminal output.
15. TODO LIST (mandatory for multi-step work): Call manage_todo_list as your FIRST tool whenever the task needs 2+ steps (coding, debugging, Godot loop, plans, exploration). Break work into 3–7 concise items in the user's language, mark ONE in-progress before each step, mark completed immediately after each step. Skip todos only for one-line trivia with no follow-up work.
16. Before TASK_COMPLETE, ensure every manage_todo_list item is completed (the IDE may auto-complete leftovers when you emit TASK_COMPLETE).
17. TOOL CALL FORMAT (CRITICAL): Tools are provided via the API tools/function-calling channel. ALWAYS use that channel (tool_calls / tool_use). NEVER invent plain-text or XML-looking tool markup in your message content — it is not executed. To edit or run a command, emit a real native function call.
18. ENCODING / CHINESE TEXT (CRITICAL): All workspace files are UTF-8. When editing, copy non-ASCII characters (especially Chinese) EXACTLY from read_file output — do not re-type, translate-through-pinyin, or "normalize" them. If you see mojibake like 鏉茬藁 / 閿俐 / 锟斤拷 instead of real Chinese, STOP and re-read the file with read_file before editing; never write mojibake back to disk.`;

class ContinueChatAgent implements IChatAgentImplementation {
	private readonly _skillEmbeddingIndex: ContinueSkillEmbeddingIndex;
	private readonly _skillFeedbackStore: ContinueSkillFeedbackStore;
	private readonly _selfEvolving: ContinueSelfEvolving;
	private readonly _memoryStore: AgentMemoryStore;

	constructor(
		private readonly _languageModelsService: ILanguageModelsService,
		private readonly _promptsService: IPromptsService,
		private readonly _fileService: IFileService,
		private readonly _configurationService: IConfigurationService,
		private readonly _logService: ILogService,
		private readonly _workspaceService: IWorkspaceContextService,
		private readonly _languageModelToolsService: ILanguageModelToolsService,
		private readonly _commandService: ICommandService,
		private readonly _extensionService: IExtensionService,
		private readonly _markerService: IMarkerService,
		private readonly _chatTodoListService: IChatTodoListService,
		private readonly _textFileService: ITextFileService,
		private readonly _environmentService: IWorkbenchEnvironmentService,
		storageService: IStorageService,
	) {
				this._skillEmbeddingIndex = new ContinueSkillEmbeddingIndex(
			this._fileService,
			this._logService,
		);
		void this._skillEmbeddingIndex.warmup(() => loadSkillWarmSnapshot(
			this._promptsService,
			this._fileService,
			this._configurationService,
			this._logService,
			CancellationToken.None,
		));
		this._skillFeedbackStore = new ContinueSkillFeedbackStore(storageService, this._logService);

		const selfEvolutionEnabled = this._configurationService.getValue<boolean>('continue.selfEvolution.enabled') ?? true;
		const selfEvolutionGlobal = this._configurationService.getValue<boolean>('continue.selfEvolution.global') ?? false;
		const selfEvolutionMinToolCalls = this._configurationService.getValue<number>('continue.selfEvolution.minToolCalls') ?? 5;

		this._selfEvolving = new ContinueSelfEvolving(
			this._languageModelsService,
			this._fileService,
			this._workspaceService,
			this._logService,
			() => this._resolveModelId(undefined),
			{
				enabled: selfEvolutionEnabled,
				global: selfEvolutionGlobal,
				minToolCalls: selfEvolutionMinToolCalls,
			},
		);
		this._memoryStore = new AgentMemoryStore(
			this._fileService,
			this._workspaceService,
			selfEvolutionGlobal,
		);
	}

	async invoke(
		request: IChatAgentRequest,
		progress: (parts: IChatProgress[]) => void,
		history: IChatAgentHistoryEntry[],
		token: CancellationToken,
	): Promise<IChatAgentResult> {
		const modelId = this._resolveModelId(request.userSelectedModelId);
		if (!modelId) {
			progress([{
				kind: 'warning',
				content: new MarkdownString(localize('continue.noModelConfigured', "No Continue model is configured. Set your API key in Settings → Model Provider (saved to ~/.continue/.env).")),
			}]);
			return {};
		}
		this._logService.info(
			`[Continue] Agent using model '${modelId}' (requested: ${request.userSelectedModelId ?? 'none'})`,
		);

		const isChipModeSelected = isChipModeExplicitlySelected(request);
		const isGameModeSelected = isGameModeExplicitlySelected(request);
		const isGameMode = !isChipModeSelected && (isGameModeSelected || hasGameDevIntent(request.message));
		const isAgentMode = request.agentId === CONTINUE_AGENT_IDS.agent
			|| request.agentId === CONTINUE_AGENT_IDS.game
			|| request.agentId === CONTINUE_AGENT_IDS.chip
			|| isChipModeSelected;
		const docEditTask = isDocumentationEditTask(request.message);
		const codeChangeIntent = hasCodeChangeIntent(request.message) || isExecuteNowMessage(request.message) || isGameMode || isChipModeSelected;
		const investigateIntent = docEditTask ? false : hasInvestigateIntent(request.message);
		const releaseIndexingPause = isAgentMode
			? acquireIndexingPause(this._commandService, this._logService)
			: () => { };
		try {
		const cwd = request.workingDirectory
			?? this._workspaceService.getWorkspace().folders[0]?.uri;

		let skillCatalog: string | undefined;
		let skillAttachments: string[] = [];
		let routedSkillNames: string[] = [];
		if (isAgentMode) {
			const skillsContext = await this._resolveAgentSkillsContext(request, progress, token);
			skillCatalog = skillsContext.systemText || undefined;
			skillAttachments = [...skillsContext.attachmentTexts];
			routedSkillNames = [...skillsContext.routedSkillNames];
			if (isGameModeSelected) {
				const ccgsRoot = resolveCcgsRootUri(cwd, this._workspaceService);
				const gf3aRoot = resolveGameFactory3ARootUri(cwd, this._workspaceService);
				const [ccgsBootstrap, gf3aBootstrap] = await Promise.all([
					loadGameStudioBootstrapContext(ccgsRoot, this._fileService, token),
					loadGameFactory3ABootstrapContext(gf3aRoot, this._fileService, token),
				]);
				const seen = new Set(routedSkillNames);
				for (const name of [...gf3aBootstrap.routedSkillNames, ...ccgsBootstrap.routedSkillNames]) {
					if (!seen.has(name)) {
						seen.add(name);
						routedSkillNames.unshift(name);
					}
				}
				skillAttachments = [...gf3aBootstrap.attachmentTexts, ...ccgsBootstrap.attachmentTexts, ...skillAttachments];
			}
			if (routedSkillNames.length) {
				progress([{
					kind: 'markdownContent',
					content: new MarkdownString(
						localize(
							'continue.skillsAutoRouted',
							"Auto-routed skills: {0}",
							routedSkillNames.map(n => `\`${n}\``).join(', '),
						),
					),
				}]);
			}
		}

		// Overlap Continue rules RPC with OCR / vision prep — rules are not needed until system prompt assembly.
		const continueRulesPromise = isAgentMode
			? loadContinueAgentRules(this._commandService, request.message, this._logService)
			: Promise.resolve(undefined);

		let agentSystem = AGENT_EXECUTE_SYSTEM;
		const modeBody = request.modeInstructions?.content?.trim();
		if (isAgentMode && modeBody) {
			agentSystem += `\n\n<mode-instructions name="${request.modeInstructions?.name ?? ''}">\n${modeBody}\n</mode-instructions>`;
		}
		if (isChipModeSelected) {
			agentSystem += `\n\n<chip-design>\n${chipDesignSystemHint()}\n</chip-design>`;
			if (cwd) {
				const detect = await bootstrapChipModeDetect(
					createFpgaToolHost(this._fileService, this._workspaceService, this._getAppRoot()),
					this._languageModelToolsService,
					this._logService,
					{ sessionResource: request.sessionResource, workingDirectory: cwd, chatRequestId: request.requestId },
					token,
				);
				progress([{
					kind: 'markdownContent',
					content: new MarkdownString(
						localize(
							'continue.fpgaDetectStart',
							"**fpga_detect** (Chip mode, automatic)\n\n```\n{0}\n```",
							detect.text.slice(0, 8000),
						),
					),
				}]);
				agentSystem += `\n\n<fpga-detect ok="${detect.ok}">\n${detect.text}\n</fpga-detect>`;
			}
		} else if (isGameModeSelected) {
			const ccgsRel = ccgsRelativePath(resolveCcgsRootUri(cwd, this._workspaceService), this._workspaceService);
			const gf3aRel = gf3aRelativePath(resolveGameFactory3ARootUri(cwd, this._workspaceService), this._workspaceService);
			agentSystem += `\n\n<game-studio-workflow>\n${gameStudioWorkflowSystemHint(ccgsRel)}\n</game-studio-workflow>`;
			agentSystem += `\n\n<game-factory-3a>\n${gameFactory3AWorkflowSystemHint(gf3aRel)}\n</game-factory-3a>`;
			agentSystem += `\n\n<game-dev>\n${gameDevSystemHint()}\n</game-dev>`;
		} else if (isGameMode) {
			agentSystem += `\n\n<game-dev>\n${gameDevSystemHint()}\n</game-dev>`;
		}
		if (docEditTask && isAgentMode) {
			agentSystem += `\n\n<doc-edit-fast-path>
Documentation-only edit (README / markdown). Workflow: read_file on the named .md files only (skip repo-wide grep unless one targeted phrase search is essential) → replace_string_in_file on those files → TASK_COMPLETE. Do NOT use manage_todo_list, get_errors, compile, or run_in_terminal. Target ≤5 tool calls; do not audit unrelated files first.
</doc-edit-fast-path>`;
		}

				let ocrExtract: string | undefined;
		let visionImageParts: Awaited<ReturnType<typeof collectAgentRequestImageParts>>['parts'] | undefined;
		try {
			const attached = request.variables?.variables ?? [];
			const maybeImages = attached.filter(v =>
				v.kind === 'image'
				|| (typeof v.name === 'string' && /\.(png|jpe?g|gif|webp|bmp)$/i.test(v.name))
			);

			// Prefer native multimodal delivery when the selected chat model declares vision support —
			// only fall back to local GLM-OCR for text-only / unknown models.
			const modelMeta = this._languageModelsService.lookupLanguageModel(modelId);
			const supportsVision = modelMeta?.capabilities?.vision === true;

			if (maybeImages.length) {
				if (supportsVision) {
					progress([{
						kind: 'markdownContent',
						content: new MarkdownString(
							localize(
								'continue.visionPassthrough',
								"Model `{0}` supports vision — sending {1} image(s) directly (skipping local OCR).",
								modelMeta?.family ?? modelId,
								maybeImages.length,
							),
						),
					}]);
					const collected = await collectAgentRequestImageParts(
						request,
						this._fileService,
						this._logService,
					);
					visionImageParts = collected.parts;
					if (collected.unresolved > 0 && collected.imageCount === 0) {
						progress([{
							kind: 'warning',
							content: new MarkdownString(
								localize(
									'continue.visionUnresolved',
									"Found image attachment(s) but could not read image bytes.",
								),
							),
						}]);
					}
				} else {
					progress([{
						kind: 'markdownContent',
						content: new MarkdownString(
							localize(
								'continue.ocrRunning',
								"Running local OCR (`{0}`) on {1} image(s)…",
								BUNDLED_ONNX_OCR.model,
								maybeImages.length,
							),
						),
					}]);

					const ocr = await preprocessAgentRequestOcr(
						request,
						this._commandService,
						this._fileService,
						this._logService,
						token,
					);
					if (ocr.unresolvedAttachments > 0 && ocr.imageCount === 0) {
						progress([{
							kind: 'warning',
							content: new MarkdownString(
								localize(
									'continue.ocrUnresolved',
									"Local OCR: found image attachment(s) but could not read image bytes.",
								),
							),
						}]);
					} else if (ocr.imageCount > 0) {
						if (ocr.successCount > 0) {
							progress([{
								kind: 'markdownContent',
								content: new MarkdownString(
									localize(
										'continue.ocrDone',
										"Local OCR (`{0}`): extracted text from {1}/{2} image(s).",
										BUNDLED_ONNX_OCR.model,
										ocr.successCount,
										ocr.imageCount,
									),
								),
							}]);
						} else if (ocr.lastError) {
							progress([{
								kind: 'warning',
								content: new MarkdownString(
									localize(
										'continue.ocrErrorDetail',
										"Local OCR (`{0}`) failed: {1}",
										BUNDLED_ONNX_OCR.model,
										ocr.lastError.slice(0, 240),
									),
								),
							}]);
						} else {
							progress([{
								kind: 'markdownContent',
								content: new MarkdownString(
									localize(
										'continue.ocrEmpty',
										"Local OCR (`{0}`): no text found in {1} image(s).",
										BUNDLED_ONNX_OCR.model,
										ocr.imageCount,
									),
								),
							}]);
						}
					}
					ocrExtract = ocr.extractBlock;
				}
			}
		} catch (err) {
			this._logService.warn(`[Continue][OCR] preprocess failed: ${err instanceof Error ? err.message : String(err)}`);
			progress([{
				kind: 'warning',
				content: new MarkdownString(
					localize(
						'continue.ocrFailed',
						"Local OCR failed ({0}). Continuing without image text.",
						BUNDLED_ONNX_OCR.model,
					),
				),
			}]);
		}

		const webSearchIntent = hasWebSearchIntent(request.message);
		const lightweightTask = isLightweightAgentTask(request.message, {
			codeChangeIntent,
			investigateIntent,
			isGameMode,
			isChipMode: isChipModeSelected,
		}) || docEditTask;
		const todoListIntent = !lightweightTask && shouldUseTodoList(request.message, {
			codeChangeIntent,
			investigateIntent,
			isGameMode,
			isChipMode: isChipModeSelected,
			webSearchIntent,
		});
		const maxCompletionVerifyNudges = lightweightTask
			? LIGHTWEIGHT_COMPLETION_VERIFY_NUDGES
			: MAX_COMPLETION_VERIFY_NUDGES;
		const maxPostToolContinueNudges = lightweightTask
			? LIGHTWEIGHT_POST_TOOL_CONTINUE_NUDGES
			: MAX_POST_TOOL_CONTINUE_NUDGES;
		if (lightweightTask) {
			this._logService.info(
				docEditTask
					? '[Continue] Doc-edit fast path — skipping todo, memory, compile gate; capped tool turns'
					: '[Continue] Lightweight task — skipping todo list and cross-session memory recall',
			);
		}

		const memoriesPromise = isAgentMode && !lightweightTask
			? this._recallMemories(request.message)
			: Promise.resolve(undefined);

		const [continueRules, memories] = await Promise.all([
			continueRulesPromise,
			memoriesPromise,
		]);
		if (continueRules) {
			agentSystem += `\n\n<continue-rules>\n${continueRules}\n</continue-rules>`;
		}
		const executeSystemWithRules = isAgentMode
			? appendWorkingDirectoryHint(agentSystem, cwd)
			: undefined;

				let messages = buildChatMessages(
			history,
			request.message,
			executeSystemWithRules,
			skillCatalog,
			skillAttachments,
			ocrExtract,
			memories,
			visionImageParts,
			todoListIntent,
			docEditTask,
		);

		if (!isAgentMode) {
			await this._streamOnce(modelId, messages, progress, token);
			return {};
		}

		const toolStats = { writeSuccess: 0, writeFailed: 0, exploreOnly: false };
		await this._ensureCopilotToolImplementationsMounted(token);
		const agentTools = await loadAgentToolSuperset(
			this._languageModelToolsService,
			this._commandService,
			this._logService,
		);
		/** Keep looping until the user task is done (edits OR investigation), not mere Q&A. */
		const untilDoneIntent = (codeChangeIntent || investigateIntent);
		if (webSearchIntent) {
			this._logService.info('[Continue] Web-search intent detected — forcing search_web tool');
		}
		const existingTodos = this._chatTodoListService.getTodos(request.sessionResource);
		let needsInitialTodoList = todoListIntent && existingTodos.length === 0;
		if (needsInitialTodoList) {
			this._logService.info('[Continue] Todo-list intent detected — will force manage_todo_list on first turn');
		}

		let needsFinalAnswer = false;
		let searchFailureCount = 0;
		let prevSearchFailureCount = 0;
		let searchFailureNudges = 0;
		let deadEndToolFailureCount = 0;
		let prevDeadEndToolFailureCount = 0;
		let deadEndToolNudges = 0;
		let narratedToolNudges = 0;
		let streamErrorRecoveries = 0;
		let transientCancelRecoveries = 0;
		let streamErrorTaskRescues = 0;
		let rateLimitRecoveries = 0;
		let stoppedForRateLimit = false;
		let postToolContinueNudges = 0;
		let lastTurnHadTools = false;
				let midLoopEditNudged = false;
		let exitedOnTaskComplete = false;
		let lastAssistantText = '';
		let completionVerifyNudges = 0;
		let compileFixNudges = 0;
		let forceRequiredTools = false;
		const editedUris = new Set<string>();
		const godotAutoPreview = isGameMode ? createGodotAutoPreviewState() : undefined;
		const taskRecorder = new TaskExecutionRecorder();
		taskRecorder.start(request.message);
		if (isGameMode && godotAutoPreview && cwd) {
			const godotHost = createGodotToolHost(
				this._fileService,
				this._workspaceService,
				this._getAppRoot(),
			);
			const terminalContext = {
				sessionResource: request.sessionResource,
				workingDirectory: cwd,
				chatRequestId: request.requestId,
			};
			void bootstrapGameModeGodotLivePreview(
				godotHost,
				this._languageModelToolsService,
				this._logService,
				terminalContext,
				godotAutoPreview,
				token,
			).then(result => {
				if (token.isCancellationRequested) {
					return;
				}
				if (result.editorOpened) {
					this._logService.info('[Continue][Godot] Live editor opened at Game-mode start');
					progress([{
						kind: 'markdownContent',
						content: new MarkdownString(
							localize(
								'continue.godotLivePreviewStart',
								"**Live preview** — Godot editor is open. Script/scene saves hot-reload while the agent edits; press **Stop** anytime to change direction.",
							),
						),
					}]);
				}
				if (result.gameOpened) {
					this._logService.info('[Continue][Godot] Live game window opened at Game-mode start');
					progress([{
						kind: 'markdownContent',
						content: new MarkdownString(
							localize(
								'continue.godotLiveGameStart',
								"**Game running** — use **arrow keys** to play (no autopilot). Score starts at 0; watch stars spawn while the agent edits.",
							),
						),
					}]);
				}
				if (!result.ok && result.text) {
					this._logService.warn('[Continue][Godot] Game-mode bootstrap failed', result.text);
					progress([{
						kind: 'markdownContent',
						content: new MarkdownString(result.text),
					}]);
				}
			}).catch(err => this._logService.warn('[Continue][Godot] Live preview at start failed', err));
		}
		// Coding / investigate / URL+web research: long runway only. Never apply the 16-turn
		// Q&A soft cap when the prompt has web/URL intent (that aborted mid-update).
		const maxTurns = docEditTask
			? DOC_EDIT_MAX_TURNS
			: lightweightTask
				? LIGHTWEIGHT_MAX_TURNS
				: (untilDoneIntent || webSearchIntent)
					? RUNAWAY_TOOL_TURN_GUARD
					: QA_TOOL_TURNS;
		let turnBudget = maxTurns;
		let editRescueGranted = false;

		for (let turn = 0; turn < turnBudget; turn++) {
			if (token.isCancellationRequested) {
				break;
			}

			const forceTool = turn === 0 && webSearchIntent
				? 'search_web'
				: turn === 0 && needsInitialTodoList
					? 'manage_todo_list'
					: undefined;
			// Force native tool_calls when coding still needs writes, or after a textual-tool dump.
			const requireNativeTools = !forceTool && (
				forceRequiredTools
				|| (untilDoneIntent && codeChangeIntent && toolStats.writeSuccess === 0)
			);
			let assistantText = '';
			let toolUses: IChatResponseToolUsePart[] = [];
			let recoveredTextualTools = false;
			let truncatedTextualToolDump = false;
			let narratedToolSpam = false;
			let assistantThinking = '';
			try {
				const streamed = await this._streamOnce(
					modelId,
					messages,
					progress,
					token,
					agentTools,
					forceTool,
					false,
					requireNativeTools,
				);
				assistantText = streamed.assistantText;
				toolUses = streamed.toolUses;
				recoveredTextualTools = streamed.recoveredTextualTools;
				truncatedTextualToolDump = streamed.truncatedTextualToolDump;
				narratedToolSpam = streamed.narratedToolSpam;
				assistantThinking = streamed.thinkingText;
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				this._logService.warn('[Continue] Agent stream failed — recovering', msg);
				if (token.isCancellationRequested) {
					break;
				}

				// TPM / 429: wait and retry the same turn — do NOT append nudges (burns more tokens)
				// and do NOT dump raw tool results when giving up.
				if (isRateLimitError(msg)) {
					if (rateLimitRecoveries >= MAX_RATE_LIMIT_RECOVERIES) {
						stoppedForRateLimit = true;
						progress([{
							kind: 'warning',
							content: new MarkdownString(
								localize(
									'continue.rateLimitFinal',
									"Model TPM rate limit exceeded after retries. {0}",
									RATE_LIMIT_USER_MESSAGE,
								),
							),
						}]);
						break;
					}
					rateLimitRecoveries++;
					const waitMs = rateLimitBackoffMs(rateLimitRecoveries - 1, msg);
					this._logService.info(`[Continue] Rate limit — backing off ${waitMs}ms (attempt ${rateLimitRecoveries}/${MAX_RATE_LIMIT_RECOVERIES})`);
					progress([{
						kind: 'markdownContent',
						content: new MarkdownString(
							localize(
								'continue.rateLimitBackoff',
								"Rate limited (429/TPM). Waiting {0}s before retry ({1}/{2})…",
								Math.ceil(waitMs / 1000),
								rateLimitRecoveries,
								MAX_RATE_LIMIT_RECOVERIES,
							),
						),
					}]);
					await delayCancellable(waitMs, token);
					continue;
				}

				// Transient Canceled / EH blip: retry quietly (do not burn a "stream failed" slot
				// and do not force a tools-disabled summary mid-edit).
				if (isTransientStreamCancelError(msg)) {
					if (transientCancelRecoveries >= MAX_TRANSIENT_CANCEL_RECOVERIES) {
						if (
							untilDoneIntent
							&& streamErrorTaskRescues < MAX_STREAM_ERROR_TASK_RESCUES
						) {
							streamErrorTaskRescues++;
							transientCancelRecoveries = 0;
							forceRequiredTools = true;
							this._logService.warn(
								'[Continue] Transient cancel budget exhausted — granting coding rescue turn',
							);
							messages = [
								...messages,
								{
									role: ChatMessageRole.User,
									content: [{
										type: 'text',
										value: `${STREAM_ERROR_CONTINUE_NUDGE}\n\n(Provider stream was canceled repeatedly; continue the unfinished edits now.)`,
									}],
								},
							];
							continue;
						}
						progress([{
							kind: 'warning',
							content: new MarkdownString(
								localize(
									'continue.streamCancelFinal',
									"Model stream kept canceling after retries ({0}). Continuing with a status summary — send 「继续」to resume edits.",
									msg.slice(0, 120),
								),
							),
						}]);
						needsFinalAnswer = true;
						break;
					}
					transientCancelRecoveries++;
					const waitMs = transientCancelBackoffMs(transientCancelRecoveries - 1);
					this._logService.info(
						`[Continue] Transient stream cancel — retry in ${waitMs}ms (${transientCancelRecoveries}/${MAX_TRANSIENT_CANCEL_RECOVERIES})`,
					);
					progress([{
						kind: 'markdownContent',
						content: new MarkdownString(
							localize(
								'continue.streamCancelBackoff',
								"Model stream canceled (transient). Retrying in {0}s ({1}/{2})…",
								Math.ceil(waitMs / 1000),
								transientCancelRecoveries,
								MAX_TRANSIENT_CANCEL_RECOVERIES,
							),
						),
					}]);
					await delayCancellable(waitMs, token);
					continue;
				}

				if (streamErrorRecoveries >= MAX_STREAM_ERROR_RECOVERIES) {
					if (
						untilDoneIntent
						&& streamErrorTaskRescues < MAX_STREAM_ERROR_TASK_RESCUES
					) {
						streamErrorTaskRescues++;
						streamErrorRecoveries = 0;
						forceRequiredTools = true;
						this._logService.warn(
							'[Continue] Stream-error budget exhausted — granting coding rescue turn',
						);
						messages = [
							...messages,
							{
								role: ChatMessageRole.User,
								content: [{
									type: 'text',
									value: `${STREAM_ERROR_CONTINUE_NUDGE}\n\n(Provider error: ${msg.slice(0, 240)})`,
								}],
							},
						];
						continue;
					}
					progress([{
						kind: 'warning',
						content: new MarkdownString(
							localize(
								'continue.streamFailedFinal',
								"Model stream failed repeatedly ({0}). Stopping tools and summarizing.",
								msg.slice(0, 200),
							),
						),
					}]);
					needsFinalAnswer = true;
					break;
				}
				streamErrorRecoveries++;
				forceRequiredTools = codeChangeIntent || investigateIntent;
				messages = [
					...messages,
					{
						role: ChatMessageRole.User,
						content: [{
							type: 'text',
							value: `${STREAM_ERROR_CONTINUE_NUDGE}\n\n(Provider error: ${msg.slice(0, 240)})`,
						}],
					},
				];
				continue;
			}
			forceRequiredTools = false;
			if (recoveredTextualTools) {
				this._logService.warn(
					'[Continue] Model dumped tools as chat text; recovered into native tool_use and will require tool_calls next turn',
				);
				forceRequiredTools = true;
			}
			if (!toolUses.length) {
				if (turn === 0 && webSearchIntent) {
					messages = [
						...messages,
						...(assistantText.trim() ? [{ role: ChatMessageRole.Assistant, content: [{ type: 'text' as const, value: assistantText }] }] : []),
						{
							role: ChatMessageRole.User,
							content: [{
								type: 'text',
								value: 'Stop answering from memory. Call search_web NOW with a query about the user question, then answer using only the search results.',
							}],
						},
					];
					forceRequiredTools = true;
					continue;
				}
				if (turn === 0 && hasScaffoldProjectIntent(request.message)) {
					messages = [
						...messages,
						...(assistantText.trim() ? [{ role: ChatMessageRole.Assistant, content: [{ type: 'text' as const, value: assistantText }] }] : []),
						{
							role: ChatMessageRole.User,
							content: [{
								type: 'text',
								value: 'Do not continue planning. Call create_file or write_file NOW — create the first file under the session working directory (e.g. README.md). Tools are required.',
							}],
						},
					];
					forceRequiredTools = true;
					continue;
				}
				if (
					needsInitialTodoList
					&& this._chatTodoListService.getTodos(request.sessionResource).length === 0
				) {
					messages = [
						...messages,
						...(assistantText.trim() ? [{ role: ChatMessageRole.Assistant, content: [{ type: 'text' as const, value: assistantText }] }] : []),
						{
							role: ChatMessageRole.User,
							content: [{ type: 'text', value: TODO_LIST_FORCE_NUDGE }],
						},
					];
					forceRequiredTools = true;
					continue;
				}

				// Model dumped XML/prose tool markup, or narrated "executing now" without tool_calls.
				if (looksLikeTextualToolDump(assistantText) || truncatedTextualToolDump || narratedToolSpam) {
					if (narratedToolSpam && narratedToolNudges >= MAX_NARRATED_TOOL_NUDGES) {
						this._logService.warn('[Continue] Narrated-tool loop exhausted — stopping tools and summarizing');
						progress([{
							kind: 'warning',
							content: new MarkdownString(
								localize(
									'continue.narratedToolLoop',
									"The model kept describing tool calls instead of executing them. Try a different chat model, or rephrase as a direct shell/edit request.",
								),
							),
						}]);
						needsFinalAnswer = true;
						break;
					}
					if (narratedToolSpam) {
						narratedToolNudges++;
					}
					this._logService.warn('[Continue] Assistant emitted textual/narrated tool markup — nudging native tool_use + tool_choice=required');
					messages = [
						...messages,
						{
							role: ChatMessageRole.Assistant,
							content: [{
								type: 'text' as const,
								value: narratedToolSpam
									? '[invalid] Previous turn narrated a tool call in prose; nothing executed.'
									: '[invalid] Previous turn wrote tool calls as plain text; ignored.',
							}],
						},
						{
							role: ChatMessageRole.User,
							content: [{
								type: 'text',
								value: narratedToolSpam
									? NARRATED_TOOL_NUDGE
									: TEXTUAL_TOOL_NUDGE,
							}],
						},
					];
					forceRequiredTools = true;
					continue;
				}

				const codingUntilDone = untilDoneIntent;
				if (codingUntilDone) {
					// After tools just ran: empty reply or "I'll check next" without tools is a premature stop.
					const incompleteAfterTools = lastTurnHadTools && (
						!assistantText.trim()
						|| looksLikeIncompleteInvestigation(assistantText)
						|| looksLikePromisedEditsWithoutTools(assistantText)
						|| looksLikeRemainingWork(assistantText)
						|| asksToContinueNextTurn(assistantText)
						|| looksLikeIncompleteHandoff(assistantText)
					);
					if (
						incompleteAfterTools
						&& !assertsTaskComplete(assistantText)
						&& postToolContinueNudges < maxPostToolContinueNudges
					) {
						postToolContinueNudges++;
						this._logService.info(
							`[Continue] Post-tool premature stop — continue nudge ${postToolContinueNudges}/${maxPostToolContinueNudges}`,
						);
						messages = [
							...messages,
							...(assistantText.trim() ? [{ role: ChatMessageRole.Assistant, content: [{ type: 'text' as const, value: assistantText }] }] : []),
							{
								role: ChatMessageRole.User,
								content: [{
									type: 'text',
									value: investigateIntent && !codeChangeIntent
										? INVESTIGATE_CONTINUE_NUDGE
										: looksLikePromisedEditsWithoutTools(assistantText)
											? FINISH_REMAINING_EDITS_NUDGE
											: POST_TOOL_CONTINUE_NUDGE,
								}],
							},
						];
						forceRequiredTools = true;
						lastTurnHadTools = false;
						continue;
					}

					const claimsComplete = assertsTaskComplete(assistantText);
					// Explicit done wins: do not re-nudge for false "remaining" matches or missing TASK_COMPLETE token shape.
					const earlyStop = !claimsComplete && (
						asksToContinueNextTurn(assistantText)
						|| asksForUserConfirmation(assistantText)
						|| looksLikeIncompleteHandoff(assistantText)
						|| looksLikePromisedEditsWithoutTools(assistantText)
						|| looksLikeRemainingWork(assistantText)
						|| looksLikeChangeProposal(assistantText)
						|| looksLikeIncompleteInvestigation(assistantText)
						|| (codeChangeIntent && toolStats.writeSuccess === 0)
						|| !assistantText.trim()
					);

					if (earlyStop) {
						const stillMustEdit =
							(codeChangeIntent && toolStats.writeSuccess === 0)
							|| asksToContinueNextTurn(assistantText)
							|| asksForUserConfirmation(assistantText)
							|| looksLikeIncompleteHandoff(assistantText)
							|| looksLikePromisedEditsWithoutTools(assistantText)
							|| looksLikeRemainingWork(assistantText)
							|| looksLikeChangeProposal(assistantText)
							|| looksLikeIncompleteInvestigation(assistantText)
							|| !assistantText.trim();

						if (stillMustEdit || completionVerifyNudges < maxCompletionVerifyNudges) {
							if (!stillMustEdit) {
								completionVerifyNudges++;
							}
							messages = [
								...messages,
								...(assistantText.trim() ? [{ role: ChatMessageRole.Assistant, content: [{ type: 'text' as const, value: assistantText }] }] : []),
								{
									role: ChatMessageRole.User,
									content: [{
										type: 'text',
										value: stillMustEdit
											? (investigateIntent && !codeChangeIntent
												? INVESTIGATE_CONTINUE_NUDGE
												: (asksToContinueNextTurn(assistantText) || looksLikeIncompleteHandoff(assistantText) || looksLikePromisedEditsWithoutTools(assistantText)
													? FINISH_REMAINING_EDITS_NUDGE
													: CONTINUE_UNTIL_TASK_DONE_NUDGE))
											: CONTINUE_UNTIL_TASK_DONE_NUDGE,
									}],
								},
							];
							if (stillMustEdit) {
								forceRequiredTools = true;
							}
							continue;
						}
						// Wrote something / answered, no remaining-work signals, and verify nudges exhausted
						// without TASK_COMPLETE — still require compile/problem gate below.
						this._logService.info(
							'[Continue] Accepting agent stop after completion verifies (no remaining-work signals)',
						);
					}

					if (
						codeChangeIntent
						&& toolStats.writeSuccess > 0
						&& compileFixNudges < MAX_COMPILE_FIX_NUDGES
						&& !docEditTask
						&& !editedUrisAreDocumentationOnly(editedUris)
					) {
						const compileNudge = await this._buildCompileGateNudge(
							editedUris,
							token,
						);
						if (compileNudge) {
							compileFixNudges++;
							this._logService.info(
								`[Continue] Compile gate blocked TASK_COMPLETE (nudge ${compileFixNudges}/${MAX_COMPILE_FIX_NUDGES})`,
							);
							messages = [
								...messages,
								...(assistantText.trim() ? [{ role: ChatMessageRole.Assistant, content: [{ type: 'text' as const, value: assistantText }] }] : []),
								{
									role: ChatMessageRole.User,
									content: [{ type: 'text', value: compileNudge }],
								},
							];
							continue;
						}
					}

					exitedOnTaskComplete = true;
					lastAssistantText = assistantText;
					break;
			}

			// Stall / propose-without-edit on non-until-done paths.
				if (
					asksToContinueNextTurn(assistantText)
					|| asksForUserConfirmation(assistantText)
					|| looksLikeIncompleteHandoff(assistantText)
					|| looksLikePromisedEditsWithoutTools(assistantText)
					|| looksLikeIncompleteInvestigation(assistantText)
					|| (lastTurnHadTools && !assistantText.trim() && postToolContinueNudges < maxPostToolContinueNudges)
					|| (turn < 2 && toolStats.writeSuccess === 0 && (
						isExecuteNowMessage(request.message)
						|| looksLikeChangeProposal(assistantText)
					))
				) {
					if (lastTurnHadTools && !assistantText.trim()) {
						postToolContinueNudges++;
					}
					messages = [
						...messages,
						...(assistantText.trim() ? [{ role: ChatMessageRole.Assistant, content: [{ type: 'text' as const, value: assistantText }] }] : []),
						{
							role: ChatMessageRole.User,
							content: [{
								type: 'text',
								value: lastTurnHadTools
									? POST_TOOL_CONTINUE_NUDGE
									: FINISH_REMAINING_EDITS_NUDGE,
							}],
						},
					];
					forceRequiredTools = true;
					lastTurnHadTools = false;
					continue;
				}
				// Model stopped tools but produced no answer text (common after web research or local thinking models).
				if (!assistantText.trim()) {
					needsFinalAnswer = true;
				}
				lastAssistantText = assistantText;
				exitedOnTaskComplete = true;
				break;
		}

			lastTurnHadTools = true;
			postToolContinueNudges = 0;
			const assistantContent: IChatMessage['content'] = [];
			if (assistantThinking.trim()) {
				assistantContent.push({ type: 'thinking', value: assistantThinking });
			}
			if (assistantText.trim()) {
				assistantContent.push({ type: 'text', value: assistantText });
			}
			for (const call of toolUses) {
				assistantContent.push(call);
			}
			messages = [
				...messages,
				{ role: ChatMessageRole.Assistant, content: assistantContent },
			];

			// Stall / remaining-work text with tools — keep going after tools run.
			// If the model already asserted completion, do not treat verify/read tools as a stall loop.
			const stallWithTools =
				!assertsTaskComplete(assistantText) && (
					asksToContinueNextTurn(assistantText)
					|| looksLikeIncompleteHandoff(assistantText)
					|| looksLikePromisedEditsWithoutTools(assistantText)
					|| asksForUserConfirmation(assistantText)
					|| looksLikeRemainingWork(assistantText)
					|| looksLikeIncompleteInvestigation(assistantText)
				);

			for (const call of toolUses) {
				if (token.isCancellationRequested) {
					break;
				}
				progress([{
					kind: 'externalToolInvocationUpdate',
					toolCallId: call.toolCallId,
					toolName: call.name,
					isComplete: false,
					invocationMessage: `${formatSupersetToolDisplayName(call.name)}…`,
				}]);

				const { ok, text, editUri, editKind } = await this._executeTool(
					call,
					cwd,
					request.sessionResource,
					request.requestId,
					token,
					godotAutoPreview,
				);
				if (isManageTodoListTool(call.name)) {
					needsInitialTodoList = false;
				}
				this._trackToolOutcome(call.name, ok, toolStats);
				taskRecorder.recordToolCall(call.name, call.parameters, ok);
				if (editUri) {
					taskRecorder.recordEdit(editUri.toString());
				}

				const searchTimedOut = isCopilotSearchTimeoutError(text)
					|| isCopilotSearchUnavailableResult(text);
				const searchFailed = (!ok || searchTimedOut) && isWorkspaceSearchTool(call.name);
				if (searchFailed) {
					searchFailureCount++;
				}
				const deadEndFailed = !ok && isDeadEndContinueTool(call.name);
				if (deadEndFailed) {
					deadEndToolFailureCount++;
				}
				const toolResultText = searchFailed
					? `${text}\n\n${SEARCH_FAILURE_RECOVERY_HINT}`
					: deadEndFailed && !text.includes('unavailable in Continue Agent')
						? `${text}\n\n${unsupportedCopilotToolRecovery(call.name)}`
						: text;

				progress([{
					kind: 'externalToolInvocationUpdate',
					toolCallId: call.toolCallId,
					toolName: call.name,
					isComplete: true,
					pastTenseMessage: ok && !searchTimedOut
						? `${formatSupersetToolDisplayName(call.name)} done`
						: `${formatSupersetToolDisplayName(call.name)} failed`,
					errorMessage: ok && !searchTimedOut ? undefined : toolResultText,
				}]);
				if (editUri && editKind) {
					editedUris.add(editUri.toString());
					if (godotAutoPreview && isGameDevProjectUri(editUri.toString())) {
						godotAutoPreview.gameFilesEdited = true;
						if (ok && !godotAutoPreview.editorLaunched) {
							void openGodotLiveEditorIfNeeded(
								this._godotToolHost(),
								this._languageModelToolsService,
								this._logService,
								{ sessionResource: request.sessionResource, workingDirectory: cwd, chatRequestId: request.requestId },
								godotAutoPreview,
								token,
							).then(live => {
								if (live.opened) {
									this._logService.info('[Continue][Godot] Live editor opened after game-dev edit');
									progress([{
										kind: 'markdownContent',
										content: new MarkdownString(
											localize(
												'continue.godotLivePreviewEdit',
												"**Live preview** — Godot editor opened. Watch changes as the agent saves; press **Stop** anytime to redirect.",
											),
										),
									}]);
								}
							}).catch(err => this._logService.warn('[Continue][Godot] Live preview after edit failed', err));
						}
					}
					progress([{
						kind: 'externalEdit',
						uri: editUri,
						editKind,
						undoStopId: call.toolCallId,
					}]);
				}

				messages = [
					...messages,
					{
						role: ChatMessageRole.User,
						content: [{
							type: 'tool_result',
							toolCallId: call.toolCallId,
							value: [{ type: 'text', value: toolResultText }],
							isError: !ok || searchTimedOut,
						}],
					},
				];
			}

			// Search timeout/failure must not end the agent run — force a narrower retry / edit.
			if (
				searchFailureCount > prevSearchFailureCount
				&& searchFailureNudges < MAX_SEARCH_FAILURE_NUDGES
			) {
				prevSearchFailureCount = searchFailureCount;
				searchFailureNudges++;
				forceRequiredTools = true;
				messages = [
					...messages,
					{
						role: ChatMessageRole.User,
						content: [{
							type: 'text',
							value: codeChangeIntent
								? SEARCH_FAILURE_CONTINUE_NUDGE
								: SEARCH_FAILURE_RECOVERY_HINT,
						}],
					},
				];
				continue;
			}

			// skill / view_image / tool_search failures must not end the agent run.
			if (
				deadEndToolFailureCount > prevDeadEndToolFailureCount
				&& deadEndToolNudges < MAX_DEAD_END_TOOL_NUDGES
			) {
				prevDeadEndToolFailureCount = deadEndToolFailureCount;
				deadEndToolNudges++;
				forceRequiredTools = true;
				this._logService.info(
					`[Continue] Dead-end tool failed — continue nudge ${deadEndToolNudges}/${MAX_DEAD_END_TOOL_NUDGES}`,
				);
				messages = [
					...messages,
					{
						role: ChatMessageRole.User,
						content: [{ type: 'text', value: DEAD_END_TOOL_CONTINUE_NUDGE }],
					},
				];
				continue;
			}

			if (stallWithTools) {
				messages = [
					...messages,
					{
						role: ChatMessageRole.User,
						content: [{
							type: 'text',
							value: untilDoneIntent
							? (investigateIntent && !codeChangeIntent
								? INVESTIGATE_CONTINUE_NUDGE
								: CONTINUE_UNTIL_TASK_DONE_NUDGE)
							: FINISH_REMAINING_EDITS_NUDGE,
						}],
					},
				];
				forceRequiredTools = true;
				continue;
			}

			// Mid-loop: stop endless explore on coding tasks — force edits early.
			if (
				!midLoopEditNudged
				&& codeChangeIntent
				&& toolStats.writeSuccess === 0
				&& turn >= EXPLORE_BEFORE_EDIT_NUDGE_TURN - 1
			) {
				midLoopEditNudged = true;
				forceRequiredTools = true;
				messages = [
					...messages,
					{
						role: ChatMessageRole.User,
						content: [{
							type: 'text',
							value: 'Stop exploring. Call edit tools NOW (replace_string_in_file / multi_replace_string_in_file / insert_edit_into_file / write_file). Do not ask the user to reply again.',
						}],
					},
				];
			}

			// Soft-cap rescue: coding never wrote — extend the main loop once instead of
			// dying at "Let me update both files:" with a tools-disabled status summary.
			if (
				turn >= turnBudget - 1
				&& !exitedOnTaskComplete
				&& codeChangeIntent
				&& toolStats.writeSuccess === 0
				&& !editRescueGranted
			) {
				editRescueGranted = true;
				turnBudget += EDIT_RESCUE_EXTRA_TURNS;
				forceRequiredTools = true;
				this._logService.warn(
					`[Continue] Tool-turn loop hit soft cap with 0 writes — granting ${EDIT_RESCUE_EXTRA_TURNS} edit-rescue turns`,
				);
				messages = [
					...messages,
					{
						role: ChatMessageRole.User,
						content: [{
							type: 'text',
							value: 'Stop narrating. You have enough context. Call edit tools NOW (replace_string_in_file / multi_replace_string_in_file / insert_edit_into_file / write_file). Do not ask the user to reply. Do not only describe planned updates.',
						}],
					},
				];
			}
		}

		// Exhausted maxTurns without task completion (coding runaway guard, or Q&A soft cap).
		if (!exitedOnTaskComplete && !token.isCancellationRequested && !needsFinalAnswer && !stoppedForRateLimit) {
			this._logService.warn(
				`[Continue] Tool-turn loop exhausted (${turnBudget}) without task completion — forcing status summary`,
			);
			needsFinalAnswer = true;
			messages = [
				...messages,
				{
					role: ChatMessageRole.User,
					content: [{
						type: 'text',
						value: codeChangeIntent
							? 'A safety guard stopped further tool calls after a very long run. Report briefly what was changed and what remains. FORBIDDEN: "工具调用已用完", "请回复任意消息", or asking the user to ping you.'
							: investigateIntent
								? 'Tools paused after a long investigation. Write the root-cause conclusion now from tool results. FORBIDDEN: asking the user to reply again.'
								: 'Tools are done for this question. Write the final answer now. FORBIDDEN: asking the user to reply again.',
					}],
				},
			];
		}

		if (needsFinalAnswer && !token.isCancellationRequested && !stoppedForRateLimit) {
			await this._forceFinalAnswer(modelId, messages, progress, token);
		}

		if (routedSkillNames.length) {
			const outcome = classifySkillRoutingOutcome(toolStats);
			this._skillFeedbackStore.recordOutcome(routedSkillNames, outcome);
		}

		// Model often emits TASK_COMPLETE without updating manage_todo_list — sync the UI.
		// Also tear down pending background-terminal completion steering so a late
		// "terminal exited" System Notification cannot start a new agent turn.
				if (exitedOnTaskComplete && !token.isCancellationRequested && request.sessionResource) {
			this._completeSessionTodos(request.sessionResource);
			RunInTerminalTool.suppressBackgroundSteeringForSession(request.sessionResource);
		}

		if (
			exitedOnTaskComplete
			&& isGameMode
			&& godotAutoPreview
			&& !token.isCancellationRequested
		) {
			try {
				const autoPreview = await ensureGodotPreviewLaunched(
					this._godotToolHost(),
					this._languageModelToolsService,
					this._logService,
					{ sessionResource: request.sessionResource, workingDirectory: cwd, chatRequestId: request.requestId },
					godotAutoPreview,
					token,
				);
				if (autoPreview.launched) {
					this._logService.info('[Continue][Godot] Auto-launched Godot preview after Game-mode task completion');
					progress([{
						kind: 'markdownContent',
						content: new MarkdownString(
							localize(
								'continue.godotAutoPreview',
								"**Godot preview (automatic)** — opened because Game-mode work finished. You do not need to launch Godot manually.\n\n{0}",
								autoPreview.text,
							),
						),
					}]);
				}
			} catch (err) {
				this._logService.warn('[Continue][Godot] Auto preview failed', err);
			}
		}

		// Self-evolution: distill a reusable skill from complex successful tasks.
		// Fire-and-forget — never blocks the agent turn. Generated SKILL.md files
		// are auto-discovered by the hybrid router on the next session.
		if (exitedOnTaskComplete && isAgentMode && toolStats.writeSuccess > 0 && !token.isCancellationRequested) {
			const record = taskRecorder.finish(true, lastAssistantText || '');
			this._selfEvolving.maybeGenerateFromTask(record, CancellationToken.None)
				.then(generated => {
					if (generated) {
						this._logService.info(
							`[SelfEvolving] ${generated.created ? 'Created' : 'Updated'} skill: ${generated.name}`,
						);
						progress([{
							kind: 'markdownContent',
							content: new MarkdownString(
								localize(
									'continue.selfEvolvedSkill',
									"\n\n🧠 _Self-evolved skill: `{0}` saved to `{1}`. It will auto-load on matching future tasks._",
									generated.name,
									generated.path,
								),
							),
						}]);
					}
				})
				.catch(err => this._logService.warn('[SelfEvolving] Background generation failed', err));
		}

		return {};
		} finally {
			releaseIndexingPause();
			if (isAgentMode) {
				void this._skillEmbeddingIndex.warmup(() => loadSkillWarmSnapshot(
					this._promptsService,
					this._fileService,
					this._configurationService,
					this._logService,
					CancellationToken.None,
				));
			}
		}
	}

	/**
	 * Hybrid skill router: prefer the warm RAM cache; if cold, await the in-flight warmup
	 * (constructor or prior turn) before auto-routing so the user still sees loaded skills.
	 */
	private async _resolveAgentSkillsContext(
		request: IChatAgentRequest,
		progress: (parts: IChatProgress[]) => void,
		token: CancellationToken,
	): Promise<ContinueSkillsContext> {
		const routingQuery = extractSkillRoutingQuery(request);
		const tryFast = (): ContinueSkillsContext | undefined =>
			buildContinueSkillsContextFast(
				routingQuery,
				this._skillEmbeddingIndex,
				this._skillFeedbackStore,
				this._logService,
			);

		let ctx = tryFast();
		if (ctx) {
			return ctx;
		}

		if (!this._skillEmbeddingIndex.hasWarmCache()) {
			this._logService.info('[Continue] Skills cache cold — awaiting warm-cache before auto-route');
			progress([{
				kind: 'markdownContent',
				content: new MarkdownString(
					localize('continue.skillsWarming', "Loading skills catalog…"),
				),
			}]);
		}

		await this._skillEmbeddingIndex.warmup(() => loadSkillWarmSnapshot(
			this._promptsService,
			this._fileService,
			this._configurationService,
			this._logService,
			token,
		));

		if (token.isCancellationRequested) {
			return { systemText: '', attachmentTexts: [], routedSkillNames: [] };
		}

		ctx = tryFast();
		if (ctx) {
			return ctx;
		}

		return buildContinueSkillsContext(
			request,
			this._promptsService,
			this._fileService,
			this._configurationService,
			this._logService,
			token,
			this._skillEmbeddingIndex,
			this._skillFeedbackStore,
		);
	}

	/**
	 * Ensure GitHub Copilot language-model tool *implementations* are registered before
	 * Continue builds its tool list. Package.json only contributes tool *data*; without
	 * this step, invokeTool fails with "does not have an implementation registered".
	 */
	private async _ensureCopilotToolImplementationsMounted(token: CancellationToken): Promise<void> {
		const hasImpl = (id: string): boolean => {
			const svc = this._languageModelToolsService as ILanguageModelToolsService & {
				hasToolImplementation?(toolId: string): boolean;
			};
			return typeof svc.hasToolImplementation === 'function'
				? svc.hasToolImplementation(id)
				: !!this._languageModelToolsService.getTool(id);
		};
		if (hasImpl('copilot_replaceString') && hasImpl('copilot_readFile')) {
			return;
		}
		try {
			await this._extensionService.activateByEvent('onLanguageModelTool:copilot_replaceString');
			await this._extensionService.activateByEvent('onLanguageModelTool:copilot_readFile');
			await this._extensionService.activateByEvent('onLanguageModelTool:copilot_multiReplaceString');
		} catch (err) {
			this._logService.warn('[Continue] Copilot tool activation events failed', err);
		}
		try {
			const mounted = await this._commandService.executeCommand('github.copilot.chat.ensureToolsMounted') as
				| { ok?: boolean; mounted?: number; skipped?: number; failed?: number; error?: string }
				| undefined;
			if (mounted) {
				this._logService.info(
					`[Continue] ensureToolsMounted → ok=${mounted.ok ?? '?'} mounted=${mounted.mounted ?? '?'} skipped=${mounted.skipped ?? '?'} failed=${mounted.failed ?? '?'}`,
				);
			}
		} catch (err) {
			this._logService.warn('[Continue] ensureToolsMounted command failed', err);
		}
		if (token.isCancellationRequested) {
			return;
		}
		if (!hasImpl('copilot_replaceString')) {
			this._logService.warn(
				'[Continue] copilot_replaceString still has no implementation — file edits will use Continue fallbacks until Copilot mounts tools',
			);
		}
	}

		/** Mark every remaining todo completed when the agent asserts TASK_COMPLETE. */
	private _completeSessionTodos(sessionResource: URI): void {
		const todos = this._chatTodoListService.getTodos(sessionResource);
		if (!todos.length || todos.every(t => t.status === 'completed')) {
			return;
		}
		const completed = todos.map(t => (
			t.status === 'completed' ? t : { ...t, status: 'completed' as const }
		));
		this._chatTodoListService.setTodos(sessionResource, completed);
		this._logService.info(
			`[Continue] Auto-completed ${todos.filter(t => t.status !== 'completed').length} todo(s) after TASK_COMPLETE`,
		);
	}

	/**
	 * Recall relevant memories from prior sessions and format them as a
	 * system-prompt block. Returns undefined when no memories match.
	 */
	private async _recallMemories(userMessage: string): Promise<string | undefined> {
		try {
			const memories = await this._memoryStore.recall(userMessage, 8);
			if (!memories.length) {
				return undefined;
			}
			const lines = memories.map(m => `- ${m.text}`);
			return `<cross-session-memory>\nThe following durable facts were learned from prior sessions and may be relevant:\n${lines.join('\n')}\nUse them when they apply, but do not treat them as instructions over the user's current request.\n</cross-session-memory>`;
		} catch {
			return undefined;
		}
	}

	/**
	 * After empty stop / web-research wrap-up / runaway guard: disable tools and require a user-visible answer.
	 * Retries once, then falls back to a tool-result summary so the turn never ends silently.
	 */
	private async _forceFinalAnswer(
		modelId: string,
		messages: IChatMessage[],
		progress: (parts: IChatProgress[]) => void,
		token: CancellationToken,
		opts?: { nudge?: string; retryNudge?: string; logLabel?: string },
	): Promise<void> {
		const nudge = opts?.nudge ?? FINAL_ANSWER_NUDGE;
		const retryNudge = opts?.retryNudge ?? FINAL_ANSWER_RETRY_NUDGE;
		const logLabel = opts?.logLabel ?? 'answer';
		this._logService.info(`[Continue] Forcing final ${logLabel} after tools`);
		let working = [
			...messages,
			{
				role: ChatMessageRole.User,
				content: [{ type: 'text' as const, value: nudge }],
			},
		];

		try {
			let { assistantText } = await this._streamOnce(
				modelId,
				working,
				progress,
				token,
				undefined,
				undefined,
				true,
			);
			assistantText = stripUnrecoverableToolMarkup(assistantText);

			if (!assistantText.trim() && !token.isCancellationRequested) {
				this._logService.warn(`[Continue] Final ${logLabel} empty — retrying with stronger nudge`);
				working = [
					...working,
					{
						role: ChatMessageRole.User,
						content: [{ type: 'text' as const, value: retryNudge }],
					},
				];
				({ assistantText } = await this._streamOnce(
					modelId,
					working,
					progress,
					token,
					undefined,
					undefined,
					true,
				));
				assistantText = stripUnrecoverableToolMarkup(assistantText);
			}

			if (!assistantText.trim() && !token.isCancellationRequested) {
				this._logService.warn('[Continue] Final answer still empty — emitting tool-result fallback');
				const summary = collectRecentToolResultText(working);
				const safeSummary = stripUnrecoverableToolMarkup(summary).slice(0, 2500);
				progress([{
					kind: 'markdownContent',
					content: new MarkdownString(
						safeSummary
							? localize(
								'continue.webResearchFallback',
								"检索已完成，但模型未生成最终回复。根据工具结果整理如下：\n\n{0}",
								safeSummary,
							)
							: localize(
								'continue.webResearchEmpty',
								"检索已完成，但模型未生成最终回复。请重试一次，或缩小问题范围后再问。",
							),
					),
				}]);
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this._logService.warn('[Continue] Forced final answer failed', err);

			// Rate limit on the wrap-up pass: tell the user to wait — do NOT dump raw tool blobs.
			if (isRateLimitError(msg)) {
				progress([{
					kind: 'warning',
					content: new MarkdownString(
						localize(
							'continue.finalAnswerRateLimit',
							"生成最终回复失败：模型 TPM 限流（429）。{0}",
							RATE_LIMIT_USER_MESSAGE,
						),
					),
				}]);
				return;
			}

			const summary = collectRecentToolResultText(messages);
			progress([{
				kind: 'warning',
				content: new MarkdownString(
					localize(
						'continue.finalAnswerFailed',
						"生成最终回复失败：{0}",
						msg,
					),
				),
			}]);
			if (summary) {
				progress([{
					kind: 'markdownContent',
					content: new MarkdownString(
						localize(
							'continue.webResearchFallback',
							"检索已完成，但模型未生成最终回复。根据工具结果整理如下：\n\n{0}",
							summary,
						),
					),
				}]);
			}
		}
	}

	private _trackToolOutcome(
		toolName: string,
		ok: boolean,
		stats: { writeSuccess: number; writeFailed: number; exploreOnly: boolean },
	): void {
		if (WRITE_SUCCESS_TOOLS.has(toolName)) {
			if (ok) {
				stats.writeSuccess++;
			} else {
				stats.writeFailed++;
			}
			return;
		}
		if (
			toolName === 'read_file'
			|| toolName === 'ls'
			|| toolName === 'list_dir'
			|| toolName === 'grep_search'
			|| toolName === 'file_glob_search'
			|| toolName === 'file_search'
			|| toolName === 'codebase'
			|| toolName === 'semantic_search'
		) {
			stats.exploreOnly = true;
		}
	}

	private async _streamOnce(
		modelId: string,
		messages: IChatMessage[],
		progress: (parts: IChatProgress[]) => void,
		token: CancellationToken,
		tools?: readonly ContinueAgentToolSchema[],
		forceToolName?: string,
		disableTools = false,
		forceRequiredTools = false,
	): Promise<{ assistantText: string; toolUses: IChatResponseToolUsePart[]; recoveredTextualTools: boolean; truncatedTextualToolDump: boolean; narratedToolSpam: boolean; thinkingText: string }> {
		const toolUses: IChatResponseToolUsePart[] = [];
		let assistantText = '';
		let thinkingText = '';
		let recoveredTextualTools = false;
		let truncatedTextualToolDump = false;
		let narratedToolSpam = false;
		let streamedUpTo = 0;
		// Always hold tool XML dumps out of the chat UI — even when tools are disabled
		// (final-answer pass). Models still emit <tool_call> / <parameter> markup there.
		const holdTextualDumps = true;

		const requestOptions = disableTools
			? { tool_choice: 'none' as const }
			: tools?.length
				? {
					tools,
					tool_choice: forceToolName
						? { type: 'function' as const, function: { name: forceToolName } }
						: forceRequiredTools
							? 'required' as const
							: 'auto' as const,
				}
				: {};

		const response = await this._languageModelsService.sendChatRequest(
			modelId,
			undefined,
			messages,
			requestOptions,
			token,
		);

		const flushSafeText = (upto: number) => {
			if (upto <= streamedUpTo) {
				return;
			}
			const chunk = assistantText.slice(streamedUpTo, upto);
			streamedUpTo = upto;
			if (chunk) {
				progress([{ kind: 'markdownContent', content: new MarkdownString(chunk) }]);
			}
		};

		for await (const part of response.stream) {
			if (token.isCancellationRequested) {
				break;
			}
			const parts = Array.isArray(part) ? part : [part];
			for (const item of parts) {
				if (item.type === 'text' && item.value) {
					// Belt-and-suspenders: never show raw think tags if a provider leaked them.
					const cleaned = stripThinkTags(item.value);
					if (!cleaned) {
						continue;
					}
					assistantText += cleaned;
					if (holdTextualDumps) {
						if (looksLikeNarratedToolExecution(assistantText)) {
							// Model is spamming "EXECUTING NOW" prose instead of tool_calls — hide from chat.
							streamedUpTo = assistantText.length;
							continue;
						}
						const dumpAt = indexOfTextualToolDumpStart(assistantText);
						if (dumpAt >= 0) {
							// Stream only prose before the dump; keep markup out of the chat UI.
							flushSafeText(dumpAt);
							streamedUpTo = assistantText.length;
							continue;
						}
						// Hold incomplete prefixes (`<tool_ca`) so mid-stream truncation
						// cannot leak partial tool tags into the chat.
						const holdAt = incompleteToolMarkupHoldStart(assistantText);
						if (holdAt >= 0) {
							flushSafeText(holdAt);
							continue;
						}
					}
					flushSafeText(assistantText.length);
				} else if (item.type === 'thinking') {
					const thinkingValue = typeof item.value === 'string' ? item.value : item.value.join('');
					if (thinkingValue) {
						thinkingText += thinkingValue;
						progress([{ kind: 'thinking', value: thinkingValue, id: item.id, metadata: item.metadata }]);
					}
				} else if (item.type === 'tool_use') {
					toolUses.push(item);
				}
			}
		}
		await response.result;

		// Some models default to thinking; if content stayed empty, surface thinking as the answer.
		if (!assistantText.trim() && thinkingText.trim() && toolUses.length === 0) {
			assistantText = thinkingText.trim();
			progress([{ kind: 'markdownContent', content: new MarkdownString(assistantText) }]);
			streamedUpTo = assistantText.length;
		}

		// Drop dangling incomplete tags if the stream ended mid-markup (`...:<tool_ca`).
		const hadIncompleteToolMarkup = incompleteToolMarkupHoldStart(assistantText) >= 0;
		assistantText = stripIncompleteTrailingToolMarkup(assistantText);
		if (hadIncompleteToolMarkup && toolUses.length === 0) {
			truncatedTextualToolDump = true;
		}

		// Local / poorly-aligned models sometimes emit tool calls as XML/text.
		// Recover them into structured tool_use so the agent loop can execute,
		// and never leave the markup as the user-visible answer.
		if (toolUses.length === 0 && looksLikeTextualToolDump(assistantText)) {
			const recovered = recoverTextualToolCalls(assistantText);
			if (recovered.toolUses.length) {
				this._logService.info(
					`[Continue] Recovered ${recovered.toolUses.length} textual tool call(s): ${recovered.toolUses.map(t => t.name).join(', ')}`,
				);
				toolUses.push(...recovered.toolUses);
				assistantText = recovered.cleanedText;
				recoveredTextualTools = true;
				truncatedTextualToolDump = false;
				// Prose before the dump may already be streamed; do not re-stream cleaned text.
				streamedUpTo = assistantText.length;
			} else {
				// Unrecoverable dump — keep prose before markup; hide the dump itself.
				assistantText = stripUnrecoverableToolMarkup(assistantText);
				streamedUpTo = assistantText.length;
				truncatedTextualToolDump = true;
			}
		} else if (looksLikeTextualToolDump(assistantText)) {
			// Native tool_use already present, but text still has leftover XML — strip it.
			assistantText = stripUnrecoverableToolMarkup(recoverTextualToolCalls(assistantText).cleanedText);
			streamedUpTo = Math.min(streamedUpTo, assistantText.length);
		} else if (holdTextualDumps && streamedUpTo < assistantText.length) {
			flushSafeText(assistantText.length);
		} else {
			// Incomplete markup was held back and stripped — do not flush it.
			streamedUpTo = Math.min(streamedUpTo, assistantText.length);
		}

		if (toolUses.length === 0 && looksLikeNarratedToolExecution(assistantText)) {
			this._logService.warn('[Continue] Assistant narrated tool execution in prose without tool_calls — stripping spam');
			narratedToolSpam = true;
			assistantText = '';
			streamedUpTo = 0;
		}

		return { assistantText, toolUses, recoveredTextualTools, truncatedTextualToolDump, narratedToolSpam, thinkingText };
	}

	private async _buildCompileGateNudge(
		editedUris: ReadonlySet<string>,
		token: CancellationToken,
	): Promise<string | undefined> {
		if (token.isCancellationRequested) {
			return undefined;
		}
		await new Promise<void>(resolve => {
			const handle = setTimeout(resolve, MARKER_SETTLE_MS);
			token.onCancellationRequested(() => {
				clearTimeout(handle);
				resolve();
			});
		});
		if (token.isCancellationRequested) {
			return undefined;
		}

		const summary = this._formatErrorMarkers(editedUris);
		if (summary) {
			return buildCompileFixNudge(summary);
		}
		// Marker service already shows 0 Errors on edited files — do not re-nudge get_errors/compile.
		return undefined;
	}

	private _formatErrorMarkers(editedUris: ReadonlySet<string>): string | undefined {
		const resources = [...editedUris].map(u => URI.parse(u));
		const markers = resources.length
			? resources.flatMap(resource => this._markerService.read({
				resource,
				severities: MarkerSeverity.Error,
				take: 50,
			}))
			: this._markerService.read({
				severities: MarkerSeverity.Error,
				take: 40,
			});

		const relevant = markers.filter(m => {
			const fsPath = m.resource.fsPath.replace(/\\/g, '/').toLowerCase();
			return !fsPath.includes('/node_modules/')
				&& !fsPath.includes('/out/')
				&& !fsPath.includes('/dist/')
				&& !fsPath.endsWith('.d.ts');
		});
		if (!relevant.length) {
			return undefined;
		}

		const lines = relevant.slice(0, 20).map(m => {
			const path = toWorkspaceRelativePath(this._workspaceService, m.resource);
			return `- ${path}:${m.startLineNumber}:${m.startColumn} ${m.message} [${m.source ?? 'compiler'}]`;
		});
		if (relevant.length > lines.length) {
			lines.push(`… and ${relevant.length - lines.length} more Error(s)`);
		}
		return `Error markers: ${relevant.length}\n${lines.join('\n')}`;
	}

	private _getAppRoot(): string | undefined {
		const appRoot = (this._environmentService as IWorkbenchEnvironmentService & { appRoot?: string }).appRoot;
		return typeof appRoot === 'string' ? appRoot : undefined;
	}

	private _godotToolHost() {
		return createGodotToolHost(
			this._fileService,
			this._workspaceService,
			this._getAppRoot(),
		);
	}

	private async _executeTool(
		call: IChatResponseToolUsePart,
		cwd: URI | undefined,
		sessionResource: URI,
		chatRequestId: string,
		token: CancellationToken,
		godotAutoPreview?: GodotAutoPreviewState,
	): Promise<{ ok: boolean; text: string; editUri?: URI; editKind?: 'create' | 'edit' }> {
		try {
			const params = (call.parameters ?? {}) as Record<string, unknown>;

			// Map Copilot model names → Continue fallback names when Copilot tool is absent.
			const continueName = remapCopilotNameToContinueFallback(call.name);
			const effectiveName = continueName ?? call.name;
			const effectiveCall = continueName && continueName !== call.name
				? { ...call, name: continueName }
				: call;

			// Prefer local read_file before Copilot. Copilot invokeTool paints its own
			// chat row; when prepare/invoke fails (path resolve, etc.) that row stays
			// red as "Read File failed" even if Continue would have succeeded.
			if (effectiveName === 'read_file' || effectiveName === 'read_file_range') {
				return this._readFileLocal(params, cwd);
			}

			if (isFpgaTool(effectiveName)) {
				return executeFpgaTool(
					createFpgaToolHost(
						this._fileService,
						this._workspaceService,
						this._getAppRoot(),
					),
					this._languageModelToolsService,
					this._logService,
					{ sessionResource, workingDirectory: cwd, chatRequestId },
					effectiveName,
					params,
					token,
				);
			}

			if (isGodotTool(effectiveName)) {
				if (godotAutoPreview) {
					trackGodotToolCall(godotAutoPreview, effectiveName, params);
				}
				return executeGodotTool(
					this._godotToolHost(),
					this._languageModelToolsService,
					this._logService,
					{ sessionResource, workingDirectory: cwd, chatRequestId },
					effectiveName,
					params,
					token,
					godotAutoPreview,
				);
			}

			// Prefer Copilot tools when registered. Soften args to Copilot's
			// expected shape (filePath, …) inside tryInvokeCopilotTool. On failure,
			// Continue fallbacks run below (handled=false).
			const copilot = await tryInvokeCopilotTool(
				this._languageModelToolsService,
				this._logService,
				call.name,
				params,
				{ sessionResource, workingDirectory: cwd, chatRequestId },
				token,
				this._commandService,
			);
			if (copilot.handled) {
				return {
					ok: copilot.ok,
					text: copilot.text,
					editUri: copilot.editUri,
					editKind: copilot.editKind,
				};
			}

			// Continue fallbacks (when Copilot tool missing or Continue-only tool).
			if (effectiveName === 'run_terminal_command' || effectiveName === 'run_in_terminal') {
				const command = coerceTerminalCommandParam(params) ?? '';
				const waitForCompletion = params.waitForCompletion !== false && params.mode !== 'async';
				return executeRunTerminalCommand(
					this._languageModelToolsService,
					this._logService,
					{ sessionResource, workingDirectory: cwd, chatRequestId },
					command,
					waitForCompletion,
					token,
				);
			}

			if (effectiveName === 'get_problems' || effectiveName === 'get_errors') {
				const filepath = typeof params.filepath === 'string' ? params.filepath.trim()
					: typeof params.filePath === 'string' ? params.filePath.trim()
						: '';
				const edited = new Set<string>();
				if (filepath) {
					edited.add(resolveWorkspacePath(cwd, filepath).toString());
				} else if (Array.isArray(params.filePaths)) {
					for (const p of params.filePaths) {
						if (typeof p === 'string' && p.trim()) {
							edited.add(resolveWorkspacePath(cwd, p.trim()).toString());
						}
					}
				}
				await new Promise(resolve => setTimeout(resolve, MARKER_SETTLE_MS));
				const summary = this._formatErrorMarkers(edited);
				return {
					ok: true,
					text: summary ?? 'Error markers: 0\nNo Error-severity problems found in scope.',
				};
			}

			if (effectiveName === 'write_file' || effectiveName === 'create_new_file' || effectiveName === 'create_file') {
				const writeArgs = coerceWriteFileParams(params);
				if (!writeArgs) {
					this._logService.warn('[Continue] write/create missing path/contents', call.name, {
						keys: Object.keys(params),
						hasRaw: typeof params.raw === 'string',
						rawPreview: typeof params.raw === 'string' ? params.raw.slice(0, 200) : undefined,
					});
					return {
						ok: false,
						text: effectiveName === 'write_file'
							? 'write_file requires path (or filePath/filepath) and contents (or content). Example: {"path":"src/app.ts","contents":"..."}'
							: 'create_file requires filePath/filepath/path and content/contents. Example: {"filePath":"src/app.ts","content":"..."}',
					};
				}
				if (effectiveName === 'create_new_file' || effectiveName === 'create_file') {
					const uri = resolveWorkspacePath(cwd, writeArgs.path.trim());
					if (await this._fileService.exists(uri)) {
						// Overwrite via write path — create_file "already exists" was stranding the agent.
						return this._writeFile(writeArgs.path, writeArgs.contents, cwd);
					}
				}
				return this._writeFile(writeArgs.path, writeArgs.contents, cwd);
			}

			// Continue-only patch edit names (fallback when Copilot replace/insert unavailable).
			if (
				effectiveName === 'edit_existing_file'
				|| effectiveName === 'single_find_and_replace'
				|| effectiveName === 'multi_edit'
			) {
				const continueParams = reshapeParamsForContinueEdit(effectiveName, params);
				const mojibakeHit = findMojibakeInEditParams(continueParams);
				if (mojibakeHit) {
					return {
						ok: false,
						text: `Edit blocked: ${mojibakeHit} looks like UTF-8 Chinese mis-decoded as GBK (mojibake). Re-read the file with read_file and copy Chinese exactly — do not write garbled text.`,
					};
				}
				let patchResult = await invokeContinueClientEditTool(
					this._commandService,
					effectiveName,
					continueParams,
					call.toolCallId,
					cwd,
				);

				if (!patchResult.ok && typeof continueParams.fallback_contents === 'string') {
					const pathParam = typeof continueParams.filepath === 'string'
						? continueParams.filepath
						: typeof continueParams.path === 'string'
							? continueParams.path
							: '';
					if (pathParam) {
						patchResult = await this._writeFile(pathParam, continueParams.fallback_contents as string, cwd);
					}
				}

				let editUri: URI | undefined;
				let editKind: 'create' | 'edit' | undefined;
				if (patchResult.fileUri) {
					editUri = toFileUri(patchResult.fileUri);
					editKind = patchResult.fileEditKind ?? 'edit';
				}

				const text = patchResult.ok
					? patchResult.text
					: patchResult.suggestFallback
						? `${patchResult.text}\n\nNext: re-read the file, then use write_file with full contents.`
						: patchResult.text;

				return {
					ok: patchResult.ok,
					text,
					editUri,
					editKind,
				};
			}

			// Remaining Continue core tools (search_web, ls, codebase, …).
			const coreParams = reshapeParamsForContinueCore(effectiveCall.name, params);
			const coreResult = await invokeContinueBuiltInTool(
				this._commandService,
				effectiveCall.name,
				coreParams,
				call.toolCallId,
				cwd,
			);
			let editUri: URI | undefined;
			let editKind: 'create' | 'edit' | undefined;
			if (coreResult.fileUri) {
				editUri = toFileUri(coreResult.fileUri);
				editKind = coreResult.fileEditKind ?? 'edit';
			}
			return {
				ok: coreResult.ok,
				text: coreResult.text,
				editUri,
				editKind,
			};
		} catch (err) {
			this._logService.warn('[Continue] tool failed', call.name, err);
			return { ok: false, text: err instanceof Error ? err.message : String(err) };
		}
	}

	private async _readFileLocal(
		params: Record<string, unknown>,
		cwd: URI | undefined,
	): Promise<{ ok: boolean; text: string }> {
		const pathParam = coerceToolPathParam(params);
		if (!pathParam) {
			return {
				ok: false,
				text: 'read_file requires filepath (or filePath / path). Example: {"filepath":"src/index.html"}',
			};
		}
		const uri = resolveWorkspacePath(cwd, pathParam);
		try {
			if (!(await this._fileService.exists(uri))) {
				return {
					ok: false,
					text: `File "${pathParam}" does not exist at ${uri.fsPath}. List the directory first and use a path that exists.`,
				};
			}
			const content = (await this._fileService.readFile(uri)).value.toString();
			const startLine = typeof params.startLine === 'number' ? params.startLine
				: typeof params.start_line === 'number' ? params.start_line
					: undefined;
			const endLine = typeof params.endLine === 'number' ? params.endLine
				: typeof params.end_line === 'number' ? params.end_line
					: undefined;
			let text = content;
			if (startLine !== undefined || endLine !== undefined) {
				const lines = content.split(/\r?\n/);
				const from = Math.max(1, startLine ?? 1) - 1;
				const to = Math.min(lines.length, endLine ?? lines.length);
				text = lines.slice(from, to).join('\n');
			}
			const capped = text.length > 80_000
				? `${text.slice(0, 80_000)}\n\n… truncated (${text.length} chars total)`
				: text;
			return { ok: true, text: capped };
		} catch (err) {
			this._logService.warn('[Continue] local read_file failed', uri.fsPath, err);
			return {
				ok: false,
				text: err instanceof Error ? err.message : String(err),
			};
		}
	}

	private async _writeFile(
		pathParam: string,
		contents: string,
		cwd: URI | undefined,
	): Promise<{ ok: boolean; text: string; editUri?: URI; editKind?: 'create' | 'edit' }> {
		const rel = pathParam.trim() || '.';
		const uri = resolveWorkspacePath(cwd, rel);
		try {
			if (looksLikeUtf8AsGbkMojibake(contents)) {
				this._logService.warn('[Continue] write_file blocked mojibake payload', uri.fsPath);
				return {
					ok: false,
					text: `write_file blocked: payload looks like UTF-8 Chinese mis-decoded as GBK (mojibake). Re-read the file with read_file and copy Chinese characters exactly — do not write garbled text like 鏉茬藁/锟斤拷.`,
					editUri: undefined,
				};
			}
			const exists = await this._fileService.exists(uri);
			const buffer = VSBuffer.fromString(contents);
						if (exists) {
				// When the file is already open in an editor, IFileService.writeFile writes raw
				// bytes to disk but does NOT update the in-memory text model. The working-copy
				// manager only reloads from onDidFilesChange (OS file watcher), which is unreliable
				// on Windows and is skipped entirely for dirty working copies. This leaves the
				// open tab showing stale (historical) content — exactly the agent-mode bug where
				// clicking the file in the right panel shows old content while a fresh IDE-mode
				// open reads the correct bytes from disk.
				//
				// Fix: route through the text file editor model when one is already loaded —
				// setValue updates the in-memory model immediately, then save() persists it.
				const model = this._textFileService.files.get(uri);
				const textModel = model?.isResolved() ? model.textEditorModel : undefined;
				if (textModel) {
					textModel.setValue(contents);
					await model!.save({ reason: SaveReason.EXPLICIT });
					this._logService.info(`[Continue] write_file edit (text model) ${uri.fsPath}`);
					return { ok: true, text: `Updated ${rel} (${contents.length} chars)`, editUri: uri, editKind: 'edit' };
				}
				// No open text model — write raw bytes to disk as before.
				await this._fileService.writeFile(uri, buffer);
				this._logService.info(`[Continue] write_file edit ${uri.fsPath}`);
				return { ok: true, text: `Updated ${rel} (${contents.length} chars)`, editUri: uri, editKind: 'edit' };
			}
			// Ensure parent directory exists (common when agent mkdir'd a folder then creates a file).
			const parent = URI.joinPath(uri, '..');
			if (!(await this._fileService.exists(parent))) {
				await this._fileService.createFolder(parent);
			}
			await this._fileService.createFile(uri, buffer, { overwrite: true });
			this._logService.info(`[Continue] write_file create ${uri.fsPath}`);
			return { ok: true, text: `Created ${rel} (${contents.length} chars)`, editUri: uri, editKind: 'create' };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this._logService.warn('[Continue] write_file failed', uri.fsPath, message);
			return {
				ok: false,
				text: `write_file failed for ${rel}: ${message}`,
				editUri: undefined,
			};
		}
	}

	private _resolveModelId(requestedModelId: string | undefined): string | undefined {
		if (requestedModelId) {
			if (this._languageModelsService.lookupLanguageModel(requestedModelId)) {
				return requestedModelId;
			}
			// Picker / storage may store bare names without the continue: vendor prefix.
			if (!requestedModelId.includes(':')) {
				const prefixed = `${CONTINUE_LM_VENDOR}:${requestedModelId}`;
				if (this._languageModelsService.lookupLanguageModel(prefixed)) {
					return prefixed;
				}
			}
			this._logService.warn(
				`[Continue] Requested model '${requestedModelId}' is not registered — falling back`,
			);
		}
		const continueIds = this._languageModelsService.getLanguageModelIds()
			.filter(id => id.startsWith(`${CONTINUE_LM_VENDOR}:`));
		return continueIds[0];
	}
}

function remapCopilotNameToContinueFallback(name: string): string | undefined {
	switch (name) {
		case 'create_file':
			return 'create_new_file';
		case 'list_dir':
			return 'ls';
		case 'semantic_search':
			return 'codebase';
		case 'file_search':
			return 'file_glob_search';
		case 'replace_string_in_file':
			return 'single_find_and_replace';
		case 'multi_replace_string_in_file':
			return 'multi_edit';
		case 'insert_edit_into_file':
			return 'edit_existing_file';
		case 'fetch_webpage':
			return 'fetch_url_content';
		case 'get_errors':
			return 'get_problems';
		case 'run_in_terminal':
			return 'run_terminal_command';
		case 'read_file':
			return 'read_file';
		case 'grep_search':
			return 'grep_search';
		default:
			return undefined;
	}
}

function reshapeParamsForContinueEdit(
	continueName: string,
	params: Record<string, unknown>,
): Record<string, unknown> {
	const filepath = params.filepath ?? params.filePath ?? params.path;
	if (continueName === 'single_find_and_replace') {
		return {
			filepath,
			old_string: params.old_string ?? params.oldString,
			new_string: params.new_string ?? params.newString,
			replace_all: params.replace_all ?? params.replaceAll,
			fallback_contents: params.fallback_contents,
		};
	}
	if (continueName === 'multi_edit') {
		const replacements = Array.isArray(params.replacements) ? params.replacements as Record<string, unknown>[] : [];
		let edits: unknown = Array.isArray(params.edits) ? params.edits : undefined;
		if (!Array.isArray(edits) || edits.length === 0) {
			if (replacements.length > 0) {
				edits = replacements.map(e => ({
					old_string: e.old_string ?? e.oldString ?? e.old_str ?? e.find,
					new_string: e.new_string ?? e.newString ?? e.new_str ?? e.replace,
					replace_all: e.replace_all ?? e.replaceAll,
				}));
			} else if (params.old_string !== undefined || params.oldString !== undefined) {
				// Model called multi_replace with a single replace-shaped payload.
				edits = [{
					old_string: params.old_string ?? params.oldString,
					new_string: params.new_string ?? params.newString ?? '',
					replace_all: params.replace_all ?? params.replaceAll,
				}];
			} else {
				edits = [];
			}
		} else {
			// Normalize camelCase keys from Copilot-style edit rows.
			edits = (edits as Record<string, unknown>[]).map(e => ({
				old_string: e.old_string ?? e.oldString ?? e.old_str ?? e.find,
				new_string: e.new_string ?? e.newString ?? e.new_str ?? e.replace,
				replace_all: e.replace_all ?? e.replaceAll,
			}));
		}
		const filepath = params.filepath ?? params.filePath ?? params.path
			?? replacements.map(e => e.filepath ?? e.filePath ?? e.path ?? e.file_path).find(v => typeof v === 'string' && String(v).trim());
		return {
			filepath,
			edits,
			fallback_contents: params.fallback_contents,
		};
	}
	if (continueName === 'edit_existing_file') {
		return {
			filepath,
			changes: params.changes ?? params.code,
			fallback_contents: params.fallback_contents,
		};
	}
	return params;
}

function reshapeParamsForContinueCore(
	continueName: string,
	params: Record<string, unknown>,
): Record<string, unknown> {
	if (continueName === 'fetch_url_content') {
		const url = typeof params.url === 'string' ? params.url
			: Array.isArray(params.urls) && typeof params.urls[0] === 'string' ? params.urls[0]
				: undefined;
		return url ? { ...params, url } : params;
	}
	if (continueName === 'ls') {
		const path = params.path ?? params.dirPath ?? params.directory;
		return path !== undefined ? { ...params, path } : params;
	}
	if (continueName === 'file_glob_search') {
		return {
			...params,
			pattern: params.pattern ?? params.query ?? params.glob,
		};
	}
	if (continueName === 'create_new_file') {
		return {
			filepath: params.filepath ?? params.filePath ?? params.path,
			contents: params.contents ?? params.content,
		};
	}
	if (continueName === 'read_file' || continueName === 'read_file_range') {
		const filepath = coerceToolPathParam(params);
		const startLine = typeof params.startLine === 'number' ? params.startLine
			: typeof params.start_line === 'number' ? params.start_line
				: undefined;
		const endLine = typeof params.endLine === 'number' ? params.endLine
			: typeof params.end_line === 'number' ? params.end_line
				: undefined;
		return {
			...params,
			filepath,
			...(startLine !== undefined ? { startLine } : {}),
			...(endLine !== undefined ? { endLine } : {}),
		};
	}
	if (continueName === 'grep_search') {
		return {
			...params,
			query: params.query ?? params.pattern,
		};
	}
	if (continueName === 'run_terminal_command' || continueName === 'run_in_terminal') {
		const command = coerceTerminalCommandParam(params);
		return command ? { ...params, command } : params;
	}
	return params;
}

/** Some models put paths in `command` / `query` instead of filePath. */
function coerceToolPathParam(params: Record<string, unknown>): string | undefined {
	const direct = [params.filepath, params.filePath, params.path]
		.find((v): v is string => typeof v === 'string' && v.trim().length > 0);
	if (direct) {
		return direct.trim();
	}
	for (const key of ['command', 'query', 'input', 'raw'] as const) {
		const raw = params[key];
		if (typeof raw !== 'string' || !raw.trim()) {
			continue;
		}
		const extracted = extractPathFromToolishText(raw);
		if (extracted) {
			return extracted;
		}
	}
	return undefined;
}

function coerceTerminalCommandParam(params: Record<string, unknown>): string | undefined {
	if (typeof params.command === 'string' && params.command.trim()) {
		const trimmed = params.command.trim();
		// Model sometimes wraps shell as: run_in_terminal command="ls"
		const nested = /(?:^|\b)(?:command|cmd)\s*=\s*["']([^"']+)["']/i.exec(trimmed);
		if (nested?.[1]?.trim() && /^(?:run_in_terminal|run_terminal_command)\b/i.test(trimmed)) {
			return nested[1].trim();
		}
		if (!/^(?:run_in_terminal|run_terminal_command|read_file)\b/i.test(trimmed)) {
			return trimmed;
		}
		if (nested?.[1]?.trim()) {
			return nested[1].trim();
		}
	}
	for (const key of ['query', 'input', 'raw', 'code'] as const) {
		const raw = params[key];
		if (typeof raw === 'string' && raw.trim()) {
			const nested = /(?:^|\b)(?:command|cmd)\s*=\s*["']([^"']+)["']/i.exec(raw)
				?? /(?:^|\b)(?:run_in_terminal|run_terminal_command)\b[\s\S]*?\bcommand\s*=\s*["']([^"']+)["']/i.exec(raw);
			if (nested?.[1]?.trim()) {
				return nested[1].trim();
			}
			if (!/^(?:run_in_terminal|run_terminal_command|read_file)\b/i.test(raw.trim())) {
				return raw.trim();
			}
		}
	}
	return undefined;
}

function extractPathFromToolishText(raw: string): string | undefined {
	const quoted = /(?:filepath|filePath|path)\s*=\s*["']([^"']+)["']/i.exec(raw)
		?? /(?:read_file|read_file_range)\b[^"'\n]*["']([^"']+)["']/i.exec(raw);
	if (quoted?.[1]?.trim()) {
		return quoted[1].trim();
	}
	const bare = /(?:filepath|filePath|path)\s*=\s*(\S+)/i.exec(raw);
	if (bare?.[1]?.trim()) {
		return bare[1].trim().replace(/[,\s]+$/, '');
	}
	// Plain relative path token (e.g. src/index.html)
	const pathToken = /(?:^|\s)((?:[A-Za-z]:[\\/]|\/|\.\/)?[\w./\\-]+\.[\w]+)\s*$/.exec(raw.trim());
	return pathToken?.[1]?.trim();
}

function toWorkspaceRelativePath(workspaceService: IWorkspaceContextService, resource: URI): string {
	const folders = workspaceService.getWorkspace().folders;
	for (const folder of folders) {
		const relative = resource.path.startsWith(folder.uri.path.endsWith('/')
			? folder.uri.path
			: `${folder.uri.path}/`)
			? resource.path.slice(folder.uri.path.length).replace(/^\//, '')
			: undefined;
		if (relative !== undefined) {
			return relative || resource.fsPath;
		}
	}
	return resource.fsPath;
}

/**
 * Detect classic UTF-8 Chinese mis-decoded as GBK/GB2312 (then re-saved as Unicode).
 * Example: 曲线 → 鏉茬藁, 杂散光 → 鏉鍐瑛…, plus the infamous 锟斤拷 replacement.
 */
function looksLikeUtf8AsGbkMojibake(text: string): boolean {
	if (!text) {
		return false;
	}
	if (text.includes('锟斤拷')) {
		return true;
	}
	// High-confidence fragments produced when common UTF-8 CJK bytes are read as GBK.
	if (/鏉茬藁|閿俐鍑|绮剧確|鍙鉑|鏉鍐瑛|父塔鐚/.test(text)) {
		return true;
	}
	// Dense runs of rare CJK that commonly appear only as UTF-8→GBK mojibake.
	const rareRuns = text.match(/[\u9200-\u95FF]{3,}/g);
	if (rareRuns && rareRuns.join('').length >= 6 && /[鏉閿鑸绮鍙鍔鿿]/.test(text)) {
		return true;
	}
	return false;
}

function findMojibakeInEditParams(params: Record<string, unknown>): string | undefined {
	const candidates: string[] = [];
	for (const key of ['new_string', 'newString', 'fallback_contents', 'contents', 'content'] as const) {
		const v = params[key];
		if (typeof v === 'string' && v) {
			candidates.push(v);
		}
	}
	const edits = params.edits;
	if (Array.isArray(edits)) {
		for (const e of edits) {
			if (!e || typeof e !== 'object') {
				continue;
			}
			const row = e as Record<string, unknown>;
			for (const key of ['new_string', 'newString'] as const) {
				const v = row[key];
				if (typeof v === 'string' && v) {
					candidates.push(v);
				}
			}
		}
	}
	for (const c of candidates) {
		if (looksLikeUtf8AsGbkMojibake(c)) {
			return c.slice(0, 48);
		}
	}
	return undefined;
}

function resolveWorkspacePath(cwd: URI | undefined, relPath: string): URI {
	if (/^[a-zA-Z]:[\\/]/.test(relPath) || relPath.startsWith('/') || relPath.startsWith('\\')) {
		return URI.file(relPath);
	}
	if (!cwd) {
		return URI.file(relPath);
	}
	const cleaned = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
	return URI.joinPath(cwd, cleaned);
}

/**
 * Normalize write_file / create_file args across model dialects and broken JSON.
 * Models often send filePath/content (Copilot), path/contents (Continue), or leave a
 * `raw` string when tool-call JSON failed to parse (unescaped newlines in contents).
 */
function coerceWriteFileParams(params: unknown): { path: string; contents: string } | undefined {
	const obj = unwrapToolParamsObject(params);
	if (!obj) {
		return undefined;
	}

	const pathCandidate = pickStringField(obj, ['path', 'filepath', 'filePath', 'file_path', 'target', 'filename', 'file'])
		?? (typeof obj.raw === 'string' ? extractPathFromRawToolArgs(obj.raw) : undefined);
	const contentsCandidate = pickContentsField(obj)
		?? (typeof obj.raw === 'string' ? extractContentsFromRawToolArgs(obj.raw) : undefined);

	if (!pathCandidate || contentsCandidate === undefined) {
		return undefined;
	}
	return { path: pathCandidate.trim(), contents: contentsCandidate };
}

function unwrapToolParamsObject(params: unknown): Record<string, unknown> | undefined {
	if (params === null || params === undefined) {
		return undefined;
	}
	if (typeof params === 'string') {
		const parsed = parseToolArgumentsLoose(params);
		return parsed ?? (params.trim() ? { raw: params } : undefined);
	}
	if (typeof params !== 'object' || Array.isArray(params)) {
		return undefined;
	}
	let obj = params as Record<string, unknown>;

	// Double-encoded / nested envelopes from some providers.
	for (const nestKey of ['arguments', 'input', 'parameters', 'args', 'data']) {
		const nested = obj[nestKey];
		if (typeof nested === 'string' && nested.trim()) {
			const parsed = parseToolArgumentsLoose(nested);
			if (parsed) {
				obj = { ...obj, ...parsed };
			} else if (!obj.raw) {
				obj = { ...obj, raw: nested };
			}
		} else if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
			obj = { ...obj, ...(nested as Record<string, unknown>) };
		}
	}

	if (typeof obj.raw === 'string' && obj.raw.trim()) {
		const parsed = parseToolArgumentsLoose(obj.raw);
		if (parsed) {
			obj = { ...parsed, ...obj, raw: obj.raw };
		}
	}

	return obj;
}

function pickStringField(obj: Record<string, unknown>, keys: string[]): string | undefined {
	for (const key of keys) {
		const value = obj[key];
		if (typeof value === 'string' && value.trim()) {
			return value;
		}
	}
	return undefined;
}

function pickContentsField(obj: Record<string, unknown>): string | undefined {
	for (const key of ['contents', 'content', 'body', 'text', 'code', 'source', 'data']) {
		const value = obj[key];
		if (typeof value === 'string') {
			return value;
		}
		if (Array.isArray(value)) {
			return value.map(v => typeof v === 'string' ? v : String(v)).join('\n');
		}
		if (typeof value === 'number' || typeof value === 'boolean') {
			return String(value);
		}
	}
	return undefined;
}

/** Best-effort JSON.parse for tool-call argument blobs (multiline / trailing commas). */
function parseToolArgumentsLoose(raw: string): Record<string, unknown> | undefined {
	const trimmed = raw.trim();
	if (!trimmed) {
		return undefined;
	}
	try {
		const parsed = JSON.parse(trimmed);
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
		if (typeof parsed === 'string') {
			return parseToolArgumentsLoose(parsed);
		}
	} catch {
		// continue
	}

	// Strip trailing commas before } or ]
	try {
		const repaired = trimmed.replace(/,\s*([}\]])/g, '$1');
		const parsed = JSON.parse(repaired);
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
	} catch {
		// continue
	}

	// Unescaped newlines inside the contents string — very common with local/cloud models.
	const path = extractPathFromRawToolArgs(trimmed);
	const contents = extractContentsFromRawToolArgs(trimmed);
	if (path !== undefined && contents !== undefined) {
		return { path, filepath: path, filePath: path, contents, content: contents };
	}
	return undefined;
}

function extractPathFromRawToolArgs(raw: string): string | undefined {
	const patterns = [
		/"(?:path|filepath|filePath|file_path|filename|file)"\s*:\s*"((?:\\.|[^"\\])*)"/i,
		/'(?:path|filepath|filePath|file_path|filename|file)'\s*:\s*'((?:\\.|[^'\\])*)'/i,
		/"(?:path|filepath|filePath|file_path)"\s*:\s*'([^']*)'/i,
		/(?:path|filepath|filePath|file_path)\s*=\s*["']([^"']+)["']/i,
	];
	for (const re of patterns) {
		const m = re.exec(raw);
		if (m?.[1]) {
			return m[1]
				.replace(/\\n/g, '\n')
				.replace(/\\r/g, '\r')
				.replace(/\\t/g, '\t')
				.replace(/\\"/g, '"')
				.replace(/\\\\/g, '\\');
		}
	}
	return extractPathFromToolishText(raw);
}

function extractContentsFromRawToolArgs(raw: string): string | undefined {
	const key = /"(?:contents|content|body|text|code)"\s*:\s*/i.exec(raw);
	if (!key) {
		const eq = /(?:contents|content)\s*=\s*/i.exec(raw);
		if (!eq) {
			return undefined;
		}
		const afterEq = raw.slice(eq.index + eq[0].length).trim();
		if ((afterEq.startsWith('"') || afterEq.startsWith("'") || afterEq.startsWith('`'))) {
			const quote = afterEq[0];
			const end = afterEq.lastIndexOf(quote);
			if (end > 0) {
				return afterEq.slice(1, end);
			}
		}
		return afterEq || undefined;
	}

	const afterKey = raw.slice(key.index + key[0].length);
	const trimmed = afterKey.trimStart();
	if (trimmed.startsWith('"')) {
		// Scan a JSON string, allowing raw newlines (invalid JSON but common).
		let out = '';
		let i = 1;
		while (i < trimmed.length) {
			const ch = trimmed[i];
			if (ch === '\\' && i + 1 < trimmed.length) {
				const next = trimmed[i + 1];
				if (next === 'n') { out += '\n'; i += 2; continue; }
				if (next === 'r') { out += '\r'; i += 2; continue; }
				if (next === 't') { out += '\t'; i += 2; continue; }
				if (next === '"' || next === '\\' || next === '/') { out += next; i += 2; continue; }
				out += next;
				i += 2;
				continue;
			}
			if (ch === '"') {
				// End if followed by optional whitespace and , or }
				const rest = trimmed.slice(i + 1).trimStart();
				if (!rest || rest.startsWith(',') || rest.startsWith('}')) {
					return out;
				}
				// Embedded quote inside broken JSON — keep going unless near the end.
				if (i > trimmed.length - 8) {
					return out;
				}
			}
			out += ch;
			i++;
		}
		return out;
	}
	if (trimmed.startsWith("'") || trimmed.startsWith('`')) {
		const quote = trimmed[0];
		const end = trimmed.lastIndexOf(quote);
		if (end > 0) {
			return trimmed.slice(1, end);
		}
	}
	return undefined;
}

/** Tell the model which folder this session is bound to (may differ from the open window). */
function appendWorkingDirectoryHint(system: string, cwd: URI | undefined): string {
	if (!cwd) {
		return system;
	}
	const pathLabel = cwd.scheme === 'file' ? cwd.fsPath : cwd.toString();
	return `${system}

SESSION WORKING DIRECTORY: ${pathLabel}
All relative paths and workspace tools (list_dir, read_file, grep_search, semantic_search, create_file, edits) are scoped to this directory. Do not assume another open IDE folder is the project root.`;
}

/** Continue tools often return file:// URIs; URI.file() would mangle those. */
function toFileUri(pathOrUri: string): URI {
	if (pathOrUri.startsWith('file:')) {
		return URI.parse(pathOrUri);
	}
	return URI.file(pathOrUri);
}

/** Pull recent tool_result text for fallback when the model emits no final answer. */
function collectRecentToolResultText(messages: readonly IChatMessage[], maxChars = 6000): string {
	const chunks: string[] = [];
	let total = 0;
	for (let i = messages.length - 1; i >= 0 && total < maxChars; i--) {
		for (const part of messages[i].content) {
			if (part.type !== 'tool_result') {
				continue;
			}
			const text = part.value
				.filter((v): v is { type: 'text'; value: string } => v.type === 'text')
				.map(v => v.value)
				.join('\n')
				.trim();
			if (!text) {
				continue;
			}
			const slice = text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
			chunks.unshift(slice);
			total += slice.length;
			if (total >= maxChars) {
				break;
			}
		}
	}
	const joined = chunks.join('\n\n---\n\n');
	return joined.length > maxChars ? `${joined.slice(0, maxChars)}…` : joined;
}

function asksToContinueNextTurn(text: string): boolean {
	if (!text.trim()) {
		return false;
	}
	return /工具调用已用完|未能执行实际修改|请回复任意消息|回复任意消息|请回复[「"“]?继续修改|请回复.{0,12}继续|我将立即(对以上|执行)|回复["“]?继续修改|由于本轮|请在下一[轮回]|下一[轮回]中回复/
		.test(text)
		|| /\b(tool (calls?|budget|turns?) (exhausted|used up|limit)|reply (any|with any) message|send another message|reply\s*["']?continue)\b/i
			.test(text);
}

/** Model asserts the user task is fully finished. */
function assertsTaskComplete(text: string): boolean {
	if (!text.trim()) {
		return false;
	}
	// Accept TASK_COMPLETE on its own line, or glued to following prose (TASK_COMPLETEThe…).
	return /(?:^|\n)\s*TASK_COMPLETE\b/i.test(text)
		|| /任务已(全部)?完成|全部(修改|更改|文件)?已完成|所有(修改|更改|文件)?已完成|修改已全部完成|已全部完成修改/
			.test(text)
		|| /\b(all (requested )?changes (are |have been )?done|task (is )?(already )?(fully )?complete|fully (verified )?complete|genuinely complete)\b/i
			.test(text);
}

/** Assistant text indicates work still remains (even without asking the user to ping). */
function looksLikeRemainingWork(text: string): boolean {
	if (!text.trim()) {
		return false;
	}
	// Negations like "no remaining work" / "没有剩余" must not count as unfinished.
	const negated =
		/没有?剩余|无剩余|已无剩余|不(再)?有剩余|无需再|没有未完成|已全部完成/
			.test(text)
		|| /\b(no|without|nothing|not any)\s+(remaining|outstanding|left)\b/i.test(text)
		|| /\bnothing remains\b/i.test(text)
		|| /\bno (further|more)\s+(work|edits?|changes?|files?|tool calls?)\b/i.test(text);
	if (negated) {
		return false;
	}
	return /还(需|要|有).{0,16}(修改|改|文件)|剩余|未完成|待修改|其余.{0,12}文件|接下来我?(还要|会|要|继续)|我将(继续|检查|查看|跟踪|修改)|尚未(完成|修改)/
		.test(text)
		|| /\b(still need|remaining|not yet (done|finished)|files? left|more files? to|todo:)\b/i
			.test(text);
}

/** Mid-investigation narration without finishing ("接下来我会查…") — must keep tools going. */
function looksLikeIncompleteInvestigation(text: string): boolean {
	if (!text.trim()) {
		return false;
	}
	if (assertsTaskComplete(text)) {
		return false;
	}
	return /接下来我?(会|要|继续)|我将(先)?(检查|查看|跟踪|确认|对比|定位|读取)|先(看|查|读|确认)|然后再|继续(查|看|跟|分析)|需要(再|继续)(查|看|确认)/
		.test(text)
		|| /\b(next I('ll| will)|I('ll| will) (now )?(check|inspect|trace|compare|look|verify)|let me (check|look|inspect|trace|verify)|going to (check|inspect|trace))\b/i
			.test(text);
}

/** Partial progress report that asks the user to ping back for remaining files. */
function looksLikeIncompleteHandoff(text: string): boolean {
	if (!text.trim()) {
		return false;
	}
	const hasProgressInventory =
		/已完成修改|不需要修改|其余|剩余|以上\s*\d+\s*个文件|还(需|要)修改|待修改/.test(text)
		|| /\b(remaining files?|still need to (edit|update|change)|files? left)\b/i.test(text);
	const asksUserToContinue =
		/请回复|继续修改|我将立即|下一[轮回]|再发|ping me|reply (again|to continue)/i.test(text);
	return hasProgressInventory && asksUserToContinue;
}

/**
 * Model narrates an imminent edit ("Let me update both files") but emits no tool_calls.
 * Without this, the loop accepts a text-only stop and looks like the agent "breaks at updates".
 */
function looksLikePromisedEditsWithoutTools(text: string): boolean {
	if (!text.trim()) {
		return false;
	}
	if (assertsTaskComplete(text)) {
		return false;
	}
	return /还没(有)?(完成|改完|写完)|尚未(完成|修改|应用)|I haven'?t finished|haven'?t (finished|applied|made) (the )?(edits?|changes?)/i
		.test(text)
		|| /让我(现在)?(更新|修改|应用|写入)|我来(更新|修改|应用)|开始(更新|修改)|现在(更新|修改|应用)/
			.test(text)
		|| /\b(let me (now )?(update|edit|apply|write|fix|change)|I('ll| will) (now )?(update|edit|apply|write|fix)|applying (the )?(edits?|changes?) now|update both files)\b/i
			.test(text);
}

function asksForUserConfirmation(text: string): boolean {
	if (!text.trim()) {
		return false;
	}
	return /请确认|是否按以上|是否一并|要我(继续|修改|执行|应用)?吗|可以执行吗|是否(需要)?(我)?(直接)?修改/
		.test(text)
		|| /\b(please\s+confirm|should\s+i\s+(proceed|apply|make|update|edit|go)|may\s+i\s+(proceed|edit|apply)|confirm\s+(before|whether)|ready\s+to\s+(apply|proceed)|shall\s+i\s+(proceed|apply))\b/i
			.test(text);
}

/** User is explicitly telling the agent to stop asking and act. */
function isExecuteNowMessage(message: string): boolean {
	return /立即执行|直接(修改|改|执行|做)|继续修改|不用问|无需确认|不要问|go\s+ahead|just\s+do\s+it|do\s+it\s+now|apply\s+(it|them|now)|execute\s+now|continue\s+(editing|modifying)/i
		.test(message);
}

/** Clear imperative edit request (not a pure question). */
function hasCodeChangeIntent(message: string): boolean {
	const trimmed = message.trim();
	const wantsAction = /(检查|排查|修复|修改|定位|查看|确认下|改一下|fix|debug|investigate|check why|look into|改为|改成|实现|添加|更新)/i.test(trimmed);
	// Pure trivia questions only — do not bail when the user also asks to check/fix.
	if (!wantsAction && /^(what|why|how|which|where|谁|什么是|为什么|怎么理解|如何理解)\b/i.test(trimmed)) {
		return false;
	}
	return /(改为|改成|修改|替换|更新|直接改|实现|修复|添加|增加|新增|继续|refactor|implement|update|change|replace|edit|fix|rename|add|create|continue)\b/i
		.test(message)
		|| /(把|将).{0,40}(改|换|替换)/.test(message)
		|| /\bok[,\s]+so\s+fix\b/i.test(message);
}

/** Debug / root-cause requests that must keep tool looping until a conclusion. */
function hasInvestigateIntent(message: string): boolean {
	const trimmed = message.trim();
	// Short pure questions — answer in one pass; do not enter long investigate loops.
	if (trimmed.length <= 80 && /^(what|why|how|where|which|谁|什么是|为什么|怎么|如何)\b/i.test(trimmed)
		&& !/(修复|fix|改|update|implement)/i.test(trimmed)) {
		return false;
	}
	return /(检查|排查|定位|查看|为何|为什么|怎么回事|不生效|没更新|没生效|又恢复|回滚|还原|对不上|不一致|debug|investigate|look into|root cause|check why|not updat|reverted|still shows?)/i
		.test(message);
}

/**
 * README / markdown-only updates — skip investigate loops, todos, and compile gate.
 */
function isDocumentationEditTask(message: string): boolean {
	const trimmed = message.trim();
	if (!trimmed) {
		return false;
	}
	if (!/(readme|\.md\b|markdown|文档|changelog|说明|doc\/|docs\/)/i.test(trimmed)) {
		return false;
	}
	if (/(fix|修复|bug|编译|compile|typescript|javascript|\.ts\b|\.tsx\b|\.py\b|单元测试|unit test|npm run)/i.test(trimmed)) {
		return false;
	}
	return /(修改|更新|改|替换|同步|update|edit|revise|rewrite|embed|embedding|ollama|说明|描述|文档|不再|去掉|remove)/i.test(trimmed);
}

function editedUrisAreDocumentationOnly(editedUris: ReadonlySet<string>): boolean {
	if (!editedUris.size) {
		return false;
	}
	for (const uri of editedUris) {
		const path = URI.parse(uri).fsPath.replace(/\\/g, '/').toLowerCase();
		const base = path.split('/').pop() ?? path;
		if (/\.(md|markdown|txt|rst|adoc)$/.test(base) || /^readme(\.|$)/i.test(base)) {
			continue;
		}
		return false;
	}
	return true;
}

/**
 * Small scoped requests (one-liner fix / short debug) — skip todo + memory churn and use tighter nudge caps.
 */
function isLightweightAgentTask(
	message: string,
	opts: { codeChangeIntent: boolean; investigateIntent: boolean; isGameMode: boolean; isChipMode: boolean },
): boolean {
	if (opts.isGameMode || opts.isChipMode) {
		return false;
	}
	const trimmed = message.trim();
	if (isDocumentationEditTask(trimmed) && trimmed.length <= 500) {
		return true;
	}
	if (!trimmed || trimmed.length > 200) {
		return false;
	}
	if (hasTodoPlanningShape(message)) {
		return false;
	}
	if (/(refactor|全部文件|所有文件|整个项目|multi[- ]file|across the repo|step[- ]by[- ]step plan)/i.test(trimmed)) {
		return false;
	}
	if (opts.codeChangeIntent && trimmed.length <= 180) {
		return true;
	}
	if (opts.investigateIntent && trimmed.length <= 120) {
		return true;
	}
	return false;
}

function hasTodoPlanningShape(message: string): boolean {
	return /方案|步骤|验收|规划|撰写|探索|定位|排查|实现|计划|plan|roadmap|step[- ]by[- ]step|investigate|explore|then|接着|然后|依次|todo/i.test(message)
		|| /\b\d+[.)）、]\s*\S/.test(message)
		|| /(?:^|\n)\s*[-*]\s+\S/m.test(message);
}

function shouldUseTodoList(
	message: string,
	opts: { codeChangeIntent: boolean; investigateIntent: boolean; isGameMode: boolean; isChipMode: boolean; webSearchIntent: boolean },
): boolean {
	const trimmed = message.trim();
	if (!trimmed || /^(hi|hello|thanks|thank you|你好|谢谢)\b/i.test(trimmed)) {
		return false;
	}
	if (opts.webSearchIntent && !opts.codeChangeIntent && !opts.investigateIntent && !opts.isGameMode && !opts.isChipMode) {
		return false;
	}
	if (opts.codeChangeIntent || opts.investigateIntent || opts.isGameMode || opts.isChipMode) {
		return true;
	}
	if (hasTodoPlanningShape(message)) {
		return true;
	}
	return trimmed.length >= 20;
}

function isManageTodoListTool(toolName: string): boolean {
	const normalized = remapCopilotNameToContinueFallback(toolName) ?? toolName;
	return normalized === 'manage_todo_list' || normalized === 'todo' || normalized === 'todos';
}

/** Assistant dumped tool calls as XML/prose instead of native function calling. */
/** Remove model think-tag wrappers that must never appear in the chat transcript. */
function stripThinkTags(text: string): string {
	if (!text) {
		return text;
	}
	const open = '<' + 'think' + '>';
	const close = '<' + '/' + 'think' + '>';
	return text.split(open).join('').split(close).join('');
}

function looksLikeTextualToolDump(text: string): boolean {
	return indexOfTextualToolDumpStart(text) >= 0;
}

/**
 * Model narrates imminent tool execution in chat prose (often ALL-CAPS staccato) but emits no tool_calls.
 * This is a generation / tool-calling alignment issue — not embeddings.
 */
function looksLikeNarratedToolExecution(text: string): boolean {
	if (!text || text.trim().length < 60) {
		return false;
	}
	const t = text.trim();
	if (looksLikeTextualToolDump(t)) {
		return false;
	}
	const narratedToolName =
		/\b(run_in_terminal|run_terminal_command|grep_search|read_file|replace_string_in_file|write_file|taskkill|manage_todo_list)\b/i.test(t)
		|| /\b(RUN_IN_TERMINAL|RUN_TERMINAL|TASKKILL|TOOL CALL|TOOL_CALL)\b/.test(t);
	const narratedAction =
		/\b(executing|calling the tool|invoke the tool|here is the tool call|just the tool call|no more words|this is the moment|right now|call it now|let me call)\b/i.test(t)
		|| /\b(EXECUTING|CALLING THE TOOL|JUST THE TOOL|NO MORE WORDS|THIS IS THE MOMENT)\b/.test(t);
	if (narratedToolName && narratedAction) {
		return true;
	}
	// Staccato ALL-CAPS spam: "GO. NOW. THE. TOOL. IS. CALLED."
	const staccatoCaps = t.match(/\b[A-Z]{2,}\./g);
	if (staccatoCaps && staccatoCaps.length >= 10 && t.length > 300) {
		return true;
	}
	if (t.length > 500 && /(?:GO\. NOW\.|EXECUTING\.|THE TOOL\.|CALL IT NOW\.|NO MORE WORDS\.)/i.test(t)) {
		const hits = t.match(/(?:GO\. NOW\.|EXECUTING\.|THE TOOL\.|CALL IT NOW\.|NO MORE WORDS\.)/gi);
		if (hits && hits.length >= 3) {
			return true;
		}
	}
	return false;
}

/**
 * Tag names (without surrounding `</?>`) that textual tool dumps may start with.
 * Used to hold back incomplete streaming prefixes like `<tool_ca`.
 */
const TEXTUAL_TOOL_TAG_PREFIXES = [
	'tool_call',
	'function_call',
	'function_calls',
	'invoke',
	'parameter',
	'arg_key',
	'arg_value',
	'multi_replace_string_in_file',
	'replace_string_in_file',
	'run_in_terminal',
	'run_terminal_command',
	'insert_edit_into_file',
	'apply_patch',
	'write_file',
	'create_file',
	'create_new_file',
	'read_file',
	'grep_search',
	'list_dir',
	'get_errors',
	'get_problems',
	'single_find_and_replace',
	'multi_edit',
	'edit_existing_file',
] as const;

/** First index of Copilot/Cursor-style textual tool markup, or -1. */
function indexOfTextualToolDumpStart(text: string): number {
	if (!text) {
		return -1;
	}
	const patterns = [
		/seed:tool_call\b/i,
		/<\/?tool_call\b/i,
		/<\/?function_calls?\b/i,
		/<\/?invoke\b/i,
		/<\/?parameter\b/i,
		/<\/?arg_(?:key|value)\b/i,
		/<(?:multi_)?replace_string_in_file\b/i,
		/<run_in_terminal\b/i,
		/<(?:insert_edit_into_file|apply_patch|write_file|create_file|read_file|grep_search|get_errors|get_problems)\b/i,
		/<(?:find|replace)_\d+\b/i,
	];
	let best = -1;
	for (const re of patterns) {
		const match = re.exec(text);
		if (match && (best < 0 || match.index < best)) {
			best = match.index;
		}
	}
	return best;
}

/**
 * If `text` ends with an incomplete tool-tag prefix (`<`, `<tool`, `<tool_ca`, `</tool_c`),
 * return the index of that `<` so streaming can hold it back. Otherwise -1.
 */
function incompleteToolMarkupHoldStart(text: string): number {
	if (!text) {
		return -1;
	}
	const lastLt = text.lastIndexOf('<');
	if (lastLt < 0) {
		return -1;
	}
	const after = text.slice(lastLt + 1);
	// A completed tag (has `>` or whitespace/newline after the name) is handled elsewhere.
	if (after.includes('>')) {
		return -1;
	}
	// Bare `<` — hold until we know it is not tool markup.
	if (after.length === 0) {
		return lastLt;
	}
	let name = after;
	if (name.startsWith('/')) {
		name = name.slice(1);
		if (name.length === 0) {
			return lastLt;
		}
	}
	// Only hold while the suffix is still a strict prefix of a known tool tag.
	// Digits allowed so `<find_1` / `<replace_12` can be held mid-stream.
	if (!/^[A-Za-z_][\w:-]*$/.test(name)) {
		return -1;
	}
	const lower = name.toLowerCase();
	for (const candidate of TEXTUAL_TOOL_TAG_PREFIXES) {
		if (candidate.startsWith(lower) && lower.length < candidate.length) {
			return lastLt;
		}
	}
	// `<find_` / `<replace_` numeric tool tags
	if (/^(?:find|replace)_?\d*$/i.test(name) && !/^(?:find|replace)_\d+$/i.test(name)) {
		return lastLt;
	}
	return -1;
}

/** Remove a trailing incomplete tool-tag prefix left by a truncated stream. */
function stripIncompleteTrailingToolMarkup(text: string): string {
	const holdAt = incompleteToolMarkupHoldStart(text);
	return holdAt >= 0 ? text.slice(0, holdAt) : text;
}

/** Keep prose before the first tool dump; drop unrecoverable XML/JS tool markup. */
function stripUnrecoverableToolMarkup(text: string): string {
	if (!text) {
		return text;
	}
	text = stripIncompleteTrailingToolMarkup(text);
	const dumpAt = indexOfTextualToolDumpStart(text);
	if (dumpAt < 0) {
		return text
			.replace(/\]\(https?:\/\/(?:www\.)?microsoft\.com\/?\)/gi, '')
			.replace(/\n{3,}/g, '\n\n')
			.trim();
	}
	const recovered = recoverTextualToolCalls(text);
	const cleaned = recovered.cleanedText;
	if (!looksLikeTextualToolDump(cleaned)) {
		return cleaned.trim();
	}
	const again = indexOfTextualToolDumpStart(cleaned);
	return (again >= 0 ? cleaned.slice(0, again) : cleaned)
		.replace(/<\/?(?:tool_call|function_calls?|invoke|parameter|arg_key|arg_value)\b[^>]*>/gi, '')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

const RECOVERABLE_TOOL_NAMES = [
	'multi_replace_string_in_file',
	'replace_string_in_file',
	'insert_edit_into_file',
	'apply_patch',
	'write_file',
	'create_file',
	'create_new_file',
	'run_in_terminal',
	'run_terminal_command',
	'read_file',
	'grep_search',
	'list_dir',
	'ls',
	'get_errors',
	'get_problems',
	'single_find_and_replace',
	'multi_edit',
	'edit_existing_file',
] as const;

/**
 * Best-effort recovery when the model prints XML-ish tool markup into chat text.
 * Supports:
 *  - <tool_call>name\nattrs\nbody</tool_call>
 *  - Copilot-style <arg_key>k</arg_key><arg_value>v</arg_value> (incl. mangled <tool_call>k</arg_key>)
 *  - <name attr="...">...</name>
 *  - <name attr="..." />
 *  - find_N / replace_N pairs for multi_replace
 */
function recoverTextualToolCalls(text: string): {
	toolUses: IChatResponseToolUsePart[];
	cleanedText: string;
} {
	const toolUses: IChatResponseToolUsePart[] = [];
	let cleaned = text;
	const nameAlt = RECOVERABLE_TOOL_NAMES.join('|');

	// Some local models emit `seed:tool_call<function name="list_dir">` instead of native tool_calls.
	const seedToolRe = /seed:tool_call\s*(?:<\s*function\s+name\s*=\s*["']([^"']+)["']\s*\/?>|(\w+)\b)?/gi;
	cleaned = cleaned.replace(seedToolRe, (_full, fnName1?: string, fnName2?: string) => {
		const rawName = (fnName1 || fnName2 || '').trim();
		if (!rawName) {
			return '';
		}
		const name = normalizeRecoveredToolName(rawName);
		toolUses.push({
			type: 'tool_use',
			name,
			toolCallId: `recovered_${name}_${toolUses.length}_${Date.now()}`,
			parameters: {},
		});
		return '';
	});

	// Cursor/Copilot-style: <tool_call>tool_name ... </tool_call>
	// Allow unclosed dumps (model often truncates) by falling back to end-of-string.
	const toolCallOpenRe = new RegExp(
		`<tool_call\\s*>(\\s*)(${nameAlt})\\b([\\s\\S]*?)(?:<\\/(?:\\2|tool_call)\\s*>|$)`,
		'gi',
	);
	cleaned = cleaned.replace(toolCallOpenRe, (_full, _ws: string, name: string, body: string) => {
		const attrs = parseXmlishAttributes(body);
		const params = buildParamsFromTextualTool(name, attrs, body);
		if (!params) {
			return ''; // drop unrecoverable dump chunks instead of leaving XML in chat
		}
		toolUses.push({
			type: 'tool_use',
			name: normalizeRecoveredToolName(name),
			toolCallId: `recovered_${name}_${toolUses.length}_${Date.now()}`,
			parameters: params,
		});
		return '';
	});

	// JS-call style jammed into text: replace_string_in_file({ ... }) / get_errors()
	const jsCallRe = new RegExp(
		`\\b(${nameAlt})\\s*\\(\\s*([\\s\\S]*?)\\s*\\)`,
		'gi',
	);
	cleaned = cleaned.replace(jsCallRe, (_full, name: string, body: string) => {
		// Avoid eating normal prose like "fix(the bug)" — require tool-ish keys or empty ().
		const attrs = parseXmlishAttributes(body);
		const looksLikeToolArgs = Object.keys(attrs).length > 0
			|| /(?:filepath|filePath|path|oldString|newString|old_string|new_string|command)\s*[:=]/i.test(body)
			|| body.trim() === '';
		if (!looksLikeToolArgs) {
			return _full;
		}
		const params = buildParamsFromTextualTool(name, attrs, body);
		if (!params && body.trim() !== '') {
			return '';
		}
		if (!params) {
			// Empty () tools like get_errors()
			const normalized = normalizeRecoveredToolName(name);
			if (normalized === 'get_errors') {
				toolUses.push({
					type: 'tool_use',
					name: normalized,
					toolCallId: `recovered_${name}_${toolUses.length}_${Date.now()}`,
					parameters: {},
				});
				return '';
			}
			return _full;
		}
		toolUses.push({
			type: 'tool_use',
			name: normalizeRecoveredToolName(name),
			toolCallId: `recovered_${name}_${toolUses.length}_${Date.now()}`,
			parameters: params,
		});
		return '';
	});

	// Also strip leftover wrappers when we recovered at least one call.
	if (toolUses.length) {
		cleaned = cleaned
			.replace(/<\/?tool_call\s*>/gi, '')
			.replace(/<\/?function_calls?\s*>/gi, '')
			.replace(/<\/?invoke\b[^>]*>/gi, '')
			.replace(/<\/?parameter\b[^>]*>/gi, '');
	}

	const blockRe = new RegExp(
		`<(${nameAlt})\\b([^>]*)>([\\s\\S]*?)<\\/\\1\\s*>|<(${nameAlt})\\b([\\s\\S]*?)\\/>`,
		'gi',
	);

	cleaned = cleaned.replace(blockRe, (
		_full,
		nameOpen?: string,
		attrsOpen?: string,
		body?: string,
		nameSelf?: string,
		attrsSelf?: string,
	) => {
		const name = (nameOpen || nameSelf || '').trim();
		if (!name) {
			return '';
		}
		const attrSource = nameOpen ? `${attrsOpen || ''}\n${body || ''}` : (attrsSelf || '');
		const attrs = parseXmlishAttributes(attrSource);
		const params = buildParamsFromTextualTool(name, attrs, body || attrsSelf || '');
		if (!params) {
			return '';
		}
		toolUses.push({
			type: 'tool_use',
			name: normalizeRecoveredToolName(name),
			toolCallId: `recovered_${name}_${toolUses.length}_${Date.now()}`,
			parameters: params,
		});
		return '';
	});

	// Remove leftover find_N/replace_N and arg_key/arg_value junk.
	cleaned = cleaned
		.replace(/<\/?(?:find|replace)_\d+\b[^>]*>/gi, '')
		.replace(/<\/?arg_(?:key|value)\b[^>]*>/gi, '')
		.replace(/\]\(https?:\/\/(?:www\.)?microsoft\.com\/?\)/gi, '')
		.replace(/\n{3,}/g, '\n\n')
		.trim();

	return { toolUses, cleanedText: cleaned };
}

function normalizeRecoveredToolName(name: string): string {
	switch (name) {
		case 'create_new_file':
			return 'create_file';
		case 'run_terminal_command':
			return 'run_in_terminal';
		case 'ls':
			return 'list_dir';
		case 'get_problems':
			return 'get_errors';
		case 'single_find_and_replace':
			return 'replace_string_in_file';
		case 'multi_edit':
			return 'multi_replace_string_in_file';
		case 'edit_existing_file':
			return 'insert_edit_into_file';
		default:
			return name;
	}
}

function parseXmlishAttributes(raw: string): Record<string, string> {
	const out: Record<string, string> = {};
	const re = /([A-Za-z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(raw)) !== null) {
		out[match[1]] = match[2] ?? match[3] ?? '';
	}
	// Also support bare filepath=... lines without quotes (rare).
	const bare = /^\s*(filepath|filePath|path|command)\s*=\s*(.+?)\s*$/gim;
	while ((match = bare.exec(raw)) !== null) {
		const key = match[1];
		if (!out[key]) {
			out[key] = match[2].replace(/^["']|["']$/g, '');
		}
	}
	// Copilot / Claude XML: <arg_key>filepath</arg_key><arg_value>...</arg_value>
	// Some models mangle the first key opener as <tool_call>filepath</arg_key>.
	const argKv = /<(?:arg_key|tool_call)\s*>\s*([A-Za-z_][\w-]*)\s*<\/arg_key\s*>\s*<arg_value\s*>([\s\S]*?)<\/arg_value\s*>/gi;
	while ((match = argKv.exec(raw)) !== null) {
		const key = match[1];
		if (!out[key]) {
			out[key] = match[2];
		}
	}
	// Cursor-style: <parameter name="filePath">...</parameter>
	const paramRe = /<parameter\s+name\s*=\s*["']([^"']+)["']\s*>([\s\S]*?)<\/parameter\s*>/gi;
	while ((match = paramRe.exec(raw)) !== null) {
		const key = match[1];
		if (!out[key]) {
			out[key] = match[2];
		}
	}
	// JS/object style: filePath: '...' / oldString: `...` / oldString: "..."
	const colonKv = /(?:^|[,\s{])(filepath|filePath|path|oldString|newString|old_string|new_string|command|query|content|contents)\s*:\s*(`[\s\S]*?`|'[^']*'|"[^"]*")/gi;
	while ((match = colonKv.exec(raw)) !== null) {
		const key = match[1];
		if (!out[key]) {
			const rawVal = match[2];
			out[key] = rawVal.length >= 2 ? rawVal.slice(1, -1) : rawVal;
		}
	}
	return out;
}

function buildParamsFromTextualTool(
	name: string,
	attrs: Record<string, string>,
	body: string,
): Record<string, unknown> | undefined {
	const filepath = attrs.filepath || attrs.filePath || attrs.path;
	const normalized = normalizeRecoveredToolName(name);

	if (normalized === 'replace_string_in_file') {
		const oldString = attrs.find_string || attrs.old_string || attrs.oldString || attrs.find;
		const newString = attrs.replace_string || attrs.new_string || attrs.newString || attrs.replace;
		if (!filepath || oldString === undefined || newString === undefined) {
			return undefined;
		}
		return { filepath, filePath: filepath, old_string: oldString, oldString, new_string: newString, newString };
	}

	if (normalized === 'multi_replace_string_in_file') {
		const edits: Array<{ old_string: string; new_string: string }> = [];
		const findRe = /<find_(\d+)>([\s\S]*?)<\/find_\1>/gi;
		let findMatch: RegExpExecArray | null;
		const finds = new Map<string, string>();
		while ((findMatch = findRe.exec(body)) !== null) {
			finds.set(findMatch[1], findMatch[2]);
		}
		const replaceRe = /<replace_(\d+)>([\s\S]*?)<\/replace_\1>/gi;
		while ((findMatch = replaceRe.exec(body)) !== null) {
			const idx = findMatch[1];
			const old_string = finds.get(idx);
			if (old_string !== undefined) {
				edits.push({ old_string, new_string: findMatch[2] });
			}
		}
		if (!filepath || !edits.length) {
			return undefined;
		}
		return {
			filepath,
			filePath: filepath,
			edits,
			replacements: edits.map(e => ({
				filePath: filepath,
				oldString: e.old_string,
				newString: e.new_string,
			})),
		};
	}

	if (normalized === 'run_in_terminal') {
		const command = attrs.command;
		if (!command) {
			return undefined;
		}
		return {
			command,
			mode: attrs.mode,
			explanation: attrs.explanation,
			goal: attrs.goal,
			waitForCompletion: attrs.mode !== 'async',
		};
	}

	if (normalized === 'write_file' || normalized === 'create_file') {
		const content = attrs.content || attrs.contents || body.trim();
		if (!filepath || !content) {
			return undefined;
		}
		return { filepath, filePath: filepath, contents: content, content };
	}

	if (normalized === 'insert_edit_into_file') {
		const code = attrs.code || attrs.changes || body.trim();
		if (!filepath || !code) {
			return undefined;
		}
		return { filepath, filePath: filepath, code, changes: code };
	}

	if (normalized === 'read_file') {
		if (!filepath) {
			return undefined;
		}
		return { filepath, filePath: filepath };
	}

	if (normalized === 'grep_search') {
		const query = attrs.query || attrs.pattern;
		if (!query) {
			return undefined;
		}
		return { query, pattern: query, includePattern: attrs.includePattern || attrs.include };
	}

	if (normalized === 'list_dir') {
		return { path: attrs.path || attrs.dirPath || filepath || '.' };
	}

	if (normalized === 'get_errors') {
		return filepath ? { filepath, filePath: filepath, filePaths: [filepath] } : {};
	}

	if (normalized === 'apply_patch') {
		const input = attrs.input || attrs.patch || body.trim();
		if (!input) {
			return undefined;
		}
		return { input, patch: input, explanation: attrs.explanation };
	}

	return Object.keys(attrs).length ? { ...attrs } : undefined;
}

/** Assistant text looks like a proposed diff plan waiting for approval. */
function looksLikeChangeProposal(text: string): boolean {
	if (!text.trim()) {
		return false;
	}
	const proposalSignals = [
		/建议(统一)?替换/,
		/建议修改/,
		/涉及\s*\d+\s*个文件/,
		/please confirm/i,
		/suggested\s+replacements?/i,
		/would\s+you\s+like\s+me\s+to/i,
		/I('ll| will)\s+(update|change|replace|edit)\b/i,
	];
	return proposalSignals.some(re => re.test(text));
}

function buildChatMessages(
	history: IChatAgentHistoryEntry[],
	currentMessage: string,
	executeSystem?: string,
	skillCatalog?: string,
	skillAttachments: readonly string[] = [],
	ocrExtract?: string,
	memoriesBlock?: string,
	visionImageParts?: IChatMessageImagePart[],
	todoListIntent = false,
	docEditTask = false,
	): IChatMessage[] {
	const messages: IChatMessage[] = [];

	const systemParts = [executeSystem, skillCatalog, memoriesBlock].filter(Boolean) as string[];
	if (systemParts.length) {
		messages.push({
			role: ChatMessageRole.System,
			content: [{ type: 'text', value: systemParts.join('\n\n') }],
		});
	}

		for (const entry of history) {
			if (entry?.request?.message) {
				messages.push({
					role: ChatMessageRole.User,
					content: [{ type: 'text', value: entry.request.message }],
				});
			}
			const assistantText = (entry?.response ?? [])
				.map(part => part.kind === 'markdownContent' ? part.content.value : '')
				.filter(Boolean)
				.join('');
		if (assistantText) {
			messages.push({
				role: ChatMessageRole.Assistant,
				content: [{ type: 'text', value: assistantText }],
			});
		}
	}

	const userParts: string[] = [];
	const webSearch = hasWebSearchIntent(currentMessage);
	if (skillAttachments.length && !webSearch) {
		userParts.push(...skillAttachments);
		userParts.push(
			'<execution-override>\nAgent mode: the user brief is sufficient for a first shippable version. Do NOT ask clarifying questions and NEVER ask for confirmation before editing (forbidden: 请确认 / please confirm / should I proceed). After any list_dir/read_file/grep_search, your NEXT action must be a patch edit tool (replace_string_in_file / multi_replace_string_in_file / insert_edit_into_file) or create_file — not write_file for small edits. Apply changes in the same turn.\n</execution-override>',
		);
	}
	if (webSearch) {
		userParts.push(
			'<web-search-override>\nExternal knowledge question. Call search_web ONCE first. You may call fetch_webpage at most once for one official page. Then STOP using tools and write your answer in the user\'s language. Do NOT repeat search_web with rephrased queries — Bing snippets are short; synthesize the best answer from what you have.\n</web-search-override>',
		);
	}
	if (hasScaffoldProjectIntent(currentMessage)) {
		userParts.push(
			'<scaffold-override>\nThis is a CODE PROJECT SCAFFOLD request (TypeScript/repo files). Use create_file or write_file to create each listed path immediately. Do NOT run WPS/office document generation pipelines in this turn.\n</scaffold-override>',
		);
	}
	if (todoListIntent) {
		userParts.push(
			'<todo-override>\nMulti-step task. Your FIRST tool call MUST be manage_todo_list: write 3–7 concise items in the user\'s language, mark the first item in-progress, then execute. Update the list after each step (one in-progress at a time). Do NOT skip the todo UI.\n</todo-override>',
		);
	}
	if (docEditTask) {
		userParts.push(
			'<doc-edit-override>\nREADME/markdown only. Read the named .md file(s), patch with replace_string_in_file, then TASK_COMPLETE. No manage_todo_list, get_errors, compile, or broad repo grep.\n</doc-edit-override>',
		);
	}
	if (ocrExtract) {
		userParts.push(
			'<ocr-context>\nThe following text was extracted locally from user-attached image(s) via OCR. Treat it as the image content for this request.\n</ocr-context>',
		);
		userParts.push(ocrExtract);
	}
		userParts.push(currentMessage);
	const userContent: IChatMessage['content'] = [{ type: 'text', value: userParts.join('\n\n') }];
	if (visionImageParts?.length) {
		userContent.push(...visionImageParts);
	}
	messages.push({
		role: ChatMessageRole.User,
		content: userContent,
	});
	return messages;
}

function createContinueAgentData(
	id: string,
	name: string,
	mode: ChatModeKind,
	opts?: { isDefault?: boolean; fullName?: string; description?: string },
): IChatAgentData {
	return {
		id,
		name,
		fullName: opts?.fullName ?? 'Continue',
		description: opts?.description ?? localize('continue.agentDescription', "Continue AI assistant"),
		extensionId: new ExtensionIdentifier(CONTINUE_EXTENSION_ID),
		extensionVersion: undefined,
		extensionPublisherId: 'Continue',
		extensionDisplayName: 'Continue',
		isDefault: opts?.isDefault ?? true,
		isDynamic: true,
		isCore: false,
		metadata: {},
		slashCommands: [],
		locations: [ChatAgentLocation.Chat],
		modes: [mode],
		disambiguation: [],
		capabilities: {
			supportsImageAttachments: true,
			supportsFileAttachments: true,
		},
	};
}

class ContinueChatAgentContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contributions.continueChatAgents';

	constructor(
		@IChatAgentService private readonly chatAgentService: IChatAgentService,
		@ILanguageModelsService languageModelsService: ILanguageModelsService,
		@IPromptsService promptsService: IPromptsService,
		@IFileService fileService: IFileService,
		@IConfigurationService configurationService: IConfigurationService,
		@ILogService logService: ILogService,
		@IWorkspaceContextService workspaceService: IWorkspaceContextService,
		@ILanguageModelToolsService languageModelToolsService: ILanguageModelToolsService,
		@ICommandService commandService: ICommandService,
		@IExtensionService extensionService: IExtensionService,
		@IMarkerService markerService: IMarkerService,
		@IChatTodoListService chatTodoListService: IChatTodoListService,
			@ITextFileService textFileService: ITextFileService,
			@IWorkbenchEnvironmentService environmentService: IWorkbenchEnvironmentService,
			@IStorageService storageService: IStorageService,
		) {
			super();

			const impl = new ContinueChatAgent(
				languageModelsService,
				promptsService,
				fileService,
				configurationService,
				logService,
				workspaceService,
				languageModelToolsService,
				commandService,
				extensionService,
				markerService,
				chatTodoListService,
				textFileService,
				environmentService,
				storageService,
			);
		const registrations: Array<{
			id: string;
			name: string;
			mode: ChatModeKind;
			opts?: { isDefault?: boolean; fullName?: string; description?: string };
		}> = [
			{ id: CONTINUE_AGENT_IDS.agent, name: 'Continue', mode: ChatModeKind.Agent },
			{
				id: CONTINUE_AGENT_IDS.game,
				name: 'Game',
				mode: ChatModeKind.Agent,
				opts: {
					isDefault: false,
					fullName: 'Game',
					description: localize(
						'continue.gameAgentDescription',
						"Claude Code Game Studios workflow + Godot live preview in game-dev/",
					),
				},
			},
			{
				id: CONTINUE_AGENT_IDS.chip,
				name: 'Chip',
				mode: ChatModeKind.Agent,
				opts: {
					isDefault: false,
					fullName: 'Chip',
					description: localize(
						'continue.chipAgentDescription',
						"FPGA physical token sampler in chip-design/ — RTL, Yosys/openXC7, UART. No Godot.",
					),
				},
			},
		];

		for (const { id, name, mode, opts } of registrations) {
			this._register(this.chatAgentService.registerDynamicAgent(
				createContinueAgentData(id, name, mode, opts),
				impl,
			));
		}
	}
}

export function registerContinueChatAgentContribution(): void {
	if (isContinuePhysicalAiIde()) {
		registerWorkbenchContribution2(ContinueChatAgentContribution.ID, ContinueChatAgentContribution, WorkbenchPhase.BlockStartup);
	}
}
