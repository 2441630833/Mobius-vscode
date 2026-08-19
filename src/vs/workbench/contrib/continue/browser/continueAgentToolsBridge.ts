/*---------------------------------------------------------------------------------------------
 *  Mobius — bridge VS Code Chat Agent tool calls to Continue core (extension host)
 *--------------------------------------------------------------------------------------------*/

import { timeout } from '../../../../base/common/async.js';
import { URI } from '../../../../base/common/uri.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { GODOT_TOOL_SCHEMAS } from './continueGodotTools.js';

export const CONTINUE_GET_AGENT_CHAT_TOOLS = 'continue.getAgentChatTools';
export const CONTINUE_CALL_BUILTIN_TOOL = 'continue.callBuiltInTool';
export const CONTINUE_APPLY_CLIENT_EDIT_TOOL = 'continue.applyClientEditTool';

export type ContinueAgentToolSchema = {
	readonly type: 'function';
	readonly function: {
		readonly name: string;
		readonly description?: string;
		readonly parameters?: Record<string, unknown>;
	};
};

type ContinueToolCallResult = {
	readonly ok: boolean;
	readonly text: string;
	readonly errorMessage?: string;
	readonly fileUri?: string;
	readonly fileEditKind?: 'create' | 'edit';
	readonly usedFallback?: boolean;
	readonly suggestFallback?: boolean;
};

type RawContextItem = {
	readonly name?: string;
	readonly description?: string;
	readonly content?: string;
	readonly uri?: { readonly type?: string; readonly value?: string };
};

type RawToolInvokeResult = {
	readonly ok?: boolean;
	readonly contextItems?: RawContextItem[];
	readonly errorMessage?: string;
};

