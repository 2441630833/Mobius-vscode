/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { localize } from '../../../../nls.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';

export const CONTINUE_LOCAL_OCR_ENABLED_SETTING = 'continue.localOcr.enabled';

export async function confirmLocalOcrForImages(
	imageCount: number,
	supportsVision: boolean,
	modelName: string,
	configuration: IConfigurationService,
	dialogs: IDialogService,
	token: CancellationToken,
): Promise<boolean> {
	if (token.isCancellationRequested) { return false; }
	if (!imageCount || supportsVision || configuration.getValue<boolean>(CONTINUE_LOCAL_OCR_ENABLED_SETTING) === true) {
		return true;
	}
	const result = await dialogs.confirm({
		message: localize('continue.ocr.enableQuestion', "Enable local OCR for this model?"),
		detail: localize('continue.ocr.enableDetail', "{0} does not declare image support. Local OCR can extract text from your images and send that text to the model. It cannot understand every visual detail. Enabling it will turn on the OCR toolbar setting for future requests.", modelName),
		primaryButton: localize('continue.ocr.enableButton', "Enable Local OCR"),
		cancelButton: localize('continue.ocr.cancelButton', "Cancel Request"),
	});
	if (!result.confirmed || token.isCancellationRequested) { return false; }
	await configuration.updateValue(CONTINUE_LOCAL_OCR_ENABLED_SETTING, true, ConfigurationTarget.USER);
	return !token.isCancellationRequested;
}
