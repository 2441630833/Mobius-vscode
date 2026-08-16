/*---------------------------------------------------------------------------------------------
 *  Mobius — Copilot-preferred tool superset for Continue Agents window
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IMarkdownString } from '../../../../base/common/htmlContent.js';
import { URI } from '../../../../base/common/uri.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { TerminalToolId } from '../../chat/common/tools/terminalToolIds.js';
import {
	CountTokensCallback,
	ILanguageModelToolsService,
	IToolData,
	IToolResult,
	IToolResultPromptTsxPart,
	IToolResultTextPart,
	isToolResultInputOutputDetails,
	stringifyPromptTsxPart,
} from '../../chat/common/tools/languageModelToolsService.js';
import {
	ContinueAgentToolSchema,
	loadContinueAgentTools,
} from './continueAgentToolsBridge.js';
import { executeRunTerminalCommand } from './continueTerminalTool.js';

export const CONTINUE_GET_AGENT_CHAT_RULES = 'continue.getAgentChatRules';

/** Continue-only tools that never map to Copilot (always keep Continue impl). */
export const CONTINUE_ONLY_TOOL_NAMES = new Set<string>([
	'search_web',
	'request_rule',
	'create_rule_block',
	'view_diff',
	'read_currently_open_file',
	'view_repo_map',
	'view_subdirectory',
	'write_file', // full overwrite fallback when Copilot create/replace insufficient
]);

/**
 * Copilot tools that break outside Copilot's own agent loop (need promptContext /
 * skills index / deferred tool loading). Never advertise these to Continue Agent.
 */
export const CONTINUE_AGENT_UNSUPPORTED_COPILOT_TOOLS = new Set<string>([
	'skill',
	'read_skill',
	'view_image',
	'viewimage',
	'tool_search',
	'toolsearch',
	'copilot_viewImage',
	// Placeholder tool ("do not use") — real edits go through replace_string / create_file / apply_patch.
	'edit_files',
	'editfiles',
	'copilot_editFiles',
	// Test-file finder is irrelevant for most Agent edits and often called with bad args.
	'test_search',
	'find_test_files',
	'findtestfiles',
	'copilot_findTestFiles',
	// Needs Copilot/VS Code chat question carousel UI — Continue Agent never renders it,
	// so invoke hangs then cancels as "failed". Agent mode must not ask; it should edit.
	'vscode_askQuestions',
	'ask_questions',
	'askquestions',
	'ask_user_question',
	'askuserquestion',
	// Plan review blocks Agent mode for manual approval — Mobius is always-allow.
	'vscode_reviewPlan',
	'review_plan',
	'reviewplan',
]);

export function isUnsupportedContinueAgentTool(nameOrId: string): boolean {
	const raw = nameOrId.trim();
	if (!raw) {
		return false;
	}
	if (CONTINUE_AGENT_UNSUPPORTED_COPILOT_TOOLS.has(raw)) {
		return true;
	}
	const snake = raw
		.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
		.replace(/-/g, '_')
		.toLowerCase();
	return CONTINUE_AGENT_UNSUPPORTED_COPILOT_TOOLS.has(snake);
}

/** Soft recovery when the model still emits an unsupported Copilot-only tool. */
export function unsupportedCopilotToolRecovery(toolName: string): string {
	if (toolName === 'skill' || toolName === 'read_skill') {
		return `Tool "${toolName}" is unavailable in Continue Agent (Copilot skill index is not wired here). `
			+ `Matching skills for this turn were already injected as <skill-context> when relevant. `
			+ `Do NOT retry skill. Continue with grep_search / read_file / list_dir / replace_string_in_file / write_file.`;
	}
	if (toolName === 'view_image' || toolName === 'viewImage' || toolName === 'copilot_viewImage') {
		return `Tool "view_image" is unavailable in Continue Agent. Attached images are OCR'd into the user message when possible. `
			+ `Do NOT retry view_image. Continue with grep_search / read_file / replace_string_in_file to fix the code.`;
	}
	if (toolName === 'tool_search' || toolName === 'toolSearch') {
		return `Tool "tool_search" is unavailable in Continue Agent. Use the tools already listed (grep_search, read_file, replace_string_in_file, …). Do NOT retry tool_search.`;
	}
	if (toolName === 'edit_files' || toolName === 'editFiles' || toolName === 'copilot_editFiles') {
		return `Tool "edit_files" is a Copilot placeholder and cannot edit files. `
			+ `Do NOT retry edit_files. Call replace_string_in_file, multi_replace_string_in_file, insert_edit_into_file, apply_patch, or write_file instead.`;
	}
	if (toolName === 'test_search' || toolName === 'findTestFiles' || toolName === 'find_test_files' || toolName === 'copilot_findTestFiles') {
		return `Tool "test_search" is unavailable / not needed here. Do NOT retry it. Use grep_search / read_file / replace_string_in_file to continue the user task.`;
	}
	if (
		toolName === 'vscode_askQuestions'
		|| toolName === 'ask_questions'
		|| toolName === 'askQuestions'
		|| toolName === 'ask_user_question'
	) {
		return `Tool "vscode_askQuestions" is unavailable in Continue Agent (no question carousel UI here). `
			+ `Do NOT ask the user and do NOT retry askQuestions. Infer sensible defaults and call `
			+ `replace_string_in_file / multi_replace_string_in_file / apply_patch / write_file NOW.`;
	}
	if (toolName === 'vscode_reviewPlan' || toolName === 'review_plan' || toolName === 'reviewPlan') {
		return `Tool "vscode_reviewPlan" is unavailable in Continue Agent (Mobius is always-allow / Bypass Approvals). `
			+ `Do NOT wait for plan approval. Proceed to implement with replace_string_in_file / multi_replace_string_in_file / apply_patch / write_file NOW.`;
	}
	return `Tool "${toolName}" is unavailable in Continue Agent. Continue with grep_search / read_file / replace_string_in_file / write_file. Do NOT retry this tool.`;
}

