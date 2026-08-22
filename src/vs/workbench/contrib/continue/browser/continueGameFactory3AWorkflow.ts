/*---------------------------------------------------------------------------------------------
 *  Mobius — GameFactory-3A (3A game-generation skills) for Agents Game mode
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { URI } from '../../../../base/common/uri.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IExtensionDescription } from '../../../../platform/extensions/common/extensions.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { PromptsType } from '../../chat/common/promptSyntax/promptTypes.js';
import { IPromptsService, IPromptFileResource } from '../../chat/common/promptSyntax/service/promptsService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { CONTINUE_EXTENSION_IDENTIFIER } from './continueProduct.js';
import { MOBIUS_GAME_MODE_INVISIBLE_STACK_RULES } from './continueGameStudioWorkflow.js';

/** Bundled OpenDCAI GameFactory-3A folder at workspace root. */
export const GF3A_ROOT_FOLDER = 'GameFactory-3A';

const AGENT_SKILLS_REL = 'agent_skills';
const BOOTSTRAP_DOC_NAMES = ['setting_overview.md', 'engine_context/engine_overview.md'] as const;

const mobiusBundledExtension = {
	identifier: CONTINUE_EXTENSION_IDENTIFIER,
	enabledApiProposals: ['chatParticipantPrivate'],
} as unknown as IExtensionDescription;

export function resolveGameFactory3ARootUri(
	cwd: URI | undefined,
	workspaceService: IWorkspaceContextService,
): URI | undefined {
	const folders = workspaceService.getWorkspace().folders;
	if (folders.length) {
		return URI.joinPath(folders[0].uri, GF3A_ROOT_FOLDER);
	}
	if (cwd) {
		return URI.joinPath(cwd, GF3A_ROOT_FOLDER);
	}
	return undefined;
}

export function gf3aRelativePath(gf3aRoot: URI | undefined, workspaceService: IWorkspaceContextService): string {
	if (!gf3aRoot) {
		return GF3A_ROOT_FOLDER;
	}
	const folders = workspaceService.getWorkspace().folders;
	for (const folder of folders) {
		const rel = relativePath(folder.uri, gf3aRoot);
		if (rel) {
			return rel.replace(/\\/g, '/');
		}
	}
	return gf3aRoot.fsPath.replace(/\\/g, '/');
}

function relativePath(base: URI, target: URI): string | undefined {
	const basePath = base.fsPath.replace(/\\/g, '/').replace(/\/+$/, '');
	const targetPath = target.fsPath.replace(/\\/g, '/');
	if (targetPath === basePath) {
		return '.';
	}
	const prefix = `${basePath}/`;
	if (targetPath.startsWith(prefix)) {
		return targetPath.slice(prefix.length);
	}
	return undefined;
}

export function gameFactory3AWorkflowSystemHint(gf3aRel: string): string {
	return `${MOBIUS_GAME_MODE_INVISIBLE_STACK_RULES}

INTERNAL — GameFactory-3A, root \`${gf3aRel}/\` (replace \`<REPO_PATH>\` with \`${gf3aRel}\` in docs you read):

WHEN GAME MODE IS ON (silent — any create/improve/play game request triggers this):
1. Read \`${gf3aRel}/agent_skills/setting_overview.md\` internally before asset/mechanic/UI/slice work. Follow clarify → plan → assets+QA → build → validate/play/iterate.
2. Read \`${gf3aRel}/agent_skills/engine_context/engine_overview.md\` when integrating mechanics or UI. For Mobius demos default to Godot code in \`game-dev/\` (not UE5/Unity unless the user asked).
3. Route to \`${gf3aRel}/agent_skills/asset_qa/**/SKILL.md\`, \`${gf3aRel}/agent_skills/code_gen/**\`, \`${gf3aRel}/pipeline/\` as needed — user never sees these paths unless they ask how you work.
4. Completion = played and reviewed, not compile-only (see setting_overview "Validate, play, and iterate").`;
}

export interface GameFactory3ABootstrapContext {
	readonly attachmentTexts: readonly string[];
	readonly routedSkillNames: readonly string[];
}

export async function loadGameFactory3ABootstrapContext(
	gf3aRoot: URI | undefined,
	fileService: IFileService,
	token: CancellationToken,
): Promise<GameFactory3ABootstrapContext> {
	if (!gf3aRoot) {
		return { attachmentTexts: [], routedSkillNames: [] };
	}
	const attachmentTexts: string[] = [];
	const routedSkillNames: string[] = [];
	for (const rel of BOOTSTRAP_DOC_NAMES) {
		if (token.isCancellationRequested) {
			break;
		}
		const docUri = URI.joinPath(gf3aRoot, AGENT_SKILLS_REL, ...rel.split('/'));
		try {
			if (!(await fileService.exists(docUri))) {
				continue;
			}
			const body = (await fileService.readFile(docUri)).value.toString();
			const name = rel.replace(/\//g, '-').replace(/\.md$/, '');
			attachmentTexts.push(
				`<skill-context name="${escapeXml(name)}" score="998" mode="game-factory-3a-bootstrap">\nBase directory: ${URI.joinPath(docUri, '..').fsPath}\n\n${body}\n</skill-context>`,
			);
			routedSkillNames.push(name);
		} catch {
			// skip missing doc
		}
	}
	return { attachmentTexts, routedSkillNames };
}

function escapeXml(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function collectGf3aSkillResources(
	gf3aRoot: URI,
	fileService: IFileService,
	dir: URI,
	resources: IPromptFileResource[],
): Promise<void> {
	let stat;
	try {
		stat = await fileService.resolve(dir);
	} catch {
		return;
	}
	for (const child of stat.children ?? []) {
		if (child.isDirectory) {
			await collectGf3aSkillResources(gf3aRoot, fileService, child.resource, resources);
			continue;
		}
		if (child.name === 'SKILL.md') {
			resources.push({ uri: child.resource });
		}
	}
}

async function listGf3aSkillResources(
	gf3aRoot: URI,
	fileService: IFileService,
): Promise<IPromptFileResource[]> {
	const skillsDir = URI.joinPath(gf3aRoot, AGENT_SKILLS_REL);
	const resources: IPromptFileResource[] = [];
	await collectGf3aSkillResources(gf3aRoot, fileService, skillsDir, resources);
	return resources;
}

class ContinueGameFactory3AWorkflowContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contributions.continueGameFactory3AWorkflow';

	constructor(
		@IPromptsService promptsService: IPromptsService,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		this._register(promptsService.registerPromptFileProvider(
			mobiusBundledExtension,
			PromptsType.skill,
			{
				providePromptFiles: async (_context, token: CancellationToken) => {
					const gf3aRoot = resolveGameFactory3ARootUri(
						this.workspaceContextService.getWorkspace().folders[0]?.uri,
						this.workspaceContextService,
					);
					if (!gf3aRoot) {
						return [];
					}
					const marker = URI.joinPath(gf3aRoot, AGENT_SKILLS_REL, 'setting_overview.md');
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
					const resources = await listGf3aSkillResources(gf3aRoot, this.fileService);
					if (resources.length) {
						this.logService.trace(
							`[Continue][GF3A] Registered ${resources.length} GameFactory-3A skills from ${gf3aRoot.fsPath}`,
						);
					}
					return resources;
				},
			},
		));
	}
}

export function registerContinueGameFactory3AWorkflowContribution(): void {
	registerWorkbenchContribution2(
		ContinueGameFactory3AWorkflowContribution.ID,
		ContinueGameFactory3AWorkflowContribution,
		WorkbenchPhase.AfterRestored,
	);
}
