/*---------------------------------------------------------------------------------------------
 *  Mobius — Agents-window Godot tools (same CLI as scripts/godot-mcp-server.js)
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ILanguageModelToolsService } from '../../chat/common/tools/languageModelToolsService.js';
import type { ContinueAgentToolSchema } from './continueAgentToolsBridge.js';
import { executeRunTerminalCommand, TerminalCommandContext } from './continueTerminalTool.js';

export interface GodotToolHost {
	readonly fileService: IFileService;
	readonly workspaceService: IWorkspaceContextService;
	readonly appRoot?: string;
}

interface GodotResolvedPaths {
	readonly mobiusRoot: URI;
	readonly godotProject: URI;
	readonly script: URI;
}

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

const GAME_EXECUTE_HINT = `GAME DEV (Game mode — user never names this; Game mode selection triggers it automatically):
1. MANDATORY: All 2D and 3D games MUST use Godot engine (Godot 4 GDScript in workspace game-dev/ or target project).
   NEVER build Web / Canvas / HTML5 / React / Vite games, and NEVER start a web server (no npm run dev, no vite, no python -m http.server, no express).
2. RESEARCH FIRST: When starting a new game, DO NOT immediately create files from scratch.
   First search GitHub (using search_web or GitHub tools) for mature open-source Godot game projects with matching mechanics or genre.
   Clone / pull the repository or reference its architecture into the workspace.
   GH-PROXY MIRROR: If connecting to foreign GitHub fails / is blocked / times out, ALWAYS use the gh-proxy mirror source: https://gh-proxy.com/ (e.g. git clone https://gh-proxy.com/https://github.com/<owner>/<repo>.git).
3. HEADLESS WHILE CODING: During development and coding, DO NOT open Godot windows or the editor by default.
   Keep asset import (godot_import) and test (godot_test) operations headless.
   ONLY open the Godot editor if the user explicitly sends a prompt asking to open Godot (e.g. "打开godot", "open godot").
4. PLAYABLE PREVIEW ON COMPLETION: When game code and tests (godot_test 0 failures) are complete, launch the playable Godot preview game using godot_play.
   The user previews and plays the real Godot game.`;

export function hasGameDevIntent(message: string): boolean {
	return /game[\s-]?dev|godot|\bmini[\s-]?game\b|\b2d\s*game\b|\b3d\s*game\b|make\s+a?\s*game|build\s+a?\s*game|create\s+a?\s*game|play\s+a?\s*game|小游戏|[23]d\s*游戏|做(?:个|款)?游戏|写(?:个|款)?游戏|开发(?:个|款)?游戏|制作(?:个|款)?游戏|游戏模式|游戏开发|game mode|star catcher/i.test(message);
}

export function userRequestedGodotOpen(message: string): boolean {
	return /打开\s*(?:godot|编辑器)|启动\s*(?:godot|编辑器)|运行\s*godot|open\s*godot|launch\s*godot|start\s*godot|show\s*godot/i.test(message);
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

function buildGodotEnvPrefix(mobiusRoot: URI, godotProject: URI): string {
	return `$env:MOBIUS_ROOT=${quotePs(mobiusRoot.fsPath)}; $env:GODOT_PROJECT=${quotePs(godotProject.fsPath)}; `;
}

async function resolveGodotProjectDir(
	fileService: IFileService,
	workspaceFolder: URI,
	mobiusRoot: URI,
): Promise<URI> {
	if (await fileService.exists(URI.joinPath(workspaceFolder, 'project.godot'))) {
		return workspaceFolder;
	}
	const nested = URI.joinPath(workspaceFolder, 'game-dev');
	if (await fileService.exists(URI.joinPath(nested, 'project.godot'))) {
		return nested;
	}
	if (await fileService.exists(nested)) {
		return nested;
	}
	return URI.joinPath(mobiusRoot, 'game-dev');
}

export function collectGodotMobiusRootCandidates(
	host: GodotToolHost,
	workingDirectory: URI | undefined,
): URI[] {
	const mobiusRootCandidates: URI[] = [];
	if (host.appRoot) {
		const appRootUri = URI.file(host.appRoot);
		// Packaged payload (resources/mobius-godot), sibling of resources/app.
		mobiusRootCandidates.push(URI.joinPath(appRootUri, '..', 'mobius-godot'));
		for (let depth = 0; depth < 6; depth++) {
			let candidate = appRootUri;
			for (let i = 0; i < depth; i++) {
				candidate = URI.joinPath(candidate, '..');
			}
			mobiusRootCandidates.push(candidate);
		}
	}
	const folder = workingDirectory ?? host.workspaceService.getWorkspace().folders[0]?.uri;
	if (folder) {
		let cur = folder;
		for (let depth = 0; depth < 10; depth++) {
			mobiusRootCandidates.push(cur);
			const parent = URI.joinPath(cur, '..');
			if (parent.fsPath === cur.fsPath) {
				break;
			}
			cur = parent;
		}
	}
	return mobiusRootCandidates;
}

async function resolveGodotPaths(
	host: GodotToolHost,
	workingDirectory: URI | undefined,
): Promise<GodotResolvedPaths | undefined> {
	const folder = workingDirectory ?? host.workspaceService.getWorkspace().folders[0]?.uri;
	if (!folder && !host.appRoot) {
		return undefined;
	}

	const mobiusRootCandidates = collectGodotMobiusRootCandidates(host, workingDirectory);

	for (const root of mobiusRootCandidates) {
		const script = URI.joinPath(root, 'scripts', 'godot-mcp-server.js');
		if (await host.fileService.exists(script)) {
			const projectFolder = folder ?? root;
			const godotProject = await resolveGodotProjectDir(host.fileService, projectFolder, root);
			return { mobiusRoot: root, godotProject, script };
		}
	}
	return undefined;
}

export function createGodotToolHost(
	fileService: IFileService,
	workspaceService: IWorkspaceContextService,
	appRoot?: string,
): GodotToolHost {
	return { fileService, workspaceService, appRoot };
}

function buildGodotCli(scriptPath: string, name: string, args: Record<string, unknown>, envPrefix = ''): string {
	const parts = [`${envPrefix}node ${quotePs(scriptPath)}`];
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
	host: GodotToolHost,
	toolsService: ILanguageModelToolsService,
	logService: ILogService,
	context: TerminalCommandContext,
	toolName: string,
	args: Record<string, unknown>,
	token: CancellationToken,
): Promise<{ ok: boolean; text: string }> {
	const paths = await resolveGodotPaths(host, context.workingDirectory);
	if (!paths) {
		return {
			ok: false,
			text: 'Cannot locate scripts/godot-mcp-server.js — reinstall Mobius (Game mode payload missing) or open the Mobius repo / resources/mobius-godot as workspace.',
		};
	}
	const envPrefix = buildGodotEnvPrefix(paths.mobiusRoot, paths.godotProject);
	const command = buildGodotCli(paths.script.fsPath, toolName, args, envPrefix);
	logService.info(`[Continue][Godot] ${toolName} → MOBIUS_ROOT=${paths.mobiusRoot.fsPath} GODOT_PROJECT=${paths.godotProject.fsPath}`);
	return executeRunTerminalCommand(
		toolsService,
		logService,
		context,
		command,
		true,
		token,
	);
}

/**
 * Cross-request in-flight registry of visible-window launches, keyed by the
 * resolved Godot project path + window kind. The Game-mode bootstrap, the
 * after-each-edit hook, and the turn-end fallback can all ask for an editor
 * within milliseconds of each other (and every new chat message used to reset
 * the per-request state and relaunch); sharing one in-flight promise guarantees
 * a single spawn. Settled launches are de-duplicated by the MCP server's own
 * per-project PID registry (it returns "already open" instead of spawning),
 * which also covers multiple IDE windows and IDE restarts.
 */
