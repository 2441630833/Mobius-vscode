/*---------------------------------------------------------------------------------------------
 *  Mobius — Agents-window Godot tools (same CLI as scripts/godot-mcp-server.js)
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { URI } from '../../../../base/common/uri.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ILanguageModelToolsService } from '../../chat/common/tools/languageModelToolsService.js';
import type { ContinueAgentToolSchema } from './continueAgentToolsBridge.js';
import { executeRunTerminalCommand, TerminalCommandContext } from './continueTerminalTool.js';

const GODOT_TOOL_NAMES = new Set([
	'godot_detect',
	'godot_project_init',
	'godot_import',
	'godot_run',
	'godot_test',
	'godot_preview',
	'godot_play',
]);

export function isGodotTool(name: string): boolean {
	return GODOT_TOOL_NAMES.has(name);
}

export const GODOT_TOOL_SCHEMAS: readonly ContinueAgentToolSchema[] = [
	{
		type: 'function',
		function: {
			name: 'godot_detect',
			description:
				'Locate the bundled Godot executable, report its version, and show the game-dev project directory.',
			parameters: { type: 'object', properties: {} },
		},
	},
	{
		type: 'function',
		function: {
			name: 'godot_project_init',
			description:
				'Scaffold a Godot 4 project under game-dev/ (project.godot, main scene, headless tests). No-op if it already exists.',
			parameters: {
				type: 'object',
				properties: {
					name: {
						type: 'string',
						description: 'Project folder relative to the workspace (default: game-dev).',
					},
				},
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'godot_import',
			description:
				'Run the Godot editor headless to import/re-import assets after writing .gd/.tscn files under game-dev/.',
			parameters: {
				type: 'object',
				properties: {
					project: {
						type: 'string',
						description: 'Project folder name (default: game-dev).',
					},
				},
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'godot_run',
			description:
				'Run the Godot project headless for N frames and return stdout/stderr plus a scan for engine errors. This is a smoke test, not a playable window.',
			parameters: {
				type: 'object',
				properties: {
					project: { type: 'string', description: 'Project folder name (default: game-dev).' },
					scene: { type: 'string', description: 'Optional scene to run (e.g. res://main.tscn).' },
					frames: { type: 'number', description: 'Frames to run before quitting (default: 120).' },
				},
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'godot_test',
			description:
				'Run game-dev/tests/test_runner.gd headlessly and report passed/failed counts.',
			parameters: {
				type: 'object',
				properties: {
					project: { type: 'string', description: 'Project folder name (default: game-dev).' },
				},
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'godot_preview',
			description:
				'Open a visible Godot window (detached, non-blocking). Use editor=true for the Godot editor UI; default runs the game scene.',
			parameters: {
				type: 'object',
				properties: {
					project: { type: 'string', description: 'Project folder name (default: game-dev).' },
					editor: {
						type: 'boolean',
						description: 'Open the editor (true) instead of running the game (default false).',
					},
					autoplay: {
						type: 'boolean',
						description: 'When running the game, enable autopilot (default false).',
					},
					scene: { type: 'string', description: 'Optional scene path to run, e.g. res://main.tscn.' },
				},
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'godot_play',
			description:
				'Run the mini-game in a visible Godot window (not the editor). Default: arrow keys, no autopilot. Use visible=false for headless autopilot YOU WIN verification.',
			parameters: {
				type: 'object',
				properties: {
					project: { type: 'string', description: 'Project folder name (default: game-dev).' },
					scene: { type: 'string', description: 'Optional scene path, e.g. res://main.tscn.' },
					autoplay: { type: 'boolean', description: 'Visible: autopilot only when true. Headless: autopilot unless false.' },
					visible: {
						type: 'boolean',
						description: 'Open a game window (default true). false = headless YOU WIN check.',
					},
					frames: { type: 'number', description: 'Headless only: frames before quit (default 2400).' },
				},
			},
		},
	},
];

const GAME_EXECUTE_HINT = `GAME DEV LOOP (Agents Game mode) — LIVE PREVIEW while you edit:
1. godot_detect — if missing, run_terminal_command: npm run godot:setup -- -Install
2. Write .gd/.tscn under game-dev/ (or godot_project_init if game-dev/ is empty)
3. Mobius keeps the Godot **editor** open during Game-mode work. Each save hot-reloads scripts/scenes so the user can watch while you edit. The user may Stop the agent anytime and ask for changes — do not wait until the end to open Godot.
4. godot_import after batches of scene/asset changes (headless re-import; editor stays open and picks up changes)
5. godot_test → fix until 0 failures
6. godot_run — headless smoke; fix engine errors
7. godot_play — visible game window, **arrow keys** (autoplay only when you pass autoplay=true). Use visible=false + autopilot for headless YOU WIN verification.

Mobius auto-opens the Godot editor + a playable game window (no autopilot) during Game-mode work. At turn end it relaunches godot_play if you skipped it.

godot_run is headless only. Visible godot_play is for manual play. godot_preview editor=true opens the editor UI.`;

export function hasGameDevIntent(message: string): boolean {
	return /game[\s-]?dev|godot|\bmini[\s-]?game\b|小游戏|做个游戏|game mode|star catcher/i.test(message);
}

export function isGameModeName(name: string | undefined): boolean {
	return typeof name === 'string' && /^game$/i.test(name.trim());
}

export function gameDevSystemHint(): string {
	return GAME_EXECUTE_HINT;
}

function quotePs(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

function buildGodotCli(scriptPath: string, name: string, args: Record<string, unknown>): string {
	const parts = [`node ${quotePs(scriptPath)}`];
	switch (name) {
		case 'godot_detect':
			parts.push('--detect');
			break;
		case 'godot_project_init':
			parts.push('--init');
			if (typeof args.name === 'string' && args.name.trim()) {
				parts.push('--name', quotePs(args.name.trim()));
			}
			break;
		case 'godot_import':
			parts.push('--import');
			break;
		case 'godot_run':
			parts.push('--run');
			if (typeof args.frames === 'number' && args.frames > 0) {
				parts.push('--frames', String(Math.floor(args.frames)));
			}
			if (typeof args.scene === 'string' && args.scene.trim()) {
				parts.push('--scene', quotePs(args.scene.trim()));
			}
			if (args.autoplay === true) {
				parts.push('--autoplay');
			}
			break;
		case 'godot_test':
			parts.push('--test');
			break;
		case 'godot_preview':
			parts.push('--preview');
			if (args.editor === true) {
				parts.push('--editor');
			}
			if (args.autoplay === true) {
				parts.push('--autoplay');
			}
			if (typeof args.scene === 'string' && args.scene.trim()) {
				parts.push('--scene', quotePs(args.scene.trim()));
			}
			break;
		case 'godot_play':
			parts.push('--play');
			if (args.visible === false) {
				parts.push('--headless-play');
			}
			if (args.autoplay === true) {
				parts.push('--autoplay');
			}
			if (typeof args.frames === 'number' && args.frames > 0) {
				parts.push('--frames', String(Math.floor(args.frames)));
			}
			if (typeof args.scene === 'string' && args.scene.trim()) {
				parts.push('--scene', quotePs(args.scene.trim()));
			}
			break;
		default:
			parts.push('--detect');
	}
	const project = typeof args.project === 'string' ? args.project.trim()
		: (typeof args.name === 'string' && name !== 'godot_project_init' ? args.name.trim() : '');
	if (project && name !== 'godot_project_init') {
		parts.push('--project', quotePs(project));
	}
	return parts.join(' ');
}

export function isGameDevProjectUri(uri: string): boolean {
	return /[/\\]game-dev[/\\]/i.test(uri);
}

export interface GodotAutoPreviewState {
	editorLaunched: boolean;
	playLaunched: boolean;
	toolsUsed: boolean;
	gameFilesEdited: boolean;
}

export function createGodotAutoPreviewState(): GodotAutoPreviewState {
	return {
		editorLaunched: false,
		playLaunched: false,
		toolsUsed: false,
		gameFilesEdited: false,
	};
}

export function trackGodotToolCall(
	state: GodotAutoPreviewState,
	toolName: string,
	params?: Record<string, unknown>,
): void {
	if (!isGodotTool(toolName)) {
		return;
	}
	state.toolsUsed = true;
	if (toolName === 'godot_preview' && params?.editor === true) {
		state.editorLaunched = true;
	}
	if (toolName === 'godot_play') {
		state.playLaunched = true;
	}
	if (toolName === 'godot_preview' && params?.editor !== true) {
		state.playLaunched = true;
	}
}

async function runGodotToolCommand(
	toolsService: ILanguageModelToolsService,
	logService: ILogService,
	workspaceService: IWorkspaceContextService,
	context: TerminalCommandContext,
	toolName: string,
	args: Record<string, unknown>,
	token: CancellationToken,
): Promise<{ ok: boolean; text: string }> {
	const folder = workspaceService.getWorkspace().folders[0]?.uri
		?? context.workingDirectory;
	if (!folder) {
		return { ok: false, text: 'No workspace folder is open — cannot locate scripts/godot-mcp-server.js' };
	}
	const script = URI.joinPath(folder, 'scripts', 'godot-mcp-server.js');
	const command = buildGodotCli(script.fsPath, toolName, args);
	logService.info(`[Continue][Godot] ${toolName} → ${command}`);
	return executeRunTerminalCommand(
		toolsService,
		logService,
		context,
		command,
		true,
		token,
	);
}

/** Open the Godot editor once per agent turn — stays open while the agent keeps editing (hot reload). */
export async function openGodotLiveEditorIfNeeded(
	toolsService: ILanguageModelToolsService,
	logService: ILogService,
	workspaceService: IWorkspaceContextService,
	context: TerminalCommandContext,
	state: GodotAutoPreviewState,
	token: CancellationToken,
): Promise<{ opened: boolean; text: string }> {
	if (state.editorLaunched || token.isCancellationRequested) {
		return { opened: false, text: '' };
	}
	const editor = await runGodotToolCommand(
		toolsService,
		logService,
		workspaceService,
		context,
		'godot_preview',
		{ editor: true },
		token,
	);
	if (editor.ok) {
		state.editorLaunched = true;
	}
	return { opened: editor.ok, text: editor.text };
}

