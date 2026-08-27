/*---------------------------------------------------------------------------------------------
 *  Mobius — mode picker subtitle for Agent / Game / Chip
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ChatMode } from '../../../chat/common/chatModes.js';
import { getMobiusModePickerDetailLine } from '../../browser/continueMobiusModeRouting.js';
import { isMobiusAgentMode } from '../../browser/continueMobiusModeIcons.js';

suite('getMobiusModePickerDetailLine', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('builtin Agent is recognized and has a subtitle', () => {
		assert.strictEqual(isMobiusAgentMode(ChatMode.Agent), true);
		const detail = getMobiusModePickerDetailLine(ChatMode.Agent);
		assert.strictEqual(detail, 'General coding · no auto Godot');
	});
});
