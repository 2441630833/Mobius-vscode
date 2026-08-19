/*---------------------------------------------------------------------------------------------
 *  Mobius — Continue core integration
 *  Activates the built-in Continue module and wires Copilot-era commands to Continue.
 *--------------------------------------------------------------------------------------------*/


import { timeout } from '../../../../base/common/async.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize2 } from '../../../../nls.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ChatViewId, ChatViewContainerId } from '../../chat/browser/chat.js';
import { KeyMod, KeyCode } from '../../../../base/common/keyCodes.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { EnablementState, IWorkbenchExtensionEnablementService } from '../../../services/extensionManagement/common/extensionManagement.js';
import { IExtensionsWorkbenchService } from '../../extensions/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IChatEntitlementService, ChatEntitlementContextKeys } from '../../../services/chat/common/chatEntitlementService.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { ChatConfiguration, ChatPermissionLevel } from '../../chat/common/constants.js';
import { AUTO_APPROVE_DONT_SHOW_AGAIN_KEY, AUTOPILOT_DONT_SHOW_AGAIN_KEY } from '../../chat/common/chatPermissionStorageKeys.js';
import { SessionType } from '../../chat/common/chatSessionsService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { AgentHostEnabledSettingId } from '../../../../platform/agentHost/common/agentService.js';
import { LOCAL_PROVIDER_ID } from '../../../../sessions/contrib/providers/localChatSessions/browser/localChatSessionsProvider.js';
import { setAccountsActionVisible } from '../../../browser/parts/globalCompositeBar.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ILanguageModelsService } from '../../chat/common/languageModels.js';

import { IRequestService } from '../../../../platform/request/common/request.js';
import { getContinueConfigWatchUris, getPackagedModelEnvUri, loadContinueModels } from './continueModelConfig.js';
import { CONTINUE_LM_VENDOR, CONTINUE_LM_VENDOR_DISPLAY, ContinueLanguageModelProvider } from './continueLanguageModelProvider.js';
import { registerContinueLanguageModelReloader, triggerContinueLanguageModelReload } from './continueLanguageModelReload.js';
import { CONTINUE_EXTENSION_ID, CONTINUE_EXTENSION_IDENTIFIER, isContinuePhysicalAiIde } from './continueProduct.js';
import { registerContinueChatAgentContribution } from './continueChatAgent.js';
import { registerContinueMobiusBundledAgentsContribution } from './continueMobiusBundledAgents.js';
import './mobiusCommitAction.js';
import { IWorkspaceTrustEnablementService, IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import './media/continueChat.css';

/**
 * Register GitHub MCP settings as real (included) keys so legacy startups that
 * still write `github.copilot.chat.githubMcpServer.enabled` do not toast
 * "not a registered configuration". `included: false` would exclude them from
 * `keys().default` and writing would still fail. GitHubMcpContrib stays
 * unregistered — these keys are inert placeholders (always default off).
 */
if (isContinuePhysicalAiIde()) {
	Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
		id: 'mobiusGithubMcpStub',
		title: 'Mobius (GitHub MCP disabled)',
		type: 'object',
		properties: {
			'github.copilot.chat.githubMcpServer.enabled': {
				type: 'boolean',
				default: false,
				description: 'Unused in Mobius — GitHub Copilot MCP server is not registered.',
			},
			'github.copilot.chat.githubMcpServer.toolsets': {
				type: 'array',
				default: ['default'],
				description: 'Unused in Mobius — GitHub Copilot MCP server is not registered.',
			},
			'github.copilot.chat.githubMcpServer.readonly': {
				type: 'boolean',
				default: false,
				description: 'Unused in Mobius — GitHub Copilot MCP server is not registered.',
			},
			'github.copilot.chat.githubMcpServer.lockdown': {
				type: 'boolean',
				default: false,
				description: 'Unused in Mobius — GitHub Copilot MCP server is not registered.',
			},
			'github.copilot.chat.githubMcpServer.channel': {
				type: 'string',
				enum: ['stable', 'insiders'],
				default: 'stable',
				description: 'Unused in Mobius — GitHub Copilot MCP server is not registered.',
			},
		},
	});

	Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
		id: 'continueSelfEvolution',
		title: 'Mobius Self-Evolving Agent',
		type: 'object',
		properties: {
			'continue.selfEvolution.enabled': {
				type: 'boolean',
				default: true,
				description: 'When enabled, the agent automatically distills reusable skills (SKILL.md) from complex successful tasks. Generated skills are auto-loaded on matching future tasks via the hybrid intent router.',
			},
			'continue.selfEvolution.global': {
				type: 'boolean',
				default: false,
				description: 'Store auto-generated skills in ~/.agents/skills/auto/ (global, all projects) instead of .agents/skills/auto/ in the current workspace.',
			},
			'continue.selfEvolution.minToolCalls': {
				type: 'number',
				default: 5,
				minimum: 1,
				maximum: 50,
				description: 'Minimum number of tool calls in a successful task before it is considered for automatic skill generation.',
			},
		},
	});

	Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
		id: 'mobiusModeRouting',
		title: 'Mobius Mode Routing',
		type: 'object',
		properties: {
			'mobius.autoModeRouting.enabled': {
				type: 'boolean',
				default: true,
				description: 'When enabled, the Agents composer infers Agent / Ask / Plan / Game from each outgoing message and switches the mode picker before send. Use /agent, /ask, /plan, or /game at the start of a message to force a mode.',
			},
		},
	});
}