/** Internal / confirmation tools — never advertise to the LM. */
const EXCLUDED_TOOL_IDS = new Set<string>([
	'vscode_get_confirmation',
	'vscode_get_confirmation_with_options',
	'vscode_get_modified_files_confirmation',
	'vscode_get_terminal_confirmation',
	'vscode_editFile_internal',
	'vscode_fetchWebPage_internal',
	'vscode_resolveDebugEventDetails_internal',
	'task_complete',
	// Never advertise — Continue Agent cannot run these Copilot-loop-only tools.
	'skill',
	'copilot_viewImage',
	'copilot_editFiles',
	'copilot_findTestFiles',
	'vscode_askQuestions',
	'vscode_reviewPlan',
]);

export type CopilotToolOverlap = {
	/** Model-facing name when Copilot tool is available. */
	readonly modelName: string;
	/** Registration id for ILanguageModelToolsService.invokeTool. */
	readonly toolId: string;
	/** Continue names replaced (and used as fallback advertise/execute). */
	readonly continueFallbackNames: readonly string[];
	/** Optional arg reshape before invokeTool. */
	readonly reshape?: (args: Record<string, unknown>, cwd: URI | undefined) => Record<string, unknown>;
};

function toAbsolutePath(cwd: URI | undefined, pathValue: unknown): string | undefined {
	if (typeof pathValue !== 'string' || !pathValue.trim()) {
		return undefined;
	}
	const raw = pathValue.trim();
	let abs: string;
	if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('/') || raw.startsWith('\\\\') || raw.startsWith('file:')) {
		abs = raw.startsWith('file:') ? URI.parse(raw).fsPath : raw;
	} else if (cwd) {
		const cleaned = raw.replace(/\\/g, '/').replace(/^\.\//, '');
		abs = URI.joinPath(cwd, cleaned).fsPath;
	} else {
		// Copilot resolveToolInputPath requires an absolute path — relative without cwd will fail.
		return undefined;
	}
	// Normalize so WorkingDirectory / resolveFilePath comparisons are stable on Windows.
	try {
		return URI.file(abs).fsPath;
	} catch {
		return abs;
	}
}

function pickPath(args: Record<string, unknown>, keys: string[]): unknown {
	for (const key of keys) {
		if (typeof args[key] === 'string' && (args[key] as string).trim()) {
			return args[key];
		}
	}
	return undefined;
}

/** Local Qwen often emits `command: 'read_file path="…"'` instead of filePath. */
function coercePathArg(args: Record<string, unknown>): unknown {
	const direct = pickPath(args, ['filePath', 'filepath', 'path']);
	if (direct) {
		return direct;
	}
	for (const key of ['command', 'query', 'input', 'raw'] as const) {
		const raw = args[key];
		if (typeof raw !== 'string' || !raw.trim()) {
			continue;
		}
		const quoted = /(?:filepath|filePath|path)\s*=\s*["']([^"']+)["']/i.exec(raw)
			?? /(?:read_file|read_file_range)\b[^"'\n]*["']([^"']+)["']/i.exec(raw);
		if (quoted?.[1]?.trim()) {
			return quoted[1].trim();
		}
		const bare = /(?:filepath|filePath|path)\s*=\s*(\S+)/i.exec(raw);
		if (bare?.[1]?.trim()) {
			return bare[1].trim().replace(/[,\s]+$/, '');
		}
		const pathToken = /(?:^|\s)((?:[A-Za-z]:[\\/]|\/|\.\/)?[\w./\\-]+\.[\w]+)\s*$/.exec(raw.trim());
		if (pathToken?.[1]?.trim()) {
			return pathToken[1].trim();
		}
	}
	return undefined;
}

function coerceTerminalCommandArg(args: Record<string, unknown>): string {
	if (typeof args.command === 'string' && args.command.trim()) {
		const trimmed = args.command.trim();
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
		const raw = args[key];
		if (typeof raw !== 'string' || !raw.trim()) {
			continue;
		}
		const nested = /(?:^|\b)(?:command|cmd)\s*=\s*["']([^"']+)["']/i.exec(raw);
		if (nested?.[1]?.trim()) {
			return nested[1].trim();
		}
	}
	return '';
}

/**
 * Overlap map: Copilot preferred when registered.
 * Continue fallbacks used when Copilot tool is missing or invocation fails.
 */
