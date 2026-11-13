/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { confirmLocalOcrForImages, ContinueImageConsent, CONTINUE_LOCAL_OCR_ENABLED_SETTING } from '../../browser/continueOcrConsent.js';
import { isWebSearchEnabled } from '../../browser/continueWebSearch.js';

suite('Continue image consent', () => {
	function fixture(enabled?: boolean, choice: ContinueImageConsent = 'ocr', cancel?: () => void) {
		let prompts = 0;
		const writes: unknown[][] = [];
		const configuration = {
			getValue: () => enabled,
			updateValue: async (...args: unknown[]) => { writes.push(args); enabled = true; },
		} as unknown as IConfigurationService;
		const dialogs = { prompt: async () => { prompts++; cancel?.(); return { result: choice }; } } as unknown as IDialogService;
		return { configuration, dialogs, writes, get prompts() { return prompts; } };
	}

	test('unset OCR asks for consent and saves opt-in, while web search defaults on', async () => {
		const f = fixture();
		assert.strictEqual(isWebSearchEnabled(f.configuration), true);
		assert.strictEqual(await confirmLocalOcrForImages(1, false, 'text model', f.configuration, f.dialogs, CancellationToken.None), 'ocr');
		assert.strictEqual(f.prompts, 1);
		assert.deepStrictEqual(f.writes, [[CONTINUE_LOCAL_OCR_ENABLED_SETTING, true, ConfigurationTarget.USER]]);
		await confirmLocalOcrForImages(1, false, 'text model', f.configuration, f.dialogs, CancellationToken.None);
		assert.strictEqual(f.prompts, 1);
	});

	test('choosing to send images directly bypasses OCR and does not persist opt-in', async () => {
		const f = fixture(false, 'send');
		assert.strictEqual(await confirmLocalOcrForImages(1, false, 'text model', f.configuration, f.dialogs, CancellationToken.None), 'send');
		assert.strictEqual(f.prompts, 1);
		assert.deepStrictEqual(f.writes, []);
	});

	for (const [images, vision, enabled, expected] of [[0, false, false, 'send'], [1, true, false, 'send'], [1, false, true, 'ocr']] as const) {
		test(`does not prompt for images=${images}, vision=${vision}, OCR=${enabled}`, async () => {
			const f = fixture(enabled);
			assert.strictEqual(await confirmLocalOcrForImages(images, vision, 'model', f.configuration, f.dialogs, CancellationToken.None), expected);
			assert.strictEqual(f.prompts, 0);
			assert.deepStrictEqual(f.writes, []);
		});
	}

	test('refusal stops the image request without enabling OCR', async () => {
		const f = fixture(false, 'cancel');
		assert.strictEqual(await confirmLocalOcrForImages(1, false, 'text model', f.configuration, f.dialogs, CancellationToken.None), 'cancel');
		assert.deepStrictEqual(f.writes, []);
	});

	test('cancellation during confirmation does not persist opt-in', async () => {
		const source = new CancellationTokenSource();
		try {
			const f = fixture(false, 'ocr', () => source.cancel());
			assert.strictEqual(await confirmLocalOcrForImages(1, false, 'text model', f.configuration, f.dialogs, source.token), 'cancel');
			assert.deepStrictEqual(f.writes, []);
		} finally { source.dispose(); }
	});
});