registerContinueChatAgentContribution();
registerContinueMobiusBundledAgentsContribution();

/**
 * Mobius is a local dev environment — auto-trust opened folders so
 * Restricted Mode banner/extensions limits do not block Continue on every launch.
 */
class PhysicalAiWorkspaceTrustContribution implements IWorkbenchContribution {
	static readonly ID = 'workbench.contributions.physicalAiWorkspaceTrust';

	constructor(
		@IWorkspaceTrustEnablementService private readonly workspaceTrustEnablementService: IWorkspaceTrustEnablementService,
		@IWorkspaceTrustManagementService private readonly workspaceTrustManagementService: IWorkspaceTrustManagementService,
	) {
		if (!isContinuePhysicalAiIde()) {
			return;
		}
		if (!this.workspaceTrustEnablementService.isWorkspaceTrustEnabled()) {
			return;
		}
		if (!this.workspaceTrustManagementService.isWorkspaceTrusted()) {
			void this.workspaceTrustManagementService.setWorkspaceTrust(true);
		}
	}
}

const GITHUB_COPILOT_EXTENSION_IDS = [
	new ExtensionIdentifier('GitHub.copilot'),
	new ExtensionIdentifier('GitHub.copilot-chat'),
];

/**
 * Mobius uses Continue for chat, auth chrome, and Agents tooling.
 * Disable both GitHub.copilot (inline completions) and GitHub.copilot-chat
 * (chat provider) so they do not clash with Continue. Agents use Continue's
 * built-in tool implementations.
 */
class ContinueCopilotDisableContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contributions.continueCopilotDisable';

	constructor(
		@IChatEntitlementService private readonly chatEntitlementService: IChatEntitlementService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();
		this.hideCopilotAuthChrome();
	}

	/**
	 * Hide Copilot sign-in chrome without setForceHidden(true): that flag sets
	 * Setup.hidden and hides the "Open in Agents Window" title bar button.
	 */
	private hideCopilotAuthChrome(): void {
		this.chatEntitlementService.setForceHidden(false);
		this.chatEntitlementService.markSetupCompleted();

		void this.configurationService.updateValue(
			ChatConfiguration.TitleBarSignInEnabled,
			false,
			ConfigurationTarget.APPLICATION,
		);
		if (this.configurationService.getValue<boolean>(ChatConfiguration.TitleBarSignInEnabled) !== false) {
			void this.configurationService.updateValue(
				ChatConfiguration.TitleBarSignInEnabled,
				false,
				ConfigurationTarget.USER,
			);
		}

		setAccountsActionVisible(this.storageService, false);
	}
}