export const COPILOT_TOOL_OVERLAPS: readonly CopilotToolOverlap[] = [
	{
		modelName: 'read_file',
		toolId: 'copilot_readFile',
		continueFallbackNames: ['read_file', 'read_file_range'],
		reshape: (args, cwd) => {
			const raw = coercePathArg(args);
			const filePath = toAbsolutePath(cwd, raw)
				?? (typeof raw === 'string' && raw.trim() ? raw.trim() : undefined);
			const startLine = typeof args.startLine === 'number' ? args.startLine
				: typeof args.start_line === 'number' ? args.start_line
					: 1;
			const endLine = typeof args.endLine === 'number' ? args.endLine
				: typeof args.end_line === 'number' ? args.end_line
					: 500;
			// Copilot prepareInvocation does input.filePath.length — never pass undefined.
			return { filePath: filePath ?? '', startLine, endLine };
		},
	},
	{
		modelName: 'list_dir',
		toolId: 'copilot_listDirectory',
		continueFallbackNames: ['ls'],
		reshape: (args, cwd) => {
			const raw = coercePathArg(args) ?? pickPath(args, ['path', 'dirPath', 'directory']);
			const path = toAbsolutePath(cwd, raw) ?? (typeof raw === 'string' ? raw : undefined) ?? cwd?.fsPath ?? '';
			return { path };
		},
	},
	{
		modelName: 'grep_search',
		toolId: 'copilot_findTextInFiles',
		continueFallbackNames: ['grep_search'],
		reshape: (args) => {
			const query = typeof (args.query ?? args.pattern) === 'string' ? String(args.query ?? args.pattern) : '';
			// Only treat as regex when the model explicitly opts in. Defaulting to true made
			// path-like queries with "|" / "()" hit Copilot's expensive regex path and 20s timeout.
			const isRegexp = args.isRegexp === true
				|| args.isRegexp === 'true'
				|| (args.isRegexp === undefined && /[|\\()[\]{}^$*+?]/.test(query));
			return {
				query,
				isRegexp,
				includePattern: args.includePattern ?? args.include,
				maxResults: args.maxResults,
				includeIgnoredFiles: args.includeIgnoredFiles,
			};
		},
	},
	{
		modelName: 'file_search',
		toolId: 'copilot_findFiles',
		continueFallbackNames: ['file_glob_search'],
		reshape: (args) => ({
			query: typeof (args.query ?? args.pattern ?? args.glob) === 'string'
				? String(args.query ?? args.pattern ?? args.glob)
				: '',
			maxResults: args.maxResults,
		}),
	},
	{
		modelName: 'semantic_search',
		toolId: 'copilot_searchCodebase',
		continueFallbackNames: ['codebase'],
		reshape: (args) => ({
			query: typeof args.query === 'string' ? args.query : '',
		}),
	},
	{
		modelName: 'create_file',
		toolId: 'copilot_createFile',
		continueFallbackNames: ['create_new_file'],
		reshape: (args, cwd) => {
			const raw = coercePathArg(args) ?? pickPath(args, ['filePath', 'filepath', 'path', 'file_path']);
			const contentRaw = args.content ?? args.contents ?? args.body ?? args.text;
			const content = typeof contentRaw === 'string'
				? contentRaw
				: contentRaw === undefined || contentRaw === null
					? ''
					: String(contentRaw);
			return {
				filePath: toAbsolutePath(cwd, raw) ?? (typeof raw === 'string' ? raw : ''),
				content,
			};
		},
	},
	{
		modelName: 'replace_string_in_file',
		toolId: 'copilot_replaceString',
		continueFallbackNames: ['single_find_and_replace'],
		reshape: (args, cwd) => {
			const raw = coercePathArg(args) ?? pickPath(args, ['filePath', 'filepath', 'path']);
			return {
				filePath: toAbsolutePath(cwd, raw) ?? (typeof raw === 'string' ? raw : ''),
				oldString: args.oldString ?? args.old_string ?? '',
				newString: args.newString ?? args.new_string ?? '',
			};
		},
	},
	{
		modelName: 'multi_replace_string_in_file',
		toolId: 'copilot_multiReplaceString',
		continueFallbackNames: ['multi_edit'],
		reshape: (args, cwd) => {
			const edits = Array.isArray(args.replacements) ? args.replacements
				: Array.isArray(args.edits) ? args.edits
					: Array.isArray(args.changes) ? args.changes
						: [];
			const raw = coercePathArg(args) ?? pickPath(args, ['filePath', 'filepath', 'path', 'file_path']);
			const filePath = toAbsolutePath(cwd, raw) ?? (typeof raw === 'string' ? raw : undefined);
			const replacements = edits
				.map((e: Record<string, unknown>) => {
					const editPath = pickPath(e, ['filePath', 'filepath', 'path', 'file_path']);
					return {
						filePath: toAbsolutePath(cwd, editPath) ?? filePath ?? (typeof editPath === 'string' ? editPath : '') ?? '',
						oldString: String(e.oldString ?? e.old_string ?? e.old_str ?? e.find ?? ''),
						newString: String(e.newString ?? e.new_string ?? e.new_str ?? e.replace ?? ''),
					};
				})
				.filter(e => e.filePath.trim().length > 0 && e.oldString.length > 0);
			return {
				explanation: typeof args.explanation === 'string' ? args.explanation : 'Apply multiple edits',
				replacements,
			};
		},
	},
	{
		modelName: 'insert_edit_into_file',
		toolId: 'copilot_insertEdit',
		continueFallbackNames: ['edit_existing_file'],
		reshape: (args, cwd) => {
			const raw = coercePathArg(args) ?? pickPath(args, ['filePath', 'filepath', 'path']);
			return {
				explanation: typeof args.explanation === 'string' ? args.explanation : 'Edit file',
				filePath: toAbsolutePath(cwd, raw) ?? (typeof raw === 'string' ? raw : ''),
				code: args.code ?? args.changes ?? '',
			};
		},
	},
	{
		modelName: 'apply_patch',
		toolId: 'copilot_applyPatch',
		continueFallbackNames: [],
		reshape: (args) => ({
			input: args.input ?? args.patch ?? '',
			explanation: typeof args.explanation === 'string' ? args.explanation : 'Apply patch',
		}),
	},
	{
		modelName: 'run_in_terminal',
		toolId: TerminalToolId.RunInTerminal,
		continueFallbackNames: ['run_terminal_command'],
	},
	{
		modelName: 'get_errors',
		toolId: 'copilot_getErrors',
		continueFallbackNames: ['get_problems'],
		reshape: (args, cwd) => {
			if (Array.isArray(args.filePaths)) {
				return {
					filePaths: args.filePaths.map((p: unknown) => toAbsolutePath(cwd, p) ?? p),
				};
			}
			const single = coercePathArg(args) ?? pickPath(args, ['filepath', 'filePath', 'path']);
			if (single) {
				const abs = toAbsolutePath(cwd, single);
				return abs ? { filePaths: [abs] } : {};
			}
			return {};
		},
	},
	{
		modelName: 'fetch_webpage',
		toolId: 'copilot_fetchWebPage',
		continueFallbackNames: ['fetch_url_content'],
		reshape: (args) => {
			const urls = Array.isArray(args.urls) ? args.urls
				: typeof args.url === 'string' ? [args.url]
					: [];
			return {
				urls,
				query: typeof args.query === 'string' ? args.query : 'Extract main content',
			};
		},
	},
];

