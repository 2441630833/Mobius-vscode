/*---------------------------------------------------------------------------------------------
 *  Mobius — Local OCR Toolbar Toggle & Direct Media Passthrough Action
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

export const CONTINUE_LOCAL_OCR_ENABLED_SETTING = 'continue.localOcr.enabled';
export const TOGGLE_LOCAL_OCR_COMMAND_ID = 'continue.toggleLocalOcr';

export class ToggleLocalOcrAction extends Action2 {
	static readonly ID = TOGGLE_LOCAL_OCR_COMMAND_ID;

	constructor() {
		super({
			id: ToggleLocalOcrAction.ID,
			title: localize2('continue.localOcr.title', "Local OCR"),
			category: localize2('continue.category', "Mobius"),
			icon: Codicon.fileMedia,
			f1: true,
			precondition: ChatContextKeys.enabled,
			toggled: {
				condition: ContextKeyExpr.notEquals(`config.${CONTINUE_LOCAL_OCR_ENABLED_SETTING}`, false),
				title: localize('continue.localOcr.enabledTitle', "Local OCR: On"),
				tooltip: localize('continue.localOcr.enabledTooltip', "Local OCR is enabled (GLM-OCR ONNX). Click to disable and send media directly to multimodal API providers."),
			},
			tooltip: localize('continue.localOcr.disabledTooltip', "Local OCR is disabled. Images and video files will be sent directly to the model API provider. Click to enable local OCR."),
			menu: [
				{
					id: MenuId.ChatInput,
					group: 'navigation',
					order: 5,
					when: ContextKeyExpr.and(
						ChatContextKeys.location.isEqualTo(ChatAgentLocation.Chat),
						ChatContextKeys.inQuickChat.negate(),
					),
				},
				{
					id: MenuId.ChatExecute,
					group: 'navigation',
					order: 3,
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

		const current = configurationService.getValue<boolean>(CONTINUE_LOCAL_OCR_ENABLED_SETTING) ?? true;
		const next = !current;

		await configurationService.updateValue(CONTINUE_LOCAL_OCR_ENABLED_SETTING, next, ConfigurationTarget.USER);

		if (next) {
			notificationService.info(localize(
				'continue.localOcr.enabledNotice',
				"Local OCR enabled: GLM-OCR ONNX will extract text from images for text-only models.",
			));
		} else {
			notificationService.info(localize(
				'continue.localOcr.disabledNotice',
				"Local OCR disabled: images and video files will be sent directly to multimodal API providers.",
			));
		}
	}
}

/**
 * Custom toolbar action view item for the Local OCR button.
 * Renders an accessible chip showing "OCR" / "OCR Off" with active/disabled state.
 */
export class LocalOcrButtonActionViewItem extends MenuEntryActionViewItem {
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
			if (e.affectsConfiguration(CONTINUE_LOCAL_OCR_ENABLED_SETTING)) {
				this._updateOcrState();
			}
		}));
	}

	override render(container: HTMLElement): void {
		super.render(container);
		container.classList.add('chat-local-ocr-button');
		if (this.label) {
			this.label.classList.add('chat-local-ocr-button');
		}
		this._updateOcrState();
	}

	protected override updateLabel(): void {
		if (this.label) {
			const enabled = this.configurationService.getValue<boolean>(CONTINUE_LOCAL_OCR_ENABLED_SETTING) ?? true;
			this.label.textContent = enabled
				? localize('continue.localOcr.onLabel', "OCR On")
				: localize('continue.localOcr.offLabel', "OCR Off");
		}
	}

	private _updateOcrState(): void {
		const enabled = this.configurationService.getValue<boolean>(CONTINUE_LOCAL_OCR_ENABLED_SETTING) ?? true;
		this.updateLabel();
		if (this.label) {
			this.label.classList.toggle('checked', enabled);
			this.label.classList.toggle('disabled-mode', !enabled);
			this.label.title = enabled
				? localize('continue.localOcr.enabledTooltip', "Local OCR is enabled (GLM-OCR ONNX). Click to disable and send media directly to multimodal API providers.")
				: localize('continue.localOcr.disabledTooltip', "Local OCR is disabled. Images and video files will be sent directly to the model API provider. Click to enable local OCR.");
		}
		if (this.element) {
			this.element.classList.toggle('checked', enabled);
			this.element.classList.toggle('disabled-mode', !enabled);
			this.element.title = enabled
				? localize('continue.localOcr.enabledTooltip', "Local OCR is enabled (GLM-OCR ONNX). Click to disable and send media directly to multimodal API providers.")
				: localize('continue.localOcr.disabledTooltip', "Local OCR is disabled. Images and video files will be sent directly to the model API provider. Click to enable local OCR.");
		}
	}
}

/**
 * Workbench contribution registering the custom ActionViewItem factory for the Local OCR button.
 */
export class LocalOcrActionViewItemContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.continueLocalOcrActionViewItem';

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
				LocalOcrButtonActionViewItem,
				action,
				options as IMenuEntryActionViewItemOptions | undefined,
			);
		};
		this._register(actionViewItemService.register(MenuId.ChatInput, TOGGLE_LOCAL_OCR_COMMAND_ID, factory));
		this._register(actionViewItemService.register(MenuId.ChatExecute, TOGGLE_LOCAL_OCR_COMMAND_ID, factory));
	}
}

export function registerContinueLocalOcrAction(): void {
	registerAction2(ToggleLocalOcrAction);
}
