/*---------------------------------------------------------------------------------------------
 *  Mobius — Pluggable Agent Harness Registry & Interfaces
 *  Inspired by DeepSeek Harness (dsh) "everything-is-a-plugin" architecture.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { IDisposable, Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IChatAgentRequest, IChatAgentResult, IChatAgentHistoryEntry } from '../../chat/common/participants/chatAgents.js';
import { IChatProgress } from '../../chat/common/chatService/chatService.js';
import { ILanguageModelsService } from '../../chat/common/languageModels.js';
import { IPromptsService } from '../../chat/common/promptSyntax/service/promptsService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ILanguageModelToolsService } from '../../chat/common/tools/languageModelToolsService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { IMarkerService } from '../../../../platform/markers/common/markers.js';
import { IChatTodoListService } from '../../chat/common/tools/chatTodoListService.js';
import { ITextFileService } from '../../../services/textfile/common/textfiles.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';

export const MOBIUS_HARNESS_ENGINE_SETTING = 'mobius.agentHarness.engine';

export type MobiusHarnessEngineId = 'continue' | 'deepseek';

export interface IMobiusHarnessServices {
	readonly languageModelsService: ILanguageModelsService;
	readonly promptsService: IPromptsService;
	readonly fileService: IFileService;
	readonly configurationService: IConfigurationService;
	readonly logService: ILogService;
	readonly workspaceService: IWorkspaceContextService;
	readonly languageModelToolsService: ILanguageModelToolsService;
	readonly commandService: ICommandService;
	readonly extensionService: IExtensionService;
	readonly markerService: IMarkerService;
	readonly chatTodoListService: IChatTodoListService;
	readonly textFileService: ITextFileService;
	readonly environmentService: IWorkbenchEnvironmentService;
	readonly storageService: IStorageService;
	readonly dialogService: IDialogService;
}

export interface IMobiusHarnessTurnContext {
	readonly request: IChatAgentRequest;
	readonly progress: (parts: IChatProgress[]) => void;
	readonly history: IChatAgentHistoryEntry[];
	readonly token: CancellationToken;
	readonly modelId: string;
	readonly cwd?: URI;
	readonly services: IMobiusHarnessServices;
	readonly executeTool: (
		call: { name: string; parameters?: Record<string, unknown>; toolCallId: string },
		cwd?: URI,
		sessionResource?: URI,
		requestId?: string,
		token?: CancellationToken,
	) => Promise<{ ok: boolean; text: string; editUri?: URI; editKind?: 'create' | 'edit' }>;
}

export interface IMobiusAgentHarness {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly version: string;
	readonly capabilities: {
		readonly supportsLoopGuards: boolean;
		readonly supportsEventLifecycle: boolean;
		readonly supportsModularPrompts: boolean;
		readonly supportsWorkingMemory: boolean;
	};

	executeTurn(context: IMobiusHarnessTurnContext): Promise<IChatAgentResult>;
}

class MobiusHarnessRegistryImpl extends Disposable {
	private readonly _harnesses = new Map<string, IMobiusAgentHarness>();
	private _activeHarnessId: string = 'continue';
	private readonly _onDidChangeActiveHarness = this._register(new Emitter<IMobiusAgentHarness>());
	readonly onDidChangeActiveHarness: Event<IMobiusAgentHarness> = this._onDidChangeActiveHarness.event;

	registerHarness(harness: IMobiusAgentHarness): IDisposable {
		this._harnesses.set(harness.id, harness);
		return toDisposable(() => {
			this._harnesses.delete(harness.id);
		});
	}

	getHarness(id: string): IMobiusAgentHarness | undefined {
		return this._harnesses.get(id);
	}

	getAllHarnesses(): readonly IMobiusAgentHarness[] {
		return Array.from(this._harnesses.values());
	}

	getActiveHarness(): IMobiusAgentHarness {
		const harness = this._harnesses.get(this._activeHarnessId);
		if (harness) {
			return harness;
		}
		// Fallback to continue, or first available
		const fallback = this._harnesses.get('continue') || this._harnesses.values().next().value;
		if (!fallback) {
			throw new Error('No Mobius agent harness registered');
		}
		return fallback;
	}

	setActiveHarness(id: string): void {
		if (this._activeHarnessId === id) {
			return;
		}
		const harness = this._harnesses.get(id);
		if (!harness) {
			return;
		}
		this._activeHarnessId = id;
		this._onDidChangeActiveHarness.fire(harness);
	}

	getActiveHarnessId(): string {
		return this._activeHarnessId;
	}
}

export const MobiusHarnessRegistry = new MobiusHarnessRegistryImpl();