/** Contributed/core toolId → model-facing name for Copilot-only tools. */
const COPILOT_ONLY_MODEL_NAMES: Record<string, string> = {
	// skill / view_image / edit_files / test_search intentionally omitted —
	// unsupported outside Copilot agent loop (see CONTINUE_AGENT_UNSUPPORTED_COPILOT_TOOLS).
	copilot_getChangedFiles: 'get_changed_files',
	copilot_readProjectStructure: 'read_project_structure',
	copilot_createNewWorkspace: 'create_new_workspace',
	copilot_createNewJupyterNotebook: 'create_new_jupyter_notebook',
	copilot_editNotebook: 'edit_notebook_file',
	copilot_runNotebookCell: 'run_notebook_cell',
	copilot_getNotebookSummary: 'copilot_getNotebookSummary',
	copilot_readNotebookCellOutput: 'read_notebook_cell_output',
	copilot_installExtension: 'install_extension',
	copilot_githubRepo: 'github_repo',
	copilot_githubTextSearch: 'github_text_search',
	copilot_createDirectory: 'create_directory',
	copilot_runVscodeCommand: 'run_vscode_command',
	copilot_getVSCodeAPI: 'get_vscode_api',
	copilot_searchWorkspaceSymbols: 'search_workspace_symbols',
	copilot_memory: 'memory',
	copilot_resolveMemoryFileUri: 'resolve_memory_file_uri',
	copilot_sessionStoreSql: 'session_store_sql',
	copilot_switchAgent: 'switch_agent',
	execution_subagent: 'execution_subagent',
	search_subagent: 'search_subagent',
	explore_subagent: 'explore_subagent',
	manage_todo_list: 'manage_todo_list',
	runTests: 'runTests',
	testFailure: 'testFailure',
	runSubagent: 'runSubagent',
	create_and_run_task: 'create_and_run_task',
	run_task: 'run_task',
	get_task_output: 'get_task_output',
	get_terminal_output: 'get_terminal_output',
	send_to_terminal: 'send_to_terminal',
	kill_terminal: 'kill_terminal',
	terminal_selection: 'terminal_selection',
	terminal_last_command: 'terminal_last_command',
	open_browser_page: 'open_browser_page',
	read_page: 'read_page',
	screenshot_page: 'screenshot_page',
	navigate_page: 'navigate_page',
	click_element: 'click_element',
	type_in_page: 'type_in_page',
	hover_element: 'hover_element',
	drag_element: 'drag_element',
	handle_dialog: 'handle_dialog',
	run_playwright_code: 'run_playwright_code',
	// vscode_askQuestions / vscode_reviewPlan intentionally omitted — unsupported in Continue Agent
	vscode_listCodeUsages: 'vscode_listCodeUsages',
	vscode_renameSymbol: 'vscode_renameSymbol',
};

const TOOL_DISPLAY_NAMES: Record<string, string> = {
	search_web: 'Search Web',
	read_file: 'Read File',
	list_dir: 'List Directory',
	grep_search: 'Grep Search',
	file_search: 'File Search',
	semantic_search: 'Semantic Search',
	create_file: 'Create File',
	replace_string_in_file: 'Replace String',
	multi_replace_string_in_file: 'Multi Replace',
	insert_edit_into_file: 'Insert Edit',
	apply_patch: 'Apply Patch',
	run_in_terminal: 'Run in Terminal',
	get_errors: 'Get Errors',
	fetch_webpage: 'Fetch Webpage',
	write_file: 'Write File',
	ls: 'List Directory',
	codebase: 'Codebase Search',
	create_new_file: 'Create File',
	run_terminal_command: 'Run Terminal Command',
	single_find_and_replace: 'Find and Replace',
	multi_edit: 'Multi Edit',
	edit_existing_file: 'Edit File',
	get_problems: 'Get Problems',
	fetch_url_content: 'Read URL',
};

export function formatSupersetToolDisplayName(toolName: string): string {
	return TOOL_DISPLAY_NAMES[toolName] ?? toolName;
}

function schemaFromToolData(modelName: string, tool: IToolData): ContinueAgentToolSchema {
	return {
		type: 'function',
		function: {
			name: modelName,
			description: tool.modelDescription || tool.userDescription || modelName,
			parameters: (tool.inputSchema as Record<string, unknown> | undefined) ?? {
				type: 'object',
				properties: {},
			},
		},
	};
}

/** Re-advertise a Continue tool under the Copilot-facing model name. */
function aliasContinueSchema(
	modelName: string,
	fallback: ContinueAgentToolSchema,
): ContinueAgentToolSchema {
	return {
		type: 'function',
		function: {
			name: modelName,
			description: fallback.function.description || modelName,
			parameters: fallback.function.parameters ?? {
				type: 'object',
				properties: {},
			},
		},
	};
}

function mergeSchemas(
	...groups: readonly (readonly ContinueAgentToolSchema[])[]
): ContinueAgentToolSchema[] {
	const byName = new Map<string, ContinueAgentToolSchema>();
	for (const group of groups) {
		for (const tool of group) {
			byName.set(tool.function.name, tool);
		}
	}
	return [...byName.values()];
}

function modelNameForToolId(toolId: string, tool: IToolData): string {
	if (COPILOT_ONLY_MODEL_NAMES[toolId]) {
		return COPILOT_ONLY_MODEL_NAMES[toolId];
	}
	if (tool.toolReferenceName) {
		// camelCase → snake_case for model-facing consistency
		return tool.toolReferenceName
			.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
			.toLowerCase();
	}
	return toolId.replace(/^copilot_/, '').replace(/^vscode_/, '');
}

export function findOverlapForModelName(name: string): CopilotToolOverlap | undefined {
	return COPILOT_TOOL_OVERLAPS.find(
		o => o.modelName === name || o.continueFallbackNames.includes(name),
	);
}

export function isCopilotToolAvailable(
	toolsService: ILanguageModelToolsService,
	overlap: CopilotToolOverlap,
): boolean {
	return toolsService.hasToolImplementation(overlap.toolId);
}

/**
 * Copilot tools to skip in Continue Agent — prefer Continue implementations for known-bad cases:
 * - findTextInFiles: hard 20s timeout on broad regex
 * - insertEdit: requires a Chat editingSession that Continue Agents sessions do not have
 *
 * Do NOT skip replace/multiReplace/createFile here — fix Copilot tool *implementation*
 * registration instead so Continue Agent can invoke real Copilot tools.
 */
const COPILOT_SKIP_FOR_CONTINUE_TOOL_IDS = new Set<string>([
	'copilot_findTextInFiles',
	'copilot_insertEdit',
	// Needs Copilot Chat + vscode_fetchWebPage_internal + embeddings. Without
	// GitHub.copilot-chat mounted this paints a red "Fetch Webpage failed" row.
	// Continue fetch_url_content (HTTP + Readability) is reliable here.
	'copilot_fetchWebPage',
]);

function copilotSkipReason(toolId: string): string {
	switch (toolId) {
		case 'copilot_findTextInFiles':
			return '20s regex timeout — Continue ripgrep fallback';
		case 'copilot_insertEdit':
			return 'needs editingSession — Continue edit fallback';
		case 'copilot_fetchWebPage':
			return 'needs Copilot internal fetcher — Continue fetch_url_content';
		default:
			return 'prefer Continue fallback';
	}
}

