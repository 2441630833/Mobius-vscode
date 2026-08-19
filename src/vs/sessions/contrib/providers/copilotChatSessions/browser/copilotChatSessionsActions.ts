/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BaseActionViewItem } from '../../../../../base/browser/ui/actionbar/actionViewItems.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore, IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { IReader, autorun } from '../../../../../base/common/observable.js';
import { isWeb } from '../../../../../base/common/platform.js';
import { localize2 } from '../../../../../nls.js';
import { IActionViewItemService } from '../../../../../platform/actions/browser/actionViewItemService.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ContextKeyExpr, IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../../../workbench/common/contributions.js';
import { Menus } from '../../../../browser/menus.js';
import { ActiveSessionHasGitRepositoryContext, ActiveSessionProviderIdContext, ActiveSessionTypeContext, ChatSessionProviderIdContext, IsNewChatSessionContext } from '../../../../common/contextkeys.js';
import { ISessionsProvidersService } from '../../../../services/sessions/browser/sessionsProvidersService.js';
import { ISession } from '../../../../services/sessions/common/session.js';
import { ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';
import { ISessionsService } from '../../../../services/sessions/browser/sessionsService.js';
import { SessionItemContextMenuId } from '../../../sessions/browser/views/sessionsList.js';
import { BranchPicker } from './branchPicker.js';
import { ClaudePermissionModePicker } from './claudePermissionModePicker.js';
import { ClaudeCodeSessionType, COPILOT_PROVIDER_ID, CopilotChatSessionsProvider, CopilotCloudSessionType } from './copilotChatSessionsProvider.js';
import { LocalChatSessionsProvider, LOCAL_PROVIDER_ID, LocalSessionType } from '../../localChatSessions/browser/localChatSessionsProvider.js';
import { IsolationPicker } from './isolationPicker.js';
import { IChatMode } from '../../../../../workbench/contrib/chat/common/chatModes.js';
import { ModePicker, ModePickerModel } from './modePicker.js';
import { CopilotPermissionPickerDelegate, PermissionPicker } from './permissionPicker.js';
import { CopilotCLISessionType } from '../../agentHost/browser/baseAgentHostSessionsProvider.js';
import { ISessionContext } from '../../../../services/sessions/browser/sessionContext.js';

const IsActiveSessionCopilotCLI = ContextKeyExpr.equals(ActiveSessionTypeContext.key, CopilotCLISessionType.id);
const IsActiveSessionLocal = ContextKeyExpr.equals(ActiveSessionTypeContext.key, LocalSessionType.id);
const IsActiveCopilotChatSessionProvider = ContextKeyExpr.equals(ActiveSessionProviderIdContext.key, COPILOT_PROVIDER_ID);
const IsActiveSessionCopilotChatCLI = ContextKeyExpr.and(IsActiveSessionCopilotCLI, IsActiveCopilotChatSessionProvider);
const IsActiveSessionClaudeCode = ContextKeyExpr.equals(ActiveSessionTypeContext.key, ClaudeCodeSessionType.id);
const IsActiveSessionCopilotChatClaudeCode = ContextKeyExpr.and(IsActiveSessionClaudeCode, IsActiveCopilotChatSessionProvider);
const IsActiveSessionCopilotChatLocal = ContextKeyExpr.and(IsActiveSessionLocal, IsActiveCopilotChatSessionProvider);

// -- Actions --

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'sessions.defaultCopilot.isolationPicker',
			title: localize2('isolationPicker', "Isolation Mode"),
			f1: false,
			menu: [{
				id: Menus.NewSessionRepositoryConfig,
				group: 'navigation',
				order: 1,
				when: ContextKeyExpr.and(
					IsNewChatSessionContext,
					IsActiveSessionCopilotChatCLI,
					ContextKeyExpr.equals('config.github.copilot.chat.cli.isolationOption.enabled', true),
				),
			}],
		});
	}
	override async run(): Promise<void> { /* handled by action view item */ }
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'sessions.defaultCopilot.branchPicker',
			title: localize2('branchPicker', "Branch"),
			f1: false,
			precondition: ActiveSessionHasGitRepositoryContext,
			menu: [{
				id: Menus.NewSessionRepositoryConfig,
				group: 'navigation',
				order: 2,
				when: ContextKeyExpr.and(IsNewChatSessionContext, IsActiveSessionCopilotChatCLI),
			}],
		});
	}
	override async run(): Promise<void> { /* handled by action view item */ }
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'sessions.defaultCopilot.modePicker',
			title: localize2('modePicker', "Mode"),
			f1: false,
			menu: [{
				id: Menus.NewSessionConfig,
				group: 'navigation',
				order: 0,
				when: ContextKeyExpr.or(
					IsActiveSessionCopilotChatCLI,
					IsActiveSessionCopilotChatLocal,
					IsActiveSessionLocal,
					// Welcome composer has no active session yet (type ''), but
					// Mobius local chat still needs the Agent/Ask/Game/Plan chip.
					ContextKeyExpr.and(
						IsNewChatSessionContext,
						ContextKeyExpr.or(
							ContextKeyExpr.equals(ActiveSessionTypeContext.key, ''),
							IsActiveSessionLocal,
						),
					),
				),
			}],
		});
	}
	override async run(): Promise<void> { /* handled by action view item */ }
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'sessions.defaultCopilot.permissionPicker',
			title: localize2('permissionPicker', "Permissions"),
			f1: false,
			menu: [{
				id: Menus.NewSessionControl,
				group: 'navigation',
				order: 1,
				when: ContextKeyExpr.or(IsActiveSessionCopilotChatCLI, IsActiveSessionCopilotChatLocal, IsActiveSessionLocal),
			}],
		});
	}
	override async run(): Promise<void> { /* handled by action view item */ }
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'sessions.defaultCopilot.claudePermissionModePicker',
			title: localize2('claudePermissionModePicker', "Permission Mode"),
			f1: false,
			menu: [{
				id: Menus.NewSessionControl,
				group: 'navigation',
				order: 1,
				when: IsActiveSessionCopilotChatClaudeCode,
			}],
		});
	}
	override async run(): Promise<void> { /* handled by action view item */ }
});