const liveWindowInFlight = new Map<string, Promise<{ ok: boolean; text: string }>>();

function liveWindowKey(godotProject: URI, kind: 'editor' | 'game'): string {
	return `${godotProject.fsPath.toLowerCase()}::${kind}`;
}

/** True when the server reported an existing window instead of spawning one. */
function wasAlreadyOpen(text: string): boolean {
	return /already open for this project/i.test(text);
}

/**
 * Singleton auto-launch for one visible window kind. Uses `godot_preview`
 * (never `godot_play`) so the server enforces one editor + one game window per
 * project; an explicit `godot_play` still force-relaunches the game.
 */
async function launchLiveWindowSingleton(
	host: GodotToolHost,
	toolsService: ILanguageModelToolsService,
	logService: ILogService,
	context: TerminalCommandContext,
	state: GodotAutoPreviewState,
	kind: 'editor' | 'game',
	token: CancellationToken,
): Promise<{ opened: boolean; text: string }> {
	if (token.isCancellationRequested) {
		return { opened: false, text: '' };
	}
	const paths = await resolveGodotPaths(host, context.workingDirectory);
	if (!paths) {
		return {
			opened: false,
			text: 'Cannot locate scripts/godot-mcp-server.js — reinstall Mobius (Game mode payload missing) or open the Mobius repo / resources/mobius-godot as workspace.',
		};
	}
	if (kind === 'editor' && state.editorLaunched) {
		return { opened: false, text: '' };
	}
	if (kind === 'game' && state.playLaunched) {
		return { opened: false, text: '' };
	}

	const key = liveWindowKey(paths.godotProject, kind);
	const inFlight = liveWindowInFlight.get(key);
	if (inFlight) {
		logService.info(`[Continue][Godot] ${kind} launch already in flight — sharing the single spawn`);
		const shared = await inFlight;
		if (shared.ok) {
			if (kind === 'editor') {
				state.editorLaunched = true;
			} else {
				state.playLaunched = true;
			}
		}
		return { opened: false, text: '' };
	}

	const promise = runGodotToolCommand(
		host,
		toolsService,
		logService,
		context,
		'godot_preview',
		kind === 'editor' ? { editor: true } : {},
		token,
	);
	liveWindowInFlight.set(key, promise);
	try {
		const result = await promise;
		const alreadyOpen = wasAlreadyOpen(result.text);
		if (result.ok) {
			if (kind === 'editor') {
				state.editorLaunched = true;
			} else {
				state.playLaunched = true;
			}
		}
		// "Already open" is success of the singleton guarantee, not a new window — suppress banner text.
		return { opened: result.ok && !alreadyOpen, text: alreadyOpen ? '' : result.text };
	} finally {
		liveWindowInFlight.delete(key);
	}
}