/**
 * Load Copilot ∪ Continue tool schemas for Agents chat (cloud models).
 * Prefer Copilot schemas for overlapping tools when registered.
 */
export async function loadAgentToolSuperset(
	toolsService: ILanguageModelToolsService,
	commandService: ICommandService,
	logService?: ILogService,
): Promise<readonly ContinueAgentToolSchema[]> {
	const continueTools = await loadContinueAgentTools(commandService, logService);
	const continueByName = new Map(continueTools.map(t => [t.function.name, t]));

	const schemas: ContinueAgentToolSchema[] = [];
	const advertisedNames = new Set<string>();
	const coveredContinueNames = new Set<string>();
	const coveredToolIds = new Set<string>();

	let copilotOverlapHits = 0;
	for (const overlap of COPILOT_TOOL_OVERLAPS) {
		const copilotTool = toolsService.getTool(overlap.toolId);
		const copilotImplReady = toolsService.hasToolImplementation(overlap.toolId);
		const preferContinueSchema = COPILOT_SKIP_FOR_CONTINUE_TOOL_IDS.has(overlap.toolId)
			|| (!!copilotTool && !copilotImplReady);
		if (copilotTool && copilotImplReady && !COPILOT_SKIP_FOR_CONTINUE_TOOL_IDS.has(overlap.toolId)) {
			schemas.push(schemaFromToolData(overlap.modelName, copilotTool));
			advertisedNames.add(overlap.modelName);
			coveredToolIds.add(overlap.toolId);
			if (overlap.toolId.startsWith('copilot_')) {
				copilotOverlapHits++;
			}
			for (const fb of overlap.continueFallbackNames) {
				coveredContinueNames.add(fb);
			}
		} else {
			// Advertise Continue schema when Copilot is absent, or when we intentionally
			// skip Copilot at invoke time (e.g. findTextInFiles 20s timeout).
			if (copilotTool && preferContinueSchema) {
				coveredToolIds.add(overlap.toolId);
				if (overlap.toolId.startsWith('copilot_')) {
					copilotOverlapHits++;
				}
			}
			for (const fb of overlap.continueFallbackNames) {
				const fallback = continueByName.get(fb);
				if (!fallback) {
					continue;
				}
				coveredContinueNames.add(fb);
				if (advertisedNames.has(overlap.modelName)) {
					continue;
				}
				schemas.push(aliasContinueSchema(overlap.modelName, fallback));
				advertisedNames.add(overlap.modelName);
			}
		}
	}

	if (copilotOverlapHits === 0) {
		logService?.warn(
			'[Continue] No Copilot overlap tools registered (copilot_readFile/…). Falling back to Continue schemas. Ensure GitHub.copilot-chat is enabled (Extensions view) and not skipped; older builds disabled it on startup — restart after re-enable.',
		);
	}

	// Continue-only + any continue tools not covered by Copilot overlaps
	for (const tool of continueTools) {
		const name = tool.function.name;
		if (coveredContinueNames.has(name) || advertisedNames.has(name)) {
			continue;
		}
		if (isUnsupportedContinueAgentTool(name)) {
			continue;
		}
		const overlap = COPILOT_TOOL_OVERLAPS.find(o => o.modelName === name);
		if (overlap && toolsService.getTool(overlap.toolId)) {
			continue;
		}
		schemas.push(tool);
		advertisedNames.add(name);
	}

	// Extra Copilot-only tools
	for (const tool of toolsService.getAllToolsIncludingDisabled()) {
		if (EXCLUDED_TOOL_IDS.has(tool.id) || coveredToolIds.has(tool.id)) {
			continue;
		}
		if (!tool.modelDescription && !tool.inputSchema) {
			continue;
		}
		if (tool.displayName === '' && !tool.canBeReferencedInPrompt && !tool.inputSchema) {
			continue;
		}
		const modelName = modelNameForToolId(tool.id, tool);
		if (advertisedNames.has(modelName) || CONTINUE_ONLY_TOOL_NAMES.has(modelName)) {
			continue;
		}
		if (isUnsupportedContinueAgentTool(modelName) || isUnsupportedContinueAgentTool(tool.id)
			|| (tool.toolReferenceName && isUnsupportedContinueAgentTool(tool.toolReferenceName))) {
			continue;
		}
		if (COPILOT_TOOL_OVERLAPS.some(o => o.continueFallbackNames.includes(modelName))) {
			continue;
		}
		schemas.push(schemaFromToolData(modelName, tool));
		advertisedNames.add(modelName);
		coveredToolIds.add(tool.id);
	}

	logService?.info(
		'[Continue] Agent tool superset loaded (Copilot-preferred):',
		schemas.map(t => t.function.name).join(', '),
	);

	return mergeSchemas(schemas);
}

export type InvokeCopilotToolContext = {
	readonly sessionResource: URI;
	readonly workingDirectory?: URI;
	readonly chatRequestId?: string;
};

export type InvokeCopilotToolResult = {
	readonly ok: boolean;
	readonly text: string;
	readonly handled: boolean;
	readonly editUri?: URI;
	readonly editKind?: 'create' | 'edit';
};

export function isCopilotSearchTimeoutError(text: string): boolean {
	return /Timeout in searching text in files/i.test(text)
		|| /Timeout in searching files/i.test(text);
}

/** Soft failures where Copilot returns ok=true but no useful search result — fall back to Continue. */
export function isCopilotSearchUnavailableResult(text: string): boolean {
	return /Semantic workspace search is not currently available/i.test(text)
		|| /workspace chunk search service not available/i.test(text)
		|| /Codebase search timed out/i.test(text);
}

/** Copilot fetch often returns ok=true with an error payload in the text body. */
export function isCopilotFetchUnavailableResult(text: string): boolean {
	return /An error occurred retrieving the fetch result/i.test(text)
		|| /No valid URLs provided/i.test(text)
		|| /Invalid URL so no data was provided/i.test(text)
		|| /Tool not found/i.test(text)
		|| /does not have an implementation registered/i.test(text);
}

/**
 * Try Copilot/VS Code LM tool first. Returns handled=false to fall back to Continue
 * when the tool is missing, has bad args, or fails (e.g. findTextInFiles timeout).
 */