// -- Helper --

/**
 * Wraps a standalone picker widget as a {@link BaseActionViewItem}
 * so it can be rendered by a {@link MenuWorkbenchToolBar}.
 *
 * Exported so the web-only `CopilotPermissionPickerWebContribution`
 * (in `mobilePermissionPicker.contribution.ts`) can reuse the same
 * wrapper for its `MobilePermissionPicker` registration.
 */
export class PickerActionViewItem extends BaseActionViewItem {
	constructor(private readonly picker: { render(container: HTMLElement): void; dispose(): void }, disposable?: IDisposable) {
		super(undefined, { id: '', label: '', enabled: true, class: undefined, tooltip: '', run: () => { } });
		if (disposable) {
			this._register(disposable);
		}
	}

	override render(container: HTMLElement): void {
		this.picker.render(container);
	}

	override dispose(): void {
		this.picker.dispose();
		super.dispose();
	}
}

/** Shared welcome-composer mode picker model (see NewChatInputWidget fallback). */
let welcomeModePickerModel: ModePickerModel | undefined;

export function getSessionsWelcomeModePickerModel(): ModePickerModel | undefined {
	return welcomeModePickerModel;
}

function applyPickerModeToSession(
	session: ISession,
	mode: IChatMode,
	sessionsProvidersService: ISessionsProvidersService,
): void {
	const provider = sessionsProvidersService.getProvider(session.providerId);
	if (provider instanceof CopilotChatSessionsProvider) {
		provider.getSession(session.sessionId)?.setMode(mode);
	} else if (provider instanceof LocalChatSessionsProvider) {
		provider.setSessionMode(session.sessionId, mode);
	}
}

