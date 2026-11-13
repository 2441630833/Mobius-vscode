/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { localize } from '../../../../nls.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';

export const CONTINUE_LOCAL_OCR_ENABLED_SETTING = 'continue.localOcr.enabled';

/**
 * How a request carrying images should be sent to a model whose image support
 * is not advertised:
 *
 * - `send`: pass the images through unchanged (the endpoint decides).
 * - `ocr`: extract text with the local OCR pipeline and send that text instead.
 * - `cancel`: do not send the request at all.
 */
export type ContinueImageConsent = 'send' | 'ocr' | 'cancel';

/**
 * Resolve how to handle image attachments for the selected model.
 *
 * A model that declares image support (or whose support we inferred) always
 * takes the `send` path. For anything else the user is asked once, and the
 * dialog always offers the direct passthrough, because capability metadata is
 * frequently missing while the endpoint itself accepts `image_url` blocks.
 */
export async function confirmLocalOcrForImages(
	imageCount: number,
	supportsVision: boolean,
	modelName: string,
	configuration: IConfigurationService,
	dialogs: IDialogService,
	token: CancellationToken,
): Promise<ContinueImageConsent> {
	if (token.isCancellationRequested) { return 'cancel'; }
	if (!imageCount || supportsVision) { return 'send'; }
	if (configuration.getValue<boolean>(CONTINUE_LOCAL_OCR_ENABLED_SETTING) === true) { return 'ocr'; }
	const result = await dialogs.prompt<ContinueImageConsent>({
		type: 'question',
		message: localize('continue.ocr.enableQuestion', "Send images to this model?"),
		detail: localize('continue.ocr.enableDetail', "{0} does not declare image support. You can send the images anyway (the provider will reject them if it cannot handle images), or use local OCR to extract text from your images. Enabling OCR will turn on the OCR toolbar setting for future requests.", modelName),
		buttons: [
			{
				label: localize('continue.ocr.sendButton', "Send Images Anyway"),
				run: () => 'send' as ContinueImageConsent,
			},
			{
				label: localize('continue.ocr.enableButton', "Enable Local OCR"),
				run: () => 'ocr' as ContinueImageConsent,
			},
		],
		cancelButton: {
			label: localize('continue.ocr.cancelButton', "Cancel Request"),
			run: () => 'cancel' as ContinueImageConsent,
		},
	});
	if (token.isCancellationRequested) { return 'cancel'; }
	const action = result.result ?? 'cancel';
	if (action === 'ocr') {
		await configuration.updateValue(CONTINUE_LOCAL_OCR_ENABLED_SETTING, true, ConfigurationTarget.USER);
		if (token.isCancellationRequested) { return 'cancel'; }
	}
	return action;
}