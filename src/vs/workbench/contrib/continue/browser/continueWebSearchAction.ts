/*---------------------------------------------------------------------------------------------
 *  Mobius — Web Search Toolbar Toggle
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IActionViewItemService } from '../../../../platform/actions/browser/actionViewItemService.js';
import { MenuEntryActionViewItem, IMenuEntryActionViewItemOptions } from '../../../../platform/actions/browser/menuEntryActionViewItem.js';
import { MenuItemAction } from '../../../../platform/actions/common/actions.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ContextKeyExpr, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IAccessibilityService } from '../../../../platform/accessibility/common/accessibility.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { ChatContextKeys } from '../../chat/common/actions/chatContextKeys.js';
import { ChatAgentLocation } from '../../chat/common/constants.js';
import { CONTINUE_WEB_SEARCH_ENABLED_SETTING } from './continueWebSearch.js';

export const TOGGLE_WEB_SEARCH_COMMAND_ID = 'continue.toggleWebSearch';

export class ToggleWebSearchAction extends Action2 {
	static readonly ID = TOGGLE_WEB_SEARCH_COMMAND_ID;

	constructor() {
		super({
			id: ToggleWebSearchAction.ID,
			title: localize2('continue.webSearch.title', "Web Search"),
			category: localize2('continue.category', "Mobius"),
			icon: Codicon.globe,
			f1: true,
			precondition: ChatContextKeys.enabled,
			toggled: {
				condition: ContextKeyExpr.notEquals(`config.${CONTINUE_WEB_SEARCH_ENABLED_SETTING}`, false),
				title: localize('continue.webSearch.enabledTitle', "Web Search: On"),
				tooltip: localize('continue.webSearch.enabledTooltip', "Web Search is enabled. Click to disable web searches."),
			},
			tooltip: localize('continue.webSearch.disabledTooltip', "Web Search is disabled. Click to allow web searches."),
			menu: [
				{
					id: MenuId.ChatInput,
					group: 'navigation',
					order: 6,
					when: ContextKeyExpr.and(
						ChatContextKeys.location.isEqualTo(ChatAgentLocation.Chat),
						ChatContextKeys.inQuickChat.negate(),
					),
				},
				{
					id: MenuId.ChatExecute,
					group: 'navigation',
					order: 4,
					when: ContextKeyExpr.and(
						ChatContextKeys.location.isEqualTo(ChatAgentLocation.Chat),
						ContextKeyExpr.or(
							ChatContextKeys.inQuickChat,
							ChatContextKeys.location.isEqualTo(ChatAgentLocation.EditorInline),
						),
					),
				},
			],
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const configurationService = accessor.get(IConfigurationService);
		const notificationService = accessor.get(INotificationService);

		const current = configurationService.getValue<boolean>(CONTINUE_WEB_SEARCH_ENABLED_SETTING) ?? true;
		const next = !current;

		await configurationService.updateValue(CONTINUE_WEB_SEARCH_ENABLED_SETTING, next, ConfigurationTarget.USER);

		if (next) {
			notificationService.info(localize(
				'continue.webSearch.enabledNotice',
				"Web Search enabled: the agent can search the web.",
			));
		} else {
			notificationService.info(localize(
				'continue.webSearch.disabledNotice',
				"Web Search disabled: the agent cannot search the web.",
			));
		}
	}
}

/**
 * Custom toolbar action view item for the Web Search button.
 * Renders an accessible chip showing "Web Search" / "Web Search Off" with active/disabled state.
 */
export class WebSearchButtonActionViewItem extends MenuEntryActionViewItem {
	constructor(
		action: MenuItemAction,
		options: IMenuEntryActionViewItemOptions | undefined,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IKeybindingService keybindingService: IKeybindingService,
		@INotificationService notificationService: INotificationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IThemeService themeService: IThemeService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IAccessibilityService accessibilityService: IAccessibilityService,
	) {
		super(
			action,
			options,
			keybindingService,
			notificationService,
			contextKeyService,
			themeService,
			contextMenuService,
			accessibilityService,
		);

		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(CONTINUE_WEB_SEARCH_ENABLED_SETTING)) {
				this._updateSearchState();
			}
		}));
	}

	override render(container: HTMLElement): void {
		super.render(container);
		container.classList.add('chat-web-search-button');
		if (this.label) {
			this.label.classList.add('chat-web-search-button');
		}
		this._updateSearchState();
	}

	protected override updateLabel(): void {
		if (this.label) {
			const enabled = this.configurationService.getValue<boolean>(CONTINUE_WEB_SEARCH_ENABLED_SETTING) ?? true;
			this.label.textContent = enabled
				? localize('continue.webSearch.onLabel', "Web Search")
				: localize('continue.webSearch.offLabel', "Web Search Off");
		}
	}

	private _updateSearchState(): void {
		const enabled = this.configurationService.getValue<boolean>(CONTINUE_WEB_SEARCH_ENABLED_SETTING) ?? true;
		this.updateLabel();
		if (this.label) {
			this.label.classList.toggle('checked', enabled);
			this.label.setAttribute('aria-pressed', String(enabled));
			this.label.classList.toggle('disabled-mode', !enabled);
			this.label.title = enabled
				? localize('continue.webSearch.enabledTooltip', "Web Search is enabled. Click to disable web searches.")
				: localize('continue.webSearch.disabledTooltip', "Web Search is disabled. Click to allow web searches.");
		}
		if (this.element) {
			this.element.classList.toggle('checked', enabled);
			this.element.classList.toggle('disabled-mode', !enabled);
			this.element.title = enabled
				? localize('continue.webSearch.enabledTooltip', "Web Search is enabled. Click to disable web searches.")
				: localize('continue.webSearch.disabledTooltip', "Web Search is disabled. Click to allow web searches.");
		}
	}
}

/**
 * Workbench contribution registering the custom ActionViewItem factory for the Web Search button.
 */
export class WebSearchActionViewItemContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.continueWebSearchActionViewItem';

	constructor(
		@IActionViewItemService actionViewItemService: IActionViewItemService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		const factory = (action: unknown, options: unknown) => {
			if (!(action instanceof MenuItemAction)) {
				return undefined;
			}
			return instantiationService.createInstance(
				WebSearchButtonActionViewItem,
				action,
				options as IMenuEntryActionViewItemOptions | undefined,
			);
		};
		this._register(actionViewItemService.register(MenuId.ChatInput, TOGGLE_WEB_SEARCH_COMMAND_ID, factory));
		this._register(actionViewItemService.register(MenuId.ChatExecute, TOGGLE_WEB_SEARCH_COMMAND_ID, factory));
	}
}

export function registerContinueWebSearchAction(): void {
	registerAction2(ToggleWebSearchAction);
}