function syncSessionModeFromPicker(
	session: ISession,
	modePickerModel: ModePickerModel,
	sessionsProvidersService: ISessionsProvidersService,
	reader: IReader,
): void {
	const sessionModeId = session.mode.read(reader)?.id;
	const selectedModeId = sessionModeId ?? modePickerModel.selectedModeId;
	modePickerModel.setSession(session, selectedModeId);
	const pickerMode = modePickerModel.selectedMode;
	if (pickerMode.id !== sessionModeId) {
		applyPickerModeToSession(session, pickerMode, sessionsProvidersService);
	}
}

// -- Action View Item Registrations --

class CopilotPickerActionViewItemContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.copilotPickerActionViewItems';

	constructor(
		@IActionViewItemService actionViewItemService: IActionViewItemService,
		@ISessionsService sessionsService: ISessionsService,
		@ISessionsProvidersService sessionsProvidersService: ISessionsProvidersService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		const modePickerModel = this._register(instantiationService.createInstance(ModePickerModel));
		welcomeModePickerModel = modePickerModel;
		this._register(toDisposable(() => {
			if (welcomeModePickerModel === modePickerModel) {
				welcomeModePickerModel = undefined;
			}
		}));
		this._register(autorun(reader => {
			const session = sessionsService.activeSession.read(reader);
			if (session) {
				const provider = sessionsProvidersService.getProvider(session.providerId);
				const isLocalChat = provider instanceof LocalChatSessionsProvider || provider?.id === LOCAL_PROVIDER_ID;
				if (provider instanceof CopilotChatSessionsProvider || isLocalChat) {
					syncSessionModeFromPicker(session, modePickerModel, sessionsProvidersService, reader);
					return;
				}
			}
			modePickerModel.setSession(undefined, undefined);
		}));
		this._register(modePickerModel.onDidChange(() => {
			const session = sessionsService.activeSession.get();
			if (!session) {
				return;
			}
			const provider = sessionsProvidersService.getProvider(session.providerId);
			const isLocalChat = provider instanceof LocalChatSessionsProvider || provider?.id === LOCAL_PROVIDER_ID;
			if (!(provider instanceof CopilotChatSessionsProvider || isLocalChat)) {
				return;
			}
			const pickerMode = modePickerModel.selectedMode;
			if (pickerMode.id !== session.mode.get()?.id) {
				applyPickerModeToSession(session, pickerMode, sessionsProvidersService);
			}
		}));

		// MenuWorkbenchToolBar only rebuilds view items on this event. Register
		// without it and a welcome composer created during restore keeps the
		// default "Mode" text button forever.
		const onDidRegisterViewItems = this._register(new Emitter<void>());
		this._register(actionViewItemService.register(
			Menus.NewSessionRepositoryConfig, 'sessions.defaultCopilot.isolationPicker',
			(_action, _options, scopedInstantiationService) => {
				const { session } = scopedInstantiationService.invokeFunction(accessor => accessor.get(ISessionContext));
				const picker = scopedInstantiationService.createInstance(IsolationPicker, session);
				return new PickerActionViewItem(picker);
			},
			onDidRegisterViewItems.event,
		));
		this._register(actionViewItemService.register(
			Menus.NewSessionRepositoryConfig, 'sessions.defaultCopilot.branchPicker',
			(_action, _options, scopedInstantiationService) => {
				const { session } = scopedInstantiationService.invokeFunction(accessor => accessor.get(ISessionContext));
				const picker = scopedInstantiationService.createInstance(BranchPicker, session);
				return new PickerActionViewItem(picker);
			},
			onDidRegisterViewItems.event,
		));
		this._register(actionViewItemService.register(
			Menus.NewSessionConfig, 'sessions.defaultCopilot.modePicker',
			(_action, _options, scopedInstantiationService) => {
				const picker = scopedInstantiationService.createInstance(ModePicker, modePickerModel);
				const disposableStore = new DisposableStore();
				disposableStore.add(picker.onDidSelect(mode => {
					const session = sessionsService.activeSession.get();
					if (!session) {
						return;
					}
					applyPickerModeToSession(session, mode, sessionsProvidersService);
				}));
				return new PickerActionViewItem(picker, disposableStore);
			},
			onDidRegisterViewItems.event,
		));
		// Permission picker registration is skipped on web so the
		// web-only `CopilotPermissionPickerWebContribution` (registered
		// from `sessions.web.main.ts`) can install the mobile-aware
		// {@link MobilePermissionPicker} variant instead. On Electron
		// desktop, register the standard {@link PermissionPicker}
		// directly — the mobile-only sheet rendering never runs there
		// and importing the mobile picker would needlessly drag
		// `mobilePickerSheet.ts` into the desktop bundle.
		if (!isWeb) {
			this._register(actionViewItemService.register(
				Menus.NewSessionControl, 'sessions.defaultCopilot.permissionPicker',
				(_action, _options, scopedInstantiationService) => {
					const { session } = scopedInstantiationService.invokeFunction(accessor => accessor.get(ISessionContext));
					const delegate = scopedInstantiationService.createInstance(CopilotPermissionPickerDelegate, session);
					const picker = scopedInstantiationService.createInstance(PermissionPicker, delegate);
					return new PickerActionViewItem(picker, delegate);
				},
				onDidRegisterViewItems.event,
			));
		}
		this._register(actionViewItemService.register(
			Menus.NewSessionControl, 'sessions.defaultCopilot.claudePermissionModePicker',
			(_action, _options, scopedInstantiationService) => {
				const { session } = scopedInstantiationService.invokeFunction(accessor => accessor.get(ISessionContext));
				const picker = scopedInstantiationService.createInstance(ClaudePermissionModePicker, session);
				return new PickerActionViewItem(picker);
			},
			onDidRegisterViewItems.event,
		));
		onDidRegisterViewItems.fire();
	}
}


