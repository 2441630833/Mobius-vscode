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
				'Open a visible Godot window. Default runs the game. Set editor=true only if the user asked for the Godot editor, not to play the mini-game.',
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
				'Run the mini-game inside Godot (not the editor). Default: visible game window with autopilot so the agent plays Star Catcher. Set visible=false to verify YOU WIN headlessly.',
			parameters: {
				type: 'object',
				properties: {
					project: { type: 'string', description: 'Project folder name (default: game-dev).' },
					scene: { type: 'string', description: 'Optional scene path, e.g. res://main.tscn.' },
					autoplay: { type: 'boolean', description: 'Agent collects stars (default true).' },
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

const GAME_EXECUTE_HINT = `GAME DEV LOOP (Agents Game mode): write .gd/.tscn under game-dev/, then godot_import → godot_test → godot_run. To actually run the mini-game in Godot (not the editor), call godot_play. That opens a visible game window with autopilot so Star Catcher plays itself. godot_preview with editor=true is the Godot editor only — do not use it as a substitute for playing. godot_run is headless frames, not a playable window. If Godot is missing, run_terminal_command: npm run godot:setup -- -Install`;

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
			if (args.autoplay !== false) {
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

export async function executeGodotTool(
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