export async function tryInvokeCopilotTool(
	toolsService: ILanguageModelToolsService,
	logService: ILogService,
	toolName: string,
	args: Record<string, unknown>,
	context: InvokeCopilotToolContext,
	token: CancellationToken,
	commandService?: ICommandService,
): Promise<InvokeCopilotToolResult> {
	// Soft-fail Copilot-loop-only tools so the agent continues instead of stalling.
	if (isUnsupportedContinueAgentTool(toolName)) {
		logService.warn(`[Continue] Soft-failing unsupported Copilot tool: ${toolName}`);
		const recovery = unsupportedCopilotToolRecovery(toolName);
		// askQuestions is intentionally disabled (no carousel UI) — treat as soft success
		// so the UI does not paint a red "failed" row; the recovery text steers the model.
		const askOrReviewDisabled = /askQuestions|ask_questions|ask_user_question|reviewPlan|review_plan/i.test(toolName);
		return {
			ok: askOrReviewDisabled,
			text: recovery,
			handled: true,
		};
	}

	const overlap = findOverlapForModelName(toolName);
	if (overlap) {
		if (!toolsService.getTool(overlap.toolId)) {
			return { ok: false, text: '', handled: false };
		}

		// Tool *data* from package.json can exist while vscode.lm.registerTool has not run yet.
		// Never call invokeTool in that state — it paints a red failed row and throws
		// "does not have an implementation registered". Prefer Continue fallbacks until mounted.
		if (!toolsService.hasToolImplementation(overlap.toolId)) {
			await tryEnsureCopilotToolsMounted(commandService, logService);
			if (!toolsService.hasToolImplementation(overlap.toolId)) {
				if (overlap.continueFallbackNames.length === 0) {
					logService.warn(
						`[Continue] Copilot ${overlap.toolId} has no implementation and no Continue fallback — soft-fail`,
					);
					return {
						ok: false,
						text: `Tool ${overlap.toolId} is not mounted yet. Use replace_string_in_file / multi_replace_string_in_file / write_file instead.`,
						handled: true,
					};
				}
				logService.info(
					`[Continue] Copilot ${overlap.toolId} has no implementation yet — Continue fallback`,
				);
				return { ok: false, text: '', handled: false };
			}
		}

		// Skip Copilot tools that break or time out too aggressively for Continue Agent.
		if (COPILOT_SKIP_FOR_CONTINUE_TOOL_IDS.has(overlap.toolId)) {
			logService.info(
				`[Continue] Skipping Copilot ${overlap.toolId} (${copilotSkipReason(overlap.toolId)})`,
			);
			return { ok: false, text: '', handled: false };
		}

		// Terminal: reuse existing helper (parameter shape differs)
		if (overlap.toolId === TerminalToolId.RunInTerminal || toolName === 'run_terminal_command' || toolName === 'run_in_terminal') {
			const command = coerceTerminalCommandArg(args);
			const waitForCompletion = args.waitForCompletion !== false && args.mode !== 'async';
			const result = await executeRunTerminalCommand(
				toolsService,
				logService,
				context,
				command,
				waitForCompletion,
				token,
			);
			return { ...result, handled: true };
		}

		const parameters = overlap.reshape ? overlap.reshape(args, context.workingDirectory) : args;

		// Guard: Copilot prepareInvocation crashes on undefined/empty filePath.length etc.
		// Fall back *before* invokeTool so we don't paint a failed "Agent tool use" row.
		if (!copilotParamsReady(overlap.toolId, parameters)) {
			logService.warn(
				`[Continue] Copilot tool ${overlap.toolId} missing required params after reshape — Continue fallback`,
				parameters,
			);
			return { ok: false, text: '', handled: false };
		}

		// Block UTF-8→GBK mojibake payloads before they hit disk via Copilot edits.
		const mojibakeField = findMojibakeInCopilotEditParams(overlap.toolId, parameters);
		if (mojibakeField) {
			logService.warn(`[Continue] Copilot tool ${overlap.toolId} blocked mojibake in ${mojibakeField}`);
			return {
				ok: false,
				text: `Edit blocked: ${mojibakeField} contains UTF-8 Chinese mis-decoded as GBK (mojibake). Re-read the file with read_file and copy Chinese exactly.`,
				handled: true,
			};
		}

		// Without a session working directory, relative→absolute reshape is impossible and
		// Copilot resolveToolInputPath throws "Invalid input path / Be sure to use an absolute path".
		if (
			(overlap.toolId === 'copilot_readFile'
				|| overlap.toolId === 'copilot_listDirectory'
				|| overlap.toolId === 'copilot_createFile'
				|| overlap.toolId === 'copilot_replaceString'
				|| overlap.toolId === 'copilot_insertEdit')
			&& !context.workingDirectory
			&& !isLikelyAbsoluteFsPath(
				typeof parameters.filePath === 'string' ? parameters.filePath
					: typeof parameters.path === 'string' ? parameters.path
						: '',
			)
		) {
			logService.warn(
				`[Continue] Copilot tool ${overlap.toolId} skipped — no session workingDirectory for path resolve`,
			);
			return { ok: false, text: '', handled: false };
		}

		const invoked = await invokeByToolId(toolsService, logService, overlap.toolId, parameters, context, token, toolName);
		// Fall back to Continue when Copilot fails validation OR invocation — avoids leaving
		// the agent stuck after a red "Agent tool use" failure.
		// Also treat soft timeout / "semantic search unavailable" payloads (ok without
		// toolResultError) as failures so local Continue search can run.
		const softSearchFail = isCopilotSearchTimeoutError(invoked.text)
			|| isCopilotSearchUnavailableResult(invoked.text)
			|| (overlap.toolId === 'copilot_fetchWebPage' && isCopilotFetchUnavailableResult(invoked.text));
		if ((!invoked.ok || softSearchFail) && overlap.continueFallbackNames.length > 0) {
			if (!softSearchFail && !shouldFallbackEditToolToContinue(overlap.toolId, invoked)) {
				// Edit already ran in Copilot (may have applied WorkspaceEdits). Returning the
				// Copilot error lets the model fix oldString mismatches instead of re-applying
				// via Continue and failing again as "Multi Replace failed".
				return invoked;
			}
			logService.warn(
				`[Continue] Copilot tool ${overlap.toolId} failed — Continue fallback (${invoked.text.slice(0, 160)})`,
			);
			return { ok: false, text: '', handled: false };
		}
		return softSearchFail ? { ...invoked, ok: false } : invoked;
	}

	// Copilot-only: resolve by model name → tool id
	const toolId = resolveToolIdForModelName(toolsService, toolName);
	if (!toolId || EXCLUDED_TOOL_IDS.has(toolId)) {
		return { ok: false, text: '', handled: false };
	}
	if (CONTINUE_ONLY_TOOL_NAMES.has(toolName)) {
		return { ok: false, text: '', handled: false };
	}
	// Placeholder / Copilot-loop-only tools may still resolve by id even when not advertised.
	if (isUnsupportedContinueAgentTool(toolId)) {
		logService.warn(`[Continue] Soft-failing unsupported Copilot tool: ${toolId}`);
		return {
			ok: false,
			text: unsupportedCopilotToolRecovery(toolName || toolId),
			handled: true,
		};
	}

	if (!toolsService.hasToolImplementation(toolId)) {
		await tryEnsureCopilotToolsMounted(commandService, logService);
		if (!toolsService.hasToolImplementation(toolId)) {
			logService.info(`[Continue] Copilot ${toolId} has no implementation — skip`);
			return { ok: false, text: '', handled: false };
		}
	}

	return invokeByToolId(toolsService, logService, toolId, args, context, token, toolName);
}