/** Open the Godot editor once (singleton across turns/races); stays open while the agent edits (hot reload). */
export async function openGodotLiveEditorIfNeeded(
	host: GodotToolHost,
	toolsService: ILanguageModelToolsService,
	logService: ILogService,
	context: TerminalCommandContext,
	state: GodotAutoPreviewState,
	token: CancellationToken,
): Promise<{ opened: boolean; text: string }> {
	return launchLiveWindowSingleton(host, toolsService, logService, context, state, 'editor', token);
}

/** Open a visible game window (no autopilot, singleton) so the user can play while the agent edits. */
export async function openGodotLiveGameIfNeeded(
	host: GodotToolHost,
	toolsService: ILanguageModelToolsService,
	logService: ILogService,
	context: TerminalCommandContext,
	state: GodotAutoPreviewState,
	token: CancellationToken,
): Promise<{ opened: boolean; text: string }> {
	return launchLiveWindowSingleton(host, toolsService, logService, context, state, 'game', token);
}

/** Launch Godot playable window when the agent finished — user previews the game in Godot. */
export async function ensureGodotPreviewLaunched(
	host: GodotToolHost,
	toolsService: ILanguageModelToolsService,
	logService: ILogService,
	context: TerminalCommandContext,
	state: GodotAutoPreviewState,
	token: CancellationToken,
): Promise<{ launched: boolean; text: string }> {
	if (!state.toolsUsed && !state.gameFilesEdited) {
		return { launched: false, text: '' };
	}
	if (state.playLaunched) {
		return { launched: false, text: '' };
	}

	const chunks: string[] = [];
	let launched = false;

	// Launch playable game preview upon completion (never force editor open unless requested)
	const play = await openGodotLiveGameIfNeeded(host, toolsService, logService, context, state, token);
	if (play.opened) {
		launched = true;
		chunks.push(`**Game preview (auto):** launched Godot preview game\n${play.text}`);
	}

	return { launched, text: chunks.join('\n\n') };
}

/** Game mode start: detect Godot, scaffold game-dev if needed. Only open editor if explicitly requested. */
export async function bootstrapGameModeGodotLivePreview(
	host: GodotToolHost,
	toolsService: ILanguageModelToolsService,
	logService: ILogService,
	context: TerminalCommandContext,
	state: GodotAutoPreviewState,
	token: CancellationToken,
	openEditor = false,
): Promise<{ ok: boolean; editorOpened: boolean; gameOpened: boolean; text: string }> {
	if (token.isCancellationRequested) {
		return { ok: false, editorOpened: false, gameOpened: false, text: '' };
	}

	const paths = await resolveGodotPaths(host, context.workingDirectory);
	if (!paths) {
		return {
			ok: false,
			editorOpened: false,
			gameOpened: false,
			text: 'Cannot locate Mobius Godot tooling (scripts/godot-mcp-server.js). Reinstall Mobius or run scripts/patch-ide-godot.ps1 — the Game mode payload was not packaged.',
		};
	}

	state.toolsUsed = true;
	state.gameFilesEdited = true;

	const chunks: string[] = [];
	const detect = await runGodotToolCommand(host, toolsService, logService, context, 'godot_detect', {}, token);
	chunks.push(detect.text);
	if (!detect.ok) {
		return { ok: false, editorOpened: false, gameOpened: false, text: chunks.join('\n\n') };
	}

	const hasProject = await host.fileService.exists(URI.joinPath(paths.godotProject, 'project.godot'));
	if (!hasProject) {
		const init = await runGodotToolCommand(host, toolsService, logService, context, 'godot_project_init', {}, token);
		chunks.push(init.text);
		if (!init.ok) {
			return { ok: false, editorOpened: false, gameOpened: false, text: chunks.join('\n\n') };
		}
	}

	let editorOpened = false;
	if (openEditor) {
		const editor = await openGodotLiveEditorIfNeeded(host, toolsService, logService, context, state, token);
		if (editor.text) {
			chunks.push(editor.text);
		}
		editorOpened = editor.opened;
	}

	return {
		ok: detect.ok,
		editorOpened,
		gameOpened: false,
		text: chunks.join('\n\n'),
	};
}

export async function executeGodotTool(
	host: GodotToolHost,
	toolsService: ILanguageModelToolsService,
	logService: ILogService,
	context: TerminalCommandContext,
	toolName: string,
	args: Record<string, unknown>,
	token: CancellationToken,
	state?: GodotAutoPreviewState,
): Promise<{ ok: boolean; text: string }> {
	const result = await runGodotToolCommand(
		host,
		toolsService,
		logService,
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

	return result;
}