/** Open a visible game window (no autopilot) so the user can play while the agent edits. */
export async function openGodotLiveGameIfNeeded(
	toolsService: ILanguageModelToolsService,
	logService: ILogService,
	workspaceService: IWorkspaceContextService,
	context: TerminalCommandContext,
	state: GodotAutoPreviewState,
	token: CancellationToken,
): Promise<{ opened: boolean; text: string }> {
	if (state.playLaunched || token.isCancellationRequested) {
		return { opened: false, text: '' };
	}
	const play = await runGodotToolCommand(
		toolsService,
		logService,
		workspaceService,
		context,
		'godot_play',
		{ autoplay: false },
		token,
	);
	if (play.ok) {
		state.playLaunched = true;
	}
	return { opened: play.ok, text: play.text };
}

/** Launch Godot editor + playable window when the agent forgot — user should never open Godot manually. */
export async function ensureGodotPreviewLaunched(
	toolsService: ILanguageModelToolsService,
	logService: ILogService,
	workspaceService: IWorkspaceContextService,
	context: TerminalCommandContext,
	state: GodotAutoPreviewState,
	token: CancellationToken,
): Promise<{ launched: boolean; text: string }> {
	if (!state.toolsUsed && !state.gameFilesEdited) {
		return { launched: false, text: '' };
	}
	if (state.editorLaunched && state.playLaunched) {
		return { launched: false, text: '' };
	}

	const chunks: string[] = [];
	let launched = false;

	if (!state.editorLaunched) {
		const editor = await runGodotToolCommand(
			toolsService,
			logService,
			workspaceService,
			context,
			'godot_preview',
			{ editor: true },
			token,
		);
		if (editor.ok) {
			state.editorLaunched = true;
			launched = true;
		}
		chunks.push(`**Godot editor (auto):** ${editor.ok ? 'opened' : 'failed'}\n${editor.text}`);
	}

	if (!state.playLaunched) {
		const play = await runGodotToolCommand(
			toolsService,
			logService,
			workspaceService,
			context,
			'godot_play',
			{ autoplay: false },
			token,
		);
		if (play.ok) {
			state.playLaunched = true;
			launched = true;
		}
		chunks.push(`**Game preview (auto):** ${play.ok ? 'launched (arrow keys — no autopilot)' : 'failed'}\n${play.text}`);
	}

	return { launched, text: chunks.join('\n\n') };
}

