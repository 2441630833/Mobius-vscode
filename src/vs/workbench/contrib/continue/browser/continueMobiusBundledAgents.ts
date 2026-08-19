/*---------------------------------------------------------------------------------------------
 *  Mobius — bundled Plan / Game custom agents for the Agents mode picker
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { FileAccess } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { IExtensionDescription } from '../../../../platform/extensions/common/extensions.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { AGENTS_SOURCE_FOLDER } from '../../chat/common/promptSyntax/config/promptFileLocations.js';
import { PromptsType } from '../../chat/common/promptSyntax/promptTypes.js';
import { IPromptsService, IPromptFileResource } from '../../chat/common/promptSyntax/service/promptsService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { LocalSessionType } from '../../../../sessions/contrib/providers/localChatSessions/browser/localChatSessionsProvider.js';
import { CONTINUE_EXTENSION_IDENTIFIER, isContinuePhysicalAiIde } from './continueProduct.js';

const MOBIUS_BUNDLED_AGENT_NAMES = ['Plan', 'Game'] as const;

const mobiusBundledExtension = {
	identifier: CONTINUE_EXTENSION_IDENTIFIER,
	enabledApiProposals: ['chatParticipantPrivate'],
} as unknown as IExtensionDescription;

function mobiusBundledAgentCandidates(name: typeof MOBIUS_BUNDLED_AGENT_NAMES[number], appRoot: string): URI[] {
	const fileName = `${name}.agent.md`;
	return [
		FileAccess.asFileUri(`vs/workbench/contrib/continue/mobius/agents/${fileName}`),
		URI.joinPath(URI.file(appRoot), 'mobius', 'agents', fileName),
		URI.joinPath(URI.file(appRoot), '..', '..', '..', '..', 'src', 'vs', 'workbench', 'contrib', 'continue', 'mobius', 'agents', fileName),
	];
}

async function resolveMobiusBundledAgentUri(
	name: typeof MOBIUS_BUNDLED_AGENT_NAMES[number],
	fileService: IFileService,
	appRoot: string,
): Promise<URI | undefined> {
	for (const candidate of mobiusBundledAgentCandidates(name, appRoot)) {
		try {
			if (await fileService.exists(candidate)) {
				return candidate;
			}
		} catch {
			// try next candidate
		}
	}
	return undefined;
}

class ContinueMobiusBundledAgentsContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contributions.continueMobiusBundledAgents';

	constructor(
		@IPromptsService promptsService: IPromptsService,
		@IFileService private readonly fileService: IFileService,
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
	) {
		super();

		this._register(promptsService.registerPromptFileProvider(
			mobiusBundledExtension,
			PromptsType.agent,
			{
				providePromptFiles: async (_context, _token: CancellationToken) => {
					const appRoot = (this.environmentService as IWorkbenchEnvironmentService & { appRoot?: string }).appRoot;
					if (typeof appRoot !== 'string') {
						return [];
					}
					const resources: IPromptFileResource[] = [];
					for (const name of MOBIUS_BUNDLED_AGENT_NAMES) {
						if (await this._workspaceHasNamedAgent(name)) {
							continue;
						}
						const uri = await resolveMobiusBundledAgentUri(name, this.fileService, appRoot);
						if (uri) {
							resources.push({
								uri,
								name,
								sessionTypes: [LocalSessionType.id],
							});
						}
					}
					return resources;
				},
			},
		));
	}

	private async _workspaceHasNamedAgent(name: string): Promise<boolean> {
		for (const folder of this.workspaceContextService.getWorkspace().folders) {
			const uri = URI.joinPath(folder.uri, AGENTS_SOURCE_FOLDER, `${name}.agent.md`);
			try {
				if (await this.fileService.exists(uri)) {
					return true;
				}
			} catch {
				// try next folder
			}
		}
		return false;
	}
}

export function registerContinueMobiusBundledAgentsContribution(): void {
	if (isContinuePhysicalAiIde()) {
		registerWorkbenchContribution2(
			ContinueMobiusBundledAgentsContribution.ID,
			ContinueMobiusBundledAgentsContribution,
			WorkbenchPhase.BlockStartup,
		);
	}
}
