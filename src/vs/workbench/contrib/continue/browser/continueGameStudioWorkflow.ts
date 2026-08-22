/*---------------------------------------------------------------------------------------------
 *  Mobius — Claude Code Game Studios (CCGS) workflow for Agents Game mode
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { URI } from '../../../../base/common/uri.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IExtensionDescription } from '../../../../platform/extensions/common/extensions.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IChatAgentRequest } from '../../chat/common/participants/chatAgents.js';
import { PromptsType } from '../../chat/common/promptSyntax/promptTypes.js';
import { IPromptsService, IPromptFileResource } from '../../chat/common/promptSyntax/service/promptsService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { CONTINUE_EXTENSION_IDENTIFIER, CONTINUE_GAME_AGENT_ID } from './continueProduct.js';
import { isGameModeName } from './continueGodotTools.js';

/** Bundled CCGS template folder name at workspace root (or nested in a folder). */
export const CCGS_ROOT_FOLDER = 'Claude-Code-Game-Studios';

const CCGS_SKILLS_REL = '.claude/skills';
const BOOTSTRAP_SKILL_NAMES = ['start', 'help'] as const;

const mobiusBundledExtension = {
	identifier: CONTINUE_EXTENSION_IDENTIFIER,
	enabledApiProposals: ['chatParticipantPrivate'],
} as unknown as IExtensionDescription;

export function isGameModeExplicitlySelected(request: Pick<IChatAgentRequest, 'agentId' | 'modeInstructions'>): boolean {
	return request.agentId === CONTINUE_GAME_AGENT_ID
		|| isGameModeName(request.modeInstructions?.name);
}

export function resolveCcgsRootUri(
	cwd: URI | undefined,
	workspaceService: IWorkspaceContextService,
): URI | undefined {
	const folders = workspaceService.getWorkspace().folders;
	if (folders.length) {
		return URI.joinPath(folders[0].uri, CCGS_ROOT_FOLDER);
	}
	if (cwd) {
		return URI.joinPath(cwd, CCGS_ROOT_FOLDER);
	}
	return undefined;
}

export function ccgsRelativePath(ccgsRoot: URI | undefined, workspaceService: IWorkspaceContextService): string {
	if (!ccgsRoot) {
		return CCGS_ROOT_FOLDER;
	}
	const folders = workspaceService.getWorkspace().folders;
	for (const folder of folders) {
		const rel = relativePath(folder.uri, ccgsRoot);
		if (rel) {
			return rel.replace(/\\/g, '/');
		}
	}
	return ccgsRoot.fsPath.replace(/\\/g, '/');
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

/** Internal-only rules: Game mode users never name bundled frameworks. */
export const MOBIUS_GAME_MODE_INVISIBLE_STACK_RULES = `USER-FACING RULE (mandatory):
The user selected **Game** mode — that alone activates every bundled game pipeline (studio design docs, 3A asset/mechanic workflows, Godot live preview under \`game-dev/\`). They are a normal game creator and do **not** know internal product names, skill files, or tool names.

- Never ask them to "use GameFactory", "read setting_overview", "follow CCGS", "run godot_import", or similar — do that silently yourself.
- Talk in game language only: mechanics, feel, art style, difficulty, "try it and tell me if it feels right".
- Concrete request (add a power-up, new enemy, new mini-game, balance change) → skip full studio onboarding; offer 1–3 plain A/B/C design choices if ambiguous, jot a short internal quick-spec under \`${CCGS_ROOT_FOLDER}/design/quick-specs/\`, implement, then verify playability.
- Vague opener only ("hi", "help me make a game", no feature yet) → run internal \`start\` skill onboarding first.
- Never declare done until \`godot_test\` passes and the user could play the change (\`godot_play\`).`;

export function gameStudioWorkflowSystemHint(ccgsRel: string): string {
	return `${MOBIUS_GAME_MODE_INVISIBLE_STACK_RULES}

INTERNAL — Claude Code Game Studios (CCGS), root \`${ccgsRel}/\`:

WHEN GAME MODE IS ON (silent — user did not ask for this):
1. **Onboarding** — only for vague openers: read \`${ccgsRel}/.claude/skills/start/SKILL.md\` Phases 1–4. Skip when the user already named a concrete game task.
2. **Phase navigation** — \`${ccgsRel}/.claude/docs/workflow-catalog.yaml\`, \`${ccgsRel}/docs/WORKFLOW-GUIDE.md\`, \`${ccgsRel}/.claude/skills/help/SKILL.md\` for "what next?".
3. **Simulate slash commands** — read \`${ccgsRel}/.claude/skills/<name>/SKILL.md\` for brainstorm, design-system, dev-story, gate-check, etc.
4. **Collaborative design** — Question → Options → user picks → draft → approval before big multi-file design writes (\`${ccgsRel}/docs/COLLABORATIVE-DESIGN-PRINCIPLE.md\`).
5. **Runnable Godot** — write under workspace \`game-dev/\`, run \`godot_*\` closed loop. Design docs under \`${ccgsRel}/design/\`.`;
}

export interface GameStudioBootstrapContext {
	readonly attachmentTexts: readonly string[];
	readonly routedSkillNames: readonly string[];
}

export async function loadGameStudioBootstrapContext(
	ccgsRoot: URI | undefined,
	fileService: IFileService,
	token: CancellationToken,
): Promise<GameStudioBootstrapContext> {
	if (!ccgsRoot) {
		return { attachmentTexts: [], routedSkillNames: [] };
	}
	const attachmentTexts: string[] = [];
	const routedSkillNames: string[] = [];
	for (const name of BOOTSTRAP_SKILL_NAMES) {
		if (token.isCancellationRequested) {
			break;
		}
		const skillUri = URI.joinPath(ccgsRoot, CCGS_SKILLS_REL, name, 'SKILL.md');
		try {
			if (!(await fileService.exists(skillUri))) {
				continue;
			}
			const body = (await fileService.readFile(skillUri)).value.toString();
			attachmentTexts.push(
				`<skill-context name="${escapeXml(name)}" score="999" mode="game-studio-bootstrap">\nBase directory: ${URI.joinPath(skillUri, '..').fsPath}\n\n${body}\n</skill-context>`,
			);
			routedSkillNames.push(name);
		} catch {
			// skip missing skill
		}
	}
	return { attachmentTexts, routedSkillNames };
}

function escapeXml(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function listCcgsSkillResources(
	ccgsRoot: URI,
	fileService: IFileService,
): Promise<IPromptFileResource[]> {
	const skillsDir = URI.joinPath(ccgsRoot, CCGS_SKILLS_REL);
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

class ContinueGameStudioSkillsContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contributions.continueGameStudioSkills';

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
					const ccgsRoot = resolveCcgsRootUri(
						this.workspaceContextService.getWorkspace().folders[0]?.uri,
						this.workspaceContextService,
					);
					if (!ccgsRoot) {
						return [];
					}
					const marker = URI.joinPath(ccgsRoot, 'CLAUDE.md');
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
					const resources = await listCcgsSkillResources(ccgsRoot, this.fileService);
					if (resources.length) {
						this.logService.trace(
							`[Continue][CCGS] Registered ${resources.length} Game Studio skills from ${ccgsRoot.fsPath}`,
						);
					}
					return resources;
				},
			},
		));
	}
}

export function registerContinueGameStudioWorkflowContribution(): void {
	registerWorkbenchContribution2(
		ContinueGameStudioSkillsContribution.ID,
		ContinueGameStudioSkillsContribution,
		WorkbenchPhase.AfterRestored,
	);
}
