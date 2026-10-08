/*---------------------------------------------------------------------------------------------
 *  Mobius — Godogen workflow integration for Agents Game mode
 *
 *  Godogen (https://github.com/...) is a source repo for autonomous game generation:
 *  - prompts/runtime.md ........ engine-agnostic runtime manifest (status/README, proof over claims)
 *  - engines/{godot,bevy,babylon}.md ... per-engine build/capture guides
 *  - asset-gen/ ................ image / GLB / rigged-character / animated-sprite skill + CLI tools
 *
 *  In Mobius Game mode the runnable game stays in workspace `game-dev/` (Godot 4, GDScript).
 *  Godogen files are used SILENTLY as generation guidance and the asset pipeline — the user
 *  never names them.
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

/** Bundled Godogen source folder name at workspace root (or nested in a folder). */
export const GODOGEN_ROOT_FOLDER = 'godogen';

/**
 * Bootstrap docs injected into every Game-mode context.
 * Only the tiny engine-agnostic runtime manifest is auto-attached: it carries the
 * "prove by running" discipline useful for every task. The C#-specific engine guide
 * is read on demand (and ported to GDScript); asset-gen/SKILL.md is registered as a
 * routable skill so the hybrid router attaches it only when art generation is relevant.
 */
const BOOTSTRAP_DOCS = [
	'prompts/runtime.md',
] as const;

const mobiusBundledExtension = {
	identifier: CONTINUE_EXTENSION_IDENTIFIER,
	enabledApiProposals: ['chatParticipantPrivate'],
} as unknown as IExtensionDescription;

export function resolveGodogenRootUri(
	cwd: URI | undefined,
	workspaceService: IWorkspaceContextService,
): URI | undefined {
	const folders = workspaceService.getWorkspace().folders;
	if (folders.length) {
		return URI.joinPath(folders[0].uri, GODOGEN_ROOT_FOLDER);
	}
	if (cwd) {
		return URI.joinPath(cwd, GODOGEN_ROOT_FOLDER);
	}
	return undefined;
}