async function tryEnsureCopilotToolsMounted(
	commandService: ICommandService | undefined,
	logService: ILogService,
): Promise<void> {
	if (!commandService) {
		return;
	}
	try {
		const result = await commandService.executeCommand<{ ok?: boolean; mounted?: number; failed?: number; error?: string }>(
			'github.copilot.chat.ensureToolsMounted',
		);
		logService.info(
			`[Continue] ensureToolsMounted (pre-invoke) → ok=${result?.ok ?? '?'} mounted=${result?.mounted ?? '?'} failed=${result?.failed ?? '?'}`,
		);
	} catch (err) {
		logService.warn('[Continue] ensureToolsMounted (pre-invoke) failed', err);
	}
}

function isLikelyAbsoluteFsPath(pathValue: string): boolean {
	const raw = pathValue.trim();
	return /^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('/') || raw.startsWith('\\\\') || raw.startsWith('file:');
}

/** Detect UTF-8 Chinese mis-decoded as GBK (e.g. 曲线 → 鏉茬藁). */
function looksLikeUtf8AsGbkMojibake(text: string): boolean {
	if (!text) {
		return false;
	}
	if (text.includes('锟斤拷')) {
		return true;
	}
	if (/鏉茬藁|閿俐鍑|绮剧確|鍙鉑|鏉鍐瑛|父塔鐚/.test(text)) {
		return true;
	}
	const rareRuns = text.match(/[\u9200-\u95FF]{3,}/g);
	return !!(rareRuns && rareRuns.join('').length >= 6 && /[鏉閿鑸绮鍙鍔鿿]/.test(text));
}

function findMojibakeInCopilotEditParams(toolId: string, parameters: Record<string, unknown>): string | undefined {
	const isEdit = toolId === 'copilot_replaceString'
		|| toolId === 'copilot_multiReplaceString'
		|| toolId === 'copilot_insertEdit'
		|| toolId === 'copilot_createFile'
		|| toolId === 'copilot_applyPatch';
	if (!isEdit) {
		return undefined;
	}
	const check = (label: string, value: unknown): string | undefined => {
		if (typeof value === 'string' && looksLikeUtf8AsGbkMojibake(value)) {
			return label;
		}
		return undefined;
	};
	const hit = check('newString', parameters.newString)
		?? check('content', parameters.content)
		?? check('contents', parameters.contents);
	if (hit) {
		return hit;
	}
	const replacements = parameters.replacements;
	if (Array.isArray(replacements)) {
		for (let i = 0; i < replacements.length; i++) {
			const row = replacements[i];
			if (!row || typeof row !== 'object') {
				continue;
			}
			const field = check(`replacements[${i}].newString`, (row as Record<string, unknown>).newString);
			if (field) {
				return field;
			}
		}
	}
	return undefined;
}

function resolveToolIdForModelName(
	toolsService: ILanguageModelToolsService,
	modelName: string,
): string | undefined {
	for (const [id, name] of Object.entries(COPILOT_ONLY_MODEL_NAMES)) {
		if (name === modelName && toolsService.getTool(id)) {
			return id;
		}
	}
	const byId = toolsService.getTool(modelName);
	if (byId) {
		return byId.id;
	}
	const byRef = toolsService.getToolByName(modelName)
		?? toolsService.getToolByName(modelName.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()));
	return byRef?.id;
}

/** Required fields Copilot tools assume are non-empty strings (avoid prepareInvocation crashes). */
function copilotParamsReady(toolId: string, parameters: Record<string, unknown>): boolean {
	switch (toolId) {
		case 'copilot_readFile':
		case 'copilot_createFile':
		case 'copilot_replaceString':
		case 'copilot_insertEdit':
			return typeof parameters.filePath === 'string' && parameters.filePath.trim().length > 0;
		case 'copilot_multiReplaceString': {
			const replacements = parameters.replacements;
			if (!Array.isArray(replacements) || replacements.length === 0) {
				return false;
			}
			return replacements.every((e) => {
				if (!e || typeof e !== 'object') {
					return false;
				}
				const row = e as Record<string, unknown>;
				return typeof row.filePath === 'string' && row.filePath.trim().length > 0
					&& typeof row.oldString === 'string'
					&& typeof row.newString === 'string';
			});
		}
		case 'copilot_findTextInFiles':
		case 'copilot_findFiles':
		case 'copilot_searchCodebase':
			return typeof parameters.query === 'string' && parameters.query.trim().length > 0;
		case 'copilot_listDirectory':
			return typeof parameters.path === 'string' && parameters.path.trim().length > 0;
		case 'copilot_fetchWebPage':
			return Array.isArray(parameters.urls) && parameters.urls.length > 0;
		default:
			return true;
	}
}

