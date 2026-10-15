/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { localize, localize2 } from '../../../nls.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from './utils.js';

suite('NLS product branding', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('brands English product names in UI templates', () => {
		assert.deepStrictEqual([
			localize('open', "Open in VS Code"),
			localize('welcome', "Welcome to Visual Studio Code"),
			localize('oss', "Code - OSS Window"),
			localize2('command', "Return to VS Code Editor")
		], [
			'Open in Mobius',
			'Welcome to Mobius',
			'Mobius Window',
			{ value: 'Return to Mobius Editor', original: 'Return to Mobius Editor' }
		]);
	});

	test('brands cached Chinese translations and the English command alias', () => {
		const messages = globalThis._VSCODE_NLS_MESSAGES;
		try {
			globalThis._VSCODE_NLS_MESSAGES = ['在 VS Code 编辑器窗口中打开'];
			assert.deepStrictEqual([
				Reflect.apply(localize, undefined, [0, 'Open in {0} Editor Window', 'Mobius']),
				Reflect.apply(localize2, undefined, [0, 'Open in VS Code Editor Window'])
			], [
				'在 Mobius 编辑器窗口中打开',
				{ value: '在 Mobius 编辑器窗口中打开', original: 'Open in Mobius Editor Window' }
			]);
		} finally {
			globalThis._VSCODE_NLS_MESSAGES = messages;
		}
	});

	test('preserves user arguments and technical identifiers', () => {
		assert.deepStrictEqual([
			localize('file', "VS Code could not open {0}", 'C:/Visual Studio Code/VS Code.txt'),
			localize('extension', "Open {0}", 'VS Code Extension'),
			localize('links', "Use vscode.env with [VS Code](https://code.visualstudio.com) and vscode://file"),
			localize('ordinary', "VS Codebase {0} {1} {2}", 42, true, null)
		], [
			'Mobius could not open C:/Visual Studio Code/VS Code.txt',
			'Open VS Code Extension',
			'Use vscode.env with [Mobius](https://code.visualstudio.com) and vscode://file',
			'VS Codebase 42 true null'
		]);
	});
});