class ContinueStartupContribution implements IWorkbenchContribution {
	static readonly ID = 'workbench.contributions.continueStartup';

	constructor(
		@IExtensionService private readonly extensionService: IExtensionService,
		@IWorkbenchExtensionEnablementService private readonly extensionEnablementService: IWorkbenchExtensionEnablementService,
		@IExtensionsWorkbenchService private readonly extensionsWorkbenchService: IExtensionsWorkbenchService,
		@IViewsService private readonly viewsService: IViewsService,
		@ILogService private readonly logService: ILogService,
	) {
		void this.ensureContinueReady();
	}

	private async ensureContinueReady(): Promise<void> {
		try {
			await this.extensionService.whenInstalledExtensionsRegistered();

			// Re-enable Continue first so activation is not blocked by extension queries below.
			await this.extensionsWorkbenchService.queryLocal();
			const continueExtension = this.extensionsWorkbenchService.local.find(
				ext => ExtensionIdentifier.equals(ext.identifier.id, CONTINUE_EXTENSION_ID)
			);

			if (continueExtension?.local && !this.extensionEnablementService.isEnabled(continueExtension.local)) {
				this.logService.info('[Continue] Re-enabling Continue extension for chat panel');
				await this.extensionEnablementService.setEnablement(
					[continueExtension.local],
					EnablementState.EnabledGlobally
				);
			}

			await this.waitForExtensionInHost();

			// Activate Continue before Copilot cleanup so the chat webview can resolve ASAP.
			await this.extensionService.activateByEvent('onStartupFinished');
			await this.extensionService.activateByEvent(`onView:${ChatViewId}`);
			await this.extensionService.activateById(CONTINUE_EXTENSION_IDENTIFIER, {
				startup: true,
				extensionId: CONTINUE_EXTENSION_IDENTIFIER,
				activationEvent: 'onStartupFinished',
			});

			void this.prewarmChatPanel();
			void this.disableGithubCopilotExtensions();
		} catch (error) {
			this.logService.error('[Continue] Failed to activate Continue extension', error);
		}
	}

	/** Eagerly resolve the chat webview — always open Continue chat on startup for Mobius. */
	private async prewarmChatPanel(): Promise<void> {
		try {
			await this.viewsService.openViewContainer(ChatViewContainerId, false);
			await this.viewsService.openView(ChatViewId, false);
			this.logService.trace('[Continue] Pre-warmed chat panel webview');
		} catch (error) {
			this.logService.warn('[Continue] Failed to pre-warm chat panel', error);
		}
	}

	private async disableGithubCopilotExtensions(): Promise<void> {
		for (const copilotId of GITHUB_COPILOT_EXTENSION_IDS) {
			const extension = this.extensionsWorkbenchService.local.find(
				ext => ExtensionIdentifier.equals(ext.identifier.id, copilotId)
			);

			if (extension?.local && this.extensionEnablementService.isEnabled(extension.local)) {
				this.logService.info(`[Continue] Disabling ${copilotId.value} extension`);
				await this.extensionEnablementService.setEnablement(
					[extension.local],
					EnablementState.DisabledGlobally
				);
			}
		}
	}

	private async waitForExtensionInHost(): Promise<void> {
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			if (this.extensionService.extensions.some(ext => ExtensionIdentifier.equals(ext.identifier, CONTINUE_EXTENSION_ID))) {
				return;
			}
			await timeout(100);
		}
		this.logService.error('[Continue] Continue.continue is not registered in the extension host (check enablement and rebuild)');
	}
}

class ContinueAgentsDefaultsContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contributions.continueAgentsDefaults';

	constructor(
		@IChatEntitlementService private readonly chatEntitlementService: IChatEntitlementService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();
		if (!isContinuePhysicalAiIde()) {
			return;
		}

		this.chatEntitlementService.markSetupCompleted();

		// Never write github.copilot.chat.githubMcpServer.* — GitHub MCP is not registered
		// in Mobius (GitHubMcpContrib disabled). Writing that key at BlockStartup races
		// extension config registration and toasts "not a registered configuration".
		// Drop any stale user value left by older Mobius builds.
		const githubMcpEnabledKey = 'github.copilot.chat.githubMcpServer.enabled';
		if (this.configurationService.inspect(githubMcpEnabledKey).userValue !== undefined) {
			void this.configurationService.updateValue(githubMcpEnabledKey, undefined, ConfigurationTarget.USER);
		}

		const mobiusDefaults: Array<[string, unknown]> = [
			[ChatConfiguration.EditorDefaultProvider, 'local'],
			[AgentHostEnabledSettingId, false],
			[ChatConfiguration.CopilotCliHideExtensionHostEditor, true],
			[ChatConfiguration.CopilotCliHideExtensionHostAgents, true],
			// Mobius Agent mode: auto-approve terminal and other tool calls (Cursor-like).
			[ChatConfiguration.DefaultPermissionLevel, ChatPermissionLevel.AutoApprove],
		];
		for (const target of [ConfigurationTarget.APPLICATION, ConfigurationTarget.USER]) {
			for (const [key, value] of mobiusDefaults) {
				// Only write core/workbench keys already in the default registry.
				if (!this.configurationService.keys().default.includes(key)) {
					continue;
				}
				void this.configurationService.updateValue(key, value, target);
			}
		}

		this.storageService.store(
			'sessions.userSelectedSessionType',
			JSON.stringify({ providerId: LOCAL_PROVIDER_ID, sessionTypeId: SessionType.Local }),
			StorageScope.PROFILE,
			StorageTarget.MACHINE,
		);

		// Never show "Enable Autopilot?" / "Enable Bypass Approvals?" dialogs in Mobius.
		this.storageService.store(AUTO_APPROVE_DONT_SHOW_AGAIN_KEY, true, StorageScope.PROFILE, StorageTarget.MACHINE);
		this.storageService.store(AUTOPILOT_DONT_SHOW_AGAIN_KEY, true, StorageScope.PROFILE, StorageTarget.MACHINE);
	}
}

/**
 * Registers Continue models (from workspace `.env` or `~/.continue/config.yaml`) with
 * the VS Code language model service so the Agents window model picker works.
 */
class ContinueLanguageModelContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contributions.continueLanguageModels';

	private readonly _hasByokModels;

	constructor(
		@ILanguageModelsService private readonly languageModelsService: ILanguageModelsService,
		@IFileService private readonly fileService: IFileService,
		@IPathService private readonly pathService: IPathService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IRequestService private readonly requestService: IRequestService,
		@ILogService private readonly logService: ILogService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
	) {
		super();

		this._hasByokModels = ChatEntitlementContextKeys.hasByokModels.bindTo(this.contextKeyService);

		const vendorDescriptor = {
			vendor: CONTINUE_LM_VENDOR,
			displayName: CONTINUE_LM_VENDOR_DISPLAY,
			configuration: undefined,
			managementCommand: undefined,
			when: undefined,
		};
		this.languageModelsService.deltaLanguageModelChatProviderDescriptors([vendorDescriptor], []);
		this._register(toDisposable(() => this.languageModelsService.deltaLanguageModelChatProviderDescriptors([], [vendorDescriptor])));

		const provider = this._register(new ContinueLanguageModelProvider(CONTINUE_EXTENSION_IDENTIFIER, this.requestService));
		this._register(this.languageModelsService.registerLanguageModelProvider(CONTINUE_LM_VENDOR, provider));
		this._register(registerContinueLanguageModelReloader(() => this.reloadModels(provider)));

		void this.reloadModels(provider);

		this._register(this.workspaceContextService.onDidChangeWorkspaceFolders(() => {
			void this.reloadModels(provider);
		}));
		this._register(this.fileService.onDidFilesChange(e => {
			void (async () => {
				const watchUris = await getContinueConfigWatchUris(this.pathService, this.workspaceContextService);
				const packagedEnvUri = getPackagedModelEnvUri(this.getAppRoot());
				if (packagedEnvUri) {
					watchUris.push(packagedEnvUri);
				}
				if (watchUris.some(uri => e.contains(uri))) {
					await this.reloadModels(provider);
				}
			})();
		}));
	}

	private getAppRoot(): string | undefined {
		const appRoot = (this.environmentService as IWorkbenchEnvironmentService & { appRoot?: string }).appRoot;
		return typeof appRoot === 'string' ? appRoot : undefined;
	}

	private async reloadModels(provider: ContinueLanguageModelProvider): Promise<void> {
		try {
			const models = await loadContinueModels(
				this.fileService,
				this.pathService,
				this.workspaceContextService,
				this.getAppRoot(),
			);
			provider.updateModels(models);
			this._hasByokModels.set(models.length > 0);
			if (models.length) {
				// Default every .env / Continue cloud profile as pinned in the Agents picker.
				for (const entry of models) {
					this.languageModelsService.pinModel(`${CONTINUE_LM_VENDOR}:${entry.name}`);
				}
				this.logService.info(`[Continue] Registered ${models.length} language model(s) for Agents`);
			} else {
				this.logService.warn('[Continue] No language models configured — set a cloud API key in Settings / .env (Ollama on :25137 is for embed + OCR only)');
			}
		} catch (error) {
			this.logService.error('[Continue] Failed to load language model configuration', error);
			provider.updateModels([]);
			this._hasByokModels.set(false);
		}
	}
}

class ReloadContinueLanguageModelsAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.continue.reloadLanguageModels',
			title: localize2('continue.reloadLanguageModels', "Reload Continue Language Models"),
			f1: false,
		});
	}

	override run(_accessor: ServicesAccessor): void {
		triggerContinueLanguageModelReload();
	}
}

class FocusContinueChatAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.continue.openChat',
			title: localize2('continue.openChat', "Open Continue Chat"),
			f1: true,
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyI,
				weight: 200,
			},
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const viewsService = accessor.get(IViewsService);
		await viewsService.openView(ChatViewId, true);
		await accessor.get(ICommandService).executeCommand('continue.focusContinueInput');
	}
}

class OpenModelProviderSettingsAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.continue.openModelProviderSettings',
			title: localize2('continue.openModelProviderSettings', "Modify Model Providers"),
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(ICommandService).executeCommand('continue.openModelProviderSettings');
	}
}

class AddModelProviderAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.continue.addModelProvider',
			title: localize2('continue.addModelProvider', "Add Model Provider"),
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(ICommandService).executeCommand('continue.addModelProvider');
	}
}

class DeleteModelProviderAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.continue.deleteModelProvider',
			title: localize2('continue.deleteModelProvider', "Delete Model Provider"),
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(ICommandService).executeCommand('continue.deleteModelProvider');
	}
}

registerWorkbenchContribution2(ContinueCopilotDisableContribution.ID, ContinueCopilotDisableContribution, WorkbenchPhase.BlockStartup);
registerWorkbenchContribution2(PhysicalAiWorkspaceTrustContribution.ID, PhysicalAiWorkspaceTrustContribution, WorkbenchPhase.BlockRestore);
registerWorkbenchContribution2(ContinueAgentsDefaultsContribution.ID, ContinueAgentsDefaultsContribution, WorkbenchPhase.BlockStartup);
registerWorkbenchContribution2(ContinueStartupContribution.ID, ContinueStartupContribution, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(ContinueLanguageModelContribution.ID, ContinueLanguageModelContribution, WorkbenchPhase.AfterRestored);
registerAction2(ReloadContinueLanguageModelsAction);
registerAction2(FocusContinueChatAction);
registerAction2(OpenModelProviderSettingsAction);
registerAction2(AddModelProviderAction);
registerAction2(DeleteModelProviderAction);