/**
 * After Copilot edit tools run, do not blindly fall back to Continue on hasError —
 * WorkspaceEdits may already be applied, and Continue would fail on changed content.
 * Only fall back for infrastructure / missing-input failures.
 * Exception: create_file — Continue's create_new_file/_writeFile is safe and should always
 * be tried when Copilot create fails (no partial edit risk on a brand-new path).
 */
function shouldFallbackEditToolToContinue(toolId: string, invoked: InvokeCopilotToolResult): boolean {
	if (toolId === 'copilot_createFile') {
		return true;
	}
	const isEdit = toolId === 'copilot_replaceString'
		|| toolId === 'copilot_multiReplaceString'
		|| toolId === 'copilot_applyPatch'
		|| toolId === 'copilot_insertEdit'
		|| /replace|create|insert|patch|edit|write/i.test(toolId);
	if (!isEdit) {
		return true;
	}
	const text = (invoked.text || '').trim();
	if (!text || /^(ok|\(ok\))$/i.test(text)) {
		return true;
	}
	// Generic empty failure label from invokeByToolId when no payload was returned
	if (/^(Replace String|Multi Replace|Create File|Apply Patch|Insert Edit|multi_replace_string_in_file|replace_string_in_file) failed$/i.test(text)) {
		return true;
	}
	return /no prompt context|Invalid stream|Invalid (file )?path|Invalid input|Failed to apply|was not contributed|does not have an implementation|Missing patch text|toolInvocationToken is required|editing session|Chat (session|request) not found/i
		.test(text);
}

async function invokeByToolId(
	toolsService: ILanguageModelToolsService,
	logService: ILogService,
	toolId: string,
	parameters: Record<string, unknown>,
	context: InvokeCopilotToolContext,
	token: CancellationToken,
	displayName: string,
): Promise<InvokeCopilotToolResult> {
	const countTokens: CountTokensCallback = async () => 0;
	try {
		const result = await toolsService.invokeTool({
			callId: generateUuid(),
			toolId,
			chatRequestId: context.chatRequestId,
			parameters,
			context: {
				sessionResource: context.sessionResource,
				workingDirectory: context.workingDirectory,
			},
		}, countTokens, token);

		const text = formatToolResult(result);
		const ok = !result.toolResultError;
		if (!text && ok) {
			logService.warn('[Continue] Copilot tool returned empty text payload', toolId, {
				contentKinds: (result.content ?? []).map(p => p.kind),
				hasMessage: !!result.toolResultMessage,
				hasDetails: !!result.toolResultDetails,
			});
		}
		const editUri = isWriteToolInvocation(toolId, displayName)
			? extractEditUri(result, parameters)
			: undefined;
		return {
			ok,
			text: text || (ok ? '(ok)' : `${displayName} failed`),
			handled: true,
			editUri,
			editKind: editUri
				? (toolId.includes('create') || displayName === 'create_file' ? 'create' : 'edit')
				: undefined,
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		logService.warn('[Continue] Copilot tool invoke failed', toolId, message);
		// ok:false so tryInvokeCopilotTool can fall back to Continue for overlaps.
		// handled:true here is overridden to handled:false by the overlap fallback check.
		return {
			ok: false,
			text: message,
			handled: true,
		};
	}
}

function extractEditUri(result: IToolResult, parameters: Record<string, unknown>): URI | undefined {
	const pathCandidate = typeof parameters.filePath === 'string' ? parameters.filePath
		: typeof parameters.path === 'string' ? parameters.path
			: undefined;
	if (pathCandidate) {
		try {
			return pathCandidate.startsWith('file:') ? URI.parse(pathCandidate) : URI.file(pathCandidate);
		} catch {
			return undefined;
		}
	}
	void result;
	return undefined;
}

function isWriteToolInvocation(toolId: string, displayName: string): boolean {
	return /create|replace|insert|patch|edit|write/i.test(toolId)
		|| /^(create_file|replace_string_in_file|multi_replace_string_in_file|insert_edit_into_file|apply_patch|write_file)$/i.test(displayName);
}

function markdownToPlain(message: string | IMarkdownString | undefined): string | undefined {
	if (!message) {
		return undefined;
	}
	if (typeof message === 'string') {
		const trimmed = message.trim();
		return trimmed || undefined;
	}
	if (typeof message === 'object' && typeof message.value === 'string') {
		const trimmed = message.value.trim();
		return trimmed || undefined;
	}
	return undefined;
}

export function formatToolResult(result: IToolResult): string {
	const parts: string[] = [];

	const message = markdownToPlain(result.toolResultMessage);
	if (message) {
		parts.push(message);
	}

	for (const part of result.content ?? []) {
		if (part.kind === 'text') {
			const value = (part as IToolResultTextPart).value;
			if (typeof value === 'string' && value.trim()) {
				parts.push(value);
			}
		} else if (part.kind === 'promptTsx') {
			try {
				const value = stringifyPromptTsxPart(part as IToolResultPromptTsxPart);
				if (value.trim()) {
					parts.push(value);
				}
			} catch {
				// Copilot prompt-tsx payloads occasionally fail to stringify; keep going.
			}
		}
	}

	if (isToolResultInputOutputDetails(result.toolResultDetails)) {
		for (const out of result.toolResultDetails.output) {
			if (out.type === 'embed' && typeof out.value === 'string' && out.value.trim() && out.isText !== false) {
				parts.push(out.value);
			} else if (out.type === 'ref' && out.uri) {
				parts.push(String(out.uri));
			}
		}
	}

	if (typeof result.toolResultError === 'string' && result.toolResultError.trim()) {
		parts.push(result.toolResultError.trim());
	}

	const seen = new Set<string>();
	const unique = parts.filter(part => {
		const key = part.trim();
		if (!key || seen.has(key)) {
			return false;
		}
		seen.add(key);
		return true;
	});
	return unique.join('\n\n').trim();
}

/** Load Continue rules text for Agents window system prompt. */
export async function loadContinueAgentRules(
	commandService: ICommandService,
	userMessage: string,
	logService?: ILogService,
): Promise<string | undefined> {
	try {
		const result = await commandService.executeCommand<{ text?: string }>(
			CONTINUE_GET_AGENT_CHAT_RULES,
			{ userMessage },
		);
		const text = result?.text?.trim();
		return text || undefined;
	} catch (e) {
		logService?.warn('[Continue] continue.getAgentChatRules failed', e);
		return undefined;
	}
}