/** Always merged — does not depend on extension command or config load. */
const CORE_SEARCH_TOOL_SCHEMAS: readonly ContinueAgentToolSchema[] = [
	{
		type: 'function',
		function: {
			name: 'search_web',
			description:
				'Search the web for external, up-to-date facts (products, models, releases). Call ONCE per question — do not repeat with rephrased queries. Returns short snippets; synthesize an answer after one search (optionally one fetch_webpage).',
			parameters: {
				type: 'object',
				required: ['query'],
				properties: {
					query: {
						type: 'string',
						description: 'The natural language search query',
					},
				},
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'grep_search',
			description:
				'Search file contents with ripgrep. Prefer a short literal symbol or path fragment. Avoid broad regex with many | alternatives over the whole repo — that is slow. If results are empty, narrow with a more specific string or use file_search / list_dir.',
			parameters: {
				type: 'object',
				required: ['query'],
				properties: {
					query: {
						type: 'string',
						description:
							'Literal string or simple regex to find in file contents. Prefer exact symbols (e.g. world-physical-model/splash) over alternation groups.',
					},
				},
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'fetch_url_content',
			description:
				'Can be used to view the contents of a website using a URL. Do NOT use this for files.',
			parameters: {
				type: 'object',
				required: ['url'],
				properties: {
					url: { type: 'string', description: 'The URL to read' },
				},
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'fetch_webpage',
			description:
				'Fetch the main content of a webpage by URL (Continue HTTP fetch). Prefer a single official docs URL after search_web.',
			parameters: {
				type: 'object',
				required: ['url'],
				properties: {
					url: { type: 'string', description: 'The URL to read' },
					urls: {
						type: 'array',
						items: { type: 'string' },
						description: 'Optional Copilot-compatible alias; first URL is used.',
					},
				},
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'codebase',
			description:
				'Use this tool to semantically search through the codebase and retrieve relevant code snippets based on a natural language query. This helps find relevant code context for understanding or working with the codebase.',
			parameters: {
				type: 'object',
				required: ['query'],
				properties: {
					query: {
						type: 'string',
						description:
							'Natural language description of what you\'re looking for in the codebase (e.g., \'authentication logic\', \'database connection setup\', \'error handling\')',
					},
				},
			},
		},
	},
];

const LOCAL_AGENT_TOOL_SCHEMAS: readonly ContinueAgentToolSchema[] = [
	{
		type: 'function',
		function: {
			name: 'read_file',
			description:
				'Read a file from the workspace. Prefer relative paths from the workspace root (e.g. src/index.html). Returns file contents.',
			parameters: {
				type: 'object',
				properties: {
					filepath: {
						type: 'string',
						description: 'File path relative to workspace root, or an absolute path.',
					},
					filePath: {
						type: 'string',
						description: 'Alias for filepath (Copilot-compatible).',
					},
					path: {
						type: 'string',
						description: 'Alias for filepath.',
					},
				},
				required: ['filepath'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'write_file',
			description:
				'Create or overwrite a file with full contents. Prefer path+contents; filePath/content aliases are also accepted. path is relative to the session working directory unless absolute.',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'File path relative to workspace root (preferred)' },
					filepath: { type: 'string', description: 'Alias for path' },
					filePath: { type: 'string', description: 'Alias for path' },
					contents: { type: 'string', description: 'Full file contents (preferred)' },
					content: { type: 'string', description: 'Alias for contents' },
				},
				required: ['path', 'contents'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'create_new_file',
			description:
				'Create a new file. Only use this when a file does not exist. filepath may be workspace-relative or an absolute path (e.g. D:\\\\folder\\\\file.py).',
			parameters: {
				type: 'object',
				properties: {
					filepath: {
						type: 'string',
						description:
							'Path for the new file. Relative to workspace root, or absolute (Windows drive paths supported).',
					},
					contents: { type: 'string', description: 'Full file contents' },
				},
				required: ['filepath', 'contents'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'run_terminal_command',
			description: 'Run a terminal command in the IDE shell and return stdout/stderr.',
			parameters: {
				type: 'object',
				properties: {
					command: { type: 'string', description: 'Shell command to execute.' },
					waitForCompletion: { type: 'boolean', description: 'Wait for completion. Default true.' },
				},
				required: ['command'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'single_find_and_replace',
			description: 'Replace one exact string in an existing file. Prefer over write_file for small edits.',
			parameters: {
				type: 'object',
				properties: {
					filepath: { type: 'string', description: 'File path relative to workspace root' },
					old_string: { type: 'string', description: 'Exact text to replace (must be unique unless replace_all is true)' },
					new_string: { type: 'string', description: 'Replacement text' },
					replace_all: { type: 'boolean', description: 'Replace all occurrences. Default false.' },
					fallback_contents: { type: 'string', description: 'Optional full file contents if patch fails' },
				},
				required: ['filepath', 'old_string', 'new_string'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'multi_edit',
			description: 'Apply multiple find-and-replace edits to one file in sequence.',
			parameters: {
				type: 'object',
				properties: {
					filepath: { type: 'string', description: 'File path relative to workspace root' },
					edits: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								old_string: { type: 'string' },
								new_string: { type: 'string' },
								replace_all: { type: 'boolean' },
							},
							required: ['old_string', 'new_string'],
						},
					},
					fallback_contents: { type: 'string', description: 'Optional full file contents if patch fails' },
				},
				required: ['filepath', 'edits'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'edit_existing_file',
			description: 'Edit an existing file by providing only changed sections (use // ... existing code ... for unchanged regions).',
			parameters: {
				type: 'object',
				properties: {
					filepath: { type: 'string', description: 'File path relative to workspace root' },
					changes: { type: 'string', description: 'Changed code sections with optional existing-code placeholders' },
					fallback_contents: { type: 'string', description: 'Optional full file contents if patch fails' },
				},
				required: ['filepath', 'changes'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'get_problems',
			description:
				'Read IDE compile/type/lint Error markers (Problems panel). Call after edits and before TASK_COMPLETE. If errors are returned, fix them with edit tools — do not finish while Errors remain.',
			parameters: {
				type: 'object',
				properties: {
					filepath: {
						type: 'string',
						description:
							'Optional file path to check. Omit to scan edited files / workspace Errors.',
					},
				},
			},
		},
	},
];

const TOOL_DISPLAY_NAMES: Record<string, string> = {
	search_web: 'Search Web',
	grep_search: 'Grep Search',
	fetch_url_content: 'Read URL',
	fetch_webpage: 'Fetch Webpage',
	codebase: 'Codebase Search',
	semantic_search: 'Semantic Search',
	write_file: 'Write File',
	run_terminal_command: 'Run Terminal Command',
	run_in_terminal: 'Run in Terminal',
	edit_existing_file: 'Edit File',
	single_find_and_replace: 'Find and Replace',
	multi_edit: 'Multi Edit',
	replace_string_in_file: 'Replace String',
	multi_replace_string_in_file: 'Multi Replace',
	insert_edit_into_file: 'Insert Edit',
	apply_patch: 'Apply Patch',
	read_file: 'Read File',
	ls: 'List Directory',
	list_dir: 'List Directory',
	file_search: 'File Search',
	create_new_file: 'Create File',
	create_file: 'Create File',
	get_problems: 'Get Problems',
	get_errors: 'Get Errors',
};

export function formatAgentToolDisplayName(toolName: string): string {
	return TOOL_DISPLAY_NAMES[toolName] ?? toolName;
}

function mergeToolSchemas(
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

function formatContextItems(items: RawContextItem[]): string {
	if (!items.length) {
		return '(no output)';
	}
	return items
		.map((item) => {
			const label = [item.name, item.description].filter(Boolean).join(' — ');
			const body = item.content ?? '';
			return label ? `## ${label}\n${body}` : body;
		})
		.join('\n\n');
}

function extractFileUri(items: RawContextItem[]): { uri?: string; kind?: 'create' | 'edit' } {
	for (const item of items) {
		if (item.uri?.type === 'file' && item.uri.value) {
			const kind = item.content?.toLowerCase().includes('created') ? 'create' : 'edit';
			return { uri: item.uri.value, kind };
		}
	}
	return {};
}

export async function loadContinueAgentTools(
	commandService: ICommandService,
	logService?: ILogService,
): Promise<readonly ContinueAgentToolSchema[]> {
	let extensionTools: ContinueAgentToolSchema[] | undefined;

	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const tools = await commandService.executeCommand<ContinueAgentToolSchema[]>(
				CONTINUE_GET_AGENT_CHAT_TOOLS,
			);
			if (Array.isArray(tools) && tools.length > 0) {
				extensionTools = tools;
				break;
			}
		} catch (e) {
			logService?.warn(
				'[Continue] continue.getAgentChatTools failed',
				attempt + 1,
				e,
			);
		}
		if (attempt < 2) {
			await timeout(400);
		}
	}

	const merged = mergeToolSchemas(
		CORE_SEARCH_TOOL_SCHEMAS,
		LOCAL_AGENT_TOOL_SCHEMAS,
		GODOT_TOOL_SCHEMAS,
		extensionTools ?? [],
	);

	if (!extensionTools?.length) {
		logService?.warn(
			'[Continue] Using workbench-embedded agent tools (extension bridge unavailable). Rebuild Continue extension for full tool parity.',
		);
	}

	logService?.trace(
		'[Continue] Agent tools loaded:',
		merged.map(t => t.function.name).join(', '),
	);

	return merged;
}

export async function invokeContinueBuiltInTool(
	commandService: ICommandService,
	toolName: string,
	args: Record<string, unknown>,
	toolCallId: string,
	/** Session working directory — scopes ls/grep/codebase/read to this folder. */
	workingDirectory?: URI,
): Promise<ContinueToolCallResult> {
	try {
		const result = await commandService.executeCommand<RawToolInvokeResult>(
			CONTINUE_CALL_BUILTIN_TOOL,
			{
				name: toolName,
				arguments: args,
				toolCallId,
				workingDirectory: workingDirectory?.toString(),
			},
		);
		if (!result) {
			return { ok: false, text: 'Continue tool bridge returned no result' };
		}
		const items = result.contextItems ?? [];
		const { uri, kind } = extractFileUri(items);
		return {
			ok: result.ok !== false && !result.errorMessage,
			text: result.errorMessage ?? formatContextItems(items),
			errorMessage: result.errorMessage,
			fileUri: uri,
			fileEditKind: kind,
		};
	} catch (e) {
		return {
			ok: false,
			text: e instanceof Error ? e.message : String(e),
		};
	}
}

type RawClientEditResult = {
	readonly ok?: boolean;
	readonly text?: string;
	readonly errorMessage?: string;
	readonly fileUri?: string;
	readonly fileEditKind?: 'create' | 'edit';
	readonly usedFallback?: boolean;
	readonly suggestFallback?: boolean;
};

export async function invokeContinueClientEditTool(
	commandService: ICommandService,
	toolName: string,
	args: Record<string, unknown>,
	toolCallId: string,
	/** Session working directory — scopes relative edit paths to this folder. */
	workingDirectory?: URI,
): Promise<ContinueToolCallResult> {
	try {
		const result = await commandService.executeCommand<RawClientEditResult>(
			CONTINUE_APPLY_CLIENT_EDIT_TOOL,
			{
				name: toolName,
				arguments: args,
				toolCallId,
				workingDirectory: workingDirectory?.toString(),
			},
		);
		if (!result) {
			return { ok: false, text: 'Continue client edit bridge returned no result' };
		}
		return {
			ok: result.ok !== false && !result.errorMessage,
			text: result.text ?? result.errorMessage ?? '(no output)',
			errorMessage: result.errorMessage,
			fileUri: result.fileUri,
			fileEditKind: result.fileEditKind,
			usedFallback: result.usedFallback,
			suggestFallback: result.suggestFallback,
		};
	} catch (e) {
		return {
			ok: false,
			text: e instanceof Error ? e.message : String(e),
			suggestFallback: true,
		};
	}
}
