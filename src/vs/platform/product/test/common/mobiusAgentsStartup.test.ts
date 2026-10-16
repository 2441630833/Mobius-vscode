/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import type { NativeParsedArgs } from '../../../environment/common/argv.js';
import { shouldDefaultToAgentsWindow } from '../../common/mobiusAgentsStartup.js';

suite('Mobius Agent startup', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const args = (overrides: Partial<NativeParsedArgs> = {}): NativeParsedArgs => ({ _: [], ...overrides });

	test('defaults to Agents for ordinary, new and reused windows', () => {
		for (const overrides of [{}, { 'new-window': true }, { 'reuse-window': true }, { agents: true }, { profile: 'Existing' }, { 'profile-temp': true }]) {
			assert.strictEqual(shouldDefaultToAgentsWindow(args(overrides), 'Continue.continue'), true);
		}
	});

	test('preserves explicit file, folder and extension development launches', () => {
		for (const overrides of [{ _: ['/project'] }, { 'folder-uri': ['file:///project'] }, { 'file-uri': ['file:///project/file.ts'] }, { extensionDevelopmentPath: ['/extension'] }]) {
			assert.strictEqual(shouldDefaultToAgentsWindow(args(overrides), 'Continue.continue'), false);
			assert.strictEqual(shouldDefaultToAgentsWindow(args({ ...overrides, 'new-window': true }), 'Continue.continue'), false);
		}
	});

	test('does not change other products', () => {
		for (const extensionId of [undefined, 'GitHub.copilot']) {
			assert.strictEqual(shouldDefaultToAgentsWindow(args(), extensionId), false);
			assert.strictEqual(shouldDefaultToAgentsWindow(args({ 'new-window': true }), extensionId), false);
		}
	});
});