export async function executeGodotTool(
	toolsService: ILanguageModelToolsService,
	logService: ILogService,
	workspaceService: IWorkspaceContextService,
	context: TerminalCommandContext,
	toolName: string,
	args: Record<string, unknown>,
	token: CancellationToken,
	state?: GodotAutoPreviewState,
): Promise<{ ok: boolean; text: string }> {
	const result = await runGodotToolCommand(
		toolsService,
		logService,
		workspaceService,
		context,
		toolName,
		args,
		token,
	);

	if (toolName === 'godot_preview' && args.editor === true && result.ok && state) {
		state.editorLaunched = true;
	}

	if (!state || !result.ok || token.isCancellationRequested) {
		return result;
	}

	const shouldOpenLiveEditor = toolName === 'godot_import'
		|| toolName === 'godot_project_init'
		|| toolName === 'godot_test';
	if (shouldOpenLiveEditor) {
		const live = await openGodotLiveEditorIfNeeded(
			toolsService,
			logService,
			workspaceService,
			context,
			state,
			token,
		);
		if (live.opened) {
			result.text += `\n\n---\n[Mobius] Live preview: Godot editor is open — saves under game-dev/ hot-reload while the agent keeps working. Press Stop in chat anytime to redirect edits.\n${live.text}`;
		}
		const game = await openGodotLiveGameIfNeeded(
			toolsService,
			logService,
			workspaceService,
			context,
			state,
			token,
		);
		if (game.opened) {
			result.text += `\n\n---\n[Mobius] Game window is running — use arrow keys to play (no autopilot). Score starts at 0.\n${game.text}`;
		}
	}

	return result;
}
