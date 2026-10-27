/*---------------------------------------------------------------------------------------------
 *  Mobius — ECC (Everything Claude Code) workflow & pre-request execution for General Agent
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { IExtensionDescription } from '../../../../platform/extensions/common/extensions.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IChatAgentRequest } from '../../chat/common/participants/chatAgents.js';
import { PromptsType } from '../../chat/common/promptSyntax/promptTypes.js';
import { IPromptsService, IPromptFileResource } from '../../chat/common/promptSyntax/service/promptsService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';
import { ILanguageModelToolsService } from '../../chat/common/tools/languageModelToolsService.js';
import { CONTINUE_EXTENSION_IDENTIFIER } from './continueProduct.js';
import type { ContinueAgentToolSchema } from './continueAgentToolsBridge.js';
import { executeRunTerminalCommand, TerminalCommandContext } from './continueTerminalTool.js';

export const ECC_ROOT_FOLDER = 'ECC';
export const PACKAGED_ECC_FOLDER = 'mobius-ecc';

const mobiusBundledExtension = {
	identifier: CONTINUE_EXTENSION_IDENTIFIER,
	enabledApiProposals: ['chatParticipantPrivate'],
} as unknown as IExtensionDescription;

export function collectEccCandidates(
	cwd: URI | undefined,
	workspaceService: IWorkspaceContextService,
	appRoot?: string,
): URI[] {
	const candidates: URI[] = [];

	// 1. Packaged desktop IDE: sibling of resources/app (appRoot)
	if (appRoot) {
		const appRootUri = URI.file(appRoot);
		candidates.push(URI.joinPath(appRootUri, '..', PACKAGED_ECC_FOLDER));
		candidates.push(URI.joinPath(appRootUri, '..', '..', 'resources', PACKAGED_ECC_FOLDER));
		for (let depth = 0; depth < 6; depth++) {
			let cur = appRootUri;
			for (let i = 0; i < depth; i++) {
				cur = URI.joinPath(cur, '..');
			}
			candidates.push(URI.joinPath(cur, ECC_ROOT_FOLDER));
			candidates.push(URI.joinPath(cur, 'resources', PACKAGED_ECC_FOLDER));
		}
	}

	// 2. Workspace folders
	const folders = workspaceService.getWorkspace().folders;
	for (const folder of folders) {
		candidates.push(URI.joinPath(folder.uri, ECC_ROOT_FOLDER));
		candidates.push(URI.joinPath(folder.uri, 'resources', PACKAGED_ECC_FOLDER));
		let cur = folder.uri;
		for (let depth = 0; depth < 6; depth++) {
			candidates.push(URI.joinPath(cur, ECC_ROOT_FOLDER));
			candidates.push(URI.joinPath(cur, 'resources', PACKAGED_ECC_FOLDER));
			const parent = URI.joinPath(cur, '..');
			if (parent.fsPath === cur.fsPath) {
				break;
			}
			cur = parent;
		}
	}

	// 3. Current working directory
	if (cwd) {
		candidates.push(URI.joinPath(cwd, ECC_ROOT_FOLDER));
		candidates.push(URI.joinPath(cwd, 'resources', PACKAGED_ECC_FOLDER));
	}

	return candidates;
}

export function resolveEccRootUri(
	cwd: URI | undefined,
	workspaceService: IWorkspaceContextService,
	appRoot?: string,
): URI | undefined {
	const candidates = collectEccCandidates(cwd, workspaceService, appRoot);
	return candidates[0];
}

export async function findEccRootUri(
	fileService: IFileService,
	cwd: URI | undefined,
	workspaceService: IWorkspaceContextService,
	appRoot?: string,
): Promise<URI | undefined> {
	const candidates = collectEccCandidates(cwd, workspaceService, appRoot);
	for (const candidate of candidates) {
		try {
			const marker = URI.joinPath(candidate, 'package.json');
			if (await fileService.exists(marker)) {
				return candidate;
			}
		} catch {
			// ignore and continue
		}
	}
	return undefined;
}

export async function resolveEccPreflightScriptUri(
	eccRoot: URI,
	fileService?: IFileService,
): Promise<URI> {
	const candidates = [
		URI.joinPath(eccRoot, 'scripts', 'ecc-agent-preflight.js'),
		URI.joinPath(eccRoot, '..', 'scripts', 'ecc-agent-preflight.js'),
		URI.joinPath(eccRoot, '..', '..', 'scripts', 'ecc-agent-preflight.js'),
	];
	if (fileService) {
		for (const c of candidates) {
			try {
				if (await fileService.exists(c)) {
					return c;
				}
			} catch {
				// continue search
			}
		}
	}
	return candidates[0];
}

export async function resolveEccCliScriptUri(
	eccRoot: URI,
	fileService?: IFileService,
): Promise<URI> {
	const candidates = [
		URI.joinPath(eccRoot, 'scripts', 'ecc-cli.js'),
		URI.joinPath(eccRoot, '..', 'scripts', 'ecc-cli.js'),
		URI.joinPath(eccRoot, '..', '..', 'scripts', 'ecc-cli.js'),
	];
	if (fileService) {
		for (const c of candidates) {
			try {
				if (await fileService.exists(c)) {
					return c;
				}
			} catch {
				// continue search
			}
		}
	}
	return candidates[0];
}

export function quotePs(text: string): string {
	if (/^[a-zA-Z0-9_.-]+$/.test(text)) {
		return text;
	}
	return `'${text.replace(/'/g, "''")}'`;
}

export interface EccPreflightResult {
	readonly ok: boolean;
	readonly summary: string;
	readonly systemPrompt: string;
	readonly matchedSkills: readonly string[];
	readonly matchedAgents: readonly string[];
}

export async function executeEccPreflight(
	eccRoot: URI | undefined,
	request: IChatAgentRequest,
	cwd: URI | undefined,
	toolsService: ILanguageModelToolsService,
	logService: ILogService,
	token: CancellationToken,
	commandService?: ICommandService,
	fileService?: IFileService,
): Promise<EccPreflightResult> {
	if (!eccRoot) {
		return {
			ok: false,
			summary: 'ECC: Not installed',
			systemPrompt: '',
			matchedSkills: [],
			matchedAgents: [],
		};
	}

	const prompt = request.message.trim();
	const preflightScriptUri = await resolveEccPreflightScriptUri(eccRoot, fileService);

	const terminalContext: TerminalCommandContext = {
		sessionResource: request.sessionResource,
		workingDirectory: cwd,
		chatRequestId: request.requestId,
	};

	const safePrompt = prompt.slice(0, 400).replace(/["'`$\\]/g, ' ');
	const cmd = `node ${quotePs(preflightScriptUri.fsPath)} --json "${safePrompt}"`;

	try {
		logService.info(`[Continue][ECC] Running preflight for request: "${prompt.slice(0, 60)}"`);
		const result = await executeRunTerminalCommand(
			toolsService,
			logService,
			terminalContext,
			cmd,
			true,
			token,
			commandService,
		);

		if (result.ok && result.text) {
			const jsonStart = result.text.indexOf('{');
			const jsonEnd = result.text.lastIndexOf('}');
			if (jsonStart !== -1 && jsonEnd > jsonStart) {
				const jsonStr = result.text.slice(jsonStart, jsonEnd + 1);
				const parsed = JSON.parse(jsonStr) as {
					ok?: boolean;
					summary?: string;
					systemPrompt?: string;
					matchedSkills?: string[];
					matchedAgents?: string[];
				};
				return {
					ok: parsed.ok ?? true,
					summary: parsed.summary || 'ECC Preflight: Active',
					systemPrompt: parsed.systemPrompt || '',
					matchedSkills: parsed.matchedSkills || [],
					matchedAgents: parsed.matchedAgents || [],
				};
			}
		}
	} catch (err) {
		logService.warn('[Continue][ECC] Preflight execution encountered non-fatal error:', err);
	}

	// A failed preflight is not evidence for any workflow or task.
	return {
		ok: false,
		summary: 'ECC Preflight: unavailable; continuing with the user request',
		systemPrompt: '',
		matchedSkills: [],
		matchedAgents: [],
	};
}

const ECC_TOOL_NAMES = new Set(['ecc_run', 'ecc_consult', 'ecc_skill', 'ecc']);

export function isEccTool(name: string): boolean {
	return ECC_TOOL_NAMES.has(name);
}

export const ECC_TOOL_SCHEMAS: ContinueAgentToolSchema[] = [
	{
		type: 'function',
		function: {
			name: 'ecc_run',
			description:
				'Execute an ECC CLI command (e.g. "status", "test", "analyze", "rules", "plan") to run workflows or check repository health.',
			parameters: {
				type: 'object',
				properties: {
					command: {
						type: 'string',
						description: 'Subcommand to run (e.g. status, analyze, review, test).',
					},
					args: {
						type: 'array',
						description: 'Optional arguments array to pass to the ECC CLI.',
						items: { type: 'string' },
					},
				},
				required: ['command'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'ecc_consult',
			description:
				'Query ECC for recommended skills, rules, agent profiles, or workflow principles based on a task or prompt query.',
			parameters: {
				type: 'object',
				properties: {
					query: {
						type: 'string',
						description: 'The engineering question, task description, or technology to consult on.',
					},
				},
				required: ['query'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'ecc_skill',
			description:
				'Read the full definition and instructions of an ECC skill (e.g. "tdd-workflow", "security-audit", "docker-expert") by name.',
			parameters: {
				type: 'object',
				properties: {
					skill_name: {
						type: 'string',
						description: 'Name of the ECC skill to load.',
					},
				},
				required: ['skill_name'],
			},
		},
	},
];

export const ECC_BRIDGE_TOOL_DEFINITIONS = ECC_TOOL_SCHEMAS;

export interface EccToolHost {
	readonly fileService: IFileService;
	readonly workspaceService: IWorkspaceContextService;
	readonly appRoot?: string;
}

export async function executeEccTool(
	host: EccToolHost,
	toolsService: ILanguageModelToolsService,
	logService: ILogService,
	context: TerminalCommandContext,
	toolName: string,
	args: Record<string, unknown>,
	token: CancellationToken,
): Promise<{ ok: boolean; text: string }> {
	const eccRoot = await findEccRootUri(host.fileService, context.workingDirectory, host.workspaceService, host.appRoot)
		?? resolveEccRootUri(context.workingDirectory, host.workspaceService, host.appRoot);
	if (!eccRoot) {
		return { ok: false, text: 'ECC submodule not found in workspace' };
	}

	if (toolName === 'ecc_skill') {
		const skillName = typeof args.skill_name === 'string' ? args.skill_name.trim() : '';
		if (!skillName) {
			return { ok: false, text: 'ecc_skill requires a valid skill_name' };
		}
		const skillMdUri = URI.joinPath(eccRoot, 'skills', skillName, 'SKILL.md');
		try {
			if (await host.fileService.exists(skillMdUri)) {
				const content = (await host.fileService.readFile(skillMdUri)).value.toString();
				return { ok: true, text: content };
			}
			return { ok: false, text: `ECC skill "${skillName}" not found at ${skillMdUri.fsPath}` };
		} catch (err) {
			return { ok: false, text: `Failed to read ECC skill "${skillName}": ${err instanceof Error ? err.message : String(err)}` };
		}
	}

	if (toolName === 'ecc_consult') {
		const query = typeof args.query === 'string' ? args.query.trim() : '';
		const scriptUri = await resolveEccPreflightScriptUri(eccRoot, host.fileService);
		const cmd = `node ${quotePs(scriptUri.fsPath)} --json "${query.replace(/["'`$\\]/g, ' ')}"`;
		return executeRunTerminalCommand(toolsService, logService, context, cmd, true, token);
	}

	// ecc_run or generic ecc
	const subcmd = typeof args.command === 'string' ? args.command.trim() : 'status';
	const extraArgs = Array.isArray(args.args)
		? args.args.map(a => quotePs(String(a))).join(' ')
		: '';
	const cliScriptUri = await resolveEccCliScriptUri(eccRoot, host.fileService);
	const cmd = `node ${quotePs(cliScriptUri.fsPath)} ${quotePs(subcmd)} ${extraArgs}`.trim();
	logService.info(`[Continue][ECC] Executing command: ${cmd}`);
	return executeRunTerminalCommand(toolsService, logService, context, cmd, true, token);
}

async function listEccSkillResources(
	eccRoot: URI,
	fileService: IFileService,
): Promise<IPromptFileResource[]> {
	const skillsDir = URI.joinPath(eccRoot, 'skills');
	let stat;
	try {
		stat = await fileService.resolve(skillsDir);
	} catch {
		return [];
	}
	const resources: IPromptFileResource[] = [];
	for (const child of stat.children ?? []) {
		if (!child.isDirectory) {
			continue;
		}
		const skillMd = URI.joinPath(child.resource, 'SKILL.md');
		try {
			if (await fileService.exists(skillMd)) {
				resources.push({ uri: skillMd });
			}
		} catch {
			// skip
		}
	}
	return resources;
}

async function listEccAgentResources(
	eccRoot: URI,
	fileService: IFileService,
): Promise<IPromptFileResource[]> {
	const agentsDir = URI.joinPath(eccRoot, 'agents');
	let stat;
	try {
		stat = await fileService.resolve(agentsDir);
	} catch {
		return [];
	}
	const resources: IPromptFileResource[] = [];
	for (const child of stat.children ?? []) {
		if (child.isDirectory || !child.name.endsWith('.md')) {
			continue;
		}
		resources.push({
			uri: child.resource,
			name: child.name.replace(/\.md$/, ''),
		});
	}
	return resources;
}

class ContinueEccWorkflowContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contributions.continueEccWorkflow';

	constructor(
		@IPromptsService promptsService: IPromptsService,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		const appRoot = (this.environmentService as { appRoot?: string }).appRoot;

		// Register ECC Skills
		this._register(promptsService.registerPromptFileProvider(
			mobiusBundledExtension,
			PromptsType.skill,
			{
				providePromptFiles: async (_context, token: CancellationToken) => {
					const eccRoot = await findEccRootUri(
						this.fileService,
						this.workspaceContextService.getWorkspace().folders[0]?.uri,
						this.workspaceContextService,
						appRoot,
					);
					if (!eccRoot) {
						return [];
					}
					const marker = URI.joinPath(eccRoot, 'package.json');
					try {
						if (!(await this.fileService.exists(marker))) {
							return [];
						}
					} catch {
						return [];
					}
					if (token.isCancellationRequested) {
						return [];
					}
					const resources = await listEccSkillResources(eccRoot, this.fileService);
					if (resources.length) {
						this.logService.trace(
							`[Continue][ECC] Registered ${resources.length} skills from ${eccRoot.fsPath}`,
						);
					}
					return resources;
				},
			},
		));

		// Register ECC Agents
		this._register(promptsService.registerPromptFileProvider(
			mobiusBundledExtension,
			PromptsType.agent,
			{
				providePromptFiles: async (_context, token: CancellationToken) => {
					const eccRoot = await findEccRootUri(
						this.fileService,
						this.workspaceContextService.getWorkspace().folders[0]?.uri,
						this.workspaceContextService,
						appRoot,
					);
					if (!eccRoot) {
						return [];
					}
					if (token.isCancellationRequested) {
						return [];
					}
					const resources = await listEccAgentResources(eccRoot, this.fileService);
					if (resources.length) {
						this.logService.trace(
							`[Continue][ECC] Registered ${resources.length} agents from ${eccRoot.fsPath}`,
						);
					}
					return resources;
				},
			},
		));
	}
}

export function registerContinueEccWorkflowContribution(): void {
	registerWorkbenchContribution2(
		ContinueEccWorkflowContribution.ID,
		ContinueEccWorkflowContribution,
		WorkbenchPhase.AfterRestored,
	);
}