export function godogenRelativePath(godogenRoot: URI | undefined, workspaceService: IWorkspaceContextService): string {
	if (!godogenRoot) {
		return GODOGEN_ROOT_FOLDER;
	}
	const folders = workspaceService.getWorkspace().folders;
	for (const folder of folders) {
		const rel = relativePath(folder.uri, godogenRoot);
		if (rel) {
			return rel.replace(/\\/g, '/');
		}
	}
	return godogenRoot.fsPath.replace(/\\/g, '/');
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

export function godogenWorkflowSystemHint(godogenRel: string): string {
	return `INTERNAL — Godogen game-generation knowledge, root \`${godogenRel}/\`. Use it silently; the user never names Godogen.

WHAT TO BORROW (silently — any create/improve/play game request):
1. **Runtime discipline** — read \`${godogenRel}/prompts/runtime.md\`: keep durable project status in \`game-dev/README.md\` (what is built, what is left, asset table with in-game SIZE + path + cost); judge progress from the RUNNING game, never a clean build — visible defects drive the next iteration; the result is proven by play, not claimed.
2. **Godot engine playbook** — read \`${godogenRel}/engines/godot.md\` for silent-failure traps and capture/proof recipes. LANGUAGE MAPPING: Mobius \`game-dev/\` is Godot 4 **GDScript** (not the guide's C#/.NET) — port the PRINCIPLES (owner-chain/serialization validation when saving scenes, primitive collision for imported meshes, GenerateNormals for procedural shadow receiving, frame-rate-independent damping via \`speed *= exp(-rate * delta)\`, deterministic fixed-fps capture) to GDScript; do NOT introduce a .csproj or C# into game-dev. Only use C# Godot if the user explicitly asks for a standalone Godot .NET project outside game-dev.
3. **Asset generation** — \`${godogenRel}/asset-gen/SKILL.md\`: PNG images (Gemini for precise characters/references, xAI Grok for textures/backgrounds/kits), GLB 3D + rigged bipeds + retargeted animation (Tripo3D), animated sprites (reference → pose → video → frames → loop-trim → background removal). Tools: \`${godogenRel}/asset-gen/tools/asset_gen.py\` (+ grid_slice.py / find_loop_frame.py / rembg_matting.py); read \`${godogenRel}/asset-gen/rembg.md\` before matting. These are PAID APIs — confirm the spend with the user in plain language ("this generates ~4 images, about ¢30 — ok?") before the first paid call, and only when the matching key is present (GOOGLE_API_KEY / XAI_API_KEY / TRIPO3D_API_KEY). Never ask for keys unless the user wants generated art; primitive/placeholder art is fine otherwise.
4. **Where outputs live** — runtime-loaded generated assets go under \`game-dev/assets/\` (or \`game-dev/<art-dir>/\`), tracked in the game-dev README asset table. Keep generation inputs/reference PNGs outside the runtime asset folder. Review every generated image before paying for a GLB conversion.
5. **Strict Godot Requirement** — All 2D and 3D games MUST use Godot engine in \`game-dev/\`. NEVER build web/canvas/browser games and NEVER start a web server.
6. **Search GitHub & Pull First** — Do not start creating a game from scratch immediately. First search GitHub for mature open-source Godot projects and pull/clone them. If foreign GitHub connection is blocked, use gh-proxy mirror source: https://gh-proxy.org/ (e.g. \`git clone https://gh-proxy.org/https://github.com/<owner>/<repo>.git\`).
7. **No Godot Popups During Coding** — Keep all editing and testing headless. Only open the Godot editor if explicitly prompted by the user. On completion, launch the playable Godot preview game (\`godot_play\`).
8. **Prompt ideas** — \`${godogenRel}/docs/demo_prompts.md\` is a reference for what a great one-line game brief contains; use it to shape vague openers into concrete builds, never read it verbatim to the user.

DO NOT run \`${godogenRel}/publish.sh\` — Mobius reads the Godogen SOURCE files directly; there is no separate published game repo.`;
}

export interface GodogenBootstrapContext {
	readonly attachmentTexts: readonly string[];
	readonly routedSkillNames: readonly string[];
}

export async function loadGodogenBootstrapContext(
	godogenRoot: URI | undefined,
	fileService: IFileService,
	token: CancellationToken,
): Promise<GodogenBootstrapContext> {
	if (!godogenRoot) {
		return { attachmentTexts: [], routedSkillNames: [] };
	}
	const attachmentTexts: string[] = [];
	const routedSkillNames: string[] = [];
	for (const rel of BOOTSTRAP_DOCS) {
		if (token.isCancellationRequested) {
			break;
		}
		const docUri = URI.joinPath(godogenRoot, ...rel.split('/'));
		try {
			if (!(await fileService.exists(docUri))) {
				continue;
			}
			const body = renderGodogenDoc((await fileService.readFile(docUri)).value.toString());
			const name = `godogen:${rel.replace(/^.*\//, '').replace(/\.md$/, '')}`;
			attachmentTexts.push(
				`<skill-context name="${escapeXml(name)}" score="997" mode="godogen-bootstrap">\nBase directory: ${URI.joinPath(docUri, '..').fsPath}\n\n${body}\n</skill-context>`,
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

/**
 * Godogen docs are publish-time rendered with placeholders; substitute Mobius paths
 * so the injected guidance is directly actionable (tools under godogen/asset-gen,
 * runtime assets under game-dev/assets).
 */
function renderGodogenDoc(body: string): string {
	return body
		.replaceAll('${ENGINE_NAME}', 'Godot')
		.replaceAll('${ENGINE_GUIDE_FILE}', `${GODOGEN_ROOT_FOLDER}/engines/godot.md`)
		.replaceAll('${ASSET_GEN_SKILL_DIR}', `${GODOGEN_ROOT_FOLDER}/asset-gen`)
		.replaceAll('${RUNTIME_ASSET_DIR}', 'game-dev/assets')
		.replaceAll('${ASSET_SKILL_COMMAND}', 'the asset-generation tool');
}

/** Register godogen/asset-gen/SKILL.md as a routable skill (it already carries SKILL frontmatter). */
async function listGodogenSkillResources(
	godogenRoot: URI,
	fileService: IFileService,
): Promise<IPromptFileResource[]> {
	const resources: IPromptFileResource[] = [];
	const skillMd = URI.joinPath(godogenRoot, 'asset-gen', 'SKILL.md');
	try {
		if (await fileService.exists(skillMd)) {
			resources.push({ uri: skillMd });
		}
	} catch {
		// skip
	}
	return resources;
}

class ContinueGodogenWorkflowContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contributions.continueGodogenWorkflow';

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
					const godogenRoot = resolveGodogenRootUri(
						this.workspaceContextService.getWorkspace().folders[0]?.uri,
						this.workspaceContextService,
					);
					if (!godogenRoot) {
						return [];
					}
					const marker = URI.joinPath(godogenRoot, 'prompts', 'runtime.md');
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
					const resources = await listGodogenSkillResources(godogenRoot, this.fileService);
					if (resources.length) {
						this.logService.trace(
							`[Continue][Godogen] Registered ${resources.length} Godogen skill(s) from ${godogenRoot.fsPath}`,
						);
					}
					return resources;
				},
			},
		));
	}
}

export function registerContinueGodogenWorkflowContribution(): void {
	registerWorkbenchContribution2(
		ContinueGodogenWorkflowContribution.ID,
		ContinueGodogenWorkflowContribution,
		WorkbenchPhase.AfterRestored,
	);
}