// -- Context Key Contribution --

class CopilotActiveSessionContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.copilotActiveSession';

	constructor(
		@ISessionsService sessionsService: ISessionsService,
		@ISessionsProvidersService sessionsProvidersService: ISessionsProvidersService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();

		const hasRepositoryKey = ActiveSessionHasGitRepositoryContext.bindTo(contextKeyService);

		this._register(autorun((reader: IReader) => {
			const session = sessionsService.activeSession.read(reader);
			if (session?.providerId === COPILOT_PROVIDER_ID) {
				const provider = sessionsProvidersService.getProvider(session.providerId);
				const providerSession = provider instanceof CopilotChatSessionsProvider ? provider.getSession(session.sessionId) : undefined;
				const isLoading = providerSession?.loading.read(reader);
				hasRepositoryKey.set(!isLoading && !!providerSession?.gitRepository);
			} else {
				hasRepositoryKey.set(false);
			}
		}));
	}
}

registerWorkbenchContribution2(CopilotPickerActionViewItemContribution.ID, CopilotPickerActionViewItemContribution, WorkbenchPhase.BlockRestore);
registerWorkbenchContribution2(CopilotActiveSessionContribution.ID, CopilotActiveSessionContribution, WorkbenchPhase.AfterRestored);

registerAction2(class DeleteSessionAction extends Action2 {
	constructor() {
		super({
			id: 'sessionsViewPane.copilot.deleteSession',
			title: localize2('deleteSession', "Delete..."),
			menu: [{
				id: SessionItemContextMenuId,
				group: '1_edit',
				order: 4,
				when: ContextKeyExpr.and(
					ContextKeyExpr.equals(ChatSessionProviderIdContext.key, COPILOT_PROVIDER_ID),
					ContextKeyExpr.notEquals('chatSessionType', ClaudeCodeSessionType.id),
					ContextKeyExpr.notEquals('chatSessionType', LocalSessionType.id),
					ContextKeyExpr.notEquals('chatSessionType', CopilotCloudSessionType.id),
				),
			}]
		});
	}
	async run(accessor: ServicesAccessor, context?: ISession | ISession[]): Promise<void> {
		if (!context) {
			return;
		}
		const sessions = Array.isArray(context) ? context : [context];
		const sessionsManagementService = accessor.get(ISessionsManagementService);
		for (const session of sessions) {
			await sessionsManagementService.deleteSession(session);
		}
	}
});
