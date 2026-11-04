/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { superAgentStatusLabel } from '../../browser/continueSuperAgentActions.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('Super Agent visible status', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('never labels absent, stale or stopped background service as running', () => {
		assert.strictEqual(superAgentStatusLabel(undefined, 20000), 'Not running');
		assert.strictEqual(superAgentStatusLabel({ mode: 'auto', stopped: true }, 20000), 'Not running');
		assert.strictEqual(superAgentStatusLabel({ mode: 'auto', active: 2, updatedAt: 1000 }, 20000), 'Status unavailable');
		assert.strictEqual(superAgentStatusLabel({ mode: 'auto', active: 2, attention: [{}], updatedAt: 19000 }, 20000), 'auto · 2 running · 1 need attention');
	});
});
